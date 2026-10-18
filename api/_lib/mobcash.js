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
  // rawText inclus pour diagnostic : si result.success est absent/faux, on
  // veut voir la réponse brute réelle plutôt qu'un "{}" muet.
  return { ...(entry.result || {}), _raw: rawText.slice(0, 300) };
}

// entry.error (voir mobileRpc) est le signal d'échec confirmé côté
// protocole JSON-RPC : mobileRpc lève déjà une exception dans ce cas.
// MobCash ne renvoie PAS de champ result.success sur /deposit — confirmé
// deux fois en conditions réelles : result:{} (vide, sans error) correspond
// à un dépôt réellement exécuté (visible dans l'historique du caissier),
// jamais à un échec. On ne fait donc plus dépendre le succès d'un champ
// que MobCash n'envoie jamais sur cet endpoint : l'absence d'erreur suffit.
export async function mobcashDeposit(payerID, montant) {
  return callMobCash(async () => {
    const { sessionID, userID, accessToken } = await mobcashLogin();
    // Vérification du compte obligatoire avant dépôt.
    await mobileRpc('/payerNickname', accessToken, { payerID, sessionID, userID });
    return mobileRpc('/deposit', accessToken, {
      deposit: { amount: String(montant), payerID },
      sessionID,
      userID,
    });
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
    // Contrairement à /deposit (voir mobcashDeposit ci-dessus), on n'a PAS
    // encore de confirmation réelle du comportement de /withdrawal en cas
    // de result:{} vide. Un faux "réussi" ici dirait au client qu'il a été
    // payé sur Waafi alors que ce n'est peut-être pas le cas — plus grave
    // qu'une fausse alerte d'échec — donc on reste prudent : seul
    // result.success === true est traité comme un succès confirmé.
    if (result.success === false) throw new Error('Retrait MobCash refusé : ' + JSON.stringify(result));
    if (result.success !== true) {
      const err = new Error('Réponse MobCash ambiguë (ni succès ni erreur confirmés) : ' + JSON.stringify(result));
      err.ambiguous = true;
      throw err;
    }
    return { ...result, amount: validatedAmount };
  });
}

/**
 * Diagnostic de connexion (commande Telegram /mobcash) : UNE tentative de login,
 * aucune opération d'argent, circuit breaker non touché. Renvoie ce que MobCash
 * répond réellement, l'état des variables d'environnement (jamais leur valeur)
 * et l'adresse IP de sortie de Vercel, utile si MobCash filtre par IP.
 */
export async function mobcashDiagnostic() {
  const rawEnv = {
    cashbox: process.env.MOBCASH_CASHBOX_CODE || '',
    login: process.env.MOBCASH_LOGIN || '',
    password: process.env.MOBCASH_PASSWORD || '',
  };
  // Défauts classiques de saisie d'une variable : espaces/retours à la ligne,
  // guillemets collés, caractères invisibles. Seules des propriétés sont renvoyées.
  const inspect = (v) => ({
    renseigne: v.trim().length > 0,
    longueur: v.trim().length,
    espaces_autour: v !== v.trim(),
    entre_guillemets: /^["'].*["']$/.test(v.trim()),
    caracteres_invisibles: /[\u0000-\u001f\u007f\u200b\ufeff]/.test(v.trim()),
  });
  const diag = {
    configure: isMobcashConfigured(),
    cashbox: { ...inspect(rawEnv.cashbox), numerique: /^\d+$/.test(rawEnv.cashbox.trim()) },
    login: inspect(rawEnv.login),
    password: inspect(rawEnv.password),
    ip_sortie: null,
    login_test: null,
  };

  try {
    const r = await fetchWithTimeout('https://api.ipify.org?format=json', { method: 'GET' });
    diag.ip_sortie = (await r.json()).ip || null;
  } catch { /* information facultative */ }

  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(LOGIN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cashboxCode: Number(MOBCASH_CASHBOX_CODE), login: MOBCASH_LOGIN, password: MOBCASH_PASSWORD }),
    });
    const rawText = await res.text();
    let data = {};
    try { data = JSON.parse(rawText); } catch { /* non JSON */ }
    const ok = res.ok && !!data.accessToken;
    diag.login_test = {
      ok,
      http: res.status,
      duree_ms: Date.now() - t0,
      serveur: res.headers && res.headers.get ? res.headers.get('server') : null,
      cloudflare: !!(res.headers && res.headers.get && res.headers.get('cf-ray')),
      // Réponse d'erreur affichée telle quelle ; en cas de succès jamais le jeton.
      reponse: ok ? 'connexion réussie (jeton reçu, non affiché)' : (data.message || rawText.slice(0, 300) || '(vide)'),
    };
  } catch (err) {
    diag.login_test = { ok: false, http: null, duree_ms: Date.now() - t0, reponse: err.message };
  }
  return diag;
}

