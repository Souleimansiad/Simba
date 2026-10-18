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

const nowIso = () => new Date().toISOString();
const appRd = (over = {}) => ({ kind: 'app', amount: 50, date_iso: nowIso(), sender_number: '77329449', sender_name: 'Souleiman Said Soubaeh', dest_number: '77626050', dest_name: 'Souleiman Siad Soubaneh', ...over });

// 1) SMS d'abord, puis l'ordre (cas le plus courant)
await sms('10010001', 50, '77329449', 'Souleiman Said Soubaneh');
let o = newOrder('A1', 50, appRd());
let r = await call(createdHook, { record: o });
t('1. SMS puis ordre (app 6/6) -> crédité', [status('A1'), o.transfer_id ?? db.depot_orders[0].transfer_id, r.confirmation?.criteria], ['paiement_recu', '10010001', '6/6']);
t('1. Transfer ID du SMS enregistré sur l\'ordre', db.depot_orders.find((x) => x.id === 'A1').transfer_id, '10010001');

// 2) ordre d'abord, puis le SMS
o = newOrder('A2', 70, appRd({ amount: 70 }));
await call(createdHook, { record: o });
t('2a. ordre sans SMS -> reste en attente', status('A2'), 'en_attente');
r = await sms('10020002', 70, '77329449', 'Souleiman Said Soubaneh');
t('2b. SMS ensuite -> ordre crédité', [status('A2'), r.confirmed], ['paiement_recu', true]);

// 3) critères non concordants -> jamais crédité
newOrder('A3', 90, appRd({ amount: 90, sender_number: '77111111' }));
r = await sms('10030003', 90, '77329449', 'Souleiman Said Soubaneh');
t('3. autre n° expéditeur -> pas de crédit', [status('A3'), r.reason], ['en_attente', 'order_not_found']);
newOrder('A4', 95, appRd({ amount: 95, dest_number: '77000000' }));
r = await sms('10040004', 95, '77329449', 'Souleiman Said Soubaneh');
t('4. destinataire ≠ boutique -> pas de crédit', status('A4'), 'en_attente');
newOrder('A5', 55, appRd({ amount: 55, date_iso: new Date(Date.now() - 3600e3).toISOString() }));
r = await sms('10050005', 55, '77329449', 'Souleiman Said Soubaneh');
t('5. date à 1 h du SMS -> pas de crédit', status('A5'), 'en_attente');

// 6) deux ordres identiques en attente -> ambigu, pas de crédit
newOrder('A6', 60, appRd({ amount: 60 })); newOrder('A7', 60, appRd({ amount: 60 }));
r = await sms('10060006', 60, '77329449', 'Souleiman Said Soubaneh');
t('6. 2 ordres identiques -> ambigu, aucun crédité', [status('A6'), status('A7'), r.reason], ['en_attente', 'en_attente', 'ambiguous']);

// 7) SMS USSD : Transfer ID, destinataire, date, montant
const u = { kind: 'ussd', transfer_id: '103888042', amount: 80, dest_name: 'Souleiman Siad Soubaneh', dest_number: '77626050', date_iso: nowIso() };
await sms('103888042', 80, '77329449', 'Souleiman Said Soubaneh');
o = newOrder('U1', 80, u);
r = await call(createdHook, { record: o });
t('7. USSD (Transfer ID + dest + date) -> crédité', [status('U1'), r.confirmation?.criteria], ['paiement_recu', '5/5']);
await sms('103888099', 81, '77329449', 'Souleiman Said Soubaneh');
o = newOrder('U2', 81, { ...u, transfer_id: '103888099', amount: 81, dest_name: 'Ahmed Daye Warsama' });
r = await call(createdHook, { record: o });
t('8. USSD mauvais destinataire -> pas de crédit', status('U2'), 'en_attente');

// 9) la même capture ne sert qu'une fois (SMS déjà consommé)
o = newOrder('A8', 50, appRd());
r = await call(createdHook, { record: o });
t('9. capture réutilisée -> détectée (fraude), pas de crédit', status('A8'), 'fraude');


// 11) l'heure de soumission de l'ordre n'entre jamais en jeu : seule la date du reçu compte
const DAY = 24 * 3600e3;
// 11a) ordre soumis il y a 5 jours (en attente), le SMS n'arrive que maintenant, date du reçu = maintenant
o = newOrder('L1', 65, appRd({ amount: 65 }), { created_at: new Date(Date.now() - 5 * DAY).toISOString() });
r = await sms('30010001', 65, '77329449', 'Souleiman Said Soubaneh');
t('11a. ordre soumis il y a 5 jours -> SMS reçu maintenant -> crédité', status('L1'), 'paiement_recu');
// 11b) SMS arrivé il y a 3 jours, client qui soumet son ordre seulement maintenant (reçu daté d'il y a 3 jours)
const threeDays = new Date(Date.now() - 3 * DAY);
db.waafi_notifications.push({ id: 9001, type: 'sms_received', transfer_id: '30020002', montant: 75, sender_number: '77329449', sender_name: 'Souleiman Said Soubaneh', paid_at: new Date(threeDays.getTime() + 20e3).toISOString(), created_at: new Date(threeDays.getTime() + 20e3).toISOString() });
o = newOrder('L2', 75, appRd({ amount: 75, date_iso: threeDays.toISOString() }));
r = await call(createdHook, { record: o });
t('11b. SMS d\'il y a 3 jours, ordre soumis maintenant -> crédité', [status('L2'), r.confirmation?.criteria], ['paiement_recu', '6/6']);
// 11c) un reçu dont la date ne correspond à aucun SMS n'est jamais crédité, même soumis à l'instant du SMS
o = newOrder('L3', 85, appRd({ amount: 85, date_iso: new Date(Date.now() - 2 * DAY).toISOString() }));
r = await sms('30030003', 85, '77329449', 'Souleiman Said Soubaneh');
t('11c. date du reçu ≠ heure du SMS -> pas de crédit (même ordre récent)', status('L3'), 'en_attente');

// 10) capture illisible -> manuel
o = newOrder('M1', 50, null, { fraud_score: 0 });
await sms('10100010', 50, '77329449', 'Souleiman Said Soubaneh');
r = await call(createdHook, { record: o });
t('10. capture non lue -> vérification manuelle', [status('M1'), r.confirmation], ['en_attente', null]);

console.log('\nTelegram envoyés :', tg.length);
console.log('--- extrait (ordre A1) ---\n' + tg.find((m) => m.includes('Nouvel ordre')));
process.exit(bad ? 1 : 0);
