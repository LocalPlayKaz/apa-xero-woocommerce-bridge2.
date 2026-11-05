import { createClient } from '@supabase/supabase-js';

export async function getXeroToken() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await supabase
    .from('xero_tokens')
    .select('*')
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error(`Failed to fetch Xero token from Supabase: ${error?.message || 'No token found'}`);
  }

  return data;
}
