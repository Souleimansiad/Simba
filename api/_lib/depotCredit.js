import { supabaseAdmin } from './supabase.js';
import { mobcashDeposit, isMobcashConfigured } from './mobcash.js';
import { sendTelegramAdmin } from './telegram.js';
import { sendWhatsApp } from './whatsapp.js';

// Un échec de payerNickname (vérification de compte) signifie que l'ID
// 1xBet lui-même est invalide.
function isPermanentMobcashError(err) {
  return /payerNickname/i.test(err.message);
}

// UNE SEULE tentative, jamais de retry automatique : MobCash peut répondre
// une erreur tout en ayant déjà réellement exécuté le dépôt côté argent
// (constaté en test — 2 dépôts de 50 DJF réels dans l'historique MobCash
// malgré 3 réponses d'erreur consécutives à nos appels). Retenter à
// l'aveugle risque de créditer plusieurs fois le même dépôt. Tout échec
// exige donc une vérification manuelle de l'historique MobCash avant toute
// relance (bouton "Relancer" du panneau admin).
async function attemptMobcashDeposit(order) {
  try {
    await mobcashDeposit(order.id_bet1x, order.montant);
    return { success: true, attempts: 1 };
  } catch (err) {
    const permanent = isPermanentMobcashError(err);
    await supabaseAdmin.from('depot_orders').update({
      mobcash_attempts: (order.mobcash_attempts || 0) + 1,
      mobcash_status: 'echec_permanent',
      last_error: err.message,
    }).eq('id', order.id);
    return { success: false, attempts: 1, error: err, permanent, ambiguous: !!err.ambiguous };
  }
}

async function finalizeCreditResult(order, result) {
  if (result.success) {
    await supabaseAdmin.from('depot_orders').update({ status: 'credite', mobcash_status: null }).eq('id', order.id);
    await sendTelegramAdmin(`✅ Dépôt — Crédité avec succès\n#${order.id} — ${order.montant} DJF`);
    await sendWhatsApp(
      order.whatsapp,
      `✅ Simba — Dépôt #${order.id} crédité avec succès !\n` +
      `${order.montant} DJF envoyés sur votre compte 1xBet ${order.id_bet1x}. Merci d'utiliser Simba 🦁`
    );
    return { credited: true };
  }

  // Échec : l'ordre reste "paiement_recu" (le paiement Waafi est bien
  // confirmé) avec mobcash_status="echec_permanent" — c'est le crédit
  // 1xBet qui nécessite une intervention manuelle, pas le paiement lui-même.
  // AUCUNE relance automatique ici : MobCash peut répondre une erreur tout
  // en ayant déjà exécuté le dépôt réel (constaté en test) — avant de
  // relancer, l'admin doit vérifier l'historique MobCash du caissier pour
  // confirmer qu'aucun dépôt n'a déjà été effectué.
  await supabaseAdmin.from('alertes_etat').insert({ type: 'mobcash_credit_failed', order_id: order.id, collection: 'depot_orders' });
  const reasonLabel = result.permanent ? 'Compte 1xBet invalide' : result.ambiguous ? 'réponse ambiguë' : 'échec MobCash';
  await sendTelegramAdmin(
    (result.ambiguous ? `❓ Résultat incertain — Dépôt #${order.id}\n` : `❌ Échec — Dépôt #${order.id}\n`) +
    `Paiement Waafi confirmé, crédit MobCash ${result.ambiguous ? 'non confirmé' : 'échoué'} (${reasonLabel}) : ${result.error.message}\n` +
    (result.ambiguous
      ? `⚠️ MobCash n'a confirmé NI le succès NI l'échec — vérifier l'historique MobCash du caissier pour savoir si le dépôt a déjà été exécuté avant de relancer.`
      : `⚠️ Vérifier l'historique MobCash du caissier AVANT de relancer (le dépôt a pu être exécuté malgré cette erreur).`)
  );
  await sendWhatsApp(
    order.whatsapp,
    result.permanent
      ? `❌ Simba — Compte 1xBet invalide pour votre dépôt #${order.id}. Contactez le support pour résoudre ça.`
      : `❌ Simba — Le crédit de votre dépôt #${order.id} n'a pas pu être confirmé automatiquement. Notre équipe va vérifier et intervenir manuellement.`
  );
  return { credited: false, error: result.error.message, permanent: result.permanent };
}

