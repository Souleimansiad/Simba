import { supabaseAdmin } from './supabase.js';

// .trim() défend contre un espace/retour à la ligne collé par erreur dans
// les variables d'env Vercel (fréquent en copiant depuis WhatsApp/Telegram),
// qui ferait échouer la comparaison exacte côté MobCash sans que rien ne le
// laisse deviner ("invalid credentials" identique à une vraie erreur).
const MOBCASH_CASHBOX_CODE = (process.env.MOBCASH_CASHBOX_CODE || '').trim();
const MOBCASH_LOGIN = (process.env.MOBCASH_LOGIN || '').trim();
const MOBCASH_PASSWORD = (process.env.MOBCASH_PASSWORD || '').trim();

// API APP-to-APP MobCash (doc fournie par le fournisseur). URLs fixes, pas
// de signature à calculer : authentification par login -> accessToken
// (Bearer), puis appels JSON-RPC avec sessionID/userID.
const LOGIN_URL = 'https://admin.mob-cash.com/api/v2/cashbox/login';
const MOBILE_BASE_URL = 'https://admin.mob-cash.com/api/v1/mobile';

const SERVICE_NAME = 'mobcash';
const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`MobCash n'a pas répondu après ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Tant que les identifiants MobCash ne sont pas fournis, le crédit/retrait
// 1xBet se fait manuellement (MacroDroid + Waafi). Dès que ces variables
// sont renseignées sur Vercel, le crédit redevient automatique sans
// changement de code.
export function isMobcashConfigured() {
  return !!(MOBCASH_CASHBOX_CODE && MOBCASH_LOGIN && MOBCASH_PASSWORD);
}

export async function getCircuitState() {
  const { data } = await supabaseAdmin.from('circuit_breakers').select('*').eq('service', SERVICE_NAME).maybeSingle();
  return data || { service: SERVICE_NAME, state: 'closed', fail_count: 0 };
}

async function recordSuccess() {
  await supabaseAdmin.from('circuit_breakers')
    .upsert({ service: SERVICE_NAME, state: 'closed', fail_count: 0, opened_at: null });
}

async function recordFailure() {
  const cb = await getCircuitState();
  const failCount = (cb.fail_count || 0) + 1;
  const patch = { service: SERVICE_NAME, fail_count: failCount, last_failure_at: new Date().toISOString() };
  if (failCount >= FAILURE_THRESHOLD) {
    patch.state = 'open';
    patch.opened_at = new Date().toISOString();
  }
  await supabaseAdmin.from('circuit_breakers').upsert(patch);
}

/** Commande Telegram "reset circuit" */
export async function resetCircuit() {
  await supabaseAdmin.from('circuit_breakers')
    .upsert({ service: SERVICE_NAME, state: 'closed', fail_count: 0, opened_at: null, last_failure_at: null });
}

async function ensureCircuitAllows() {
  const cb = await getCircuitState();
  if (cb.state === 'open') {
    const openedAt = cb.opened_at ? new Date(cb.opened_at).getTime() : 0;
    if (Date.now() - openedAt >= OPEN_DURATION_MS) {
      await supabaseAdmin.from('circuit_breakers').upsert({ service: SERVICE_NAME, state: 'half_open' });
      return 'half_open';
    }
    const err = new Error('Circuit MobCash ouvert (pannes répétées). Nouvel essai automatique dans quelques minutes.');
    err.circuitOpen = true;
    throw err;
  }
  return cb.state;
}

async function callMobCash(fn) {
  await ensureCircuitAllows();
  try {
    const result = await fn();
    await recordSuccess();
    return result;
  } catch (err) {
    await recordFailure();
    throw err;
  }
}

// Chaque opération refait un login : volume faible, et ça évite toute la
// complexité de cache/rafraîchissement de token entre invocations
// serverless (chaque appel est indépendant).
async function mobcashLogin() {
  const res = await fetchWithTimeout(LOGIN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cashboxCode: Number(MOBCASH_CASHBOX_CODE),
      login: MOBCASH_LOGIN,
      password: MOBCASH_PASSWORD,
    }),
  });
  const rawText = await res.text();
  let data = {};
  try { data = JSON.parse(rawText); } catch { /* réponse non-JSON, gardée dans rawText */ }
  if (!res.ok || !data.accessToken) {
    const detail = data.message || rawText.slice(0, 300) || ('HTTP ' + res.status);
    throw new Error(`MobCash login échoué (${res.status}) : ${detail}`);
  }
  return data; // { sessionID, userID, accessToken, expiresAt, cashbox }
}

async function mobileRpc(path, accessToken, params) {
  const res = await fetchWithTimeout(MOBILE_BASE_URL + path, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + accessToken,
    },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', params }),
  });
  const rawText = await res.text();
  let data = {};
  try { data = JSON.parse(rawText); } catch { /* réponse non-JSON, gardée dans rawText */ }
  const entry = Array.isArray(data) ? data[0] : data;
  if (!res.ok || !entry || entry.error) {
    const msg = entry && entry.error
      ? (entry.error.message || JSON.stringify(entry.error))
      : (rawText.slice(0, 300) || ('MobCash HTTP ' + res.status));
    throw new Error(`MobCash ${path} échoué (${res.status}) : ${msg}`);
  }
  return entry.result || {};
}

export async function mobcashDeposit(payerID, montant) {
  return callMobCash(async () => {
    const { sessionID, userID, accessToken } = await mobcashLogin();
    // Vérification du compte obligatoire avant dépôt.
    await mobileRpc('/payerNickname', accessToken, { payerID, sessionID, userID });
    const result = await mobileRpc('/deposit', accessToken, {
      deposit: { amount: String(montant), payerID },
      sessionID,
      userID,
    });
    if (!result.success) throw new Error('Dépôt MobCash refusé');
    return result;
  });
}

export async function mobcashPayout(payerID, withdrawalCode, montant) {
  return callMobCash(async () => {
    const { sessionID, userID, accessToken } = await mobcashLogin();
    // Demande d'ordre : récupère le montant validé côté 1xBet pour ce code.
    const amountResult = await mobileRpc('/getWithdrawalAmount', accessToken, {
      sessionID,
      userID,
      withdraw: { payerID, withdrawalCode },
    });
    const validatedAmount = Number(amountResult.amount);
    if (!validatedAmount || validatedAmount <= 0) {
      throw new Error('Code de retrait invalide ou expiré');
    }
    if (montant != null && Math.abs(validatedAmount - Number(montant)) > 0.01) {
      throw new Error(`Montant du retrait MobCash (${validatedAmount}) différent du montant de l'ordre (${montant})`);
    }
    const result = await mobileRpc('/withdrawal', accessToken, {
      sessionID,
      userID,
      withdraw: { amount: validatedAmount, payerID, withdrawalCode },
    });
    if (!result.success) throw new Error('Retrait MobCash refusé');
    return { ...result, amount: validatedAmount };
  });
}
