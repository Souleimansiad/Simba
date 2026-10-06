// Parsing et vérification des SMS/notifications Waafi relayés par MacroDroid.
// Format réel observé : "WAAFI -> Transfer-Id: 90926098, You have Received
// DJF 50 from Souleiman Siad Soubaneh(77626050), Your Balance is: DJF 6,444.7."

export function parseWaafiText(text) {
  if (!text) return { transferId: null, montant: null, senderName: null, senderNumber: null, dateTime: null };
  const idMatch = text.match(/(?:trx|transaction|ref(?:erence)?|id)[\s.:#]*([A-Za-z0-9]{6,})/i);
  const amountMatch = text.match(/(?:djf|amount|montant)[^\d]{0,6}([\d,.]+)/i) || text.match(/([\d,.]{3,})\s*(?:djf)/i);
  const senderMatch = text.match(/from\s+(.*?)\s*\((\d{6,10})\)/i);
  const senderNumberFallback = senderMatch ? null : text.match(/exp[ée]diteur\D{0,10}(\d{6,10})/i);
  return {
    transferId: idMatch ? idMatch[1] : null,
    montant: amountMatch ? Number(amountMatch[1].replace(/[,.](?=\d{3}\b)/g, '').replace(',', '.')) : null,
    senderName: senderMatch && senderMatch[1] ? senderMatch[1].trim() : null,
    senderNumber: senderMatch ? senderMatch[2] : senderNumberFallback ? senderNumberFallback[1] : null,
    dateTime: parseWaafiDate(text),
  };
}

// Date/heure éventuellement présente dans le texte (ex: "06/10/2026 14:35"
// ou "2026-10-06 14:35"), interprétée en heure de Djibouti (UTC+3 fixe).
// Renvoie un ISO UTC, ou null si le texte ne contient pas de date.
function parseWaafiDate(text) {
  let m = text.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})[ ,T]+(\d{1,2})[:h](\d{2})/);
  let y, mo, d, h, mi;
  if (m) [, d, mo, y, h, mi] = m;
  else {
    m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})/);
    if (!m) return null;
    [, y, mo, d, h, mi] = m;
  }
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 3, Number(mi));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// Affichage "JJ/MM/AAAA HH:MM" en heure de Djibouti.
export function formatDjibouti(iso) {
  const w = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(w.getUTCDate())}/${p(w.getUTCMonth() + 1)}/${w.getUTCFullYear()} ${p(w.getUTCHours())}:${p(w.getUTCMinutes())}`;
}

function normalizePhone(num) {
  if (!num) return null;
  const digits = String(num).replace(/\D/g, '').replace(/^253/, ''); // retire l'indicatif +253 si présent
  return digits.slice(-8) || null; // numéros Djibouti : 8 chiffres
}

// Vérifie un ordre de dépôt contre le SMS Waafi stocké portant le même
// Transfer ID. 3 facteurs : Transfer ID (déjà garanti par la recherche),
// numéro expéditeur, montant. Sans ça, un client pourrait déclarer un
// montant ou un expéditeur différent du vrai paiement et se faire créditer
// sur la seule foi d'un Transfer ID recopié.
export function verifyDepotMatch(order, sms) {
  if (!sms) return { ok: false, reasons: ['Aucun SMS Waafi reçu avec ce Transfer ID'] };

  const reasons = [];
  const senderOk = normalizePhone(order.numero_waafi_expediteur) === normalizePhone(sms.sender_number);
  if (!senderOk) {
    reasons.push(`numéro expéditeur différent (ordre: ${order.numero_waafi_expediteur}, SMS: ${sms.sender_number || '?'})`);
  }
  const montantOk = sms.montant != null && Math.abs(Number(sms.montant) - Number(order.montant)) < 0.01;
  if (!montantOk) {
    reasons.push(`montant différent (ordre: ${order.montant} DJF, SMS: ${sms.montant ?? '?'} DJF)`);
  }
  return { ok: senderOk && montantOk, reasons };
}
