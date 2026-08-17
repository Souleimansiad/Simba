import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[simba] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants dans les variables d\'environnement Vercel.');
}

// Client service_role partagé par toutes les routes /api. Ne JAMAIS exposer
// cette clé côté client — elle contourne intégralement les policies RLS.
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
