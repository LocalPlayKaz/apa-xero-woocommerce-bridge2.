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

  return data;
}
