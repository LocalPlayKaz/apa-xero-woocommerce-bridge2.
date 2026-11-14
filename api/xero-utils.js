import { createClient } from '@supabase/supabase-js';

export async function getXeroToken() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Fetch the latest token row securely, ordered by ID descending
  const { data, error } = await supabase
    .from('xero_tokens')
    .select('*')
    .order('id', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error(`Failed to fetch Xero token from Supabase: ${error?.message || 'No token rows found'}`);
  }

  const currentTime = Math.floor(Date.now() / 1000);
  
  // Check if token is expired or will expire in the next 60 seconds
  if (data.expires_at && data.expires_at > currentTime + 60) {
    // Token is still valid
    return data;
  }

  console.log('Xero access token expired. Refreshing token...');

  // Token is expired, use the refresh token to get a new one
  const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(
        `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`
      ).toString('base64')}`
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: data.refresh_token
    })
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok) {
    throw new Error(tokenData.error_description || 'Failed to refresh token with Xero. Re-authentication required.');
  }

  const newAccessToken = tokenData.access_token;
  const newRefreshToken = tokenData.refresh_token;
  const newExpiresAt = Math.floor(Date.now() / 1000) + tokenData.expires_in;

  // Update Supabase with the newly refreshed tokens
  const { error: updateError } = await supabase
    .from('xero_tokens')
    .update({
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      expires_at: newExpiresAt,
      updated_at: new Date().toISOString()
    })
    .eq('id', data.id);

  if (updateError) {
    throw new Error(`Failed to save refreshed tokens to Supabase: ${updateError.message}`);
  }

  return {
    ...data,
    access_token: newAccessToken,
    refresh_token: newRefreshToken,
    expires_at: newExpiresAt
  };
}
