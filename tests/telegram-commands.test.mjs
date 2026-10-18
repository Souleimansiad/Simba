// Test de non-régression (voir DEPLOY.md). Lancer : npm test
const ROOT = new URL('../', import.meta.url).href;
const NOMOB = process.env.NOMOB === '1';
Object.assign(process.env, { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'k', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ADMIN_CHAT_ID: '1',
  GREENAPI_API_URL: 'https://wa.test', GREENAPI_ID_INSTANCE: '1', GREENAPI_API_TOKEN: 'tok', ADMIN_URL_TOKEN: 'admintok', SMS_WEBHOOK_SECRET: 's' });
delete process.env.OPENROUTER_API_KEY;
if (!NOMOB) Object.assign(process.env, { MOBCASH_CASHBOX_CODE: '12345', MOBCASH_LOGIN: 'cashier', MOBCASH_PASSWORD: 'pw' });
else for (const k of ['MOBCASH_CASHBOX_CODE', 'MOBCASH_LOGIN', 'MOBCASH_PASSWORD']) delete process.env[k];

const { supabaseAdmin } = await import(ROOT + 'api/_lib/supabase.js');
const bot = (await import(ROOT + 'api/admin-bot.js')).default;
const adminApi = (await import(ROOT + 'api/admin.js')).default;
const updatedHook = (await import(ROOT + 'api/hooks/depot-updated.js')).default;
const createdHook = (await import(ROOT + 'api/hooks/depot-created.js')).default;
const smsHook = (await import(ROOT + 'api/sms-webhook.js')).default;

/* ---------- faux Supabase en mémoire ---------- */
const db = { depot_orders: [], retrait_orders: [], waafi_notifications: [], ordre_traite: [], alertes_etat: [], audit_logs: [], circuit_breakers: [], ai_usage: [] };
class Q {
  constructor(t) { this.t = t; this.f = []; this.lim = null; this.op = 'select'; this.sel = false; }
  select() { this.sel = true; return this; }
  eq(k, v) { this.f.push((r) => String(r[k]) === String(v)); return this; }
  neq(k, v) { this.f.push((r) => String(r[k]) !== String(v)); return this; }
  in(k, vs) { this.f.push((r) => vs.map(String).includes(String(r[k]))); return this; }
  not(k, op, v) { this.f.push((r) => op === 'is' ? !(r[k] === null || r[k] === undefined) : !String(v).replace(/[()]/g, '').split(',').includes(String(r[k]))); return this; }
  gte(k, v) { this.f.push((r) => new Date(r[k]) >= new Date(v)); return this; }
  lte(k, v) { this.f.push((r) => new Date(r[k]) <= new Date(v)); return this; }
  lt(k, v) { this.f.push((r) => new Date(r[k]) < new Date(v)); return this; }
  order() { return this; }
  limit(n) { this.lim = n; return this; }
  update(p) { this.op = 'update'; this.patch = p; this.sel = false; return this; }
  delete() { this.op = 'delete'; return this; }
  upsert() { return Promise.resolve({ error: null }); }
  insert(row) {
    if (this.t === 'ordre_traite' && db.ordre_traite.some((r) => r.transfer_id === row.transfer_id)) return Promise.resolve({ error: { code: '23505' } });
    db[this.t].push({ id: ['waafi_notifications'].includes(this.t) ? db[this.t].length + 1 : undefined, created_at: new Date().toISOString(), ...row }); return Promise.resolve({ error: null });
  }
  rows() { let r = db[this.t].filter((x) => this.f.every((fn) => fn(x))); if (this.lim) r = r.slice(0, this.lim); return r; }
  maybeSingle() { const r = this.rows()[0]; return Promise.resolve({ data: r ? { ...r } : null, error: null }); }
  then(res, rej) {
    if (this.op === 'update') { const rows = this.rows(); rows.forEach((r) => Object.assign(r, this.patch)); return Promise.resolve({ data: this.sel ? rows.map((r) => ({ id: r.id })) : null, error: null }).then(res, rej); }
    if (this.op === 'delete') { const rows = this.rows(); db[this.t] = db[this.t].filter((r) => !rows.includes(r)); return Promise.resolve({ data: null, error: null }).then(res, rej); }
    return Promise.resolve({ data: this.rows().map((r) => ({ ...r })), error: null }).then(res, rej);
  }
}
supabaseAdmin.from = (t) => new Q(t);
supabaseAdmin.storage = { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://x/r' } }) }) };

/* ---------- faux MobCash / WhatsApp / Telegram ---------- */
const tg = [], wa = []; let deposits = []; let mob = {};
const mobReply = (status, body) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });
globalThis.fetch = async (u, o) => {
  u = String(u);
  if (u.includes('telegram.org')) { tg.push(JSON.parse(o.body).text); return { ok: true, text: async () => '{}' }; }
  if (u.includes('wa.test')) { wa.push(JSON.parse(o.body)); return { ok: true, status: 200, text: async () => '{}' }; }
  if (u.includes('/cashbox/login')) return mob.login ? mobReply(mob.login.status, mob.login.body) : mobReply(200, { accessToken: 'T', sessionID: 's', userID: 'u' });
  if (u.endsWith('/payerNickname')) return mob.nick ? mobReply(mob.nick.status, mob.nick.body) : mobReply(200, [{ result: { name: 'x' } }]);
  if (u.endsWith('/deposit')) {
    const p = JSON.parse(o.body).params; deposits.push({ payerID: p.deposit.payerID, amount: p.deposit.amount });
    await new Promise((r) => setTimeout(r, mob.depositDelay || 0));
    return mob.deposit ? mobReply(mob.deposit.status, mob.deposit.body) : mobReply(200, { result: {} });
  }
  throw new Error('appel inattendu ' + u);
};
const send = (h, text, chat = 1) => new Promise((rs) => h({ method: 'POST', headers: {}, body: { message: { text, chat: { id: chat } } } }, { status: () => ({ json: rs }) }));
const cmd = async (text, chat) => { tg.length = 0; await send(bot, text, chat); return tg.join('\n'); };
let bad = 0; const t = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) bad++; console.log(ok ? 'OK ' : 'KO ', n, ok ? '' : `(obtenu ${JSON.stringify(g)}, attendu ${JSON.stringify(w)})`); };
const has = (s, ...parts) => parts.map((p) => (p instanceof RegExp ? p.test(s) : s.includes(p)));
let n = 0;
const order = (over = {}) => { const o = { id: `T${++n}`, status: 'en_attente', montant: 50, id_bet1x: '111222333', whatsapp: '77000000', mobcash_status: null, mobcash_attempts: 0, last_error: null, transfer_id: null, receipt_data: null, receipt_path: 'x.jpg', fraud_score: 0, created_at: new Date().toISOString(), updated_at: new Date(Date.now() - 3600e3).toISOString(), ...over }; db.depot_orders.push(o); return o; };
const get = (id) => db.depot_orders.find((o) => o.id === id);
const reset = () => { deposits = []; mob = {}; wa.length = 0; };

