import { supabaseAdmin } from './supabase.js';
import { mobcashDeposit, isMobcashConfigured } from './mobcash.js';
import { sendTelegramAdmin } from './telegram.js';
import { sendWhatsApp } from './whatsapp.js';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Un échec de payerNickname (vérification de compte) signifie que l'ID
// 1xBet lui-même est invalide — retenter ne changera rien, on classe ça en
// échec permanent immédiat plutôt que de gaspiller 3 tentatives.
function isPermanentMobcashError(err) {
  return /payerNickname/i.test(err.message);
}

async function attemptMobcashDeposit(order) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await mobcashDeposit(order.id_bet1x, order.montant);
      return { success: true, attempts: attempt };
    } catch (err) {
      lastErr = err;
      const permanent = isPermanentMobcashError(err);
      await supabaseAdmin.from('depot_orders').update({
        mobcash_attempts: attempt,
        mobcash_status: permanent ? 'echec_permanent' : 'retry',
        last_error: err.message,
      }).eq('id', order.id);

      if (permanent) break;
      if (attempt < MAX_ATTEMPTS) {
        await sendTelegramAdmin(`⚠️ Tentative ${attempt}/${MAX_ATTEMPTS} échouée pour #${order.id} — nouvelle tentative...\n${err.message}`);
        await sendWhatsApp(order.whatsapp, `⚠️ Simba — Tentative de crédit ${attempt}/${MAX_ATTEMPTS} échouée pour votre dépôt #${order.id}. Nouvelle tentative en cours...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  return { success: false, attempts: MAX_ATTEMPTS, error: lastErr, permanent: isPermanentMobcashError(lastErr) };
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

  // Échec définitif : l'ordre reste "paiement_recu" (le paiement Waafi est
  // bien confirmé) avec mobcash_status="echec_permanent" — c'est le crédit
  // 1xBet qui nécessite une intervention manuelle, pas le paiement lui-même.
  await supabaseAdmin.from('alertes_etat').insert({ type: 'mobcash_credit_failed', order_id: order.id, collection: 'depot_orders' });
  const reasonLabel = result.permanent ? 'Compte 1xBet invalide' : `échec après ${result.attempts} tentatives`;
  await sendTelegramAdmin(
    `❌ Échec définitif — Dépôt #${order.id}\n` +
    `Paiement Waafi confirmé mais crédit MobCash échoué (${reasonLabel}) : ${result.error.message}\n` +
    `Intervention manuelle requise.`
  );
  await sendWhatsApp(
    order.whatsapp,
    result.permanent
      ? `❌ Simba — Compte 1xBet invalide pour votre dépôt #${order.id}. Contactez le support pour résoudre ça.`
      : `❌ Simba — Le crédit de votre dépôt #${order.id} a échoué après plusieurs tentatives. Notre équipe va intervenir manuellement.`
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

// Relance automatique pour un ordre bloqué depuis longtemps en
// paiement_recu/echec_permanent (voir ordres-bloques.js, relance auto >24h).
// Réutilise le même cycle de 3 tentatives que le flux normal.
export async function relaunchStaleCredit(order) {
  const result = await attemptMobcashDeposit(order);
  return finalizeCreditResult(order, result);
}

// Le SMS existe (Transfer ID trouvé) mais montant et/ou expéditeur ne
// correspondent pas à l'ordre déclaré — ne crédite pas, alerte un agent
// pour vérification manuelle au lieu de rejeter ou créditer en aveugle.
export async function flagMismatch(order, reasons) {
  await supabaseAdmin.from('alertes_etat').insert({
    type: 'depot_sms_mismatch',
    order_id: order.id,
    collection: 'depot_orders',
  });
  await sendTelegramAdmin(
    `⚠️ Dépôt #${order.id} — paiement NON confirmé automatiquement (${reasons.join(' ; ')}). Vérification manuelle requise avant de créditer.`
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
