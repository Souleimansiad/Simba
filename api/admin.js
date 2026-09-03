import { supabaseAdmin } from './_lib/supabase.js';
import { resolveCaller, requireRole } from './_lib/auth.js';
import { mobcashDeposit, mobcashPayout, isMobcashConfigured } from './_lib/mobcash.js';
import { sendTelegramAdmin } from './_lib/telegram.js';
import { sendWhatsApp, isGreenApiConfigured } from './_lib/whatsapp.js';

// Route admin consolidée : plusieurs actions peu fréquentes regroupées dans
// un seul fichier pour rester sous la limite de fonctions serverless du plan
// Vercel Hobby (12). Dispatch via ?action=stats|action-ordre|retry-deposit|test-payment|create-agent.

const PROFIT_MARGIN_RATE = Number(process.env.PROFIT_MARGIN_RATE || 0.02);
const TABLE_BY_TYPE = { depot: 'depot_orders', retrait: 'retrait_orders' };
const VALID_AGENT_ROLES = ['admin', 'agent_paiement', 'support', 'observateur'];

export default async function handler(req, res) {
  const action = req.query.action;
  try {
    if (action === 'stats') return await handleStats(req, res);
    if (action === 'action-ordre') return await handleActionOrdre(req, res);
    if (action === 'retry-deposit') return await handleRetryDeposit(req, res);
    if (action === 'test-payment') return await handleTestPayment(req, res);
    if (action === 'test-whatsapp') return await handleTestWhatsapp(req, res);
    if (action === 'create-agent') return await handleCreateAgent(req, res);
    return res.status(400).json({ error: 'Action inconnue' });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
}

/* --------------------------- stats --------------------------- */
// Djibouti (Africa/Djibouti) est en UTC+3 fixe, sans heure d'été : un
// simple décalage constant suffit, pas besoin de lib de fuseaux horaires.
// Sans ça, "aujourd'hui"/"hier" et le bucketing par heure tournaient dans
// le fuseau du runtime Vercel (UTC), décalés de 3h par rapport au calendrier
// réel des utilisateurs.
const DJIBOUTI_OFFSET_MS = 3 * 60 * 60 * 1000;

// Renvoie un Date dont les composants UTC (getUTCFullYear/Month/Date...)
// représentent l'heure murale de Djibouti au moment réel `d`.
function toDjiboutiWallClock(d) {
  return new Date(d.getTime() + DJIBOUTI_OFFSET_MS);
}

// Instant UTC réel correspondant à minuit heure de Djibouti pour la date
// (murale) donnée.
function djiboutiMidnightUTC(wallClock) {
  const utcMidnight = Date.UTC(wallClock.getUTCFullYear(), wallClock.getUTCMonth(), wallClock.getUTCDate());
  return new Date(utcMidnight - DJIBOUTI_OFFSET_MS);
}

function rangeToDates(range) {
  const now = new Date();
  const wallNow = toDjiboutiWallClock(now);
  const startOfToday = djiboutiMidnightUTC(wallNow);
  if (range === 'today') return { from: startOfToday, to: now };
  if (range === 'yesterday') {
    const wallYesterday = new Date(wallNow.getTime() - 24 * 60 * 60 * 1000);
    return { from: djiboutiMidnightUTC(wallYesterday), to: startOfToday };
  }
  if (range === '7d') { const from = new Date(now); from.setDate(from.getDate() - 7); return { from, to: now }; }
  if (range === '30d') { const from = new Date(now); from.setDate(from.getDate() - 30); return { from, to: now }; }
  return { from: null, to: now };
}

async function handleStats(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée' });
  const caller = await resolveCaller(req);
  requireRole(caller, ['createur', 'admin', 'agent_paiement', 'support', 'observateur']);

  const range = req.query.range || 'today';
  const { from, to } = rangeToDates(range);

  // Agrégats calculés en SQL (admin_order_stats, voir supabase/schema.sql) :
  // un ancien reduce() JS sur un select() sans limit() explicite dérivait
  // silencieusement dès qu'une période dépassait le plafond PostgREST
  // (1000 lignes par défaut).
  const { data: rows, error } = await supabaseAdmin.rpc('admin_order_stats', {
    p_from: from ? from.toISOString() : null,
    p_to: to.toISOString(),
  });
  if (error) throw error;
  const stats = rows && rows[0] ? rows[0] : {
    depot_count: 0, retrait_count: 0, total_volume: 0, credited_volume: 0, by_hour: {}, credited_by_day: {},
  };

  const byHourMap = stats.by_hour || {};
  const byHour = Array.from({ length: 24 }, (_, h) => {
    const key = String(h).padStart(2, '0') + 'h';
    return { hour: key, volume: Number(byHourMap[key] || 0) };
  }).filter((h) => h.volume > 0 || range === 'today');

  const creditedByDay = stats.credited_by_day || {};
  const profitByDay = Object.keys(creditedByDay)
    .sort((a, b) => a.localeCompare(b))
    .map((day) => ({ day, profit: Math.round(Number(creditedByDay[day]) * PROFIT_MARGIN_RATE) }));

  const totals = {
    orders: Number(stats.depot_count) + Number(stats.retrait_count),
    depots: Number(stats.depot_count),
    retraits: Number(stats.retrait_count),
    volume: Number(stats.total_volume),
  };
  if (caller.role === 'createur') {
    totals.profit = Math.round(Number(stats.credited_volume) * PROFIT_MARGIN_RATE);
  }

  return res.status(200).json({ totals, byHour, profitByDay });
}

/* ----------------------- action sur un ordre ----------------------- */
async function handleActionOrdre(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const caller = await resolveCaller(req);
  const { order_id, type, action, reason } = req.body || {};

  if (!order_id || !TABLE_BY_TYPE[type] || !['confirmer', 'rejeter', 'fraude'].includes(action)) {
    return res.status(400).json({ error: 'Paramètres invalides' });
  }

  if (action === 'confirmer') requireRole(caller, ['createur', 'admin', 'agent_paiement']);
  else requireRole(caller, ['createur', 'admin']);

  const table = TABLE_BY_TYPE[type];
  const { data: order, error: fetchErr } = await supabaseAdmin.from(table).select('*').eq('id', order_id).maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!order) return res.status(404).json({ error: 'Ordre introuvable' });

  if (action === 'rejeter') {
    await supabaseAdmin.from(table).update({ status: 'rejete', last_error: reason || null }).eq('id', order_id);
    await sendTelegramAdmin(`🚫 Ordre rejeté — #${order_id} (${type})\n${reason ? 'Raison : ' + reason : 'Aucune raison précisée'}`);
    if (order.whatsapp) {
      await sendWhatsApp(
        order.whatsapp,
        `❌ Simba — Votre ordre #${order_id} a été rejeté.\n${reason ? 'Raison : ' + reason : 'Contactez le support pour plus de détails.'}`
      );
    }
  } else if (action === 'fraude') {
    await supabaseAdmin.from(table).update({ status: 'fraude' }).eq('id', order_id);
  } else if (action === 'confirmer') {
    // Verrou anti-double-crédit : un INSERT qui échoue sur conflit AVANT
    // tout autre changement d'état, pas une vérification applicative après
    // coup. Couvrait déjà les dépôts (transfer_id Waafi) ; couvre
    // maintenant aussi les retraits (code_retrait_1x, tout aussi unique
    // par transaction côté 1xBet) — sans ça, un double-clic ou une requête
    // rejouée sur "confirmer" un retrait pouvait déclencher deux payouts.
    const dedupeKey = type === 'depot' ? order.transfer_id : order.code_retrait_1x;
    if (dedupeKey) {
      const { error: dedupeError } = await supabaseAdmin
        .from('ordre_traite')
        .insert({ transfer_id: dedupeKey, order_id: order.id });
      if (dedupeError && dedupeError.code !== '23505') throw dedupeError;
      if (dedupeError && dedupeError.code === '23505') {
        return res.status(200).json({ ok: true, already_processed: true });
      }
    }
    await supabaseAdmin.from(table).update({ status: 'paiement_recu' }).eq('id', order_id);

    if (!isMobcashConfigured()) {
      // Mode manuel (MacroDroid + Waafi) : l'agent a déjà crédité/payé le
      // joueur à la main avant de cliquer "Confirmer" — on clôture l'ordre
      // directement, sans appel MobCash.
      await supabaseAdmin.from(table).update({ status: 'credite' }).eq('id', order_id);
    } else {
      try {
        if (type === 'depot') await mobcashDeposit(order.id_bet1x, order.montant);
        else await mobcashPayout(order.id_bet1x, order.code_retrait_1x, order.montant);
        await supabaseAdmin.from(table).update({ status: 'credite' }).eq('id', order_id);
      } catch (mcErr) {
        // Sans ceci, l'ordre reste "paiement_recu" avec mobcash_status
        // toujours null : le client voit un spinner infini sur la page de
        // suivi, sans aucune indication d'échec (visible seulement dans
        // l'alerte Telegram admin).
        await supabaseAdmin.from(table).update({ mobcash_status: 'echec_permanent', last_error: mcErr.message }).eq('id', order_id);
        await supabaseAdmin.from('alertes_etat').insert({ type: 'mobcash_credit_failed', order_id, collection: table });
        await sendTelegramAdmin(`❌ Confirmation manuelle #${order_id} : échec MobCash — ${mcErr.message}`);
        if (order.whatsapp) {
          await sendWhatsApp(
            order.whatsapp,
            `❌ Simba — Le crédit de votre ordre #${order_id} n'a pas pu être confirmé automatiquement. Notre équipe va vérifier et intervenir manuellement.`
          );
        }
        return res.status(502).json({ error: 'Confirmation enregistrée mais crédit MobCash a échoué: ' + mcErr.message });
      }
    }
  }

  await supabaseAdmin.from('audit_logs').insert({
    action: 'admin_action_ordre:' + action,
    actor: caller.email || caller.id,
    target: order_id,
    meta: { type, action },
  });

  return res.status(200).json({ ok: true });
}

