import { supabaseAdmin } from './supabase.js';
import { mobcashDeposit, isMobcashConfigured } from './mobcash.js';
import { sendTelegramAdmin } from './telegram.js';
import { sendWhatsApp } from './whatsapp.js';

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
    if (dedupeError.code === '23505') return { already_processed: true };
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

  try {
    await mobcashDeposit(order.id_bet1x, order.montant);
    await supabaseAdmin.from('depot_orders').update({ status: 'credite' }).eq('id', order.id);
    await sendTelegramAdmin(`✅ Dépôt — Crédité avec succès\n#${order.id} — ${order.montant} DJF`);
    await sendWhatsApp(
      order.whatsapp,
      `✅ Simba — Dépôt #${order.id} crédité avec succès !\n` +
      `${order.montant} DJF envoyés sur votre compte 1xBet ${order.id_bet1x}. Merci d'utiliser Simba 🦁`
    );
    return { credited: true };
  } catch (mcErr) {
    await supabaseAdmin.from('alertes_etat').insert({ type: 'mobcash_credit_failed', order_id: order.id, collection: 'depot_orders' });
    await sendTelegramAdmin(`❌ Paiement Waafi confirmé pour #${order.id} mais crédit MobCash échoué : ${mcErr.message}. Intervention manuelle requise.`);
    return { credited: false, error: mcErr.message };
  }
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
