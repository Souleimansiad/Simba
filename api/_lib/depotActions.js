import { supabaseAdmin } from './supabase.js';
import { mobcashDeposit, isMobcashConfigured, describeMobcashError } from './mobcash.js';
import { sendWhatsApp } from './whatsapp.js';
import { findSmsForOrder } from './receiptMatch.js';

// Actions manuelles sur un dépôt, communes à la commande Telegram
// (confirme / relance) et au panneau admin. Chaque fonction renvoie
// { ok, code, message, info? } : message est du texte brut (à échapper avant
// envoi en HTML).
//
// Deux cas distincts, volontairement séparés :
//  - confirme : le paiement Waafi n'a pas été détecté automatiquement (macros
//    en panne, erreur réseau…) mais le client a bien payé -> l'agent confirme
//    à la main, le compte 1xBet est crédité par MobCash.
//  - relance : le paiement est déjà confirmé mais le crédit MobCash a échoué
//    (solde, ID 1xBet, devise…) -> on réessaie le crédit, éventuellement avec
//    un ID 1xBet corrigé.

const IN_FLIGHT_MS = 2 * 60 * 1000;
const BET_ID_RE = /^[A-Za-z0-9]{4,20}$/;

async function audit(action, actor, target, meta) {
  try { await supabaseAdmin.from('audit_logs').insert({ action, actor, target, meta }); } catch { /* journal non bloquant */ }
}

/** Prévient le client d'un échec de crédit : seulement quand il peut agir (ID 1xBet) ou à la 1re tentative. */
export async function notifyCreditFailure(order, info, idBet) {
  if (!order.whatsapp) return;
  if (info.kind === 'invalid_id') {
    await sendWhatsApp(order.whatsapp,
      `❌ Simba — L'ID 1xBet indiqué pour votre dépôt #${order.id} (${idBet}) est incorrect ou introuvable. ` +
      `Vérifiez votre ID 1xBet et contactez le support pour corriger votre dépôt.`);
  } else if ((order.mobcash_attempts || 0) === 0) {
    await sendWhatsApp(order.whatsapp,
      `❌ Simba — Le crédit de votre dépôt #${order.id} n'a pas pu être confirmé automatiquement. ` +
      `Notre équipe va vérifier et intervenir manuellement.`);
  }
}

/**
 * Crédite le compte 1xBet via MobCash (ou clôture l'ordre si MobCash n'est pas
 * configuré : mode manuel). `attempts` = valeur à enregistrer si ça échoue.
 * Le client est prévenu du succès par le webhook depot-updated (changement de statut).
 */
export async function creditViaMobcash(order, { actor, newBetId = null, attempts = (order.mobcash_attempts || 0) + 1, source = 'depot' }) {
  const idBet = newBetId || order.id_bet1x;
  const betPatch = newBetId ? { id_bet1x: newBetId } : {};

  if (!isMobcashConfigured()) {
    await supabaseAdmin.from('depot_orders').update({ status: 'credite', mobcash_status: null, last_error: null, ...betPatch }).eq('id', order.id);
    await audit(`${source}:credite_manuel`, actor, order.id, { id_bet1x: idBet });
    return { ok: true, code: 'closed_manual', message: `#${order.id} marqué crédité. MobCash n'est pas configuré : le crédit du compte 1xBet ${idBet} reste à faire à la main.` };
  }

  try {
    await mobcashDeposit(idBet, order.montant);
  } catch (err) {
    const info = describeMobcashError(err.message);
    await supabaseAdmin.from('depot_orders').update({ ...betPatch, mobcash_status: 'echec_permanent', mobcash_attempts: attempts, last_error: err.message }).eq('id', order.id);
    await supabaseAdmin.from('alertes_etat').insert({ type: 'mobcash_credit_failed', order_id: order.id, collection: 'depot_orders' });
    await audit(`${source}:echec_mobcash`, actor, order.id, { id_bet1x: idBet, erreur: err.message.slice(0, 200), kind: info.kind });
    await notifyCreditFailure(order, info, idBet);
    return { ok: false, code: 'mobcash_failed', info, message: `Échec du crédit MobCash pour #${order.id} : ${info.label}.\n${info.hint.replace('#ORDRE', '#' + order.id)}\n(détail : ${err.message.slice(0, 160)})` };
  }

  await supabaseAdmin.from('depot_orders').update({ ...betPatch, status: 'credite', mobcash_status: null, last_error: null }).eq('id', order.id);
  await audit(`${source}:credite`, actor, order.id, { id_bet1x: idBet, montant: order.montant });
  return { ok: true, code: 'credited', message: `#${order.id} crédité : ${order.montant} DJF envoyés sur le compte 1xBet ${idBet}.` };
}

/**
 * confirme #ORDRE : le client a payé mais le paiement n'a pas été détecté.
 * Réservé aux ordres « en attente ».
 */