/* ----------------------- relance dépôt ----------------------- */
async function handleRetryDeposit(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const caller = await resolveCaller(req);
  requireRole(caller, ['createur', 'admin']);

  const { order_id, new_id_bet1x } = req.body || {};
  if (!order_id) return res.status(400).json({ error: 'order_id requis' });

  const { data: order, error: fetchErr } = await supabaseAdmin.from('depot_orders').select('*').eq('id', order_id).maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!order) return res.status(404).json({ error: 'Ordre introuvable' });
  if (order.status === 'credite') return res.status(200).json({ ok: true, already_credited: true });
  if (!isMobcashConfigured()) return res.status(400).json({ error: 'MobCash non configuré — mode manuel, rien à relancer.' });

  // Après un échec MobCash "compte 1xBet invalide", l'admin peut corriger
  // l'ID avant de relancer plutôt que de rejeter tout l'ordre.
  const idBet1x = new_id_bet1x && new_id_bet1x.trim() ? new_id_bet1x.trim() : order.id_bet1x;

  try {
    await mobcashDeposit(idBet1x, order.montant);
  } catch (mcErr) {
    await supabaseAdmin.from('depot_orders').update({ id_bet1x: idBet1x, last_error: mcErr.message }).eq('id', order_id);
    await sendTelegramAdmin(`❌ Relance manuelle #${order_id} toujours en échec (ID 1xBet ${idBet1x}) : ${mcErr.message}`);
    if (order.whatsapp) {
      await sendWhatsApp(
        order.whatsapp,
        `❌ Simba — La relance de votre dépôt #${order_id} a de nouveau échoué. Notre équipe reste sur le dossier.`
      );
    }
    return res.status(502).json({ error: 'Relance échouée : ' + mcErr.message });
  }

  await supabaseAdmin.from('depot_orders').update({
    id_bet1x: idBet1x, status: 'credite', mobcash_status: null, last_error: null,
  }).eq('id', order_id);
  await supabaseAdmin.from('audit_logs').insert({
    action: 'admin_retry_deposit', actor: caller.email || caller.id, target: order_id, meta: { new_id_bet1x: idBet1x },
  });
  await sendTelegramAdmin(`✅ Dépôt #${order_id} crédité après relance manuelle${new_id_bet1x ? ` (nouvel ID 1xBet : ${idBet1x})` : ''}.`);
  await sendWhatsApp(
    order.whatsapp,
    `✅ Simba — Dépôt #${order_id} crédité avec succès ! ${order.montant} DJF envoyés sur votre compte 1xBet ${idBet1x}.`
  );

  return res.status(200).json({ ok: true });
}

