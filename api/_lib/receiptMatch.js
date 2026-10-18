import { supabaseAdmin } from './supabase.js';
import { normalizePhone } from './waafiMatch.js';

// Rapprochement d'une capture de paiement (lue côté navigateur, stockée dans
// depot_orders.receipt_data) avec le SMS Waafi reçu sur le téléphone du compte.
//
// Deux formats de capture, chacun avec ses critères — TOUS doivent concorder
// pour un crédit automatique, sinon l'ordre reste en vérification manuelle :
//  - "app"  (reçu de l'app Waafi, sans Transfer ID) : montant, n° expéditeur,
//           nom expéditeur, n° destinataire, nom destinataire, date  (6/6)
//  - "ussd" (SMS de l'opérateur après un code USSD) : Transfer ID, montant,
//           n° destinataire, nom destinataire, date                  (5/5)
// Le SMS reçu ne contient ni destinataire ni date : le destinataire est
// comparé au compte de la boutique, et la date écrite sur le reçu à l'heure de
// réception du SMS. L'heure à laquelle l'ordre a été soumis n'entre jamais en jeu.

export const SHOP_NUMBER = (process.env.WAAFI_NUMBER || '77626050').trim();
// Nom du compte Waafi qui reçoit les paiements (modifiable sans toucher au code
// via WAAFI_DEST_NAMES, plusieurs noms séparés par des virgules).
export const SHOP_NAMES = (process.env.WAAFI_DEST_NAMES || 'Souleiman Siad Soubaneh')
  .split(',').map((n) => n.trim()).filter(Boolean);
const DATE_TOLERANCE_MS = 10 * 60 * 1000;
const CANDIDATE_WINDOW_MS = 15 * 60 * 1000;

