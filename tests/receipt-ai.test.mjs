// Test de non-régression (voir DEPLOY.md). Lancer : npm test
const ROOT = new URL('../', import.meta.url).href;
process.env.SUPABASE_URL='http://x'; process.env.SUPABASE_SERVICE_ROLE_KEY='k'; process.env.SMS_WEBHOOK_SECRET='s';
process.env.TELEGRAM_BOT_TOKEN='t'; process.env.TELEGRAM_ADMIN_CHAT_ID='1'; delete process.env.OPENROUTER_API_KEY;
const { supabaseAdmin } = await import(ROOT + 'api/_lib/supabase.js');
const smsHook = (await import(ROOT + 'api/sms-webhook.js')).default;
const createdHook = (await import(ROOT + 'api/hooks/depot-created.js')).default;

// ---- base en mémoire minimale ----
const db = { retrait_orders: [], ai_usage: [], depot_orders: [], waafi_notifications: [], ordre_traite: [], alertes_etat: [], audit_logs: [] };
let seq = 0;
class Q {
  constructor(t) { this.t = t; this.f = []; this.lim = null; this.op = 'select'; }
  select() { return this; }
  eq(k, v) { this.f.push((r) => String(r[k]) === String(v)); return this; }
  neq(k, v) { this.f.push((r) => String(r[k]) !== String(v)); return this; }
  in(k, vs) { this.f.push((r) => vs.map(String).includes(String(r[k]))); return this; }
  not(k, op, v) { this.f.push((r) => op === 'is' ? !(r[k] === null || r[k] === undefined) : !String(v).replace(/[()]/g, '').split(',').includes(String(r[k]))); return this; }
  gte(k, v) { this.f.push((r) => new Date(r[k]) >= new Date(v)); return this; }
  lte(k, v) { this.f.push((r) => new Date(r[k]) <= new Date(v)); return this; }
  lt(k, v) { this.f.push((r) => new Date(r[k]) < new Date(v)); return this; }
  order() { return this; }
  limit(n) { this.lim = n; return this; }
  update(p) { this.op = 'update'; this.patch = p; return this; }
  insert(row) {
    if (this.t === 'ordre_traite' && db.ordre_traite.some((r) => r.transfer_id === row.transfer_id)) return Promise.resolve({ error: { code: '23505' } });
    db[this.t].push({ id: this.t === 'waafi_notifications' ? ++seq : undefined, created_at: new Date().toISOString(), ...row }); return Promise.resolve({ error: null });
  }
  rows() { let r = db[this.t].filter((x) => this.f.every((fn) => fn(x))); if (this.lim) r = r.slice(0, this.lim); return r; }
  maybeSingle() { return Promise.resolve({ data: this.rows()[0] || null, error: null }); }
  then(res, rej) {
    if (this.op === 'update') { this.rows().forEach((r) => Object.assign(r, this.patch)); return Promise.resolve({ data: null, error: null }).then(res, rej); }
    return Promise.resolve({ data: this.rows(), error: null }).then(res, rej);
  }
}
supabaseAdmin.from = (t) => new Q(t);
supabaseAdmin.storage = { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://x/receipt' } }) }) };
const tg = []; globalThis.fetch = async (u, o) => { if (String(u).includes('telegram')) tg.push(JSON.parse(o.body).text); return { ok: true, text: async () => '{}' }; };

const call = (h, body) => new Promise((r) => h({ method: 'POST', headers: { 'x-sms-secret': 's' }, body }, { status: () => ({ json: (j) => r(j) }) }));
const sms = (id, amount, from, name, text) => call(smsHook, { titre: 'WAAFI SAS', notification: text || `WAAFI -> Transfer-Id: ${id}, You have Received DJF ${amount} from ${name}(${from}), Your Balance is: DJF 85.` });
const newOrder = (id, montant, rd, extra = {}) => { const o = { id, status: 'en_attente', montant, id_bet1x: '1234', whatsapp: '77000000', receipt_path: 'x.jpg', receipt_data: rd, transfer_id: rd?.transfer_id || null, fraud_score: 0, created_at: new Date().toISOString(), ...extra }; db.depot_orders.push(o); return o; };
const status = (id) => db.depot_orders.find((o) => o.id === id).status;
let bad = 0; const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? 'OK ' : 'KO ', n, ok ? '' : `(obtenu ${JSON.stringify(got)}, attendu ${JSON.stringify(want)})`); };