/* ----------------------- test paiement ----------------------- */
async function handleTestPayment(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const caller = await resolveCaller(req);
  requireRole(caller, ['createur', 'admin']);

  const { userId, amount, operation, withdrawalCode } = req.body || {};
  if (!userId || !amount || !['deposit', 'payout'].includes(operation)) {
    return res.status(400).json({ error: 'Paramètres invalides' });
  }
  if (operation === 'payout' && !withdrawalCode) {
    return res.status(400).json({ error: 'withdrawalCode requis pour un test payout' });
  }
  if (!isMobcashConfigured()) {
    return res.status(400).json({ error: 'MobCash non configuré (MOBCASH_CASHBOX_CODE / MOBCASH_LOGIN / MOBCASH_PASSWORD manquants sur Vercel).' });
  }

  const result = operation === 'deposit'
    ? await mobcashDeposit(userId, amount)
    : await mobcashPayout(userId, withdrawalCode, amount);

  return res.status(200).json({ ok: true, operation, result });
}

/* ----------------------- test WhatsApp (Green API) ----------------------- */
async function handleTestWhatsapp(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const caller = await resolveCaller(req);
  requireRole(caller, ['createur', 'admin']);

  const { number, message } = req.body || {};
  if (!number) return res.status(400).json({ error: 'number requis' });
  if (!isGreenApiConfigured()) {
    return res.status(400).json({ error: 'Green API non configuré (GREENAPI_API_URL / GREENAPI_ID_INSTANCE / GREENAPI_API_TOKEN manquants sur Vercel).' });
  }

  const result = await sendWhatsApp(number, message || '🦁 Simba — message de test WhatsApp (Green API).');
  return res.status(result.ok ? 200 : 502).json({ ok: result.ok, result });
}

/* ----------------------- création agent ----------------------- */
async function handleCreateAgent(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const caller = await resolveCaller(req);
  requireRole(caller, ['createur', 'admin']);

  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || !VALID_AGENT_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Paramètres invalides' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (min. 8 caractères)' });

  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (createErr) throw createErr;

  const { error: insertErr } = await supabaseAdmin.from('agents').insert({
    id: created.user.id, name, email, role, created_by: caller.email || caller.id,
  });
  if (insertErr) {
    await supabaseAdmin.auth.admin.deleteUser(created.user.id);
    throw insertErr;
  }

  await supabaseAdmin.from('audit_logs').insert({
    action: 'admin_create_agent', actor: caller.email || caller.id, target: email, meta: { role },
  });

  return res.status(200).json({ ok: true, id: created.user.id });
}
