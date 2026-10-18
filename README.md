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
| `OPENROUTER_API_KEY`, `OPENROUTER_API_KEY_2` … `_9` | Clés [OpenRouter](https://openrouter.ai) (lecture des captures par IA, **uniquement via OpenRouter**). Plusieurs clés = rotation : une clé à sec ou invalide passe à la suivante. Sans clé, les captures sont vérifiées à la main |
| `OPENROUTER_MODEL` | Modèle de vision principal (défaut `google/gemini-2.5-flash`) |
| `OPENROUTER_FALLBACK_MODEL` | Modèle de secours si le principal échoue (défaut `openai/gpt-4o-mini`, `none` pour désactiver) |
| `OPENROUTER_LOW_BALANCE_USD`, `OPENROUTER_DAILY_ALERT_USD` | Seuils d'alerte Telegram : solde d'une clé plafonnée sous ce montant (défaut 2 $), ou dépense du jour d'une clé sans plafond au-dessus (défaut 1 $) |
| `WAAFI_NUMBER`, `WAAFI_DEST_NAMES` | Optionnels : compte Waafi qui reçoit les paiements (défaut `77626050`) et nom(s) du compte, séparés par des virgules (défaut `Souleiman Siad Soubaneh`) |

3. Configurer les **Database Webhooks** Supabase vers `/api/hooks/depot-created`, `/api/hooks/depot-updated`, `/api/hooks/retrait-created`, `/api/hooks/retrait-updated`.
4. Configurer le webhook Telegram des bots vers `/api/admin-bot` et `/api/support-client`.

Sans ces variables, le site fonctionne déjà (dépôt/retrait/suivi), seules les notifications et le crédit automatique MobCash restent inactifs.

## Dépôt par capture de paiement

Le client ne saisit plus de Transfer ID : il joint la capture de son paiement Waafi (reçu de l'app, ou SMS de l'opérateur s'il a payé par code USSD).

1. L'image est stockée dans le bucket privé `receipts` (Supabase Storage).
2. `api/hooks/depot-created.js` la lit **côté serveur** avec un modèle de vision (OpenRouter) → `depot_orders.receipt_data`.
3. `api/_lib/receiptMatch.js` la compare au SMS « WAAFI SAS » relayé par MacroDroid :
   - reçu de l'app Waafi : montant, n° + nom expéditeur, n° + nom destinataire, date → **6/6** ;
   - SMS USSD : Transfer-ID, montant, n° + nom destinataire, date → **5/5**.
4. Tous les critères concordent → crédit automatique ; sinon vérification manuelle (capture visible dans Telegram et le panneau admin).

### Suivi du coût de l'IA

- Chaque appel est journalisé dans `ai_usage` : modèle, clé utilisée (nom de la variable, jamais la clé), succès, tokens et **`cout_usd`** réel renvoyé par OpenRouter (`usage: {include: true}`).
- Commande Telegram **`/ia`** : solde/consommation de chaque clé (`GET /api/v1/key`) et cumuls aujourd'hui / 7 jours / 30 jours.
- Le cron quotidien (`/api/ordres-bloques`) contrôle les clés et alerte sur Telegram : clé invalide, solde bas, dépense anormale.

## Diagnostic MobCash

Commande Telegram **`/mobcash`** (chat admin) : une seule tentative de connexion, **aucun dépôt**. Affiche la réponse exacte de MobCash, l'état des 3 variables (longueur, espaces, guillemets collés — jamais leur valeur) et l'IP de sortie de Vercel (utile si MobCash filtre par IP). Évitez de la lancer en boucle : MobCash applique un rate limit.

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
