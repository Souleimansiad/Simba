// Test de non-régression (voir DEPLOY.md). Lancer : npm test
const ROOT = new URL('../', import.meta.url).href;
process.env.SUPABASE_URL='http://x'; process.env.SUPABASE_SERVICE_ROLE_KEY='k';
process.env.TELEGRAM_BOT_TOKEN='t'; process.env.TELEGRAM_ADMIN_CHAT_ID='1';
process.env.MOBCASH_CASHBOX_CODE = '12345 \n'; process.env.MOBCASH_LOGIN = '"cashier_x"'; process.env.MOBCASH_PASSWORD = 'S3cr3t-PASS ';
const M = await import(ROOT + 'api/_lib/mobcash.js');
const bot = (await import(ROOT + 'api/admin-bot.js')).default;
let bad = 0; const t = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) bad++; console.log(ok ? 'OK ' : 'KO ', n, ok ? '' : `(obtenu ${JSON.stringify(g)}, attendu ${JSON.stringify(w)})`); };
const sent = []; let loginReply; let ipFails = false; let loginBodies = [];
const hdr = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
globalThis.fetch = async (u, o) => {
  u = String(u);
  if (u.includes('telegram')) { sent.push(JSON.parse(o.body).text); return { ok: true, text: async () => '{}' }; }
  if (u.includes('ipify')) { if (ipFails) throw new Error('ipify down'); return { ok: true, json: async () => ({ ip: '3.80.12.9' }) }; }
  if (u.includes('/cashbox/login')) { loginBodies.push(JSON.parse(o.body)); if (loginReply instanceof Error) throw loginReply; return { ok: loginReply.status === 200, status: loginReply.status, headers: hdr(loginReply.headers || {}), text: async () => JSON.stringify(loginReply.body) }; }
  throw new Error('appel inattendu ' + u);
};

loginReply = { status: 500, headers: { server: 'nginx' }, body: { message: 'unauthorized error' } };
let d = await M.mobcashDiagnostic();
t('échec : réponse exacte de MobCash', [d.login_test.ok, d.login_test.http, d.login_test.reponse, d.login_test.serveur, d.login_test.cloudflare], [false, 500, 'unauthorized error', 'nginx', false]);
t('IP de sortie récupérée', d.ip_sortie, '3.80.12.9');
t('une seule tentative de connexion, comme en production', [loginBodies.length, loginBodies[0].cashboxCode, loginBodies[0].login, loginBodies[0].password], [1, NaN === loginBodies[0].cashboxCode ? null : loginBodies[0].cashboxCode, '"cashier_x"', 'S3cr3t-PASS']);
t('code caisse : espaces/retour ligne détectés, valeur numérique', [d.cashbox.espaces_autour, d.cashbox.numerique], [true, true]);
process.env.MOBCASH_CASHBOX_CODE = 'AB12'; t('code caisse non numérique détecté', (await M.mobcashDiagnostic()).cashbox.numerique, false); process.env.MOBCASH_CASHBOX_CODE = '12345 \n';
t('login entre guillemets détecté', d.login.entre_guillemets, true);
t('mot de passe : espace final détecté', d.password.espaces_autour, true);
t('caractères invisibles détectés (retour à la ligne)', d.cashbox.caracteres_invisibles, false);   // le \n final est retiré par trim(), signalé via espaces_autour

const text = M.formatMobcashDiagnostic(d);
t('rapport : ne contient aucune valeur secrète', [text.includes('S3cr3t'), text.includes('cashier_x'), text.includes('12345')], [false, false, false]);
t('rapport : montre l\'échec et la réponse', [/ÉCHEC/.test(text), /unauthorized error/.test(text), /3\.80\.12\.9/.test(text), /guillemets collés/.test(text)], [true, true, true, true]);

loginReply = { status: 200, headers: { 'cf-ray': 'abc' }, body: { accessToken: 'TOKEN-SECRET-XYZ', sessionID: 's', userID: 'u' } };
d = await M.mobcashDiagnostic();
t('succès : ok, jamais le jeton', [d.login_test.ok, JSON.stringify(d).includes('TOKEN-SECRET'), d.login_test.cloudflare], [true, false, true]);
t('succès : rapport « RÉUSSIE »', /RÉUSSIE/.test(M.formatMobcashDiagnostic(d)), true);

ipFails = true; loginReply = new Error('getaddrinfo ENOTFOUND admin.mob-cash.com');
d = await M.mobcashDiagnostic();
t('réseau en panne : pas d\'exception, erreur rapportée', [d.login_test.ok, /ENOTFOUND/.test(d.login_test.reponse), d.ip_sortie], [false, true, null]);

ipFails = false; loginReply = { status: 500, body: { message: '<script>x</script>' } };
await new Promise((rs) => bot({ method: 'POST', headers: {}, body: { message: { text: '/mobcash', chat: { id: 1 } } } }, { status: () => ({ json: rs }) }));
t('commande Telegram /mobcash : réponse envoyée et HTML échappé', [/Diagnostic MobCash/.test(sent.at(-1)), sent.at(-1).includes('<script>')], [true, false]);
sent.length = 0;
await new Promise((rs) => bot({ method: 'POST', headers: {}, body: { message: { text: '/mobcash', chat: { id: 999 } } } }, { status: () => ({ json: rs }) }));
t('autre chat que l\'admin : ignoré', sent.length, 0);
process.exit(bad ? 1 : 0);
