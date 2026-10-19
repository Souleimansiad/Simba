// Date des captures : le code convertit (jour d'abord), jamais le modèle. Voir DEPLOY.md.
const ROOT = new URL('../', import.meta.url).href;
process.env.SUPABASE_URL='http://x'; process.env.SUPABASE_SERVICE_ROLE_KEY='k';
const { parseReceiptDate, normalizeExtraction } = await import(ROOT + 'api/_lib/receiptAI.js');
let bad = 0; const t = (n, g, w) => { const ok = g === w; if (!ok) bad++; console.log(ok ? 'OK ' : 'KO ', n, ok ? '' : `(obtenu ${g}, attendu ${w})`); };
t('19.10.26 11:29 (le cas qui échouait : lu 2019)', parseReceiptDate('19.10.26 11:29'), '2026-10-19T08:29:00.000Z');
t('18.10.26 20:14 (lu 2018)', parseReceiptDate('18.10.26 20:14'), '2026-10-18T17:14:00.000Z');
t('19/10/26 11:29:03 (SMS USSD)', parseReceiptDate('19/10/26 11:29:03'), '2026-10-19T08:29:00.000Z');
t('18/10/26 20:14:11', parseReceiptDate('18/10/26 20:14:11'), '2026-10-18T17:14:00.000Z');
t('19.10.2026 11:29 (année sur 4 chiffres)', parseReceiptDate('19.10.2026 11:29'), '2026-10-19T08:29:00.000Z');
t('espaces et h : 19 . 10 . 26  11h29', parseReceiptDate('19 . 10 . 26  11h29'), '2026-10-19T08:29:00.000Z');
t('heure d\'abord : 11:29 19.10.26', parseReceiptDate('11:29 19.10.26'), '2026-10-19T08:29:00.000Z');
t('ISO 2026-10-19 11:29 (pas lu 26-10-19)', parseReceiptDate('2026-10-19 11:29'), '2026-10-19T08:29:00.000Z');
t('ISO avec T : 2026-10-19T11:29', parseReceiptDate('2026-10-19T11:29'), '2026-10-19T08:29:00.000Z');
t('texte autour : Transaction date 19.10.26 11:29', parseReceiptDate('Transaction date 19.10.26 11:29'), '2026-10-19T08:29:00.000Z');
t('mois impossible (31.13.26)', parseReceiptDate('31.13.26 10:00'), null);
t('jour impossible (31.02.26)', parseReceiptDate('31.02.26 10:00'), null);
t('année absurde (19.10.19 : 2019)', parseReceiptDate('19.10.19 11:29'), null);
t('date sans heure', parseReceiptDate('19.10.26'), null);
t('futur lointain', parseReceiptDate('19.10.30 11:29'), null);
t('vide / null', [parseReceiptDate(''), parseReceiptDate(null)].join(), ',');
// l'ancien champ « date » (ISO) : accepté seulement s'il est plausible
t('ancien champ date mal lu (2019-10-26) rejeté', normalizeExtraction({ kind: 'app', amount: 50, date: '2019-10-26 11:29' }).date_iso, undefined);
t('ancien champ date correct accepté', normalizeExtraction({ kind: 'app', amount: 50, date: '2026-10-19 11:29' }).date_iso, '2026-10-19T08:29:00.000Z');
const n = normalizeExtraction({ kind: 'ussd', transfer_id: '103994947', amount: 50, dest_number: '77626050', dest_name: 'Souleiman Siad Soubaneh', date_raw: '19/10/26 11:29:03', date: '2019-10-26 11:29' });
t('date_raw prioritaire sur un « date » faux', n.date_iso, '2026-10-19T08:29:00.000Z');
t('date_raw conservé pour audit', n.date_raw, '19/10/26 11:29:03');

/* ---- messages d'écart montrés à l'agent et au client ---- */
const { evaluateReceipt, failedReasons } = await import(ROOT + 'api/_lib/receiptMatch.js');
const order = { montant: 50, receipt_data: { kind: 'ussd', transfer_id: '103994947', amount: 50, dest_number: '77626050', dest_name: 'Souleiman Siad Soubaneh', date_iso: '2026-10-26T08:29:00.000Z' } };
const sms = { transfer_id: '103994947', montant: 50, paid_at: '2026-10-19T08:29:45.291Z' };
const reasons = failedReasons(evaluateReceipt(order, sms));
t('écart de date : texte lisible, heure de Djibouti, accord féminin', reasons.join(' | '), 'Date différente (reçu : 26/10/2026 11:29 / SMS : 19/10/2026 11:29)');
t('plus de date ISO brute dans le message', /T\d\d:\d\d:\d\d/.test(reasons.join('')), false);
t('écart de montant : accord masculin', failedReasons(evaluateReceipt({ ...order, montant: 60 }, { ...sms, paid_at: '2026-10-26T08:29:10Z' })).some((x) => x.startsWith('Montant différent')), true);
process.exit(bad ? 1 : 0);
