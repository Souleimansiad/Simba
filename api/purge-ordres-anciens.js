import { supabaseAdmin } from './_lib/supabase.js';

const RETENTION_DAYS = 90;

function isAuthorizedCron(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  return req.headers['authorization'] === `Bearer ${cronSecret}`;
}

// Déclenché quotidiennement par Vercel Cron. Supprime les ordres terminaux
// (crédité / rejeté / fraude) plus vieux que RETENTION_DAYS. Les ordres en
// attente ne sont jamais purgés (ordres-bloques.js s'en charge en amont).
export default async function handler(req, res) {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Non autorisé' });

  try {
    const threshold = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const terminalStatuses = ['credite', 'rejete', 'fraude'];

    const { data: deletedDepots, error: dErr } = await supabaseAdmin
      .from('depot_orders').delete().in('status', terminalStatuses).lt('created_at', threshold).select('id');
    if (dErr) throw dErr;
    const { data: deletedRetraits, error: rErr } = await supabaseAdmin
      .from('retrait_orders').delete().in('status', terminalStatuses).lt('created_at', threshold).select('id');
    if (rErr) throw rErr;

    const total = (deletedDepots || []).length + (deletedRetraits || []).length;
    await supabaseAdmin.from('audit_logs').insert({
      action: 'purge_ordres_anciens', actor: 'cron', meta: { deleted: total, retention_days: RETENTION_DAYS },
    });

    return res.status(200).json({ ok: true, deleted: total });
  } catch (err) {
    console.error('[purge-ordres-anciens]', err);
    return res.status(500).json({ error: err.message });
  }
}
