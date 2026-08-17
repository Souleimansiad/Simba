import { supabaseAdmin } from './_lib/supabase.js';
import { sendTelegramMessage } from './_lib/telegram.js';
import { resetCircuit, getCircuitState } from './_lib/mobcash.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

function reply(chatId, text) {
  return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, text);
}

// Webhook Telegram du bot admin. Configurer avec :
// https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain>/api/admin-bot&secret_token=<TELEGRAM_WEBHOOK_SECRET>
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
    // Seul le chat admin configuré peut déclencher des actions.
    if (chatId !== String(TELEGRAM_ADMIN_CHAT_ID)) {
      return res.status(200).json({ ok: true });
    }

    const text = message.text.trim();

    if (/^reset circuit$/i.test(text)) {
      await resetCircuit();
      await reply(chatId, '✅ Circuit MobCash réinitialisé (état: closed).');
      return res.status(200).json({ ok: true });
    }

    if (/^\/status$/i.test(text) || /^status$/i.test(text)) {
      const cb = await getCircuitState();
      await reply(chatId, `⚙️ Circuit MobCash: <b>${cb.state}</b> (échecs: ${cb.fail_count || 0})`);
      return res.status(200).json({ ok: true });
    }

    if (/^\/ordres$|^ordres$/i.test(text)) {
      const [{ data: depots }, { data: retraits }] = await Promise.all([
        supabaseAdmin.from('depot_orders').select('id,montant,status').eq('status', 'en_attente').limit(10),
        supabaseAdmin.from('retrait_orders').select('id,montant,status').eq('status', 'en_attente').limit(10),
      ]);
      const lines = [
        ...(depots || []).map((o) => `D #${o.id} — ${o.montant} DJF`),
        ...(retraits || []).map((o) => `R #${o.id} — ${o.montant} DJF`),
      ];
      await reply(chatId, lines.length ? `🧾 Ordres en attente:\n${lines.join('\n')}` : 'Aucun ordre en attente.');
      return res.status(200).json({ ok: true });
    }

    await reply(chatId, 'Commandes disponibles:\n/ordres — ordres en attente\n/status — état circuit MobCash\nreset circuit — réinitialiser le circuit MobCash');
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[admin-bot]', err);
    return res.status(500).json({ error: err.message });
  }
}
