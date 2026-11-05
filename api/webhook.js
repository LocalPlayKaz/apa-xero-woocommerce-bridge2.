import { processWooOrderToXero } from './woocommerce-xero.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const order = req.body;
    console.log(`Received WooCommerce Webhook for Order ID: ${order.id}`);

    const result = await processWooOrderToXero(order);

    return res.status(200).json({ success: true, xeroResponse: result });
  } catch (err) {
    console.error('Bridge error:', err.message);
    return res.status(500).json({ error: `Bridge error: ${err.message}` });
  }
}
