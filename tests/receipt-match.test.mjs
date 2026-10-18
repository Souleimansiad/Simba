// Test de non-régression (voir DEPLOY.md). Lancer : npm test
const ROOT = new URL('../', import.meta.url).href;
process.env.SUPABASE_URL='http://x'; process.env.SUPABASE_SERVICE_ROLE_KEY='k';
const { evaluateReceipt, sameName, isShopName } = await import(ROOT + 'api/_lib/receiptMatch.js');
let bad = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) bad++; console.log(ok ? 'OK ' : 'KO ', name, ok ? '' : `(obtenu ${got}, attendu ${want})`); };

const app = { kind:'app', amount:50, date_iso:'2026-10-18T17:14:00.000Z', sender_number:'77329449', sender_name:'Souleiman Said Soubaeh', dest_number:'77626050', dest_name:'Souleiman Siad Soubaneh' };
const ussd = { kind:'ussd', transfer_id:'103888042', amount:50, dest_name:'Souleiman Siad Soubaneh', dest_number:'77626050', date_iso:'2026-10-18T17:14:00.000Z' };
const sms = { transfer_id:'103888042', montant:50, sender_number:'77329449', sender_name:'Souleiman Said Soubaneh', paid_at:'2026-10-18T17:14:07.000Z' };
const ord = (rd, m = 50) => ({ montant: m, receipt_data: rd });

let e = evaluateReceipt(ord(app), sms);
t('APP réel : 6/6', `${e.passed}/${e.total}`, '6/6');
t('APP réel : ok', e.ok, true);
e = evaluateReceipt(ord(ussd), sms);
t('USSD réel : 5/5', `${e.passed}/${e.total}`, '5/5');

t('app : montant ordre ≠ capture', evaluateReceipt(ord(app, 100), { ...sms, montant: 100 }).ok, false);
t('app : montant SMS ≠', evaluateReceipt(ord(app), { ...sms, montant: 500 }).ok, false);
t('app : autre n° expéditeur', evaluateReceipt(ord(app), { ...sms, sender_number: '77111111' }).ok, false);
t('app : autre nom expéditeur', evaluateReceipt(ord(app), { ...sms, sender_name: 'Ahmed Daye Warsama' }).ok, false);
t('app : date +30 min', evaluateReceipt(ord(app), { ...sms, paid_at: '2026-10-18T17:44:00.000Z' }).ok, false);
t('app : date +5 min (toléré)', evaluateReceipt(ord(app), { ...sms, paid_at: '2026-10-18T17:19:00.000Z' }).ok, true);
t('app : n° destinataire = autre', evaluateReceipt(ord({ ...app, dest_number:'77000000' }), sms).ok, false);
t('app : nom destinataire = autre', evaluateReceipt(ord({ ...app, dest_name:'Ahmed Daye Warsama' }), sms).ok, false);
t('app : nom destinataire 1 seul mot', evaluateReceipt(ord({ ...app, dest_name:'Siad' }), sms).ok, false);
t('app : dest "Siad Soubaneh Kawaleh"', evaluateReceipt(ord({ ...app, dest_name:'Siad Soubaneh Kawaleh' }), sms).ok, true);
t('app : champ manquant (date)', evaluateReceipt(ord({ ...app, date_iso: undefined }), sms).ok, false);
t('ussd : autre Transfer ID', evaluateReceipt(ord(ussd), { ...sms, transfer_id:'999999999' }).ok, false);
t('ussd : sans SMS expéditeur (non requis)', evaluateReceipt(ord(ussd), { ...sms, sender_number:null, sender_name:null }).ok, true);
t('capture non reconnue', evaluateReceipt(ord(null), sms).applicable, false);

t('sameName OCR tronqué', sameName('Souleiman Said Soubaeh', 'Souleiman Said Soubaneh'), true);
t('sameName accents', sameName('Siad Soubanéh', 'siad soubaneh'), true);
t('sameName différents', sameName('Ali Omar', 'Ahmed Warsama'), false);
t('isShopName', isShopName('Souleiman Siad Soubaneh'), true);
process.exit(bad ? 1 : 0);
