import { supabaseAdmin } from './supabase.js';
import { mobcashDeposit, isMobcashConfigured } from './mobcash.js';
import { sendTelegramAdmin } from './telegram.js';

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

  if (!isMobcashConfigured()) {
    await sendTelegramAdmin(`💰 Paiement Waafi confirmé — Dépôt #${order.id} (${order.montant} DJF → 1xBet ${order.id_bet1x}). Créditez manuellement puis confirmez sur le panneau admin.`);
    return { credited: false, manual: true };
  }

  try {
    await mobcashDeposit(order.id_bet1x, order.montant);
    await supabaseAdmin.from('depot_orders').update({ status: 'credite' }).eq('id', order.id);
    await sendTelegramAdmin(`✅ Dépôt #${order.id} crédité automatiquement (${order.montant} DJF → ${order.id_bet1x})`);
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
