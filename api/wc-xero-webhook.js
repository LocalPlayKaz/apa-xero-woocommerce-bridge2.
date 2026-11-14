import crypto from 'crypto';
import { getXeroToken } from './xero-utils.js';

export const config = {
  api: {
    bodyParser: false, // Required for raw HMAC signature verification
  },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawBody = await getRawBody(req);
    const bodyText = rawBody.toString('utf8');

    // Handle WooCommerce webhook ping test when first saving the webhook
    if (bodyText.startsWith('webhook_id=')) {
      return res.status(200).json({ received: true, ping: true });
    }

    // 1. Verify WooCommerce HMAC-SHA256 Signature using WC_PAYPAL_WEBHOOK_SECRET
    const webhookSecret =
      process.env.WC_PAYPAL_WEBHOOK_SECRET ||
      process.env.WOO_WEBHOOK_SECRET ||
      process.env.WC_WEBHOOK_SECRET;

    const signature = req.headers['x-wc-webhook-signature'];
    const expectedSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('base64');

    if (!signature || signature !== expectedSig) {
      return res.status(401).json({ error: 'Invalid WooCommerce webhook signature' });
    }

    const order = JSON.parse(bodyText);
    const meta = order.meta_data || [];

    // 2. Dokan Parent Order Guard: Skip parent container orders ONLY if parent_id is 0 and it has sub-orders
    const hasSubOrdersMeta = meta.some(
      (m) => (m.key === '_dokan_has_sub_order' || m.key === 'has_sub_order') && (m.value === '1' || m.value === true || m.value === 'yes')
    );
    if (Number(order.parent_id) === 0 && hasSubOrdersMeta) {
      return res.status(200).json({ skipped: true, reason: 'Dokan parent order container skipped' });
    }

    // 3. Only sync paid orders in processing/completed state
    if (!['processing', 'completed'].includes(order.status)) {
      return res.status(200).json({ skipped: true, reason: `Status is ${order.status}` });
    }

    // 4. Confirm payment method (supports Stripe and PayPal gateways)
    const allowedGateways = ['stripe', 'ppcp-gateway', 'ppcp-credit-card-gateway', 'other'];
    if (!allowedGateways.includes(order.payment_method)) {
      return res.status(200).json({ skipped: true, reason: `Gateway ${order.payment_method}` });
    }

    // 5. Extract Vendor / Company Name from top-level fields first, then metadata
    const metaVendorName = meta.find((m) =>
      ['_dokan_vendor_name', 'store_name', 'seller_name'].includes(m.key)
    )?.value;

    const vendorName =
      order.forced_vendor_name ||
      order.store?.shop_name ||
      order.store?.name ||
      (Array.isArray(order.stores) && order.stores[0]?.shop_name) ||
      (Array.isArray(order.stores) && order.stores[0]?.name) ||
      metaVendorName ||
      'APA Direct';

    // 6. Build Xero Line Items (Account Code 4500 for Store Sales)
    const lineItems = (order.line_items || []).map((item) => ({
      Description: `${item.name} [Vendor: ${vendorName}]`,
      Quantity: item.quantity,
      UnitAmount: parseFloat(item.subtotal) / (item.quantity || 1),
      AccountCode: '4500',
      TaxType: 'NONE',
    }));

    if (parseFloat(order.shipping_total) > 0) {
      lineItems.push({
        Description: `Shipping [Vendor: ${vendorName}]`,
        Quantity: 1,
        UnitAmount: parseFloat(order.shipping_total),
        AccountCode: '4500',
        TaxType: 'NONE',
      });
    }

    // 7. Get refreshed Xero token from Supabase & push invoice
    const tokenRow = await getXeroToken();
    const accessToken = tokenRow.access_token;
    const tenantId = tokenRow.tenant_id || process.env.XERO_TENANT_ID;

    const contactName =
      order.billing?.company?.trim() ||
      `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim() ||
      order.billing?.email;

    const invoicePayload = {
      Invoices: [
        {
          Type: 'ACCREC',
          Contact: {
            Name: contactName,
            EmailAddress: order.billing?.email,
          },
          Date: new Date().toISOString().split('T')[0],
          DueDate: new Date().toISOString().split('T')[0],
          InvoiceNumber: `WC-${order.id}`,
          Reference: `Payment Tx: ${order.transaction_id || order.id} | Vendor: ${vendorName}`,
          Status: 'AUTHORISED',
          LineAmountTypes: 'Exclusive',
          LineItems: lineItems,
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
      console.error('Xero WC Sync Error:', JSON.stringify(xeroData));
      return res.status(500).json({ error: 'Xero API error', details: xeroData });
    }

    return res.status(200).json({
      synced: true,
      orderId: order.id,
      vendor: vendorName,
      xeroInvoiceId: xeroData.Invoices?.[0]?.InvoiceID,
    });
  } catch (err) {
    console.error('WC Webhook Handler Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
