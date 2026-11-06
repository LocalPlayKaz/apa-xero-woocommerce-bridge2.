const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient((process.env.SUPABASE_URL || '').trim(), (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim());
const parseExp = (v) => (!v ? 0 : !isNaN(Number(v)) ? Number(v) : new Date(v).getTime());

async function getAccessTokenAndTenant() {
  const { data: td, error: fe } = await supabase.from('xero_tokens').select('*').eq('id', 1).single();
  if (fe || !td) throw new Error(`Supabase fetch error: ${fe?.message || 'No row id=1'}`);

  const tid = td.tenant_id || process.env.XERO_TENANT_ID;
  if (Date.now() < parseExp(td.expires_at) - 120000) {
    return { accessToken: td.access_token, tenantId: tid };
  }

  const ref = (td.refresh_token || '').trim();
  const creds = Buffer.from(`${(process.env.XERO_CLIENT_ID || '').trim()}:${(process.env.XERO_CLIENT_SECRET || '').trim()}`).toString('base64');
  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: ref });

  const res = await axios.post('https://identity.xero.com/connect/token', params.toString(), {
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000
  });

  const expAt = Date.now() + ((res.data.expires_in || 1800) * 1000);
  const { error: ue } = await supabase.from('xero_tokens').update({
    access_token: res.data.access_token,
    refresh_token: res.data.refresh_token,
    expires_at: expAt,
    updated_at: new Date().toISOString()
  }).eq('id', td.id);

  if (ue) throw new Error(`Supabase update error: ${ue.message}`);
  return { accessToken: res.data.access_token, tenantId: tid };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {
        try { body = require('querystring').parse(body); } catch (err) { body = {}; }
      }
    } else if (!body || Object.keys(body).length === 0) {
      body = {};
    }

    const p = body?.order || body?.data || body;
    const orderId = p?.id || p?.order_id || p?.ID;
    const parentId = Number(p?.parent_id || p?.parentID || 0);

    console.log(`Webhook received. Order ID: ${orderId || 'Ping'}, Parent ID: ${parentId}`);

    if (!p || !orderId) {
      return res.status(200).json({ status: 'ignored', message: 'Webhook ping OK / No order ID.' });
    }

    const hasSubMeta = Array.isArray(p.meta_data) && p.meta_data.some(m => m?.key === 'has_sub_order' && (m?.value === true || m?.value === '1' || m?.value === 'yes'));
    const hasSubOrder = p.has_sub_order || hasSubMeta;

    if (parentId === 0 && hasSubOrder) {
      console.log(`Skipping parent order #${orderId}`);
      return res.status(200).json({ status: 'ignored', message: 'Parent order skipped.' });
    }

    let vName = p.forced_vendor_name || 'Store Order';
    if (!p.forced_vendor_name && Array.isArray(p.stores) && p.stores.length > 0) {
      vName = p.stores[0].shop_name || p.stores[0].name || vName;
    } else if (!p.forced_vendor_name && Array.isArray(p.meta_data)) {
      const vMeta = p.meta_data.find(m => m?.key === '_dokan_vendor_name' || m?.key === 'dokan_store_name');
      if (vMeta?.value) vName = vMeta.value;
    }

    const items = [];
    if (Array.isArray(p.line_items)) {
      p.line_items.forEach(i => {
        let itemVendor = vName;
        if (Array.isArray(i.meta_data)) {
          const ivMeta = i.meta_data.find(m => m?.key === '_dokan_vendor_name' || m?.key === 'dokan_store_name' || m?.key === 'Vendor');
          if (ivMeta?.value) itemVendor = ivMeta.value;
        }

        const qty = Number(i.quantity || 1);
        const price = parseFloat(i.price || (i.subtotal / qty) || 0);

        items.push({
          Description: `[${itemVendor}] ${i.sku ? `(SKU: ${i.sku}) ` : ''}${i.name}`,
          Quantity: qty,
          UnitAmount: price.toFixed(2),
          AccountCode: "4500",
          TaxType: "NONE"
        });

        const itemTax = parseFloat(i.total_tax || 0);
        if (itemTax > 0) {
          items.push({
            Description: `Sales Tax for [${itemVendor}] ${i.name}`,
            Quantity: 1,
            UnitAmount: itemTax.toFixed(2),
            AccountCode: "2700",
            TaxType: "NONE"
          });
        }
      });
    }

    if (Array.isArray(p.shipping_lines)) {
      p.shipping_lines.forEach(s => {
        const shipTotal = parseFloat(s.total || 0);
        if (shipTotal > 0) {
          items.push({
            Description: `Shipping: ${s.method_title || 'Standard'}`,
            Quantity: 1,
            UnitAmount: shipTotal.toFixed(2),
            AccountCode: "4500",
            TaxType: "NONE"
          });
        }
      });
    }

    if (!items.length) return res.status(400).json({ error: 'No line items found.' });

    const { accessToken, tenantId } = await getAccessTokenAndTenant();
    const cName = `${p.billing?.first_name || ''} ${p.billing?.last_name || ''}`.trim() || 'Customer';
    const refText = parentId !== 0 ? `Child Order #${orderId} (Parent #${parentId})` : `Order #${orderId}`;

    const inv = {
      Invoices: [{
        Type: 'ACCREC',
        Contact: { Name: cName },
        Date: new Date().toISOString().split('T')[0],
        DueDate: new Date(Date.now() + 25 * 86400000).toISOString().split('T')[0],
        Reference: refText,
        LineItems: items,
        Status: 'AUTHORISED'
      }]
    };

    const xRes = await axios.post('https://api.xero.com/api.xro/2.0/Invoices', inv, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Xero-tenant-id': tenantId, 'Content-Type': 'application/json' },
      timeout: 15000
    });

    console.log('Xero Invoice Created! ID:', xRes.data.Invoices[0].InvoiceID);
    return res.status(200).json({ status: 'success', invoice_id: xRes.data.Invoices[0].InvoiceID });
  } catch (err) {
    console.error('Bridge error:', err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data || err.message });
  }
};
