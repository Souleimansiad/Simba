import { supabaseAdmin } from '../_lib/supabase.js';
import { computeFraudScore } from '../_lib/fraud.js';
import { sendTelegramAdmin } from '../_lib/telegram.js';
import { notifyAgentsWhatsApp } from '../_lib/whatsapp.js';

// Database Webhook Supabase : INSERT on public.retrait_orders
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const secret = process.env.SUPABASE_WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Signature webhook invalide' });
  }

  const record = req.body && req.body.record;
  if (!record || !record.id) return res.status(400).json({ error: 'Payload invalide' });

  try {
    const { score, reasons, isFraud } = computeFraudScore(record, 'retrait');

    if (score > 0) {
      await supabaseAdmin
        .from('retrait_orders')
        .update({ fraud_score: score, status: isFraud ? 'fraude' : record.status })
        .eq('id', record.id);
    }

    await supabaseAdmin.from('waafi_notifications').insert({
      type: 'retrait_created',
      message: `Nouveau retrait ${record.id} — ${record.montant} DJF`,
      montant: record.montant,
      order_id: record.id,
    });

    const lines = [
      `🔵 <b>Nouveau retrait</b> #${record.id}`,
      `Montant: <b>${record.montant} DJF</b>`,
      `ID 1xBet: ${record.id_bet1x}`,
      `Waafi réception: ${record.numero_waafi_reception}`,
      `Code retrait: ${record.code_retrait_1x}`,
      isFraud ? `⚠️ <b>FRAUDE SUSPECTÉE</b> (score ${score}): ${reasons.join(', ')}` : `Score fraude: ${score}`,
    ];
    await sendTelegramAdmin(lines.join('\n'));
    await notifyAgentsWhatsApp(`Nouveau retrait #${record.id} — ${record.montant} DJF${isFraud ? ' (FRAUDE SUSPECTÉE)' : ''}`);

    return res.status(200).json({ ok: true, fraud_score: score, is_fraud: isFraud });
  } catch (err) {
    console.error('[retrait-created]', err);
    return res.status(500).json({ error: err.message });
  }
}
