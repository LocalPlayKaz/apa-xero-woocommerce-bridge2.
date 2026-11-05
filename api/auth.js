import { createClient } from '@supabase/supabase-js';

export async function getXeroToken() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Query your token table (verify your table name matches 'xero_tokens')
  const { data, error } = await supabase
    .from('xero_tokens')
    .select('*')
    .limit(1)
    .single();

  if (error) {
    throw new Error(`Supabase query error: ${error.message} (Hint: Check if table 'xero_tokens' exists)`);
  }

  if (!data) {
    throw new Error('Supabase returned no rows in xero_tokens table.');
  }

  return data;
}
