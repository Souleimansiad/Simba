import { supabaseAdmin } from './_lib/supabase.js';
import { sendTelegramMessage } from './_lib/telegram.js';
import { resetCircuit, getCircuitState, mobcashDiagnostic, formatMobcashDiagnostic } from './_lib/mobcash.js';
import { aiBudgetReport } from './_lib/receiptAI.js';
import { confirmDepotManually, retryDepotCredit } from './_lib/depotActions.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function reply(chatId, text) {
  return sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, text);
}

// Charge un dépôt par son identifiant ; répond directement à l'agent si introuvable
// ou si c'est un retrait (ces commandes ne concernent que les dépôts).
async function findDepot(chatId, rawId) {
  const id = String(rawId).replace(/^#/, '').trim();
  const { data: order } = await supabaseAdmin.from('depot_orders').select('*').eq('id', id).maybeSingle();
  if (order) return order;
  const { data: retrait } = await supabaseAdmin.from('retrait_orders').select('id').eq('id', id).maybeSingle();
  await reply(chatId, retrait
    ? `⚠️ #${esc(id)} est un retrait : ces commandes ne concernent que les dépôts.`
    : `⚠️ Ordre #${esc(id)} introuvable. Vérifiez le numéro avec /ordres.`);
  return null;
}

// Webhook Telegram du bot admin. Configurer avec :
// https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain>/api/admin-bot&secret_token=<TELEGRAM_WEBHOOK_SECRET>
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).json({ error: 'Secret invalide' });
  }

  try {
    const message = req.body && req.body.message;
    if (!message || !message.text) return res.status(200).json({ ok: true });

    const chatId = String(message.chat.id);
    // Seul le chat admin configuré peut déclencher des actions.
    if (chatId !== String(TELEGRAM_ADMIN_CHAT_ID)) {
      return res.status(200).json({ ok: true });
    }

    const text = message.text.trim();

    if (/^reset circuit$/i.test(text)) {
      await resetCircuit();
      await reply(chatId, '✅ Circuit MobCash réinitialisé (état: closed).');
      return res.status(200).json({ ok: true });
    }

    if (/^\/status$/i.test(text) || /^status$/i.test(text)) {
      const cb = await getCircuitState();
      await reply(chatId, `⚙️ Circuit MobCash: <b>${cb.state}</b> (échecs: ${cb.fail_count || 0})`);
      return res.status(200).json({ ok: true });
    }

    if (/^\/mobcash$|^mobcash$/i.test(text)) {
      await reply(chatId, formatMobcashDiagnostic(await mobcashDiagnostic()));
      return res.status(200).json({ ok: true });
    }

    if (/^\/ia$|^ia$/i.test(text)) {
      await reply(chatId, await aiBudgetReport());
      return res.status(200).json({ ok: true });
    }

    // confirme #ORDRE : le client a bien payé mais le paiement n'a pas été détecté
    // (macros en panne, erreur réseau ou technique) -> l'agent confirme à la main.
    const confirm = text.match(/^\/?confirm(?:e|er)(?:@\w+)?(?:\s+#?(\S+))?\s*$/i);
    if (confirm) {
      if (!confirm[1]) {
        await reply(chatId, 'Usage : confirme #ORDRE\nExemple : confirme #18102026-001\n\nÀ utiliser quand le client a bien payé mais que le paiement n\'a pas été détecté automatiquement.');
        return res.status(200).json({ ok: true });
      }
      const order = await findDepot(chatId, confirm[1]);
      if (!order) return res.status(200).json({ ok: true });
      const r = await confirmDepotManually(order, { actor: `telegram:${chatId}` });
      await reply(chatId, `${r.ok ? '✅' : r.code === 'mobcash_failed' ? '❌' : '⚠️'} ${esc(r.message)}`);
      return res.status(200).json({ ok: true });
    }

    // relance #ORDRE [bon ID 1xBet] [oui] : réessaie le crédit MobCash d'un paiement
    // déjà confirmé (solde insuffisant, ID 1xBet erroné, devise, autre échec).
    const relance = text.match(/^\/?relance(?:@\w+)?(?:\s+#?(\S+))?((?:\s+\S+){0,2})\s*$/i);
    if (relance) {
      if (!relance[1]) {
        await reply(chatId, 'Usage : relance #ORDRE\n        ou : relance #ORDRE [bon ID 1xBet]\n\nÀ utiliser quand le paiement est confirmé mais que le crédit MobCash a échoué (solde de la caisse insuffisant, ID 1xBet erroné, devise, autre).');
        return res.status(200).json({ ok: true });
      }
      const extra = relance[2].trim().split(/\s+/).filter(Boolean);
      const isForce = (t) => /^(oui|yes|force)$/i.test(t);
      const order = await findDepot(chatId, relance[1]);
      if (!order) return res.status(200).json({ ok: true });
      const r = await retryDepotCredit(order, {
        actor: `telegram:${chatId}`,
        newBetId: extra.find((t) => !isForce(t)) || null,
        force: extra.some(isForce),
      });
      await reply(chatId, `${r.ok ? '✅' : r.code === 'mobcash_failed' ? '❌' : '⚠️'} ${esc(r.message)}`);
      return res.status(200).json({ ok: true });
    }

    if (/^\/ordres$|^ordres$/i.test(text)) {
      const [{ data: depots }, { data: retraits }] = await Promise.all([
        supabaseAdmin.from('depot_orders').select('id,montant,status,mobcash_status').in('status', ['en_attente', 'paiement_recu']).order('created_at', { ascending: false }).limit(15),
        supabaseAdmin.from('retrait_orders').select('id,montant,status').eq('status', 'en_attente').limit(10),
      ]);
      const lines = [
        ...(depots || []).map((o) => o.status === 'paiement_recu'
          ? (o.mobcash_status === 'echec_permanent'
            ? `D #${o.id} — ${o.montant} DJF — 🔁 crédit en échec → relance #${o.id}`
            : `D #${o.id} — ${o.montant} DJF — ⏳ crédit en cours`)
          : `D #${o.id} — ${o.montant} DJF — en attente (si payé : confirme #${o.id})`),
        ...(retraits || []).map((o) => `R #${o.id} — ${o.montant} DJF`),
      ];
      await reply(chatId, lines.length ? `🧾 Ordres à traiter:\n${lines.join('\n')}` : 'Aucun ordre à traiter.');
      return res.status(200).json({ ok: true });
    }

    await reply(chatId, 'Commandes disponibles:\n/ordres — dépôts/retraits à traiter\nconfirme #ORDRE — confirmer à la main un dépôt payé mais non détecté\nrelance #ORDRE [bon ID 1xBet] — relancer le crédit MobCash en échec\n/status — état circuit MobCash\n/ia — coût et solde de l\'IA (OpenRouter)\n/mobcash — diagnostic de connexion MobCash (sans dépôt)\nreset circuit — réinitialiser le circuit MobCash');
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[admin-bot]', err);
    return res.status(500).json({ error: err.message });
  }
}
