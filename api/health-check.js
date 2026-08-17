import { supabaseAdmin } from './_lib/supabase.js';

// Sonde de santé publique (sans données sensibles) : DB joignable + état des
// circuit breakers. Utilisable par un monitoring externe (UptimeRobot, etc.).
export default async function handler(req, res) {
  const result = { ok: true, db: false, circuit_breakers: [], timestamp: new Date().toISOString() };

  try {
    const { error } = await supabaseAdmin.from('circuit_breakers').select('service,state,fail_count').limit(20);
    if (error) throw error;
    result.db = true;
    const { data } = await supabaseAdmin.from('circuit_breakers').select('service,state,fail_count');
    result.circuit_breakers = data || [];
  } catch (err) {
    result.ok = false;
    result.error = err.message;
  }

  return res.status(result.ok ? 200 : 503).json(result);
}
