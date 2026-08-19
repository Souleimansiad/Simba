import { supabaseAdmin } from '../_lib/supabase.js';
import { computeFraudScore } from '../_lib/fraud.js';
import { sendTelegramAdmin } from '../_lib/telegram.js';
import { notifyAgentsWhatsApp, sendWhatsApp } from '../_lib/whatsapp.js';
import { verifyDepotMatch } from '../_lib/waafiMatch.js';
import { creditDepot, flagMismatch } from '../_lib/depotCredit.js';

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

    if (isFraud) {
      await sendTelegramAdmin(
        `⚠️ <b>FRAUDE SUSPECTÉE</b> — Dépôt #${record.id}\n` +
        `Montant: ${record.montant} DJF | ID 1xBet: ${record.id_bet1x}\n` +
        `Score fraude ${score}: ${reasons.join(', ')}`
      );
    } else {
      await sendTelegramAdmin(
        `📥 Nouvel ordre Dépôt — #${record.id}\n\n` +
        `Montant : ${record.montant} DJF\n` +
        `ID 1xBet : ${record.id_bet1x}\n` +
        `Transfer-ID : ${record.transfer_id || '—'}\n` +
        `N° Waafi : ${record.numero_waafi_expediteur}\n\n` +
        `⏳ Vérification en cours...`
      );
    }
    await notifyAgentsWhatsApp(`Nouveau dépôt #${record.id} — ${record.montant} DJF${isFraud ? ' (FRAUDE SUSPECTÉE)' : ''}`);

    if (!isFraud && record.whatsapp) {
      await sendWhatsApp(
        record.whatsapp,
        `✅ Simba — Votre dépôt #${record.id} de ${record.montant} DJF est enregistré.\n` +
        `Vérification du paiement Waafi en cours...`
      );
    }

    // Le client paie souvent AVANT de remplir le formulaire : le SMS Waafi
    // (relayé par MacroDroid) peut donc déjà être stocké au moment où cet
    // ordre est créé. On le cherche tout de suite au lieu d'attendre un SMS
    // qui ne viendra plus (il est déjà arrivé et reparti).
    let confirmation = null;
    if (!isFraud && record.transfer_id) {
      const { data: sms } = await supabaseAdmin
        .from('waafi_notifications')
        .select('*')
        .eq('transfer_id', record.transfer_id)
        .eq('type', 'sms_received')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (sms) {
        const verif = verifyDepotMatch(record, sms);
        if (verif.ok) {
          confirmation = await creditDepot(record, record.transfer_id);
        } else {
          await flagMismatch(record, verif.reasons);
          confirmation = { confirmed: false, reasons: verif.reasons };
        }
      }
    }

    return res.status(200).json({ ok: true, fraud_score: score, is_fraud: isFraud, confirmation });
  } catch (err) {
    console.error('[depot-created]', err);
    return res.status(500).json({ error: err.message });
  }
}