const AI = await import(ROOT + 'api/_lib/receiptAI.js');
const botHook = (await import(ROOT + 'api/admin-bot.js')).default;
const cronHook = (await import(ROOT + 'api/ordres-bloques.js')).default;
const urls = []; let script = [];            // script : réponses successives de l'« OpenRouter » simulé
const calls = [];                             // { model, key }
const ok = (obj, usage = { prompt_tokens: 1200, completion_tokens: 80, cost: 0.000345 }) => ({ status: 200, body: { choices: [{ message: { content: JSON.stringify(obj) } }], usage } });
const good = { kind: 'app', amount: 50, sender_number: '77329449', sender_name: 'Souleiman Said Soubaneh', dest_number: '77626050', dest_name: 'Souleiman Siad Soubaneh', date: '2026-10-18 20:14' };
const keyInfo = {};                           // réponses du faux GET /key par clé
globalThis.fetch = async (u, o) => {
  urls.push(String(u));
  if (String(u).includes('telegram')) { tg.push(JSON.parse(o.body).text); return { ok: true, text: async () => '{}' }; }
  if (String(u).endsWith('/api/v1/key')) {
    const key = o.headers.Authorization.replace('Bearer ', '');
    const r = keyInfo[key] || { status: 401, body: { error: 'invalid' } };
    return { ok: r.status === 200, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  }
  if (String(u).endsWith('/chat/completions')) {
    const body = JSON.parse(o.body); calls.push({ model: body.model, key: o.headers.Authorization.replace('Bearer ', ''), body });
    const r = script.shift() || { status: 500, body: 'script épuisé' };
    return { ok: r.status === 200, status: r.status, text: async () => typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
  }
  throw new Error('appel réseau inattendu : ' + u);
};
const run = async (steps, keys = ['k1', 'k2'], mockRandom = 0) => {
  for (const n of Object.keys(process.env).filter((n) => n.startsWith('OPENROUTER_API_KEY'))) delete process.env[n];
  keys.forEach((k, i) => { process.env[i === 0 ? 'OPENROUTER_API_KEY' : `OPENROUTER_API_KEY_${i + 1}`] = k; });
  script = [...steps]; calls.length = 0; db.ai_usage.length = 0;
  const r0 = Math.random; Math.random = () => mockRandom;
  try { return { out: await AI.extractReceiptFromImage('QUJD', 'image/jpeg', { orderId: 'T1' }) }; }
  catch (err) { return { err }; } finally { Math.random = r0; }
};

/* ---- modèles et clés ---- */
t('modèles par défaut', AI.getModels(), ['google/gemini-2.5-flash', 'openai/gpt-4o-mini']);
process.env.OPENROUTER_MODEL = 'google/gemini-2.5-flash-lite'; process.env.OPENROUTER_FALLBACK_MODEL = 'none';
t('modèle choisi + secours désactivé', AI.getModels(), ['google/gemini-2.5-flash-lite']);
process.env.OPENROUTER_FALLBACK_MODEL = 'google/gemini-2.5-flash-lite'; t('secours identique au principal ignoré', AI.getModels().length, 1);
delete process.env.OPENROUTER_MODEL; delete process.env.OPENROUTER_FALLBACK_MODEL;
process.env.OPENROUTER_API_KEY = ' kA '; process.env.OPENROUTER_API_KEY_2 = 'kB'; process.env.OPENROUTER_API_KEY_3 = 'kA'; process.env.OPENROUTER_API_KEY_4 = '';
t('clés : trim, doublons et vides ignorés', AI.getOpenRouterKeys().map((k) => k.label + '=' + k.key), ['OPENROUTER_API_KEY=kA', 'OPENROUTER_API_KEY_2=kB']);
t('rotation (r=0 / r=0.99)', [AI.rotateKeys([1, 2], 0), AI.rotateKeys([1, 2], 0.99)], [[1, 2], [2, 1]]);

/* ---- appel nominal : requête, coût journalisé, uniquement OpenRouter ---- */
urls.length = 0;
let r = await run([ok(good)]);
t('lecture OK', r.out && r.out.kind, 'app');
t('requête : modèle principal Gemini 2.5 Flash', calls[0].model, 'google/gemini-2.5-flash');
t('requête : usage.include + JSON strict', [calls[0].body.usage, calls[0].body.response_format.type], [{ include: true }, 'json_object']);
t('uniquement des appels OpenRouter', urls.every((u) => u.startsWith('https://openrouter.ai/api/v1/')), true);
const row = db.ai_usage[0];
t('coût journalisé (cout_usd, tokens, clé par étiquette)', [row.cout_usd, row.prompt_tokens, row.completion_tokens, row.cle, row.model, row.succes, row.order_id], [0.000345, 1200, 80, 'OPENROUTER_API_KEY', 'google/gemini-2.5-flash', true, 'T1']);

/* ---- rotation / redondance des clés ---- */
r = await run([{ status: 402, body: { error: { message: 'Insufficient credits' } } }, ok(good)]);
t('clé à sec (402) -> clé suivante, même modèle', [r.out && r.out.kind, calls.map((c) => c.key + '@' + c.model)], ['app', ['k1@google/gemini-2.5-flash', 'k2@google/gemini-2.5-flash']]);
t('échec 402 journalisé à coût 0', [db.ai_usage[0].succes, db.ai_usage[0].http_status, db.ai_usage[0].cout_usd, db.ai_usage[1].succes], [false, 402, 0, true]);
r = await run([{ status: 200, body: { error: { code: 402, message: 'no credits' } } }, ok(good)]);
t('erreur 402 dans un corps HTTP 200 -> clé suivante', [r.out && r.out.kind, calls.length], ['app', 2]);
r = await run([{ status: 429, body: 'rate' }, ok(good)]);
t('429 -> clé suivante', [r.out && r.out.kind, calls[1].key], ['app', 'k2']);
r = await run([ok(good)], ['k1', 'k2'], 0.99);
t('rotation : la charge démarre sur la 2e clé', calls[0].key, 'k2');

/* ---- modèle de secours ---- */
r = await run([{ status: 500, body: 'down' }, ok(good)]);
t('principal en panne (500) -> secours gpt-4o-mini', [r.out && r.out.kind, calls.map((c) => c.model)], ['app', ['google/gemini-2.5-flash', 'openai/gpt-4o-mini']]);
r = await run([ok('pas du json'), ok(good)]);
t('réponse non JSON -> secours', [r.out && r.out.kind, calls[1].model], ['app', 'openai/gpt-4o-mini']);
r = await run([{ status: 200, body: { choices: [{ message: { content: 'désolé, je ne peux pas' } }], usage: { cost: 0.0004 } } }, ok(good)]);
t('texte sans JSON -> secours, coût du 1er appel conservé', [r.out && r.out.kind, db.ai_usage[0].cout_usd, db.ai_usage[0].succes], ['app', 0.0004, false]);
r = await run([{ status: 404, body: 'model not found' }, ok(good)]);
t('modèle introuvable (404) -> secours', [r.out && r.out.kind, calls.length], ['app', 2]);
r = await run([{ status: 402, body: 'x' }, { status: 500, body: 'down' }, ok(good)]);
t('clé morte écartée pour le modèle de secours', calls.map((c) => c.key + '@' + c.model), ['k1@google/gemini-2.5-flash', 'k2@google/gemini-2.5-flash', 'k2@openai/gpt-4o-mini']);
r = await run([ok({ kind: 'unknown' })]);
t('image non reconnue -> null, pas de 2e appel', [r.out, calls.length, r.err], [null, 1, undefined]);

/* ---- échec total ---- */
r = await run([{ status: 401, body: 'bad key' }, { status: 401, body: 'bad key' }]);
t('toutes les clés invalides -> erreur', [!!r.err, calls.length], [true, 2]);
r = await run([{ status: 500, body: 'down' }, { status: 500, body: 'down' }]);
t('modèles tous en panne -> erreur', [!!r.err, calls.length], [true, 2]);
t('les clés ne sont jamais écrites dans ai_usage ni dans les erreurs', JSON.stringify(db.ai_usage) + r.err.message, JSON.stringify(db.ai_usage) + r.err.message);
t('  … (vérification : aucune clé)', /k1|k2/.test(JSON.stringify(db.ai_usage.map((x) => ({ ...x, cle: '' }))) ), false);

/* ---- extraction pour un ordre : panne -> null (manuel), journal tenu ---- */
supabaseAdmin.storage = { from: () => ({ download: async () => ({ data: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), error: null }) }) };
script = [ok(good)]; db.ai_usage.length = 0; process.env.OPENROUTER_API_KEY = 'k1';
const rd = await AI.extractReceiptForOrder('x.jpg', 'ORD9'); t('extractReceiptForOrder : lecture + ordre dans le journal', [rd.kind, db.ai_usage[0].order_id], ['app', 'ORD9']);
script = [{ status: 500, body: 'x' }, { status: 500, body: 'x' }]; t('extractReceiptForOrder : panne -> null (jamais d\'exception)', await AI.extractReceiptForOrder('x.jpg', 'ORD9'), null);

/* ---- budget : GET /api/v1/key ---- */
process.env.OPENROUTER_API_KEY = 'k1'; process.env.OPENROUTER_API_KEY_2 = 'k2'; delete process.env.OPENROUTER_API_KEY_3; delete process.env.OPENROUTER_API_KEY_4;
const info = (o) => ({ status: 200, body: { data: { label: 'x', usage: 5, usage_daily: 0.2, usage_weekly: 1, usage_monthly: 5, limit: null, ...o } } });
keyInfo.k1 = info({ limit: 100, limit_remaining: 95 }); keyInfo.k2 = info({});
let b = await AI.checkOpenRouterBudgets();
t('budget sain : aucune alerte', [b.alerts.length, b.keys.map((k) => k.ok)], [0, [true, true]]);
t('budget : plafond null = sans plafond', [b.keys[0].limit, b.keys[1].limit], [100, null]);
keyInfo.k1 = info({ limit: 10, limit_remaining: 1.5 }); b = await AI.checkOpenRouterBudgets();
t('solde bas (1,50 $ < 2 $) -> alerte', [b.alerts.length, /reste|il reste/.test(b.alerts[0])], [1, true]);
keyInfo.k1 = info({}); keyInfo.k2 = info({ usage_daily: 3 }); b = await AI.checkOpenRouterBudgets();
t('dépense du jour anormale sans plafond (3 $ > 1 $) -> alerte', [b.alerts.length, /OPENROUTER_API_KEY_2/.test(b.alerts[0])], [1, true]);
delete keyInfo.k1; keyInfo.k2 = info({}); b = await AI.checkOpenRouterBudgets();
t('clé invalide (401) -> alerte, l\'autre clé continue', [b.alerts.length, b.keys.map((k) => k.ok)], [1, [false, true]]);
delete keyInfo.k2; b = await AI.checkOpenRouterBudgets();
t('toutes les clés invalides -> alerte critique', /Toutes les clés/.test(b.alerts[0]), true);
for (const n of Object.keys(process.env).filter((n) => n.startsWith('OPENROUTER_API_KEY'))) delete process.env[n];
b = await AI.checkOpenRouterBudgets(); t('aucune clé -> alerte', /Aucune clé/.test(b.alerts[0]), true);

/* ---- Telegram /ia et cron quotidien ---- */
process.env.OPENROUTER_API_KEY = 'k1'; keyInfo.k1 = info({ limit: 10, limit_remaining: 1.5 });
supabaseAdmin.rpc = async () => ({ data: [{ periode: '30_jours', appels: 40, echecs: 2, cout_usd: 0.0123 }, { periode: 'aujourd_hui', appels: 3, echecs: 0, cout_usd: 0.001 }] });
tg.length = 0;
const bot = (text) => new Promise((rs) => botHook({ method: 'POST', headers: {}, body: { message: { text, chat: { id: 1 } } } }, { status: () => ({ json: rs }) }));
await bot('/ia');
t('/ia : rapport (modèles, clé, consommation, alerte)', [/gemini-2\.5-flash → openai\/gpt-4o-mini/.test(tg[0]), /OPENROUTER_API_KEY/.test(tg[0]), /Aujourd'hui : 3 appels/.test(tg[0]), /30 jours : 40 appels.*\$0\.0123/.test(tg[0]), /il reste \$1\.50/.test(tg[0])], [true, true, true, true, true]);
tg.length = 0;
await new Promise((rs) => cronHook({ method: 'GET', headers: {}, query: {} }, { status: () => ({ json: rs }) }));
t('cron quotidien : alerte Telegram « Budget IA »', tg.some((m) => /Budget IA/.test(m) && /il reste \$1\.50/.test(m)), true);
keyInfo.k1 = info({ limit: 100, limit_remaining: 90 }); tg.length = 0;
await new Promise((rs) => cronHook({ method: 'GET', headers: {}, query: {} }, { status: () => ({ json: rs }) }));
t('cron quotidien : budget sain -> aucun message', tg.some((m) => /Budget IA/.test(m)), false);

process.exit(bad ? 1 : 0);
