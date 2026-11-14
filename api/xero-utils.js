import { getXeroToken } from './xero-utils.js';

const PAYPAL_BASE =
  process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

async function getPayPalAccessToken() {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  return data.access_token;
}

async function verifyPayPalWebhook(headers, rawBodyString, accessToken) {
  const verifyPayload = {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: process.env.PAYPAL_WEBHOOK_ID,
    webhook_event: JSON.parse(rawBodyString),
  };

  const res = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(verifyPayload),
  });

  const data = await res.json();
  return data.verification_status === 'SUCCESS';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawBodyString =
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // 1. Verify signature with PayPal
    const ppToken = await getPayPalAccessToken();
    const isValid = await verifyPayPalWebhook(req.headers, rawBodyString, ppToken);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid PayPal webhook signature' });
    }

    // 2. Filter for completed initial or recurring membership payments
    const targetEvents = ['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.SALE.COMPLETED'];
    if (!targetEvents.includes(event.event_type)) {
      return res.status(200).json({ skipped: true, event: event.event_type });
    }

    const resource = event.resource || {};
    const customId = resource.custom_id || resource.invoice_id || '';

    // 3. Guard: Ignore WooCommerce store orders (handled by wc-xero-webhook.js)
    if (String(customId).startsWith('WC-') || String(resource.invoice_id || '').includes('wc_order')) {
      return res.status(200).json({ skipped: true, reason: 'WooCommerce order handled separately' });
    }

    // 4. Extract amount, transaction ID, and payer info
    const amount = parseFloat(
      resource.amount?.value || resource.amount?.total || '87.50'
    );
    const transactionId = resource.id;

    let payerEmail = resource.payer?.email_address || '';
    let payerName = resource.payer?.name
      ? `${resource.payer.name.given_name || ''} ${resource.payer.name.surname || ''}`.trim()
      : '';

    const orderLink = resource.links?.find((l) => l.rel === 'up')?.href;
    if (!payerEmail && orderLink) {
      const orderRes = await fetch(orderLink, {
        headers: { Authorization: `Bearer ${ppToken}` },
      });
      if (orderRes.ok) {
        const orderData = await orderRes.json();
        payerEmail = orderData.payer?.email_address || '';
        payerName = `${orderData.payer?.name?.given_name || ''} ${
          orderData.payer?.name?.surname || ''
        }`.trim();
      }
    }

    // 5. Push Membership Invoice to Xero (Account Code 4100)
    const tokenRow = await getXeroToken();
    const accessToken = tokenRow.access_token;
    const tenantId = tokenRow.tenant_id || process.env.XERO_TENANT_ID;

    const invoicePayload = {
      Invoices: [
        {
          Type: 'ACCREC',
          Contact: {
            Name: payerName || payerEmail || `APA Member (${transactionId})`,
            ...(payerEmail ? { EmailAddress: payerEmail } : {}),
          },
          Date: new Date().toISOString().split('T')[0],
          DueDate: new Date().toISOString().split('T')[0],
          InvoiceNumber: `MEPR-${transactionId}`,
          Reference: `APA Membership | PayPal Tx: ${transactionId}`,
          Status: 'AUTHORISED',
          LineAmountTypes: 'Exclusive',
          LineItems: [
            {
              Description: 'Aquatic Power Alliance Membership',
              Quantity: 1,
              UnitAmount: amount,
              AccountCode: '4100',
              TaxType: 'NONE',
            },
          ],
        },
      ],
    };

    const xeroRes = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'xero-tenant-id': tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(invoicePayload),
    });

    const xeroData = await xeroRes.json();
    if (!xeroRes.ok) {
      console.error('Xero MemberPress Sync Error:', JSON.stringify(xeroData));
      return res.status(500).json({ error: 'Xero API error', details: xeroData });
    }

    return res.status(200).json({
      synced: true,
      transactionId,
      xeroInvoiceId: xeroData.Invoices?.[0]?.InvoiceID,
    });
  } catch (err) {
    console.error('PayPal MemberPress Webhook Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