if (!NOMOB) {
/* ================= confirme ================= */
let o = order({ receipt_data: { kind: 'app', amount: 50, sender_number: '77329449', sender_name: 'A B', dest_number: '77626050', dest_name: 'Souleiman Siad Soubaneh', date_iso: new Date().toISOString() } });
let r = await cmd(`confirme #${o.id}`);
t('confirme : crédit MobCash + statut crédité', [get(o.id).status, deposits, has(r, '✅', 'crédité', '111222333')], ['credite', [{ payerID: '111222333', amount: '50' }], [true, true, true]]);
t('confirme : clé anti-double-crédit posée', db.ordre_traite.some((x) => x.transfer_id === `order:${o.id}`), true);
t('confirme : journal d\'audit', db.audit_logs.some((a) => a.action === 'telegram:confirme:credite' && a.actor === 'telegram:1'), true);
r = await cmd(`confirme #${o.id}`); t('confirme : 2e fois -> déjà crédité, pas de 2e dépôt', [has(r, 'déjà crédité')[0], deposits.length], [true, 1]);

reset();
db.waafi_notifications.push({ id: 900, type: 'sms_received', transfer_id: '70010001', montant: 70, sender_number: '77329449', sender_name: 'A B', paid_at: new Date().toISOString(), created_at: new Date().toISOString() });
const rd2 = { kind: 'app', amount: 70, sender_number: '77329449', sender_name: 'A B', dest_number: '77626050', dest_name: 'Souleiman Siad Soubaneh', date_iso: new Date().toISOString() };
o = order({ montant: 70, receipt_data: rd2 });
r = await cmd(`/confirme ${o.id}`);
t('confirme : consomme le Transfer ID du SMS correspondant', [get(o.id).status, get(o.id).transfer_id, db.ordre_traite.some((x) => x.transfer_id === '70010001' && x.order_id === o.id), db.ordre_traite.some((x) => x.transfer_id === `order:${o.id}`)], ['credite', '70010001', true, false]);
// le même reçu soumis de nouveau par le client est refusé
const o2 = order({ montant: 70, receipt_data: rd2 });
await new Promise((rs) => createdHook({ method: 'POST', headers: {}, body: { record: o2 } }, { status: () => ({ json: rs }) }));
t('même reçu soumis une 2e fois -> fraude, pas de crédit', [get(o2.id).status, deposits.length], ['fraude', 1]);

reset(); o = order({ status: 'credite' });
t('confirme sur un ordre inconnu / un retrait',
  [has(await cmd('confirme #ZZ-404'), 'introuvable')[0], (db.retrait_orders.push({ id: 'R1', status: 'en_attente' }), has(await cmd('confirme #R1'), 'est un retrait')[0])], [true, true]);
const p = order({ status: 'paiement_recu', mobcash_status: 'echec_permanent', last_error: 'MobCash /payerNickname échoué (500) : x' });
t('confirme sur un paiement déjà confirmé -> conseille relance', has(await cmd(`confirme #${p.id}`), 'relance #' + p.id, 'déjà confirmé'), [true, true]);
t('confirme sur un ordre rejeté', has(await cmd(`confirme #${order({ status: 'rejete' }).id}`), '« rejete »')[0], true);

/* ---- échecs MobCash expliqués à l'agent ---- */
reset(); mob = { nick: { status: 500, body: { error: { message: 'player not found' } } } };
o = order({ id_bet1x: '999' });
r = await cmd(`confirme #${o.id}`);
t('échec ID 1xBet : cause expliquée + commande relance avec bon ID', [get(o.id).status, get(o.id).mobcash_status, has(r, 'ID 1xBet introuvable ou invalide', `relance #${o.id} [bon ID 1xBet]`)], ['paiement_recu', 'echec_permanent', [true, true]]);
t('échec ID 1xBet : le client est prévenu (il doit corriger son ID)', [wa.length, /ID 1xBet indiqué/.test(wa[0]?.message || '')], [1, true]);
t('échec : tentatives comptées, alerte enregistrée', [get(o.id).mobcash_attempts, db.alertes_etat.some((a) => a.order_id === o.id)], [1, true]);

reset(); mob = {}; // l'agent relance avec le bon ID
r = await cmd(`relance #${o.id} 555666777`);
t('relance avec un nouvel ID 1xBet', [get(o.id).status, get(o.id).id_bet1x, deposits, has(r, '✅', '555666777')], ['credite', '555666777', [{ payerID: '555666777', amount: '50' }], [true, true]]);

reset(); mob = { deposit: { status: 400, body: { error: { message: 'Insufficient balance on cashbox' } } } };
o = order({ montant: 200 });
r = await cmd(`confirme #${o.id}`);
t('échec solde insuffisant : cause + « recharger puis relance »', has(r, 'Solde de la caisse MobCash insuffisant', 'Recharger la caisse', 'relance #' + o.id), [true, true, true]);
t('solde insuffisant : le client reçoit le message générique (pas le détail interne)', [wa.length, /intervenir manuellement/.test(wa[0]?.message || ''), /solde|balance/i.test(wa[0]?.message || '')], [1, true, false]);
mob = {}; deposits = [];
r = await cmd(`relance #${o.id}`); t('relance après recharge de la caisse (échec « sûr ») -> crédité', [get(o.id).status, deposits.length], ['credite', 1]);

reset(); mob = { deposit: { status: 400, body: { error: { message: 'currency mismatch' } } } };
o = order(); r = await cmd(`confirme #${o.id}`);
t('échec devise expliqué', has(r, 'Devise du compte 1xBet incompatible')[0], true);

/* ---- échec ambigu : relance protégée contre le double crédit ---- */
reset(); mob = { deposit: { status: 500, body: { message: 'boom' } } };
o = order(); await cmd(`confirme #${o.id}`);
mob = {}; deposits = [];
r = await cmd(`relance #${o.id}`);
t('échec ambigu (500 sur /deposit) : relance refusée sans confirmation', [deposits.length, get(o.id).status, has(r, 'historique MobCash', `relance #${o.id} oui`)], [0, 'paiement_recu', [true, true]]);
r = await cmd(`relance #${o.id} oui`); t('… puis relance avec « oui » -> exécutée', [deposits.length, get(o.id).status], [1, 'credite']);

/* ---- relance : états et verrou ---- */
reset(); o = order();
t('relance sur un ordre en attente -> conseille confirme', has(await cmd(`relance #${o.id}`), `confirme #${o.id}`)[0], true);
t('relance sur un ordre crédité', has(await cmd(`relance #${get('T1').id}`), 'déjà crédité')[0], true);
const f = order({ status: 'paiement_recu', mobcash_status: 'echec_permanent', last_error: 'MobCash /payerNickname échoué (500) : x' });
t('ID 1xBet invalide refusé (caractères)', has(await cmd(`relance #${f.id} ab!`), 'invalide')[0], true);
t('ID 1xBet trop court refusé', has(await cmd(`relance #${f.id} 12`), 'invalide')[0], true);
t('aucun dépôt envoyé pour ces refus', deposits.length, 0);
mob = { depositDelay: 40 };
const [a1, a2] = await Promise.all([cmd(`relance #${f.id}`), (async () => { const tg2 = []; return null; })()]);
// double relance simultanée : un seul dépôt
const g = order({ status: 'paiement_recu', mobcash_status: 'echec_permanent', last_error: 'MobCash /payerNickname échoué (500) : x' });
deposits = []; tg.length = 0;
await Promise.all([send(bot, `relance #${g.id}`), send(bot, `relance #${g.id}`)]);
t('2 relances simultanées -> un seul dépôt MobCash', [deposits.length, get(g.id).status, tg.some((m) => /déjà en cours/.test(m))], [1, 'credite', true]);
mob = {};
const inflight = order({ status: 'paiement_recu', mobcash_status: null, updated_at: new Date().toISOString() });
t('crédit automatique en cours -> relance refusée', has(await cmd(`relance #${inflight.id}`), 'en cours')[0], true);
const stuck = order({ status: 'paiement_recu', mobcash_status: null });
deposits = []; t('paiement_recu sans échec enregistré (ancien) -> demande confirmation', [has(await cmd(`relance #${stuck.id}`), 'oui')[0], deposits.length], [true, 0]);

/* ---- syntaxes et sécurité ---- */
reset(); o = order();
t('variante /confirmer@Bot #id', (await cmd(`/confirmer@Simba_bot #${o.id}`), get(o.id).status), 'credite');
t('commande sans numéro -> usage', [has(await cmd('confirme'), 'Usage')[0], has(await cmd('relance'), 'Usage')[0]], [true, true]);
const x = order(); t('autre chat que l\'admin -> ignoré', [await cmd(`confirme #${x.id}`, 999), get(x.id).status], ['', 'en_attente']);
t('aide : les 2 commandes', has(await cmd('aide'), 'confirme #ORDRE', 'relance #ORDRE'), [true, true]);
order({ status: 'en_attente', id: 'L1' }); order({ status: 'paiement_recu', mobcash_status: 'echec_permanent', id: 'L2' });
r = await cmd('/ordres'); t('/ordres : en attente + crédits à relancer', has(r, 'confirme #L1', 'relance #L2'), [true, true]);

/* ---- panneau admin : même logique ---- */
const api = (action, body, method = 'POST') => new Promise((rs) => adminApi({ method, query: { action }, headers: { 'x-admin-token': 'admintok' }, body }, { status: (c) => ({ json: (j) => rs([c, j]) }) }));
reset(); o = order();
let [code, j] = await api('action-ordre', { order_id: o.id, type: 'depot', action: 'confirmer' });
t('panneau : confirmer un dépôt -> crédité via la logique partagée', [code, get(o.id).status, deposits.length], [200, 'credite', 1]);
[code, j] = await api('action-ordre', { order_id: f.id, type: 'depot', action: 'confirmer' });
t('panneau : confirmer un paiement déjà confirmé -> 409 + conseil', [code, /relance|Relancer|crédit/i.test(j.error)], [409, true]);
const h = order({ status: 'paiement_recu', mobcash_status: 'echec_permanent', last_error: 'MobCash /payerNickname échoué (500) : x' });
deposits = []; [code, j] = await api('retry-deposit', { order_id: h.id, new_id_bet1x: '888777666' });
t('panneau : relance avec nouvel ID', [code, get(h.id).status, get(h.id).id_bet1x, deposits[0]?.payerID], [200, 'credite', '888777666', '888777666']);
mob = { nick: { status: 500, body: { error: { message: 'nope' } } } };
const h2 = order({ status: 'paiement_recu', mobcash_status: 'echec_permanent', last_error: 'x /payerNickname' });
[code, j] = await api('retry-deposit', { order_id: h2.id }); t('panneau : relance en échec -> 502', [code, /ID 1xBet/.test(j.error)], [502, true]);
mob = {};

/* ---- notifications client : seulement au crédit ---- */
wa.length = 0; tg.length = 0;
const rec = { id: 'N1', status: 'credite', montant: 50, id_bet1x: '4242', whatsapp: '77123456' };
await new Promise((rs) => updatedHook({ method: 'POST', headers: {}, body: { record: rec, old_record: { ...rec, status: 'paiement_recu' } } }, { status: () => ({ json: rs }) }));
t('crédité : un seul WhatsApp, avec l\'ID 1xBet', [wa.length, /crédité avec succès/.test(wa[0]?.message), /4242/.test(wa[0]?.message)], [1, true, true]);
wa.length = 0;
for (const st of ['paiement_recu', 'rejete', 'fraude']) await new Promise((rs) => updatedHook({ method: 'POST', headers: {}, body: { record: { ...rec, status: st }, old_record: { ...rec, status: 'en_attente' } } }, { status: () => ({ json: rs }) }));
t('paiement reçu / rejeté / fraude : aucun WhatsApp client', wa.length, 0);
t('… mais l\'admin voit « Paiement reçu » sur Telegram', tg.some((m) => /Paiement reçu/.test(m)), true);

/* ---- parcours automatique : plus de messages intermédiaires ---- */
reset(); tg.length = 0;
const tidNow = new Date(); const rdA = { kind: 'app', amount: 55, sender_number: '77329449', sender_name: 'A B', dest_number: '77626050', dest_name: 'Souleiman Siad Soubaneh', date_iso: tidNow.toISOString() };
const oa = order({ montant: 55, receipt_data: rdA });
await send(smsHook, '', 1).catch(() => {});
await new Promise((rs) => smsHook({ method: 'POST', headers: { 'x-sms-secret': 's' }, body: { titre: 'WAAFI SAS', notification: 'WAAFI -> Transfer-Id: 80010001, You have Received DJF 55 from A B(77329449), Your Balance is: DJF 85.' } }, { status: () => ({ json: rs }) }));
t('SMS reçu -> crédité automatiquement', [get(oa.id).status, deposits.length], ['credite', 1]);
t('auto : aucun WhatsApp « paiement reçu » ni double message de succès', wa.length, 0);
reset(); mob = { nick: { status: 500, body: { error: { message: 'unknown player' } } } };
const ob = order({ montant: 66, receipt_data: { ...rdA, amount: 66, date_iso: new Date().toISOString() } }); tg.length = 0;
await new Promise((rs) => smsHook({ method: 'POST', headers: { 'x-sms-secret': 's' }, body: { titre: 'WAAFI SAS', notification: 'WAAFI -> Transfer-Id: 80020002, You have Received DJF 66 from A B(77329449), Your Balance is: DJF 85.' } }, { status: () => ({ json: rs }) }));
const alertTxt = tg.find((m) => /crédit MobCash en échec/.test(m)) || '';
t('auto : échec -> alerte admin avec cause + commande relance', [get(ob.id).status, ...has(alertTxt, 'ID 1xBet introuvable', `relance #${ob.id}`, '[bon ID 1xBet]')], ['paiement_recu', true, true, true]);
t('auto : échec -> le client est prévenu une fois', wa.length, 1);
} else {
/* ================= mode manuel (MobCash non configuré) ================= */
let o = order(); let r = await cmd(`confirme #${o.id}`);
t('MobCash non configuré : confirme clôture l\'ordre', [get(o.id).status, deposits.length, has(r, 'à faire à la main')[0]], ['credite', 0, true]);
const p = order({ status: 'paiement_recu', mobcash_status: 'echec_permanent', last_error: 'x' });
t('MobCash non configuré : relance impossible', has(await cmd(`relance #${p.id}`), 'non configuré')[0], true);
}
process.exit(bad ? 1 : 0);
