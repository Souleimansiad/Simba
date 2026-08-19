import { supabaseAdmin } from './_lib/supabase.js';
import { sendTelegramAdmin } from './_lib/telegram.js';
import { isMobcashConfigured } from './_lib/mobcash.js';
import { relaunchStaleCredit } from './_lib/depotCredit.js';

const STALE_MINUTES = 30;
const RELAUNCH_HOURS = 24;

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
    const staleAlert = await alertStaleOrders();
    const relaunched = await relaunchStaleDepots();
    return res.status(200).json({ ok: true, ...staleAlert, relaunched });
  } catch (err) {
    console.error('[ordres-bloques]', err);
    return res.status(500).json({ error: err.message });
  }
}

async function alertStaleOrders() {
  const threshold = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();

  const [{ data: depots }, { data: retraits }] = await Promise.all([
    supabaseAdmin.from('depot_orders').select('id,montant,status,created_at').in('status', ['en_attente', 'paiement_recu']).lt('created_at', threshold),
    supabaseAdmin.from('retrait_orders').select('id,montant,status,created_at').in('status', ['en_attente', 'paiement_recu']).lt('created_at', threshold),
  ]);

  const stale = [
    ...(depots || []).map((o) => ({ ...o, type: 'depot' })),
    ...(retraits || []).map((o) => ({ ...o, type: 'retrait' })),
  ];
  if (stale.length === 0) return { stale: 0, new_alerts: 0 };

  const { data: alreadyAlerted } = await supabaseAdmin
    .from('alertes_etat')
    .select('order_id')
    .eq('type', 'ordre_bloque')
    .in('order_id', stale.map((o) => o.id));
  const alertedSet = new Set((alreadyAlerted || []).map((a) => a.order_id));
  const toAlert = stale.filter((o) => !alertedSet.has(o.id));
  if (toAlert.length === 0) return { stale: stale.length, new_alerts: 0 };

  await supabaseAdmin.from('alertes_etat').insert(
    toAlert.map((o) => ({ type: 'ordre_bloque', order_id: o.id, collection: o.type === 'depot' ? 'depot_orders' : 'retrait_orders' }))
  );

  const lines = toAlert.map((o) => `#${o.id} (${o.type}) — ${o.montant} DJF — bloqué depuis ${Math.round((Date.now() - new Date(o.created_at).getTime()) / 60000)} min`);
  await sendTelegramAdmin(`⏱️ <b>${toAlert.length} ordre(s) bloqué(s) &gt; ${STALE_MINUTES} min</b>\n` + lines.join('\n'));

  return { stale: stale.length, new_alerts: toAlert.length };
}

// Relance automatique du crédit MobCash pour les dépôts "paiement_recu" +
// echec_permanent bloqués depuis plus de 24h — évite qu'un ordre reste
// bloqué indéfiniment faute d'intervention manuelle.
async function relaunchStaleDepots() {
  if (!isMobcashConfigured()) return 0;

  const threshold = new Date(Date.now() - RELAUNCH_HOURS * 60 * 60 * 1000).toISOString();
  const { data: stuck } = await supabaseAdmin
    .from('depot_orders')
    .select('*')
    .eq('status', 'paiement_recu')
    .eq('mobcash_status', 'echec_permanent')
    .lt('updated_at', threshold);

  if (!stuck || stuck.length === 0) return 0;

  for (const order of stuck) {
    await sendTelegramAdmin(`🔁 Relance automatique (>${RELAUNCH_HOURS}h) — Dépôt #${order.id}`);
    await relaunchStaleCredit(order);
  }
  return stuck.length;
}
