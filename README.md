# Simba — Dépôt & Retrait 1xBet via Waafi

Plateforme d'échange Waafi ⇄ 1xBet : dépôt et retrait en quelques minutes.

## Stack

- **Frontend** : `index.html` (SPA HTML+CSS+JS vanilla, sans framework)
- **Backend/API** : Vercel Serverless Functions (`/api`)
- **Base de données** : Supabase (Postgres + Auth + Realtime), schéma dans `supabase/schema.sql`
- **PWA** : `manifest.json` + `sw.js`

## Déploiement

1. **Supabase** : projet créé, schéma appliqué (`supabase/schema.sql`). URL et clé anonyme déjà renseignées dans `index.html`.
2. **Vercel** : lier ce dépôt GitHub à un projet Vercel (Import Git Repository), puis configurer les variables d'environnement suivantes dans *Project Settings → Environment Variables* :

| Variable | Description |
|---|---|
| `SUPABASE_URL` | URL du projet Supabase (`https://ylbhmtujnhhrdywnztxo.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé service_role Supabase (Dashboard → Settings → API) — **jamais côté client** |
| `ADMIN_URL_TOKEN` | Doit être identique à la valeur codée en dur dans `index.html` (bypass créateur `?kp=TOKEN`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_SUPPORT_BOT_TOKEN` | Bots Telegram (admin + support) |
| `WHATSAPP_API_KEY`, `WHATSAPP_API_URL`, `WHATSAPP_AGENT_NUMBERS` | Notifications WhatsApp |
| `MOBCASH_BASE_URL`, `MOBCASH_CASHIER_PASS`, `MOBCASH_CASHDESK_ID` | API MobCash (crédit/retrait 1xBet) |
| `SUPABASE_WEBHOOK_SECRET`, `SMS_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET` | Secrets optionnels de vérification des webhooks |

3. Configurer les **Database Webhooks** Supabase vers `/api/hooks/depot-created`, `/api/hooks/depot-updated`, `/api/hooks/retrait-created`, `/api/hooks/retrait-updated`.
4. Configurer le webhook Telegram des bots vers `/api/admin-bot` et `/api/support-client`.

Sans ces variables, le site fonctionne déjà (dépôt/retrait/suivi), seules les notifications et le crédit automatique MobCash restent inactifs.

## Limites du plan Vercel Hobby

- **Fonctions serverless** : max 12 par déploiement. Les routes admin peu fréquentes (`stats`, `action-ordre`, `retry-deposit`, `test-payment`, `create-agent`) sont donc regroupées dans `api/admin.js`, dispatché via `?action=`.
- **Cron jobs** : max 1 exécution/jour sur Hobby. `ordres-bloques` (censé tourner toutes les 10 min pour détecter les ordres bloqués) tourne donc une fois par jour (9h UTC) tant que le compte n'est pas passé sur le plan Pro. Passer sur Pro permet de repasser `vercel.json` sur `*/10 * * * *` pour une vraie détection en temps quasi réel.
