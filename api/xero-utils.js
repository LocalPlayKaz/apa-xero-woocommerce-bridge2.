import { createClient } from '@supabase/supabase-js';

function parseExpiresAtSeconds(rawExpiresAt) {
  if (!rawExpiresAt) return 0;
  if (typeof rawExpiresAt === 'string' && isNaN(Number(rawExpiresAt))) {
    const parsedMs = Date.parse(rawExpiresAt);
    return isNaN(parsedMs) ? 0 : Math.floor(parsedMs / 1000);
  }
  const num = Number(rawExpiresAt);
  if (isNaN(num)) return 0;
  // If stored in milliseconds (> 100 billion), convert to seconds
  return num > 1e11 ? Math.floor(num / 1000) : Math.floor(num);
}

export async function getXeroToken(forceRefresh = false) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await supabase
    .from('xero_tokens')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error(`Failed to fetch Xero token from Supabase: ${error?.message || 'No token rows found'}`);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = parseExpiresAtSeconds(data.expires_at);

  // Only reuse token if not forced and still valid for at least 5 minutes
  if (!forceRefresh && expiresAtSeconds > nowSeconds + 300) {
    return data;
  }

  console.log('Refreshing Xero access token via refresh_token...');

  const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(
        `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`
      ).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: data.refresh_token,
    }),
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok) {
    console.error('Xero Token Refresh Failed:', JSON.stringify(tokenData));
    throw new Error(
      tokenData.error_description || tokenData.error || 'Failed to refresh token with Xero.'
    );
  }

  const newAccessToken = tokenData.access_token;
  const newRefreshToken = tokenData.refresh_token;
  const isMilliseconds = Number(data.expires_at) > 1e11;
  const newExpiresAt = isMilliseconds
    ? Date.now() + tokenData.expires_in * 1000
    : Math.floor(Date.now() / 1000) + tokenData.expires_in;

  const { error: updateError } = await supabase
    .from('xero_tokens')
    .update({
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', data.id);

  if (updateError) {
    throw new Error(`Failed to save refreshed tokens to Supabase: ${updateError.message}`);
  }

  console.log('Successfully refreshed and saved Xero token to Supabase.');

  return {
    ...data,
    access_token: newAccessToken,
    refresh_token: newRefreshToken,
    expires_at: newExpiresAt,
  };
}
