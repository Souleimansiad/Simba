// Green API (green-api.com) — auth intégrée dans l'URL (idInstance +
// apiTokenInstance), pas de header Authorization. Format chatId : numéro
// sans "+" ni espaces, suffixé "@c.us". L'URL de base est spécifique à
// l'instance (ex: https://7107.api.greenapi.com), pas un domaine générique.
const GREENAPI_API_URL = process.env.GREENAPI_API_URL;
const GREENAPI_ID_INSTANCE = process.env.GREENAPI_ID_INSTANCE;
const GREENAPI_API_TOKEN = process.env.GREENAPI_API_TOKEN;

function greenApiUrl(method) {
  return `${GREENAPI_API_URL}/waInstance${GREENAPI_ID_INSTANCE}/${method}/${GREENAPI_API_TOKEN}`;
}

function toChatId(number) {
  const digits = String(number || '').replace(/\D/g, '');
  return digits ? `${digits}@c.us` : null;
}

export async function sendWhatsApp(to, message) {
  const chatId = toChatId(to);
  if (!GREENAPI_API_URL || !GREENAPI_ID_INSTANCE || !GREENAPI_API_TOKEN || !chatId) return;
  await fetch(greenApiUrl('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, message }),
  }).catch(() => {});
}

export function agentWhatsappNumbers() {
  return (process.env.WHATSAPP_AGENT_NUMBERS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export async function notifyAgentsWhatsApp(message) {
  const numbers = agentWhatsappNumbers();
  await Promise.all(numbers.map((n) => sendWhatsApp(n, message)));
}
