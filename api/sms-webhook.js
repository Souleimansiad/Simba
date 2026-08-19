import { supabaseAdmin } from './_lib/supabase.js';
import { sendTelegramAdmin } from './_lib/telegram.js';
import { parseWaafiText, verifyDepotMatch } from './_lib/waafiMatch.js';
import { creditDepot, flagMismatch } from './_lib/depotCredit.js';

// Reçoit les SMS/notifications Waafi relayés par MacroDroid (sur le téléphone
// recevant les paiements). Accepte plusieurs formats de body JSON :
// { text | message | notification, transfer_id?, montant?, sender_number? }
// — le texte brut est parsé si ces champs ne sont pas fournis explicitement.
// Le secret (SMS_WEBHOOK_SECRET) peut être envoyé soit en header
// "x-sms-secret", soit en champ "secret" du body JSON (MacroDroid ne
// permettant pas toujours facilement d'ajouter un header).
//
// Chaque SMS reçu est toujours stocké (même sans ordre correspondant), pour
// que hooks/depot-created.js puisse le retrouver si le client remplit le
// formulaire de dépôt APRÈS avoir payé (cas le plus courant).

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const body = req.body || {};

  const secret = process.env.SMS_WEBHOOK_SECRET;
  const providedSecret = req.headers['x-sms-secret'] || body.secret;
  if (secret && providedSecret !== secret) {
    return res.status(401).json({ error: 'Secret invalide' });
  }

  const rawText = body.text || body.message || body.notification;
  const parsed = parseWaafiText(rawText);
  const transferId = body.transfer_id || parsed.transferId;
  const montant = body.montant != null ? Number(body.montant) : parsed.montant;
  const senderNumber = body.sender_number || parsed.senderNumber;

  try {
    await supabaseAdmin.from('waafi_notifications').insert({
      type: 'sms_received',
      message: rawText || null,
      transfer_id: transferId,
      montant,
      sender_number: senderNumber,
    });

    if (!transferId) {
      await sendTelegramAdmin(`⚠️ SMS Waafi reçu sans Transfer ID détecté : "${(rawText || '').slice(0, 200)}"`);
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

    const verif = verifyDepotMatch(order, { montant, sender_number: senderNumber });
    if (!verif.ok) {
      await flagMismatch(order, verif.reasons);
      return res.status(200).json({ ok: true, matched: true, confirmed: false, reasons: verif.reasons });
    }

    const result = await creditDepot(order, transferId);
    return res.status(200).json({ ok: true, matched: true, confirmed: true, ...result });
  } catch (err) {
    console.error('[sms-webhook]', err);
    return res.status(500).json({ error: err.message });
  }
}
