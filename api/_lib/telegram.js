const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const TELEGRAM_SUPPORT_BOT_TOKEN = process.env.TELEGRAM_SUPPORT_BOT_TOKEN;

export async function sendTelegramMessage(botToken, chatId, text) {
  if (!botToken || !chatId) return;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(() => {});
}

export function sendTelegramAdmin(text) {
  return sendTelegramMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID, text);
}

export function sendTelegramSupport(chatId, text) {
  return sendTelegramMessage(TELEGRAM_SUPPORT_BOT_TOKEN, chatId, text);
}
