export default function handler(req, res) {
  const clientId = process.env.XERO_CLIENT_ID;
  const redirectUri = process.env.XERO_REDIRECT_URI || 'https://apa-xero-woocommerce-bridge2.vercel.app/api/auth';
  const scope = 'openid profile email accounting.transactions accounting.settings offline_access';

  const xeroAuthUrl = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=123`;

  res.setHeader('Location', xeroAuthUrl);
  return res.status(302).end();
}
