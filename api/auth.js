import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code } = req.query;
  const redirectUri = process.env.XERO_REDIRECT_URI || 'https://apa-xero-woocommerce-bridge2.vercel.app/api/auth';

  if (!code) {
    return res.status(400).json({ error: 'Authorization code missing from Xero redirect' });
  }

  try {
    // 1. Exchange the code for live tokens from Xero
    const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(
          `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`
        ).toString('base64')}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri
      })
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      throw new Error(tokenData.error_description || 'Failed to exchange token with Xero');
    }

    // 2. Fetch Xero Tenant ID
    const connectionsResponse = await fetch('https://api.xero.com/connections', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json'
      }
    });

    const connections = await connectionsResponse.json();
    const tenantId = connections?.[0]?.tenantId;

    if (!tenantId) {
      throw new Error('No Xero tenant found for this connection.');
    }

    // 3. Upsert the live tokens into Supabase
    const { error: dbError } = await supabase
      .from('xero_tokens')
      .upsert({
        id: 1,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + tokenData.expires_in,
        tenant_id: tenantId,
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });

    if (dbError) {
      throw new Error(`Supabase save error: ${dbError.message}`);
    }

    return res.status(200).send('Xero Authentication Successful! Tokens saved to Supabase. You can close this window.');

  } catch (err) {
    console.error('Xero OAuth Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
