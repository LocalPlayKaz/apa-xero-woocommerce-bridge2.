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