/* ------------------------------ noms ------------------------------ */
function nameTokens(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// Tolère une faute de lecture (OCR) ou de troncature sur les mots de 4+ lettres.
function tokenMatch(a, b) {
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && editDistance(a, b) <= 1;
}

function countTokenMatches(a, b) {
  const tb = nameTokens(b);
  return nameTokens(a).filter((x) => tb.some((y) => tokenMatch(x, y))).length;
}

// Même personne ? Il faut 2 mots concordants (1 si un des noms n'en a qu'un).
export function sameName(a, b) {
  const la = nameTokens(a).length;
  const lb = nameTokens(b).length;
  if (!la || !lb) return false;
  return countTokenMatches(a, b) >= Math.min(2, la, lb);
}

// Destinataire = la boutique : au moins 2 mots d'un des noms attendus.
export function isShopName(name) {
  return SHOP_NAMES.some((shop) => countTokenMatches(name, shop) >= 2);
}

/* --------------------------- critères --------------------------- */
const sameAmount = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.01;

function smsTime(sms) {
  const t = new Date(sms.paid_at || sms.created_at || 0).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Compare la capture de l'ordre au SMS Waafi.
 * Renvoie { applicable, ok, passed, total, criteria: [{ key, label, ok, detail }] }.
 */
export function evaluateReceipt(order, sms) {
  const r = order.receipt_data;
  if (!r || (r.kind !== 'app' && r.kind !== 'ussd')) return { applicable: false, ok: false, passed: 0, total: 0, criteria: [] };

  const criteria = [];
  const add = (key, label, ok, detail) => criteria.push({ key, label, ok: !!ok, detail });

  if (r.kind === 'ussd') {
    add('transfer_id', 'Transfer ID', r.transfer_id && sms.transfer_id && String(r.transfer_id) === String(sms.transfer_id),
      `capture: ${r.transfer_id ?? '?'} / SMS: ${sms.transfer_id ?? '?'}`);
  }
  add('amount', 'Montant', sameAmount(r.amount, order.montant) && sameAmount(order.montant, sms.montant),
    `capture: ${r.amount ?? '?'} / ordre: ${order.montant} / SMS: ${sms.montant ?? '?'} DJF`);
  if (r.kind === 'app') {
    const rs = normalizePhone(r.sender_number);
    add('sender_number', 'N° expéditeur', rs && rs === normalizePhone(sms.sender_number),
      `capture: ${r.sender_number ?? '?'} / SMS: ${sms.sender_number ?? '?'}`);
    add('sender_name', 'Nom expéditeur', r.sender_name && sms.sender_name && sameName(r.sender_name, sms.sender_name),
      `capture: ${r.sender_name ?? '?'} / SMS: ${sms.sender_name ?? '?'}`);
  }
  add('dest_number', 'N° destinataire', normalizePhone(r.dest_number) === normalizePhone(SHOP_NUMBER),
    `capture: ${r.dest_number ?? '?'} / attendu: ${SHOP_NUMBER}`);
  add('dest_name', 'Nom destinataire', r.dest_name && isShopName(r.dest_name),
    `capture: ${r.dest_name ?? '?'} / attendu: ${SHOP_NAMES.join(' ou ')}`);
  const rt = r.date_iso ? new Date(r.date_iso).getTime() : null;
  const st = smsTime(sms);
  add('date', 'Date', rt != null && st != null && Math.abs(rt - st) <= DATE_TOLERANCE_MS,
    `capture: ${r.date_iso ?? '?'} / SMS reçu: ${st != null ? new Date(st).toISOString() : '?'}`);

  const passed = criteria.filter((c) => c.ok).length;
  return { applicable: true, ok: passed === criteria.length, passed, total: criteria.length, criteria };
}

export function failedReasons(evaluation) {
  return evaluation.criteria.filter((c) => !c.ok).map((c) => `${c.label} différent (${c.detail})`);
}

/* ------------------------ recherche en base ------------------------ */
async function consumedTransferIds(ids) {
  if (!ids.length) return new Set();
  const { data } = await supabaseAdmin.from('ordre_traite').select('transfer_id').in('transfer_id', ids);
  return new Set((data || []).map((r) => r.transfer_id));
}

/**
 * Cherche le SMS Waafi correspondant à un ordre avec capture.
 * -> { status: 'matched', sms, evaluation } | { status: 'ambiguous', count }
 *    | { status: 'mismatch', sms, evaluation } | { status: 'none' }
 */
export async function findSmsForOrder(order) {
  const r = order.receipt_data;
  if (!r || (r.kind !== 'app' && r.kind !== 'ussd')) return { status: 'none' };

  let query = supabaseAdmin.from('waafi_notifications').select('*').eq('type', 'sms_received');
  if (r.kind === 'ussd') {
    if (!r.transfer_id) return { status: 'none' };
    query = query.eq('transfer_id', r.transfer_id);
  } else {
    if (!r.date_iso) return { status: 'none' };
    const t = new Date(r.date_iso).getTime();
    query = query.eq('montant', order.montant)
      .gte('created_at', new Date(t - CANDIDATE_WINDOW_MS).toISOString())
      .lte('created_at', new Date(t + CANDIDATE_WINDOW_MS).toISOString());
  }
  const { data: smsList } = await query.order('created_at', { ascending: false }).limit(20);
  if (!smsList || smsList.length === 0) return { status: 'none' };

  const used = await consumedTransferIds(smsList.map((s) => s.transfer_id).filter(Boolean));
  const open = smsList.filter((s) => s.transfer_id && !used.has(s.transfer_id));
  const evaluated = open.map((sms) => ({ sms, evaluation: evaluateReceipt(order, sms) }));
  const good = evaluated.filter((e) => e.evaluation.ok);
  if (good.length === 1) return { status: 'matched', ...good[0] };
  if (good.length > 1) return { status: 'ambiguous', count: good.length };
  // Un SMS existe (même Transfer ID) mais des critères ne concordent pas.
  if (r.kind === 'ussd' && evaluated.length) return { status: 'mismatch', ...evaluated[0] };
  return { status: 'none' };
}

/**
 * Cherche l'ordre en attente (avec capture) correspondant à un SMS qui vient d'arriver.
 * -> { status: 'matched', order } | { status: 'ambiguous', count } | { status: 'none' }
 */
export async function findOrderForSms(sms) {
  // Aucun filtre sur l'heure de soumission de l'ordre : la date qui compte est
  // celle écrite sur le reçu, comparée à l'arrivée du SMS (critère "date" de
  // evaluateReceipt). Un client peut soumettre son ordre bien après avoir payé.
  const { data: orders } = await supabaseAdmin
    .from('depot_orders')
    .select('*')
    .eq('status', 'en_attente')
    .not('receipt_data', 'is', null)
    .eq('montant', sms.montant)
    .order('created_at', { ascending: false })
    .limit(200);
  const good = (orders || []).filter((o) => {
    // Un ordre "ussd" porte déjà son Transfer ID : il ne peut viser qu'un SMS identique.
    if (o.receipt_data && o.receipt_data.kind === 'ussd' && String(o.receipt_data.transfer_id) !== String(sms.transfer_id)) return false;
    return evaluateReceipt(o, sms).ok;
  });
  if (good.length === 1) return { status: 'matched', order: good[0] };
  if (good.length > 1) return { status: 'ambiguous', count: good.length };
  return { status: 'none' };
}

/** Résumé lisible (une ligne) de ce qui a été lu sur la capture, pour Telegram. */
export function describeReceipt(r) {
  if (!r || !r.kind) return '⚠️ non lue — vérifier la capture avant de confirmer';
  const when = r.date_iso
    ? new Date(r.date_iso).toLocaleString('fr-FR', { timeZone: 'Africa/Djibouti', dateStyle: 'short', timeStyle: 'short' })
    : null;
  const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return [
    r.kind === 'ussd' ? 'SMS USSD' : 'reçu app Waafi',
    r.amount != null ? `${r.amount} DJF` : null,
    r.transfer_id ? `Transfer-ID ${r.transfer_id}` : null,
    r.sender_number || r.sender_name ? `de ${esc([r.sender_name, r.sender_number].filter(Boolean).join(' '))}` : null,
    r.dest_number || r.dest_name ? `vers ${esc([r.dest_name, r.dest_number].filter(Boolean).join(' '))}` : null,
    when,
  ].filter(Boolean).join(' · ');
}