/** Texte lisible (Telegram HTML) du diagnostic. */
export function formatMobcashDiagnostic(d) {
  const esc = (v) => String(v ?? '—').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const flags = (x) => [
    x.renseigne ? `${x.longueur} car.` : '❌ VIDE',
    x.espaces_autour ? '⚠️ espaces/retour ligne autour' : null,
    x.entre_guillemets ? '⚠️ guillemets collés' : null,
    x.caracteres_invisibles ? '⚠️ caractères invisibles' : null,
  ].filter(Boolean).join(' · ');
  const t = d.login_test || {};
  return [
    '🔧 <b>Diagnostic MobCash</b> (1 connexion, aucun dépôt)',
    '',
    `Variables Vercel : ${d.configure ? '✅ les 3 sont renseignées' : '❌ incomplètes'}`,
    `• Code caisse : ${flags(d.cashbox)}${d.cashbox.renseigne && !d.cashbox.numerique ? ' · ❌ NON numérique' : ''}`,
    `• Login : ${flags(d.login)}`,
    `• Mot de passe : ${flags(d.password)}`,
    '',
    `IP de sortie Vercel : ${esc(d.ip_sortie)}`,
    '',
    `Connexion : ${t.ok ? '✅ RÉUSSIE' : '❌ ÉCHEC'}`,
    `• HTTP ${esc(t.http)} en ${esc(t.duree_ms)} ms${t.serveur ? ` · serveur ${esc(t.serveur)}` : ''}${t.cloudflare ? ' · derrière Cloudflare' : ''}`,
    `• Réponse : ${esc(t.reponse)}`,
  ].join('\n');
}

/**
 * Explique une erreur MobCash à l'agent. safeToRetry = false quand MobCash a pu
 * exécuter le dépôt malgré l'erreur (constaté en test : timeouts, 5xx sur
 * /deposit) : relancer à l'aveugle risquerait de créditer deux fois.
 * Une erreur de connexion, de vérification du compte (/payerNickname) ou un
 * refus explicite (solde, devise, limite) survient AVANT toute exécution.
 */
export function describeMobcashError(message) {
  const m = String(message || '');
  const out = (kind, label, safeToRetry, hint) => ({ kind, label, safeToRetry, hint });
  if (/Circuit MobCash ouvert/i.test(m)) return out('circuit', 'Circuit MobCash ouvert (pannes répétées)', true, 'Attendre quelques minutes ou envoyer « reset circuit »');
  if (/payerNickname/i.test(m) && !/429|rate/i.test(m)) return out('invalid_id', 'ID 1xBet introuvable ou invalide', true, 'Demander le bon ID au client puis : relance #ORDRE [bon ID 1xBet]');
  if (/login/i.test(m) || /unauthorized/i.test(m)) return out('login', 'Connexion MobCash refusée (identifiants ou accès)', true, 'Vérifier les variables MOBCASH_* ou lancer /mobcash');
  if (/insuffisan|insufficient|not enough|solde|balance|funds/i.test(m)) return out('balance', 'Solde de la caisse MobCash insuffisant', true, 'Recharger la caisse MobCash puis : relance #ORDRE');
  if (/currency|devise/i.test(m)) return out('currency', 'Devise du compte 1xBet incompatible', true, 'Vérifier la devise du compte 1xBet du client');
  if (/429|rate ?limit/i.test(m)) return out('rate_limit', 'Limite de requêtes MobCash atteinte', true, 'Réessayer dans quelques minutes : relance #ORDRE');
  if (/n'a pas répondu|timeout|ECONN|fetch failed|injoignable|ENOTFOUND/i.test(m)) return out('timeout', 'MobCash n\'a pas répondu', false, 'Vérifier l\'historique MobCash du caissier : le dépôt a peut-être déjà été exécuté');
  return out('other', 'Autre échec MobCash', false, 'Vérifier l\'historique MobCash du caissier avant de relancer');
}
