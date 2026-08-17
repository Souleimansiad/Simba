const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY;
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;

export async function sendWhatsApp(to, message) {
  if (!WHATSAPP_API_KEY || !WHATSAPP_API_URL || !to) return;
  await fetch(WHATSAPP_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WHATSAPP_API_KEY}` },
    body: JSON.stringify({ to, message }),
  }).catch(() => {});
}

export function agentWhatsappNumbers() {
  return (process.env.WHATSAPP_AGENT_NUMBERS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export async function notifyAgentsWhatsApp(message) {
  const numbers = agentWhatsappNumbers();
  await Promise.all(numbers.map((n) => sendWhatsApp(n, message)));
}
