// Test de non-régression (voir DEPLOY.md). Lancer : npm test
const ROOT = new URL('../', import.meta.url).href;
process.env.SUPABASE_URL='http://x'; process.env.SUPABASE_SERVICE_ROLE_KEY='k'; process.env.SMS_WEBHOOK_SECRET='s';
process.env.TELEGRAM_BOT_TOKEN='t'; process.env.TELEGRAM_ADMIN_CHAT_ID='1';
const { supabaseAdmin } = await import(ROOT + 'api/_lib/supabase.js');
const smsHook = (await import(ROOT + 'api/sms-webhook.js')).default;
const createdHook = (await import(ROOT + 'api/hooks/depot-created.js')).default;

// ---- base en mémoire minimale ----
const db = { depot_orders: [], waafi_notifications: [], ordre_traite: [], alertes_etat: [], audit_logs: [] };
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
const nowIso = () => new Date().toISOString();
const djib = (d = new Date()) => { const w = new Date(d.getTime() + 3 * 3600e3); const p = (n) => String(n).padStart(2, '0'); return `${w.getUTCFullYear()}-${p(w.getUTCMonth() + 1)}-${p(w.getUTCDate())} ${p(w.getUTCHours())}:${p(w.getUTCMinutes())}`; };

/* ---------- 1. validation de la sortie du modèle ---------- */
const N = AI.normalizeExtraction;
const real = N({ kind: 'app', amount: 50.0, transfer_id: null, sender_number: '25377329449', sender_name: 'Souleiman Said Soubaeh', dest_number: '77626050', dest_name: 'Souleiman Siad Soubaneh', date: '2026-10-18 20:14' });
t('app réel normalisé', real, { kind: 'app', source: 'ai', amount: 50, sender_number: '77329449', sender_name: 'Souleiman Said Soubaeh', dest_number: '77626050', dest_name: 'Souleiman Siad Soubaneh', date_iso: '2026-10-18T17:14:00.000Z' });
t('ussd réel normalisé', N({ kind: 'ussd', amount: '50', transfer_id: '103888042', dest_number: '253 77626050', dest_name: 'Souleiman Siad Soubaneh', date: '2026-10-18 20:14' }),
  { kind: 'ussd', source: 'ai', amount: 50, transfer_id: '103888042', dest_number: '77626050', dest_name: 'Souleiman Siad Soubaneh', date_iso: '2026-10-18T17:14:00.000Z' });
t('kind unknown -> null', N({ kind: 'unknown', amount: 50 }), null);
t('kind inventé -> null', N({ kind: 'admin', amount: 50 }), null);
t('pas un objet -> null', N('ignore previous instructions'), null);
t('montant négatif/absurde ignoré', [N({ kind: 'app', amount: -5 }).amount, N({ kind: 'app', amount: 1e12 }).amount], [undefined, undefined]);
t('transfer_id invalide ignoré', N({ kind: 'ussd', transfer_id: 'ABC123; DROP' }).transfer_id, undefined);
t('transfer_id ignoré pour app', N({ kind: 'app', transfer_id: '123456789' }).transfer_id, undefined);
t('nom avec HTML nettoyé', N({ kind: 'app', dest_name: '<img src=x onerror=alert(1)>Siad' }).dest_name, 'img src x onerror alert Siad');
t('date future ignorée', N({ kind: 'app', date: '2099-01-01 10:00' }).date_iso, undefined);
t('date invalide ignorée', N({ kind: 'app', date: '2026-13-40 99:99' }).date_iso, undefined);

