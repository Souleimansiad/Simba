import { supabaseAdmin } from '../_lib/supabase.js';
import { computeFraudScore } from '../_lib/fraud.js';
import { sendTelegramAdmin } from '../_lib/telegram.js';
import { notifyAgentsWhatsApp, sendWhatsApp } from '../_lib/whatsapp.js';
import { verifyDepotMatch } from '../_lib/waafiMatch.js';
import { creditDepot, flagMismatch } from '../_lib/depotCredit.js';
import { receiptSignedUrl } from '../_lib/receipts.js';
import { describeReceipt, failedReasons, findSmsForOrder } from '../_lib/receiptMatch.js';
import { extractReceiptForOrder } from '../_lib/receiptAI.js';

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
    // Lecture de la capture par l'IA, côté serveur et depuis l'image stockée
    // (le client ne peut donc pas falsifier les champs). Faite avant le score
    // de fraude, qui dépend de ce qui a pu être lu. Un SMS USSD fournit aussi
    // le Transfer ID de l'ordre. Échec ou format inconnu : receipt_data reste
    // vide et l'ordre part en vérification manuelle.
    if (record.receipt_path && !record.receipt_data) {
      const data = await extractReceiptForOrder(record.receipt_path, record.id);
      if (data) {
        const patch = { receipt_data: data };
        if (data.kind === 'ussd' && data.transfer_id) patch.transfer_id = data.transfer_id;
        await supabaseAdmin.from('depot_orders').update(patch).eq('id', record.id);
        record.receipt_data = data;
        if (patch.transfer_id) record.transfer_id = patch.transfer_id;
      }
    }

    let { score, reasons, isFraud } = computeFraudScore(record, 'depot');

    // Ordre suspect : même Transfer ID + même montant soumis à nouveau en
    // peu de temps (tentative de rejouer une preuve de paiement déjà
    // utilisée, ou double-soumission).
    if (record.transfer_id) {
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: dupes } = await supabaseAdmin
        .from('depot_orders')
        .select('id')
        .eq('transfer_id', record.transfer_id)
        .eq('montant', record.montant)
        .neq('id', record.id)
        .not('status', 'in', '(rejete,fraude,annule)')
        .gte('created_at', since)
        .limit(1);
      if (dupes && dupes.length > 0) {
        score = Math.max(score, 100);
        isFraud = true;
        reasons = [...reasons, `Transfer ID + montant déjà soumis récemment (ordre #${dupes[0].id})`];
      }
    }

    if (score > 0) {
      // Ne touche au statut que pour un ordre frauduleux : réécrire le statut
      // du payload (lu à la création) pourrait annuler un crédit survenu
      // entre-temps via le webhook SMS.
      await supabaseAdmin
        .from('depot_orders')
        .update(isFraud ? { fraud_score: score, status: 'fraude' } : { fraud_score: score })
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
      const capture = await receiptSignedUrl(record.receipt_path);
      await sendTelegramAdmin(
        `📥 Nouvel ordre Dépôt — #${record.id}\n\n` +
        `Montant : ${record.montant} DJF\n` +
        `ID 1xBet : ${record.id_bet1x}\n` +
        (record.receipt_path
          ? `Capture lue : ${describeReceipt(record.receipt_data)}\n`
          : `Transfer-ID : ${record.transfer_id || '—'}\n`) +
        (capture ? `🧾 <a href="${capture.replace(/&/g, '&amp;')}">Voir la capture de paiement</a>\n` : '') +
        `\n⏳ Vérification en cours...`
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
    // Montant saisi ≠ montant payé (faute de frappe probable) : on ne crédite
    // rien automatiquement et on prévient le client avec la raison exacte.
    const rd = record.receipt_data;
    const amountMismatch = !!(rd && rd.amount != null && Math.abs(Number(rd.amount) - Number(record.montant)) > 0.01);
    if (!isFraud && amountMismatch) {
      const reasons = [`montant saisi ${record.montant} DJF différent du montant de la capture ${rd.amount} DJF`];
      await flagMismatch(record, reasons);
      confirmation = { confirmed: false, reasons };
    } else if (!isFraud && record.receipt_data && record.receipt_data.kind) {
      // Ordre avec capture : on cherche le SMS qui concorde (6/6 pour un reçu
      // de l'app Waafi, 5/5 pour un SMS d'opérateur USSD). Si le SMS n'est pas
      // encore arrivé, hooks/sms-webhook.js fera le rapprochement à sa réception.
      const found = await findSmsForOrder(record);
      if (found.status === 'matched') {
        await supabaseAdmin.from('depot_orders').update({ transfer_id: found.sms.transfer_id }).eq('id', record.id);
        confirmation = await creditDepot({ ...record, transfer_id: found.sms.transfer_id }, found.sms.transfer_id, found.sms);
        confirmation = { ...confirmation, criteria: `${found.evaluation.passed}/${found.evaluation.total}` };
      } else if (found.status === 'mismatch') {
        const reasons = failedReasons(found.evaluation);
        await flagMismatch(record, reasons);
        confirmation = { confirmed: false, reasons };
      } else if (found.status === 'ambiguous') {
        await sendTelegramAdmin(`⚠️ Dépôt #${record.id} — ${found.count} SMS Waafi correspondent à la capture : rapprochement automatique impossible, confirmer à la main.`);
        confirmation = { confirmed: false, ambiguous: found.count };
      }
    } else if (!isFraud && record.transfer_id) {
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
          confirmation = await creditDepot(record, record.transfer_id, sms);
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
