import { supabaseAdmin } from './_lib/supabase.js';
import { sendTelegramAdmin } from './_lib/telegram.js';
import { parseWaafiText, verifyDepotMatch, formatDjibouti } from './_lib/waafiMatch.js';
import { creditDepot, flagMismatch } from './_lib/depotCredit.js';

// Reçoit les SMS/notifications Waafi relayés par MacroDroid (sur le téléphone
// recevant les paiements). Accepte plusieurs formats de body JSON :
// { not_title?, text | message | notification, transfer_id?, montant?, sender_number? }
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

  const title = body.not_title || body.title || null;
  const rawText = body.text || body.message || body.notification;

  // MacroDroid relaie aussi les SMS/notifications ordinaires (titre = un
  // numéro ou un contact) : seuls ceux de Waafi sont traités, le reste est
  // ignoré sans être stocké ni alerté. Sans titre, on se rabat sur le texte.
  if (!/waafi/i.test(title || rawText || '')) {
    return res.status(200).json({ ok: true, ignored: true, reason: 'not_waafi', titre: title });
  }

  const parsed = parseWaafiText(rawText);
  const transferId = body.transfer_id || parsed.transferId;
  const montant = body.montant != null ? Number(body.montant) : parsed.montant;
  const senderNumber = body.sender_number || parsed.senderNumber;
  const senderName = parsed.senderName;
  // Date du texte Waafi si elle y figure, sinon heure de réception.
  const paidAt = parsed.dateTime || new Date().toISOString();
  const extracted = {
    titre: title,
    transfer_id: transferId,
    nom_expediteur: senderName,
    numero_expediteur: senderNumber,
    montant,
    date_heure: formatDjibouti(paidAt),
  };

  try {
    const baseRow = { type: 'sms_received', message: rawText || null, transfer_id: transferId, montant, sender_number: senderNumber };
    const { error: insertErr } = await supabaseAdmin.from('waafi_notifications').insert({
      ...baseRow, title, sender_name: senderName, paid_at: paidAt,
    });
    // Colonnes title/sender_name/paid_at absentes tant que la migration
    // de schema.sql n'est pas appliquée : on stocke quand même le SMS
    // (indispensable pour hooks/depot-created.js) sans ces champs.
    if (insertErr) {
      console.error('[sms-webhook] insert', insertErr);
      await supabaseAdmin.from('waafi_notifications').insert(baseRow);
    }

    if (!transferId) {
      await sendTelegramAdmin(`⚠️ SMS Waafi reçu sans Transfer ID détecté : "${(rawText || '').slice(0, 200)}"`);
      return res.status(200).json({ ok: true, matched: false, reason: 'no_transfer_id', extracted });
    }

    const { data: order } = await supabaseAdmin
      .from('depot_orders')
      .select('*')
      .eq('transfer_id', transferId)
      .in('status', ['en_attente', 'paiement_recu'])
      .maybeSingle();

    if (!order) {
      // Cas normal : le client paie avant de remplir le formulaire. Ce
      // n'est pas une anomalie — juste une confirmation que le paiement est
      // enregistré et attend l'ordre (voir hooks/depot-created.js, qui
      // retrouvera ce SMS dès la création de l'ordre).
      await sendTelegramAdmin(
        `📩 SMS Waafi reçu — Paiement enregistré\n\n` +
        `Titre: ${title ?? '—'}\n` +
        `Transfer-ID: ${transferId}\n` +
        `Montant: ${montant ?? '?'} DJF\n` +
        `Expéditeur: ${senderName ?? '?'} (${senderNumber ?? '?'})\n` +
        `Date: ${extracted.date_heure}\n\n` +
        `✅ En attente de l'ordre client — confirmation automatique dès soumission.`
      );
      return res.status(200).json({ ok: true, matched: false, reason: 'order_not_found', extracted });
    }

    const verif = verifyDepotMatch(order, { montant, sender_number: senderNumber });
    if (!verif.ok) {
      await flagMismatch(order, verif.reasons);
      return res.status(200).json({ ok: true, matched: true, confirmed: false, reasons: verif.reasons, extracted });
    }

    const result = await creditDepot(order, transferId);
    return res.status(200).json({ ok: true, matched: true, confirmed: true, ...result, extracted });
  } catch (err) {
    console.error('[sms-webhook]', err);
    return res.status(500).json({ error: err.message });
  }
}
