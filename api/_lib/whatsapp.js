// Green API (green-api.com) — auth intégrée dans l'URL (idInstance +
// apiTokenInstance), pas de header Authorization. Format chatId : numéro
// sans "+" ni espaces, suffixé "@c.us". L'URL de base est spécifique à
// l'instance (ex: https://7107.api.greenapi.com), pas un domaine générique.
const GREENAPI_API_URL = process.env.GREENAPI_API_URL;
const GREENAPI_ID_INSTANCE = process.env.GREENAPI_ID_INSTANCE;
const GREENAPI_API_TOKEN = process.env.GREENAPI_API_TOKEN;

export function isGreenApiConfigured() {
  return !!(GREENAPI_API_URL && GREENAPI_ID_INSTANCE && GREENAPI_API_TOKEN);
}

function greenApiUrl(method) {
  return `${GREENAPI_API_URL}/waInstance${GREENAPI_ID_INSTANCE}/${method}/${GREENAPI_API_TOKEN}`;
}

function toChatId(number) {
  const digits = String(number || '').replace(/\D/g, '');
  return digits ? `${digits}@c.us` : null;
}

// Ne lève jamais (les appelants — messages de statut — ne doivent pas
// planter si WhatsApp est down) mais renvoie {ok, status, body} pour que
// l'appelant puisse diagnostiquer un échec silencieux (ex: testeur admin).
export async function sendWhatsApp(to, message) {
  const chatId = toChatId(to);
  if (!isGreenApiConfigured()) return { ok: false, error: 'GREENAPI_API_URL/ID_INSTANCE/API_TOKEN manquants' };
  if (!chatId) return { ok: false, error: 'Numéro WhatsApp invalide ou manquant' };
  try {
    const res = await fetch(greenApiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, message }),
    });
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* garde le texte brut */ }
    if (!res.ok) return { ok: false, status: res.status, error: typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body) };
    return { ok: true, status: res.status, body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function agentWhatsappNumbers() {
  return (process.env.WHATSAPP_AGENT_NUMBERS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export async function notifyAgentsWhatsApp(message) {
  const numbers = agentWhatsappNumbers();
  await Promise.all(numbers.map((n) => sendWhatsApp(n, message)));
}
