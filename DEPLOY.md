# Déploiement de production — mode d'emploi

Production = branche `claude/new-session-mg7695` (Vercel : projet `simba`, domaines `simba-pay.com` et `www.simba-pay.com`).
Développement = branche `claude/new-session-2tinvq`.

## Contenu de la prochaine mise en production
- Dépôt par capture de paiement lue par IA (OpenRouter), rapprochement 6/6 (reçu de l'app Waafi) et 5/5 (SMS USSD).
- Deux statuts côté client (En attente / Crédité avec succès), un seul WhatsApp de succès.
- Bot Telegram admin : `confirme #ORDRE`, `relance #ORDRE [bon ID 1xBet] [oui]`, `/ia`, `/mobcash`, `/ordres`.
- Panneau admin aligné sur la même logique (confirmer / relancer).
- Un même reçu ne sert qu'à un ordre ; ancien dépôt sans capture retiré (déjà fait en base).
- Durée maximale 30 s pour les 4 fonctions qui appellent MobCash (`vercel.json`).

La base de données est **déjà à jour** (migrations appliquées par le workflow « Migrations Supabase ») : le code actuellement en ligne reste compatible.

## Avant le déploiement
1. **Quota Vercel** : plan Hobby = 100 déploiements/jour pour toute l'équipe. Déconnecter les projets en double reliés au même dépôt (`simba-waafi`, `simba-frf8`, `simba-f1mv`, `simba-wgjx` : Settings → Git → Disconnect), sinon chaque push en consomme 5.
2. **MobCash** : vérifier le login/mot de passe/code caisse sur l'espace MobCash (échec « unauthorized error » constaté le 18/10) et mettre à jour `MOBCASH_*` sur Vercel si besoin.
3. Variables Vercel (Production) — déjà présentes : `OPENROUTER_API_KEY`, `MOBCASH_*`, `GREENAPI_*`, `TELEGRAM_*`, `SMS_WEBHOOK_SECRET`, `SUPABASE_*`. Facultatives : `OPENROUTER_API_KEY_2` (2e clé, redondance), `OPENROUTER_MODEL`, `OPENROUTER_FALLBACK_MODEL`.
4. `npm test` passe (GitHub Actions « Tests » vert sur le dernier commit).

## Déployer (une seule fois)
Vercel ne reconstruit pas un commit déjà construit en aperçu, et les redéploiements par l'API sont bloqués quand le quota est atteint. Donc :
```bash
git checkout claude/new-session-2tinvq && git pull
# 1 commit nouveau (jamais poussé sur la branche de développement), par ex. la date de version :
npm version patch --no-git-tag-version
git commit -am "Release : mise en production"
git push origin HEAD:claude/new-session-mg7695      # UNIQUEMENT la branche de production
```
Ne pas pousser ce commit sur la branche de développement avant que le déploiement de production soit « Ready ». Si le déploiement n'apparaît pas dans Vercel → Deployments, le quota n'est pas revenu : attendre.

## Après le déploiement (5 minutes)
1. Vercel → Deployments : le dernier déploiement de production est **Ready** et son commit est le bon (pas un ancien : ne jamais « Redeploy » un vieux déploiement, il refait tourner l'ancien code).
2. `https://www.simba-pay.com/api/health-check` répond `{"ok":true,"db":true,…}`.
3. Telegram (bot admin) : `/mobcash` (connexion MobCash réussie ?), `/ia` (clés OpenRouter OK), `/ordres`.
4. Site : le formulaire de dépôt demande la capture ; la page de suivi d'un dépôt affiche « En attente » ou « Crédité avec succès » seulement.
5. Test réel de 50 DJF depuis un autre numéro vers 77626050, avec la capture : Telegram doit afficher « Capture lue … » puis, MobCash fonctionnel, le crédit.
6. Ordres de test en attente de crédit (`18102026-001`, `18102026-002`) : `relance #ORDRE` une fois MobCash réparé (ils partiraient sur de vrais comptes 1xBet : 50 DJF chacun).

## Retour arrière
Vercel → Deployments → ancien déploiement de production sain (`ea92f03`) → **Promote to Production** (ou Instant Rollback). La base reste compatible avec l'ancien code.

## Pendant l'exploitation
- Paiement non détecté (macros en panne, réseau) mais client payé : `confirme #ORDRE`.
- Crédit MobCash en échec (solde, ID 1xBet, devise…) : `relance #ORDRE` ou `relance #ORDRE [bon ID 1xBet]` ; après une erreur ambiguë : `relance #ORDRE oui` après avoir vérifié l'historique MobCash.
- Coût et solde IA : `/ia`. Alertes de budget automatiques (cron quotidien).