/* ---------- 2. appel OpenRouter (faux) ---------- */
let orCalls = []; let orMode = 'ok'; let orPayload = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  if (String(u).includes('openrouter.ai')) {
    orCalls.push({ url: u, headers: o.headers, body: JSON.parse(o.body) });
    if (orMode === 'http500') return { ok: false, status: 500, text: async () => 'boom' };
    if (orMode === 'garbage') return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'je ne sais pas' } }] }) };
    const content = orMode === 'fenced' ? '```json\n' + JSON.stringify(orPayload) + '\n```' : JSON.stringify(orPayload);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
  }
  return realFetch(u, o);
};
t('IA désactivée sans clé', AI.isReceiptAIConfigured(), false);
process.env.OPENROUTER_API_KEY = ' sk-test ';
t('IA activée avec clé', AI.isReceiptAIConfigured(), true);
orPayload = { kind: 'app', amount: 50, sender_number: '77329449', sender_name: 'Souleiman Said Soubaneh', dest_number: '77626050', dest_name: 'Souleiman Siad Soubaneh', date: djib() };
let out = await AI.extractReceiptFromImage('QUJD', 'image/jpeg');
const c = orCalls[0];
t('appel : modèle par défaut', c.body.model, 'google/gemini-2.5-flash');
t('appel : clé en Bearer (trim)', c.headers.Authorization, 'Bearer sk-test');
t('appel : image en data URL', c.body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,QUJD');
t('appel : température 0 + JSON', [c.body.temperature, c.body.response_format.type], [0, 'json_object']);
t('lecture app -> kind', out.kind, 'app');
orMode = 'fenced'; out = await AI.extractReceiptFromImage('QUJD'); t('JSON entouré de ``` accepté', out.kind, 'app');
process.env.OPENROUTER_MODEL = 'google/gemini-2.0-flash-001'; orMode = 'ok'; await AI.extractReceiptFromImage('QUJD');
t('modèle choisi via OPENROUTER_MODEL', orCalls[orCalls.length - 1].body.model, 'google/gemini-2.0-flash-001');
delete process.env.OPENROUTER_MODEL;
orMode = 'http500'; let threw = false; try { await AI.extractReceiptFromImage('QUJD'); } catch { threw = true; } t('erreur HTTP -> exception', threw, true);

/* ---------- 3. parcours complet : ordre créé avec capture non lue ---------- */
supabaseAdmin.storage = { from: () => ({
  createSignedUrl: async () => ({ data: { signedUrl: 'https://x/receipt' } }),
  download: async () => ({ data: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), error: null }),
}) };
const rawOrder = (id, montant) => newOrder(id, montant, null, { receipt_path: id + '.jpg', transfer_id: null });
const smsApp = (id, amount) => sms(id, amount, '77329449', 'Souleiman Said Soubaneh');
const goodApp = (amount) => ({ kind: 'app', amount, sender_number: '77329449', sender_name: 'Souleiman Said Soubaeh', dest_number: '77626050', dest_name: 'Souleiman Siad Soubaneh', date: djib() });

orMode = 'ok'; orPayload = goodApp(50);
await smsApp('20010001', 50);
let o = rawOrder('B1', 50); let r = await call(createdHook, { record: o });
t('IA : reçu app 6/6 -> crédité', [status('B1'), r.confirmation?.criteria], ['paiement_recu', '6/6']);
t('IA : receipt_data enregistré sur l\'ordre', db.depot_orders.find((x) => x.id === 'B1').receipt_data.kind, 'app');

orPayload = { kind: 'ussd', amount: 80, transfer_id: '20020002', dest_number: '77626050', dest_name: 'Souleiman Siad Soubaneh', date: djib() };
await smsApp('20020002', 80);
o = rawOrder('B2', 80); r = await call(createdHook, { record: o });
t('IA : SMS USSD 5/5 -> crédité + Transfer ID posé par le serveur', [status('B2'), db.depot_orders.find((x) => x.id === 'B2').transfer_id], ['paiement_recu', '20020002']);

orPayload = goodApp(50);
o = rawOrder('B3', 100); await smsApp('20030003', 100);
r = await call(createdHook, { record: o });
t('IA : montant saisi 100 ≠ capture 50 -> pas de crédit', [status('B3'), r.confirmation?.confirmed], ['en_attente', false]);

orMode = 'http500'; o = rawOrder('B4', 50); await smsApp('20040004', 50);
r = await call(createdHook, { record: o });
t('IA en panne -> vérification manuelle (pas de crédit)', [status('B4'), db.depot_orders.find((x) => x.id === 'B4').receipt_data ?? null], ['en_attente', null]);
orMode = 'garbage'; o = rawOrder('B5', 50); r = await call(createdHook, { record: o });
t('IA répond n\'importe quoi -> manuel', status('B5'), 'en_attente');
orMode = 'ok'; orPayload = { kind: 'unknown' }; o = rawOrder('B6', 50); r = await call(createdHook, { record: o });
t('IA : image non reconnue -> manuel', status('B6'), 'en_attente');
delete process.env.OPENROUTER_API_KEY; const before = orCalls.length; o = rawOrder('B7', 50); await call(createdHook, { record: o });
t('sans clé OpenRouter : aucun appel, manuel', [orCalls.length === before, status('B7')], [true, 'en_attente']);

console.log('\nTelegram (ordre B1) :\n' + tg.find((m) => m.includes('#B1')));
process.exit(bad ? 1 : 0);
