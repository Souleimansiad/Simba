import { supabaseAdmin } from './_lib/supabase.js';
import { sendTelegramMessage } from './_lib/telegram.js';

const TELEGRAM_SUPPORT_BOT_TOKEN = process.env.TELEGRAM_SUPPORT_BOT_TOKEN;

// Webhook Telegram du bot support client. Configurer avec :
// https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain>/api/support-client&secret_token=<TELEGRAM_WEBHOOK_SECRET>
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).json({ error: 'Secret invalide' });
  }

  try {
    const message = req.body && req.body.message;
    if (!message || !message.text) return res.status(200).json({ ok: true });

    const chatId = String(message.chat.id);
    const text = message.text.trim();

    await supabaseAdmin.from('support_sessions').insert({ chat_id: chatId, text });

    let reply = "Merci pour votre message. Un agent Simba va vous répondre sous peu. Pour suivre un ordre, utilisez le lien #suivi-XXXX reçu après votre dépôt/retrait.";
    if (/^\/start$/i.test(text)) {
      reply = 'Bienvenue sur le support Simba 👋\nEnvoyez votre question ou votre référence d\'ordre (#suivi-XXXX).';
    }

    await sendTelegramMessage(TELEGRAM_SUPPORT_BOT_TOKEN, chatId, reply);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[support-client]', err);
    return res.status(500).json({ error: err.message });
  }
}
