const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(
  (process.env.SUPABASE_URL || '').trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim()
);

function parseExpiresAt(val) {
  if (!val) return 0;
  const num = Number(val);
  return !isNaN(num) ? num : new Date(val).getTime();
}

async function getAccessTokenAndTenant() {
  const now = Date.now();

  const { data: tokenData, error: fetchError } = await supabase
    .from('xero_tokens')
    .select('*')
    .eq('id', 1)
    .single();

  if (fetchError || !tokenData) {
    throw new Error('Failed to fetch Xero token from Supabase.');
  }

  const expiresAt = parseExpiresAt(tokenData.expires_at);
  const tenantId = tokenData.tenant_id || process.env.XERO_TENANT_ID;

  // Check if token is still valid (with 2-minute buffer)
  if (now < expiresAt - 120000) {
    return { accessToken: tokenData.access_token, tenantId };
  }

  const { data: lockAcquired } = await supabase
    .rpc('acquire_token_lock', { lock_id: 'xero_refresh_lock' });

  if (!lockAcquired) {
    await new Promise(resolve => setTimeout(resolve, 2500));
    return await getAccessTokenAndTenant();
  }

  try {
    // Re-check inside lock in case a parallel webhook just refreshed it
    const { data: freshCheck } = await supabase
      .from('xero_tokens')
      .select('*')
      .eq('id', 1)
      .single();

    if (freshCheck && Date.now() < parseExpiresAt(freshCheck.expires_at) - 120000) {
      return {
        accessToken: freshCheck.access_token,
        tenantId: freshCheck.tenant_id || tenantId
      };
    }

    const currentRefresh = (freshCheck?.refresh_token || tokenData.refresh_token || '').trim();
    const clientId = (process.env.XERO_CLIENT_ID || '').trim();
    const clientSecret = (process.env.XERO_CLIENT_SECRET || '').trim();
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const tokenParams = new URLSearchParams();
    tokenParams.append('grant_type', 'refresh_token');
    tokenParams.append('refresh_token', currentRefresh);

    const tokenRes = await axios.post(
      'https://identity.xero.com/connect/token',
      tokenParams.toString(),
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const newAccessToken = tokenRes.data.access_token;
    const newRefreshToken = tokenRes.data.refresh_token;
    const expiresIn = tokenRes.data.expires_in || 1800;
    const newExpiresAt = new Date(Date.now() + (expiresIn * 1000)).toISOString();

    const { error: updateErr } = await supabase
      .from('xero_tokens')
      .update({
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
        expires_at: newExpiresAt,
        updated_at: new Date().toISOString()
      })
      .eq('id', tokenData.id);

    if (updateErr) {
      throw new Error(`Supabase token update failed: ${updateErr.message}`);
    }

    return { accessToken: newAccessToken, tenantId };
  } catch (err) {
    console.error('Token refresh failed:', err.response?.data || err.message);
    throw err;
  } finally {
    await supabase.rpc('release_token_lock', { lock_id: 'xero_refresh_lock' });
  }
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { resolve(data); });
    req.on('error', err => { reject(err); });
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const rawBodyString = await getRawBody(req);
    let body = {};
    try {
      body = JSON.parse(rawBodyString);
    } catch (e) {
      try {
        body = require('querystring').parse(rawBodyString);
      } catch (err) {
        body = {};
      }
    }

    const payload = body?.order || body?.data || body;
    const orderId = payload?.id || payload?.order_id || payload?.ID;
    const parentId = payload?.parent_id || payload?.parentID || 0;

    console.log(`Incoming Payload ID: ${orderId} Parent ID: ${parentId}`);

    if (!payload || !orderId) {
      return res.status(200).json({ status: 'ignored', message: 'No order ID found.' });
    }

    const hasSubOrderMeta = payload.meta_data?.some(
      meta => meta.key === 'has_sub_order' && (meta.value === true || meta.value === '1' || meta.value === 'yes')
    );
    const hasSubOrder = payload.has_sub_order || hasSubOrderMeta;
    const isParentOrder = (!parentId || parentId === 0 || parentId === '0') && hasSubOrder;

    if (isParentOrder) {
      console.log(`[PAID/SKIP] Parent Order #${orderId} skipped.`);
      return res.status(200).json({ status: 'ignored', message: 'Parent order skipped.' });
    }

    let vendorName = payload.forced_vendor_name;
    if (!vendorName && payload.meta_data) {
      const orderMeta = payload.meta_data.find(meta =>
        meta.key === '_dokan_vendor_name' || meta.key === 'dokan_store_name'
      );
      if (orderMeta && orderMeta.value) vendorName = orderMeta.value;
    }
    vendorName = vendorName || 'Store Order';

    const lineItems = [];
    if (payload.line_items && Array.isArray(payload.line_items)) {
      payload.line_items.forEach(item => {
        const skuText = item.sku ? `(SKU: ${item.sku}) ` : '';
        lineItems.push({
          Description: `[${vendorName}] ${skuText}${item.name}`,
          Quantity: item.quantity,
          UnitAmount: parseFloat(item.price || (item.subtotal / item.quantity) || 0).toFixed(2),
          AccountCode: "4500",
          TaxType: "NONE"
        });

        const itemTax = parseFloat(item.total_tax || 0);
        if (itemTax > 0) {
          lineItems.push({
            Description: `Sales Tax for [${vendorName}] ${item.name}`,
            Quantity: 1,
            UnitAmount: itemTax.toFixed(2),
            AccountCode: "2700",
            TaxType: "NONE"
          });
        }
      });
    }

    if (payload.shipping_lines && Array.isArray(payload.shipping_lines)) {
      payload.shipping_lines.forEach(ship => {
        lineItems.push({
          Description: `Shipping: ${ship.method_title || 'Standard'}`,
          Quantity: 1,
          UnitAmount: parseFloat(ship.total || 0).toFixed(2),
          AccountCode: "4500",
          TaxType: "NONE"
        });
      });
    }

    if (lineItems.length === 0) {
      return res.status(400).json({ error: 'Order contains no line items.' });
    }

    const issueDate = new Date();
    const dueDate = new Date(issueDate.getTime() + 25 * 24 * 60 * 60 * 1000);

    // Fetch both valid access token and tenant ID dynamically from Supabase
    const { accessToken, tenantId } = await getAccessTokenAndTenant();

    const customerName = `${payload.billing?.first_name || ''} ${payload.billing?.last_name || ''}`.trim() || 'Customer';
    const referenceText = (parentId && parentId !== 0 && parentId !== '0')
      ? `Child Order #${orderId} (Parent #${parentId})`
      : `Order #${orderId}`;

    const invoicePayload = {
      Invoices: [
        {
          Type: 'ACCREC',
          Contact: { Name: customerName },
          Date: issueDate.toISOString().split('T')[0],
          DueDate: dueDate.toISOString().split('T')[0],
          Reference: referenceText,
          LineItems: lineItems,
          Status: 'AUTHORISED'
        }
      ]
    };

    const response = await axios.post('https://api.xero.com/api.xro/2.0/Invoices', invoicePayload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        'Content-Type': 'application/json'
      }
    });

    console.log('Xero Invoice Created! ID:', response.data.Invoices[0].InvoiceID);
    return res.status(200).json({ status: 'success', invoice_id: response.data.Invoices[0].InvoiceID });

  } catch (error) {
    console.log('Bridge error:', error.response?.data || error.message);
    return res.status(500).json({ error: error.response?.data || error.message });
  }
};
