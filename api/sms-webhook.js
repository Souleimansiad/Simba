import { supabaseAdmin } from './_lib/supabase.js';
import { mobcashDeposit, isMobcashConfigured } from './_lib/mobcash.js';
import { sendTelegramAdmin } from './_lib/telegram.js';

// Reçoit les SMS Waafi relayés par MacroDroid (sur le téléphone recevant les
// paiements). Configurer MacroDroid pour POSTer soit du JSON structuré
// { transfer_id, montant, text }, soit uniquement { text } (SMS brut) —
// dans ce cas l'extraction se fait par expression régulière ci-dessous.
// Header optionnel "x-sms-secret" à faire correspondre à SMS_WEBHOOK_SECRET.

function extractFromText(text) {
  if (!text) return { transferId: null, montant: null };
  const idMatch = text.match(/(?:trx|transaction|ref(?:erence)?|id)[\s.:#]*([A-Za-z0-9]{6,})/i);
  const amountMatch = text.match(/(?:djf|amount|montant)[^\d]{0,6}([\d,.]+)/i) || text.match(/([\d,.]{3,})\s*(?:djf)/i);
  return {
    transferId: idMatch ? idMatch[1] : null,
    montant: amountMatch ? Number(amountMatch[1].replace(/[,.](?=\d{3}\b)/g, '').replace(',', '.')) : null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const secret = process.env.SMS_WEBHOOK_SECRET;
  if (secret && req.headers['x-sms-secret'] !== secret) {
    return res.status(401).json({ error: 'Secret invalide' });
  }

  const body = req.body || {};
  const extracted = extractFromText(body.text || body.message);
  const transferId = body.transfer_id || extracted.transferId;
  const montant = body.montant != null ? Number(body.montant) : extracted.montant;

  try {
    await supabaseAdmin.from('waafi_notifications').insert({
      type: 'sms_received',
      message: body.text || body.message || null,
      transfer_id: transferId,
      montant,
    });

    if (!transferId) {
      await sendTelegramAdmin(`⚠️ SMS Waafi reçu sans Transfer ID détecté : "${(body.text || body.message || '').slice(0, 200)}"`);
      return res.status(200).json({ ok: true, matched: false, reason: 'no_transfer_id' });
    }

    const { data: order } = await supabaseAdmin
      .from('depot_orders')
      .select('*')
      .eq('transfer_id', transferId)
      .in('status', ['en_attente', 'paiement_recu'])
      .maybeSingle();

    if (!order) {
      await sendTelegramAdmin(`⚠️ SMS Waafi reçu (Transfer ID ${transferId}, ${montant ?? '?'} DJF) — aucun ordre en attente correspondant.`);
      return res.status(200).json({ ok: true, matched: false, reason: 'order_not_found' });
    }

    // Anti-double-crédit atomique : transfer_id est clé primaire de ordre_traite.
    const { error: dedupeError } = await supabaseAdmin
      .from('ordre_traite')
      .insert({ transfer_id: transferId, order_id: order.id });

    if (dedupeError) {
      if (dedupeError.code === '23505') {
        return res.status(200).json({ ok: true, matched: true, already_processed: true });
      }
      throw dedupeError;
    }

    await supabaseAdmin.from('depot_orders').update({ status: 'paiement_recu' }).eq('id', order.id);

    // Tant que MobCash n'est pas configuré : paiement Waafi confirmé (SMS
    // matché), mais le crédit 1xBet se fait manuellement — un agent recharge
    // le compte puis clique "Confirmer" dans le panneau admin.
    if (!isMobcashConfigured()) {
      await sendTelegramAdmin(`💰 Paiement Waafi reçu — Dépôt #${order.id} (${order.montant} DJF → 1xBet ${order.id_bet1x}). Créditez manuellement puis confirmez sur le panneau admin.`);
      return res.status(200).json({ ok: true, matched: true, credited: false, manual: true });
    }

    try {
      await mobcashDeposit(order.id_bet1x, order.montant);
      await supabaseAdmin.from('depot_orders').update({ status: 'credite' }).eq('id', order.id);
      await sendTelegramAdmin(`✅ Dépôt #${order.id} crédité automatiquement (${order.montant} DJF → ${order.id_bet1x})`);
      return res.status(200).json({ ok: true, matched: true, credited: true });
    } catch (mcErr) {
      await supabaseAdmin.from('alertes_etat').insert({
        type: 'mobcash_credit_failed',
        order_id: order.id,
        collection: 'depot_orders',
      });
      await sendTelegramAdmin(`❌ Paiement Waafi reçu pour #${order.id} mais crédit MobCash échoué : ${mcErr.message}. Intervention manuelle requise.`);
      return res.status(200).json({ ok: true, matched: true, credited: false, error: mcErr.message });
    }
  } catch (err) {
    console.error('[sms-webhook]', err);
    return res.status(500).json({ error: err.message });
  }
}
