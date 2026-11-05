import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
    );

    // Fetch active Xero token from Supabase
    const { data: tokenData, error: tokenError } = await supabase
      .from('xero_tokens')
      .select('*')
      .limit(1)
      .single();

    if (tokenError || !tokenData) {
      throw new Error('Failed to fetch Xero token from Supabase.');
    }

    const order = req.body;
    console.log('Processing WooCommerce order ID:', order.id);

    // TODO: Map WooCommerce parent/child line items and send to Xero API here

    return res.status(200).json({ success: true, message: 'Order processed successfully' });
  } catch (err) {
    console.error('Bridge error:', err.message);
    return res.status(500).json({ error: `Bridge error: ${err.message}` });
  }
}
