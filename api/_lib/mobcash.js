import crypto from 'node:crypto';
import { supabaseAdmin } from './supabase.js';

const MOBCASH_BASE_URL = process.env.MOBCASH_BASE_URL;
const MOBCASH_CASHIER_PASS = process.env.MOBCASH_CASHIER_PASS;
const MOBCASH_CASHDESK_ID = process.env.MOBCASH_CASHDESK_ID;

const SERVICE_NAME = 'mobcash';
const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS = 5 * 60 * 1000;

// Tant que les identifiants MobCash ne sont pas fournis, le crédit/retrait
// 1xBet se fait manuellement (MacroDroid + Waafi). Dès que ces variables
// sont renseignées sur Vercel, le crédit redevient automatique sans
// changement de code.
export function isMobcashConfigured() {
  return !!(MOBCASH_BASE_URL && MOBCASH_CASHIER_PASS && MOBCASH_CASHDESK_ID);
}

function signature(summa) {
  return crypto.createHash('md5').update(String(summa) + MOBCASH_CASHIER_PASS + MOBCASH_CASHDESK_ID).digest('hex');
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

async function callMobCash(path, body) {
  await ensureCircuitAllows();
  try {
    const res = await fetch(MOBCASH_BASE_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || ('MobCash HTTP ' + res.status));
    await recordSuccess();
    return data;
  } catch (err) {
    await recordFailure();
    throw err;
  }
}

export async function mobcashDeposit(userId1xbet, montant) {
  const summa = montant;
  return callMobCash(`/Deposit/${userId1xbet}/Add`, {
    summa,
    cashdeskId: MOBCASH_CASHDESK_ID,
    sign: signature(summa),
  });
}

export async function mobcashPayout(userId1xbet, montant) {
  const summa = montant;
  return callMobCash(`/Deposit/${userId1xbet}/Payout`, {
    summa,
    cashdeskId: MOBCASH_CASHDESK_ID,
    sign: signature(summa),
  });
}