// Marque l'ordre "paiement_recu" puis tente le crédit (automatique si
// MobCash est configuré, sinon attente de confirmation manuelle dans le
// panneau admin). Protégé par dédoublonnage atomique sur ordre_traite
// (transfer_id = clé primaire) : appelée depuis sms-webhook.js et
// hooks/depot-created.js, qui peuvent recevoir le même événement deux fois.
export async function creditDepot(order, transferId) {
  const { error: dedupeError } = await supabaseAdmin
    .from('ordre_traite')
    .insert({ transfer_id: transferId, order_id: order.id });

  if (dedupeError) {
    if (dedupeError.code === '23505') {
      // Ce transfer_id est déjà présent dans ordre_traite. Deux cas très
      // différents se cachent derrière le même code d'erreur : (a) c'est CE
      // même ordre qui repasse ici (webhook rejoué) — rien à faire ; (b) un
      // AUTRE ordre a déjà consommé cette preuve de paiement — celui-ci ne
      // peut pas être crédité une deuxième fois et doit le dire clairement
      // au lieu de rester bloqué en silence sur "en_attente" pour toujours.
      const { data: existing } = await supabaseAdmin
        .from('ordre_traite')
        .select('order_id')
        .eq('transfer_id', transferId)
        .maybeSingle();
      if (existing && existing.order_id === order.id) return { already_processed: true };
      return flagDuplicateTransfer(order, existing ? existing.order_id : null);
    }
    throw dedupeError;
  }

  await supabaseAdmin.from('depot_orders').update({ status: 'paiement_recu' }).eq('id', order.id);

  const mobcashOn = isMobcashConfigured();
  await sendTelegramAdmin(
    `💳 Ordre paiement confirmé — Paiement Waafi validé\n\n` +
    `Ordre: #${order.id} | ${order.montant} DJF\n` +
    `Transfer-ID: ${transferId} | N°: ${order.numero_waafi_expediteur}\n` +
    `WhatsApp: ${order.whatsapp || '—'}\n\n` +
    (mobcashOn ? `⏳ MobCash va créditer le compte 1xBet...` : `⏳ Créditez manuellement puis confirmez sur le panneau admin...`)
  );
  await sendWhatsApp(
    order.whatsapp,
    `💳 Simba — Paiement Waafi confirmé pour votre dépôt #${order.id} (${order.montant} DJF).\n` +
    `Crédit en cours vers votre compte 1xBet...`
  );

  if (!mobcashOn) {
    return { credited: false, manual: true };
  }

  const result = await attemptMobcashDeposit(order);
  return finalizeCreditResult(order, result);
}

// Le SMS existe (Transfer ID trouvé) mais montant et/ou expéditeur ne
// correspondent pas à l'ordre déclaré — ne crédite pas, alerte un agent
// pour vérification manuelle au lieu de rejeter ou créditer en aveugle.
// Le client voyait avant ça uniquement "en attente" sans explication (la
// raison n'existait que dans l'alerte Telegram admin) — on l'enregistre
// maintenant sur l'ordre (visible sur la page de suivi) et on prévient le
// client par WhatsApp, avec la raison précise pour qu'il puisse corriger
// lui-même une erreur de saisie si c'en est une.
export async function flagMismatch(order, reasons) {
  const reasonText = reasons.join(' ; ');
  await supabaseAdmin.from('depot_orders').update({ last_error: reasonText }).eq('id', order.id);
  await supabaseAdmin.from('alertes_etat').insert({
    type: 'depot_sms_mismatch',
    order_id: order.id,
    collection: 'depot_orders',
  });
  await sendTelegramAdmin(
    `⚠️ Dépôt #${order.id} — paiement NON confirmé automatiquement (${reasonText}). Vérification manuelle requise avant de créditer.`
  );
  await sendWhatsApp(
    order.whatsapp,
    `⚠️ Simba — Votre dépôt #${order.id} n'a pas pu être vérifié automatiquement : ${reasonText}. ` +
    `Notre équipe va vérifier manuellement. Si vous pensez qu'il y a une erreur de votre côté, contactez le support avec votre référence.`
  );
}

// Le Transfer-ID de cet ordre a déjà été crédité pour un AUTRE ordre —
// impossible de créditer deux fois la même preuve de paiement Waafi.
// Traité comme une fraude (même sévérité que le doublon détecté à la
// création dans hooks/depot-created.js) plutôt que laissé bloqué en
// silence sur "en_attente".
async function flagDuplicateTransfer(order, existingOrderId) {
  await supabaseAdmin.from('depot_orders').update({
    status: 'fraude',
    last_error: `Transfer-ID déjà utilisé par l'ordre #${existingOrderId || '?'}`,
  }).eq('id', order.id);
  await supabaseAdmin.from('alertes_etat').insert({
    type: 'depot_duplicate_transfer',
    order_id: order.id,
    collection: 'depot_orders',
  });
  await sendTelegramAdmin(
    `🚫 Dépôt #${order.id} — Transfer-ID déjà utilisé par l'ordre #${existingOrderId || '?'}. ` +
    `Ce paiement Waafi a déjà été crédité ailleurs, impossible de le créditer une deuxième fois.`
  );
  await sendWhatsApp(
    order.whatsapp,
    `❌ Simba — Votre dépôt #${order.id} n'a pas pu être confirmé. Contactez le support pour plus de détails.`
  );
  return { credited: false, duplicate: true, existing_order_id: existingOrderId };
}
