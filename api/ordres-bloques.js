import { supabaseAdmin } from './_lib/supabase.js';
import { sendTelegramAdmin } from './_lib/telegram.js';

const STALE_MINUTES = 30;

function isAuthorizedCron(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // pas de secret configuré -> pas de vérification (déconseillé en prod)
  return req.headers['authorization'] === `Bearer ${cronSecret}`;
}

// Déclenché par Vercel Cron (vercel.json) toutes les 10 minutes.
// Alerte Telegram pour tout ordre en attente depuis plus de 30 minutes.
export default async function handler(req, res) {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Non autorisé' });

  try {
    const threshold = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();

    const [{ data: depots }, { data: retraits }] = await Promise.all([
      supabaseAdmin.from('depot_orders').select('id,montant,status,created_at').in('status', ['en_attente', 'paiement_recu']).lt('created_at', threshold),
      supabaseAdmin.from('retrait_orders').select('id,montant,status,created_at').in('status', ['en_attente', 'paiement_recu']).lt('created_at', threshold),
    ]);

    const stale = [
      ...(depots || []).map((o) => ({ ...o, type: 'depot' })),
      ...(retraits || []).map((o) => ({ ...o, type: 'retrait' })),
    ];
    if (stale.length === 0) return res.status(200).json({ ok: true, stale: 0 });

    const { data: alreadyAlerted } = await supabaseAdmin
      .from('alertes_etat')
      .select('order_id')
      .eq('type', 'ordre_bloque')
      .in('order_id', stale.map((o) => o.id));
    const alertedSet = new Set((alreadyAlerted || []).map((a) => a.order_id));
    const toAlert = stale.filter((o) => !alertedSet.has(o.id));
    if (toAlert.length === 0) return res.status(200).json({ ok: true, stale: stale.length, new_alerts: 0 });

    await supabaseAdmin.from('alertes_etat').insert(
      toAlert.map((o) => ({ type: 'ordre_bloque', order_id: o.id, collection: o.type === 'depot' ? 'depot_orders' : 'retrait_orders' }))
    );

    const lines = toAlert.map((o) => `#${o.id} (${o.type}) — ${o.montant} DJF — bloqué depuis ${Math.round((Date.now() - new Date(o.created_at).getTime()) / 60000)} min`);
    await sendTelegramAdmin(`⏱️ <b>${toAlert.length} ordre(s) bloqué(s) &gt; ${STALE_MINUTES} min</b>\n` + lines.join('\n'));

    return res.status(200).json({ ok: true, stale: stale.length, new_alerts: toAlert.length });
  } catch (err) {
    console.error('[ordres-bloques]', err);
    return res.status(500).json({ error: err.message });
  }
}