export async function confirmDepotManually(order, { actor, source = 'telegram' }) {
  if (order.status === 'credite') return { ok: false, code: 'already_credited', message: `#${order.id} est déjà crédité.` };
  if (order.status === 'paiement_recu') {
    return { ok: false, code: 'payment_already_confirmed', message: `Le paiement de #${order.id} est déjà confirmé ; seul le crédit MobCash a échoué. Utilisez : relance #${order.id}` };
  }
  if (order.status !== 'en_attente') {
    return { ok: false, code: 'bad_status', message: `#${order.id} est « ${order.status} » : confirmation impossible par Telegram (utilisez le panneau admin).` };
  }

  // Clé anti-double-crédit. Si un SMS Waafi correspond à la capture, on consomme
  // SON Transfer ID : il ne pourra plus servir à un autre ordre. Sinon, l'ordre lui-même.
  let transferId = order.transfer_id || null;
  let sms = null;
  if (!transferId && order.receipt_data && order.receipt_data.kind) {
    const found = await findSmsForOrder(order);
    if (found.status === 'matched') { sms = found.sms; transferId = sms.transfer_id; }
  }
  const key = transferId || `order:${order.id}`;
  const { error: dedupeErr } = await supabaseAdmin.from('ordre_traite').insert({ transfer_id: key, order_id: order.id });
  if (dedupeErr) {
    if (dedupeErr.code !== '23505') throw dedupeErr;
    const { data: existing } = await supabaseAdmin.from('ordre_traite').select('order_id').eq('transfer_id', key).maybeSingle();
    if (existing && existing.order_id === order.id) return { ok: false, code: 'already_processed', message: `#${order.id} est déjà en cours de traitement.` };
    return { ok: false, code: 'transfer_used', message: `Le paiement ${key} a déjà servi pour l'ordre #${existing ? existing.order_id : '?'} : impossible de le créditer deux fois.` };
  }

  // Passage atomique en_attente -> paiement_recu : si un autre traitement (SMS
  // reçu entre-temps) a déjà changé l'ordre, on s'arrête et on libère la clé.
  const { data: moved } = await supabaseAdmin.from('depot_orders').update({
    status: 'paiement_recu',
    ...(transferId && !order.transfer_id ? { transfer_id: transferId } : {}),
    ...(sms && sms.sender_number && !order.numero_waafi_expediteur ? { numero_waafi_expediteur: sms.sender_number } : {}),
  }).eq('id', order.id).eq('status', 'en_attente').select('id');
  if (!moved || moved.length === 0) {
    await supabaseAdmin.from('ordre_traite').delete().eq('transfer_id', key).eq('order_id', order.id);
    return { ok: false, code: 'busy', message: `#${order.id} vient d'être modifié par un autre traitement (SMS reçu ?). Vérifiez son statut avec /ordres.` };
  }

  await audit(`${source}:confirme`, actor, order.id, { cle: key });
  return creditViaMobcash(order, { actor, attempts: (order.mobcash_attempts || 0) + 1, source: `${source}:confirme` });
}

/**
 * relance #ORDRE [nouvel ID 1xBet] [oui] : réessaie le crédit d'un ordre dont le
 * paiement est confirmé mais le crédit MobCash a échoué. `force` = l'agent a
 * vérifié l'historique MobCash quand l'échec précédent est ambigu.
 */
export async function retryDepotCredit(order, { actor, newBetId = null, force = false, source = 'telegram' }) {
  if (order.status === 'credite') return { ok: false, code: 'already_credited', message: `#${order.id} est déjà crédité.` };
  if (order.status !== 'paiement_recu') {
    return { ok: false, code: 'bad_status', message: `#${order.id} est « ${order.status} » : la relance ne s'applique qu'à un paiement déjà confirmé dont le crédit a échoué.${order.status === 'en_attente' ? ` Si le client a bien payé, utilisez : confirme #${order.id}` : ''}` };
  }
  if (!isMobcashConfigured()) return { ok: false, code: 'no_mobcash', message: 'MobCash non configuré : rien à relancer (mode manuel).' };
  if (newBetId && !BET_ID_RE.test(newBetId)) return { ok: false, code: 'bad_id', message: `ID 1xBet « ${newBetId} » invalide (lettres et chiffres, 4 à 20 caractères).` };

  const sameId = newBetId ? ` ${newBetId}` : '';
  if (order.mobcash_status !== 'echec_permanent') {
    // Pas d'échec enregistré : soit un crédit automatique est en train de se faire
    // (ne surtout pas le doubler), soit il a été interrompu.
    const age = Date.now() - new Date(order.updated_at || 0).getTime();
    if (age < IN_FLIGHT_MS) return { ok: false, code: 'in_flight', message: `Un crédit est peut-être en cours pour #${order.id}. Réessayez dans une minute.` };
    if (!force) {
      return { ok: false, code: 'needs_confirmation', message: `Aucun échec MobCash enregistré pour #${order.id} : le crédit a pu être interrompu ou déjà exécuté. Vérifiez l'historique MobCash du caissier, puis confirmez : relance #${order.id}${sameId} oui` };
    }
  } else {
    const info = describeMobcashError(order.last_error);
    if (!info.safeToRetry && !force) {
      return { ok: false, code: 'needs_confirmation', info, message: `${info.label}. ${info.hint}.\nSi vous avez vérifié, confirmez : relance #${order.id}${sameId} oui` };
    }
  }

  // Verrou : une seule relance à la fois (le compteur d'essais ne passe qu'une fois de n à n+1).
  const attempts = (order.mobcash_attempts || 0) + 1;
  const { data: locked } = await supabaseAdmin.from('depot_orders')
    .update({ mobcash_attempts: attempts })
    .eq('id', order.id).eq('status', 'paiement_recu').eq('mobcash_attempts', order.mobcash_attempts || 0)
    .select('id');
  if (!locked || locked.length === 0) return { ok: false, code: 'busy', message: `Une relance est déjà en cours pour #${order.id}. Réessayez dans un instant.` };

  await audit(`${source}:relance`, actor, order.id, { nouvel_id_bet1x: newBetId || null, force });
  return creditViaMobcash(order, { actor, newBetId, attempts, source: `${source}:relance` });
}
