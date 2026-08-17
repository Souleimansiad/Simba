import { supabaseAdmin } from '../_lib/supabase.js';
import { computeFraudScore } from '../_lib/fraud.js';
import { sendTelegramAdmin } from '../_lib/telegram.js';
import { notifyAgentsWhatsApp } from '../_lib/whatsapp.js';

// Configurer ce endpoint comme Database Webhook Supabase :
// INSERT on public.depot_orders -> POST https://<domain>/api/hooks/depot-created
// avec un header "x-webhook-secret: <SUPABASE_WEBHOOK_SECRET>" pour authentifier l'appel.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const secret = process.env.SUPABASE_WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Signature webhook invalide' });
  }

  const record = req.body && req.body.record;
  if (!record || !record.id) return res.status(400).json({ error: 'Payload invalide' });

  try {
    const { score, reasons, isFraud } = computeFraudScore(record, 'depot');

    if (score > 0) {
      await supabaseAdmin
        .from('depot_orders')
        .update({ fraud_score: score, status: isFraud ? 'fraude' : record.status })
        .eq('id', record.id);
    }

    await supabaseAdmin.from('waafi_notifications').insert({
      type: 'depot_created',
      message: `Nouveau dépôt ${record.id} — ${record.montant} DJF`,
      transfer_id: record.transfer_id || null,
      montant: record.montant,
      order_id: record.id,
    });

    const lines = [
      `🟢 <b>Nouveau dépôt</b> #${record.id}`,
      `Montant: <b>${record.montant} DJF</b>`,
      `ID 1xBet: ${record.id_bet1x}`,
      `Waafi expéditeur: ${record.numero_waafi_expediteur}`,
      `Transfer ID: ${record.transfer_id || '—'}`,
      isFraud ? `⚠️ <b>FRAUDE SUSPECTÉE</b> (score ${score}): ${reasons.join(', ')}` : `Score fraude: ${score}`,
    ];
    await sendTelegramAdmin(lines.join('\n'));
    await notifyAgentsWhatsApp(`Nouveau dépôt #${record.id} — ${record.montant} DJF${isFraud ? ' (FRAUDE SUSPECTÉE)' : ''}`);

    return res.status(200).json({ ok: true, fraud_score: score, is_fraud: isFraud });
  } catch (err) {
    console.error('[depot-created]', err);
    return res.status(500).json({ error: err.message });
  }
}
