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
| `GREENAPI_API_URL`, `GREENAPI_ID_INSTANCE`, `GREENAPI_API_TOKEN` | Notifications WhatsApp client (Green API — URL spécifique à l'instance, ex. `https://7107.api.greenapi.com`) |
| `WHATSAPP_AGENT_NUMBERS` | Numéros WhatsApp des agents à notifier (liste séparée par des virgules, optionnel) |
| `MOBCASH_CASHBOX_CODE`, `MOBCASH_LOGIN`, `MOBCASH_PASSWORD` | Identifiants API MobCash APP2APP (crédit/retrait 1xBet) — cashboxCode, login et mot de passe du caissier fournis par MobCash |
| `SUPABASE_WEBHOOK_SECRET`, `SMS_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET` | Secrets optionnels de vérification des webhooks |

3. Configurer les **Database Webhooks** Supabase vers `/api/hooks/depot-created`, `/api/hooks/depot-updated`, `/api/hooks/retrait-created`, `/api/hooks/retrait-updated`.
4. Configurer le webhook Telegram des bots vers `/api/admin-bot` et `/api/support-client`.

Sans ces variables, le site fonctionne déjà (dépôt/retrait/suivi), seules les notifications et le crédit automatique MobCash restent inactifs.

## Mode manuel (en attendant l'accès à l'API MobCash)

Tant que `MOBCASH_CASHBOX_CODE` / `MOBCASH_LOGIN` / `MOBCASH_PASSWORD` ne sont pas configurées sur Vercel, le crédit/paiement 1xBet se fait **manuellement** :

1. Le SMS Waafi arrive via MacroDroid → `/api/sms-webhook` matche le Transfer ID et passe l'ordre en "Paiement reçu", puis envoie une alerte Telegram à l'admin avec le montant et l'ID 1xBet à créditer.
2. L'agent recharge/paye manuellement le compte 1xBet, puis clique **Confirmer** dans le panneau admin (Ordres) — l'ordre passe directement à "Crédité avec succès" sans appel MobCash.
3. Dès que les 3 variables MobCash sont renseignées, le code bascule automatiquement en mode automatique (crédit via l'API MobCash) — aucune modification de code nécessaire.

## API MobCash (mode automatique)

Intégration "APP2APP" (doc fournie par MobCash) :

- Connexion : `POST https://admin.mob-cash.com/api/v2/cashbox/login` avec `{cashboxCode, login, password}` → `accessToken` (Bearer), `sessionID`, `userID`.
- Dépôt (2 étapes) : `POST /api/v1/mobile/payerNickname` (vérification du compte 1xBet) puis `POST /api/v1/mobile/deposit`.
- Retrait (2 étapes) : `POST /api/v1/mobile/getWithdrawalAmount` (récupère le montant validé par 1xBet pour le `code_retrait_1x` fourni par le client) puis `POST /api/v1/mobile/withdrawal`.
- Chaque opération refait un login (pas de cache de token entre invocations serverless) — volume faible, donc pas de complexité de rafraîchissement de token.
- Voir `api/_lib/mobcash.js`.

## Limites du plan Vercel Hobby

- **Fonctions serverless** : max 12 par déploiement. Les routes admin peu fréquentes (`stats`, `action-ordre`, `retry-deposit`, `test-payment`, `create-agent`) sont donc regroupées dans `api/admin.js`, dispatché via `?action=`.
- **Cron jobs** : max 1 exécution/jour sur Hobby. `ordres-bloques` (censé tourner toutes les 10 min pour détecter les ordres bloqués) tourne donc une fois par jour (9h UTC) tant que le compte n'est pas passé sur le plan Pro. Passer sur Pro permet de repasser `vercel.json` sur `*/10 * * * *` pour une vraie détection en temps quasi réel.
