const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient((process.env.SUPABASE_URL || '').trim(), (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim());
const parseExp = (v) => (!v ? 0 : !isNaN(Number(v)) ? Number(v) : new Date(v).getTime());

async function getAccessTokenAndTenant() {
  const { data: td, error: fe } = await supabase.from('xero_tokens').select('*').eq('id', 1).single();
  if (fe || !td) throw new Error('Failed to fetch Xero token.');
  const tid = td.tenant_id || process.env.XERO_TENANT_ID;
  if (Date.now() < parseExp(td.expires_at) - 120000) return { accessToken: td.access_token, tenantId: tid };

  const { data: lock } = await supabase.rpc('acquire_token_lock', { lock_id: 'xero_refresh_lock' });
  if (!lock) { await new Promise(r => setTimeout(r, 2500)); return await getAccessTokenAndTenant(); }

  try {
    const { data: fc } = await supabase.from('xero_tokens').select('*').eq('id', 1).single();
    if (fc && Date.now() < parseExp(fc.expires_at) - 120000) return { accessToken: fc.access_token, tenantId: fc.tenant_id || tid };
    const ref = (fc?.refresh_token || td.refresh_token || '').trim();
    const creds = Buffer.from(`${(process.env.XERO_CLIENT_ID || '').trim()}:${(process.env.XERO_CLIENT_SECRET || '').trim()}`).toString('base64');
    const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: ref });
    const res = await axios.post('https://identity.xero.com/connect/token', params.toString(), { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
    const expAt = new Date(Date.now() + ((res.data.expires_in || 1800) * 1000)).toISOString();
    await supabase.from('xero_tokens').update({ access_token: res.data.access_token, refresh_token: res.data.refresh_token, expires_at: expAt, updated_at: new Date().toISOString() }).eq('id', td.id);
    return { accessToken: res.data.access_token, tenantId: tid };
  } finally { await supabase.rpc('release_token_lock', { lock_id: 'xero_refresh_lock' }); }
}

const getRawBody = (req) => new Promise((res, rej) => { let d = ''; req.on('data', c => d += c); req.on('end', () => res(d)); req.on('error', rej); });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });
  try {
    const raw = await getRawBody(req);
    let body = {}; try { body = JSON.parse(raw); } catch (e) { try { body = require('querystring').parse(raw); } catch (err) { body = {}; } }
    const p = body?.order || body?.data || body;
    const orderId = p?.id || p?.order_id || p?.ID;
    const parentId = p?.parent_id || p?.parentID || 0;
    if (!p || !orderId) return res.status(200).json({ status: 'ignored', message: 'Ping/No order ID.' });

    const hasSub = p.has_sub_order || p.meta_data?.some(m => m.key === 'has_sub_order' && (m.value === true || m.value === '1' || m.value === 'yes'));
    if ((!parentId || parentId == 0) && hasSub) return res.status(200).json({ status: 'ignored', message: 'Parent order skipped.' });

    let vName = p.forced_vendor_name || p.meta_data?.find(m => m.key === '_dokan_vendor_name' || m.key === 'dokan_store_name')?.value || 'Store Order';
    const items = [];
    (p.line_items || []).forEach(i => {
      items.push({ Description: `[${vName}] ${i.sku ? `(SKU: ${i.sku}) ` : ''}${i.name}`, Quantity: i.quantity, UnitAmount: parseFloat(i.price || (i.subtotal / i.quantity) || 0).toFixed(2), AccountCode: "4500", TaxType: "NONE" });
      if (parseFloat(i.total_tax || 0) > 0) items.push({ Description: `Sales Tax for [${vName}] ${i.name}`, Quantity: 1, UnitAmount: parseFloat(i.total_tax).toFixed(2), AccountCode: "2700", TaxType: "NONE" });
    });
    (p.shipping_lines || []).forEach(s => items.push({ Description: `Shipping: ${s.method_title || 'Standard'}`, Quantity: 1, UnitAmount: parseFloat(s.total || 0).toFixed(2), AccountCode: "4500", TaxType: "NONE" }));
    if (!items.length) return res.status(400).json({ error: 'No line items.' });

    const { accessToken, tenantId } = await getAccessTokenAndTenant();
    const cName = `${p.billing?.first_name || ''} ${p.billing?.last_name || ''}`.trim() || 'Customer';
    const refText = (parentId && parentId != 0) ? `Child Order #${orderId} (Parent #${parentId})` : `Order #${orderId}`;
    const inv = { Invoices: [{ Type: 'ACCREC', Contact: { Name: cName }, Date: new Date().toISOString().split('T')[0], DueDate: new Date(Date.now() + 25 * 86400000).toISOString().split('T')[0], Reference: refText, LineItems: items, Status: 'AUTHORISED' }] };
    const xRes = await axios.post('https://api.xero.com/api.xro/2.0/Invoices', inv, { headers: { Authorization: `Bearer ${accessToken}`, 'Xero-tenant-id': tenantId, 'Content-Type': 'application/json' } });
    return res.status(200).json({ status: 'success', invoice_id: xRes.data.Invoices[0].InvoiceID });
  } catch (err) {
    console.error('Bridge error:', err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data || err.message });
  }
};
