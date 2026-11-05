export default async function handler(req, res) {
  const clientId = process.env.XERO_CLIENT_ID;
  const redirectUri = process.env.XERO_REDIRECT_URI || 'https://apa-xero-woocommerce-bridge2.vercel.app/api/auth';

  if (!clientId) {
    return res.status(500).json({ 
      error: 'Missing XERO_CLIENT_ID in Vercel environment variables.' 
    });
  }

  // Using Xero's NEW granular scopes (post-March 2026 requirement)
  const scopes = [
    'openid',
    'profile',
    'email',
    'offline_access',
    'accounting.invoices',
    'accounting.payments',
    'accounting.contacts',
    'accounting.settings'
  ].join(' ');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state: 'apa_xero_auth_state'
  });

  const authUrl = `https://login.xero.com/identity/connect/authorize?${params.toString()}`;

  return res.redirect(302, authUrl);
}
