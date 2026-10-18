// Lance toutes les suites de tests, une par processus (chacune simule Supabase,
// MobCash, WhatsApp, Telegram et OpenRouter : aucun appel réseau réel).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const suites = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()
  .flatMap((f) => f === 'telegram-commands.test.mjs'
    ? [{ name: f, env: {} }, { name: `${f} (MobCash non configuré)`, file: f, env: { NOMOB: '1' } }]
    : [{ name: f, env: {} }]);

let failed = 0;
for (const s of suites) {
  const r = spawnSync(process.execPath, [new URL(s.file || s.name, dir).pathname], { env: { ...process.env, ...s.env }, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  const ok = (out.match(/^OK /gm) || []).length;
  const ko = (out.match(/^KO /gm) || []).length;
  const pass = r.status === 0 && ko === 0 && ok > 0;
  console.log(`${pass ? '✅' : '❌'} ${s.name} : ${ok} OK${ko ? `, ${ko} KO` : ''}`);
  if (!pass) { failed++; console.log(out.split('\n').filter((l) => /^KO |Error/.test(l)).join('\n')); }
}
console.log(failed ? `\n${failed} suite(s) en échec` : '\nToutes les suites passent');
process.exit(failed ? 1 : 0);
