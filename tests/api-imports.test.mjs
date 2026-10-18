// Chaque route /api se charge sans erreur (imports, syntaxe, dépendances circulaires)
// et exporte un handler. Vercel déploie une fonction par fichier : une erreur
// d'import casserait la route en production sans qu'aucun autre test ne le voie.
import { readdirSync, statSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
Object.assign(process.env, { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'k', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ADMIN_CHAT_ID: '1' });

const routes = [];
const walk = (rel) => {
  for (const f of readdirSync(new URL(rel, ROOT))) {
    const path = rel + f;
    if (path === 'api/_lib') continue;
    if (statSync(new URL(path, ROOT)).isDirectory()) walk(path + '/');
    else if (f.endsWith('.js')) routes.push(path);
  }
};
walk('api/');

let bad = 0;
for (const r of routes.sort()) {
  try {
    const m = await import(new URL(r, ROOT).href);
    const ok = typeof m.default === 'function';
    if (!ok) bad++;
    console.log(ok ? 'OK ' : 'KO ', r, ok ? '' : '(pas de handler par défaut)');
  } catch (err) { bad++; console.log('KO ', r, err.message); }
}
// Hobby : 12 fonctions serverless au maximum par déploiement.
const many = routes.length > 12;
if (many) bad++;
console.log(many ? 'KO ' : 'OK ', `${routes.length} fonctions serverless (maximum 12 sur le plan Hobby)`);
// Chaque module partagé se charge aussi.
for (const f of readdirSync(new URL('api/_lib/', ROOT)).filter((x) => x.endsWith('.js'))) {
  try { await import(new URL('api/_lib/' + f, ROOT).href); console.log('OK ', 'api/_lib/' + f); }
  catch (err) { bad++; console.log('KO ', 'api/_lib/' + f, err.message); }
}
process.exit(bad ? 1 : 0);
