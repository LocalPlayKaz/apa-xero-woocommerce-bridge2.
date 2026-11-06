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
