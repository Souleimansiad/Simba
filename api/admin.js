import { supabaseAdmin } from './_lib/supabase.js';
import { resolveCaller, requireRole } from './_lib/auth.js';
import { mobcashDeposit, mobcashPayout } from './_lib/mobcash.js';
import { sendTelegramAdmin } from './_lib/telegram.js';

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
    if (action === 'create-agent') return await handleCreateAgent(req, res);
    return res.status(400).json({ error: 'Action inconnue' });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
}

/* --------------------------- stats --------------------------- */
function rangeToDates(range) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (range === 'today') return { from: startOfDay(now), to: now };
  if (range === 'yesterday') {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    return { from: startOfDay(y), to: startOfDay(now) };
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

  let depotQuery = supabaseAdmin.from('depot_orders').select('id,montant,status,created_at');
  let retraitQuery = supabaseAdmin.from('retrait_orders').select('id,montant,status,created_at');
  if (from) { depotQuery = depotQuery.gte('created_at', from.toISOString()); retraitQuery = retraitQuery.gte('created_at', from.toISOString()); }
  if (to) { depotQuery = depotQuery.lte('created_at', to.toISOString()); retraitQuery = retraitQuery.lte('created_at', to.toISOString()); }

  const [{ data: depots, error: dErr }, { data: retraits, error: rErr }] = await Promise.all([depotQuery, retraitQuery]);
  if (dErr) throw dErr;
  if (rErr) throw rErr;

  const allOrders = [
    ...(depots || []).map((o) => ({ ...o, type: 'depot' })),
    ...(retraits || []).map((o) => ({ ...o, type: 'retrait' })),
  ];

  const volume = allOrders.reduce((sum, o) => sum + Number(o.montant || 0), 0);
  const creditedVolume = allOrders.filter((o) => o.status === 'credite').reduce((sum, o) => sum + Number(o.montant || 0), 0);

  const byHourMap = new Map();
  for (const o of allOrders) {
    const hour = new Date(o.created_at).getHours();
    const key = String(hour).padStart(2, '0') + 'h';
    byHourMap.set(key, (byHourMap.get(key) || 0) + Number(o.montant || 0));
  }
  const byHour = Array.from({ length: 24 }, (_, h) => {
    const key = String(h).padStart(2, '0') + 'h';
    return { hour: key, volume: byHourMap.get(key) || 0 };
  }).filter((h) => h.volume > 0 || range === 'today');

  const profitByDayMap = new Map();
  for (const o of allOrders) {
    if (o.status !== 'credite') continue;
    const day = new Date(o.created_at).toISOString().slice(0, 10);
    profitByDayMap.set(day, (profitByDayMap.get(day) || 0) + Number(o.montant || 0) * PROFIT_MARGIN_RATE);
  }
  const profitByDay = Array.from(profitByDayMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, profit]) => ({ day, profit: Math.round(profit) }));

  const totals = {
    orders: allOrders.length,
    depots: (depots || []).length,
    retraits: (retraits || []).length,
    volume,
  };
  if (caller.role === 'createur') {
    totals.profit = Math.round(creditedVolume * PROFIT_MARGIN_RATE);
  }

  return res.status(200).json({ totals, byHour, profitByDay });
}

/* ----------------------- action sur un ordre ----------------------- */
async function handleActionOrdre(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const caller = await resolveCaller(req);
  const { order_id, type, action } = req.body || {};

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
    await supabaseAdmin.from(table).update({ status: 'rejete' }).eq('id', order_id);
  } else if (action === 'fraude') {
    await supabaseAdmin.from(table).update({ status: 'fraude' }).eq('id', order_id);
  } else if (action === 'confirmer') {
    if (type === 'depot' && order.transfer_id) {
      const { error: dedupeError } = await supabaseAdmin
        .from('ordre_traite')
        .insert({ transfer_id: order.transfer_id, order_id: order.id });
      if (dedupeError && dedupeError.code !== '23505') throw dedupeError;
      if (dedupeError && dedupeError.code === '23505') {
        return res.status(200).json({ ok: true, already_processed: true });
      }
    }
    await supabaseAdmin.from(table).update({ status: 'paiement_recu' }).eq('id', order_id);
    try {
      if (type === 'depot') await mobcashDeposit(order.id_bet1x, order.montant);
      else await mobcashPayout(order.id_bet1x, order.montant);
      await supabaseAdmin.from(table).update({ status: 'credite' }).eq('id', order_id);
    } catch (mcErr) {
      await supabaseAdmin.from('alertes_etat').insert({ type: 'mobcash_credit_failed', order_id, collection: table });
      await sendTelegramAdmin(`❌ Confirmation manuelle #${order_id} : échec MobCash — ${mcErr.message}`);
      return res.status(502).json({ error: 'Confirmation enregistrée mais crédit MobCash a échoué: ' + mcErr.message });
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

  const { order_id } = req.body || {};
  if (!order_id) return res.status(400).json({ error: 'order_id requis' });

  const { data: order, error: fetchErr } = await supabaseAdmin.from('depot_orders').select('*').eq('id', order_id).maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!order) return res.status(404).json({ error: 'Ordre introuvable' });
  if (order.status === 'credite') return res.status(200).json({ ok: true, already_credited: true });

  await mobcashDeposit(order.id_bet1x, order.montant);
  await supabaseAdmin.from('depot_orders').update({ status: 'credite' }).eq('id', order_id);
  await supabaseAdmin.from('audit_logs').insert({
    action: 'admin_retry_deposit', actor: caller.email || caller.id, target: order_id,
  });
  await sendTelegramAdmin(`✅ Dépôt #${order_id} crédité après relance manuelle.`);

  return res.status(200).json({ ok: true });
}

/* ----------------------- test paiement ----------------------- */
async function handleTestPayment(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const caller = await resolveCaller(req);
  requireRole(caller, ['createur', 'admin']);

  const { userId, amount, operation } = req.body || {};
  if (!userId || !amount || !['deposit', 'payout'].includes(operation)) {
    return res.status(400).json({ error: 'Paramètres invalides' });
  }

  const result = operation === 'deposit'
    ? await mobcashDeposit(userId, amount)
    : await mobcashPayout(userId, amount);

  return res.status(200).json({ ok: true, operation, result });
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
