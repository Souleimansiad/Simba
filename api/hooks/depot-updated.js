import { sendTelegramAdmin } from '../_lib/telegram.js';
import { sendWhatsApp } from '../_lib/whatsapp.js';

const STATUS_LABEL_FR = {
  en_attente: 'En attente',
  paiement_recu: 'Paiement reçu',
  credite: 'Crédité avec succès ✅',
  rejete: 'Rejeté ❌',
  fraude: 'Bloqué — fraude suspectée ⚠️',
};

// Database Webhook Supabase : UPDATE on public.depot_orders
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const secret = process.env.SUPABASE_WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Signature webhook invalide' });
  }

  const record = req.body && req.body.record;
  const oldRecord = req.body && req.body.old_record;
  if (!record || !record.id) return res.status(400).json({ error: 'Payload invalide' });

  try {
    if (oldRecord && oldRecord.status !== record.status) {
      // Admin : tous les changements, y compris l'étape interne "paiement reçu".
      const label = STATUS_LABEL_FR[record.status] || record.status;
      await sendTelegramAdmin(`🔄 Dépôt #${record.id} → <b>${label}</b>`);
      // Client : un dépôt n'a que deux états visibles, en attente / crédité avec
      // succès. Seul le crédit déclenche un message (les refus et les échecs sont
      // annoncés, avec leur raison, par l'action qui les provoque).
      if (record.status === 'credite' && record.whatsapp) {
        await sendWhatsApp(
          record.whatsapp,
          `✅ Simba — Dépôt #${record.id} crédité avec succès ! ` +
          `${record.montant} DJF envoyés sur votre compte 1xBet ${record.id_bet1x}. Merci d'utiliser Simba 🦁`
        );
      }
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[depot-updated]', err);
    return res.status(500).json({ error: err.message });
  }
}
