import { supabaseAdmin } from './_lib/supabase.js';
import { resolveCaller, requireRole } from './_lib/auth.js';
import { mobcashDeposit, mobcashPayout } from './_lib/mobcash.js';
import { sendTelegramAdmin } from './_lib/telegram.js';

const TABLE_BY_TYPE = { depot: 'depot_orders', retrait: 'retrait_orders' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const caller = await resolveCaller(req);
    const { order_id, type, action } = req.body || {};

    if (!order_id || !TABLE_BY_TYPE[type] || !['confirmer', 'rejeter', 'fraude'].includes(action)) {
      return res.status(400).json({ error: 'Paramètres invalides' });
    }

    if (action === 'confirmer') requireRole(caller, ['createur', 'admin', 'agent_paiement']);
    else requireRole(caller, ['createur', 'admin']);

    const table = TABLE_BY_TYPE[type];
    const { data: order, error: fetchErr } = await supabaseAdmin.from(table).select('*').eq('id', order_id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!order) return res.status(404).json({ error: 'Ordre introuvable' });

    if (action === 'rejeter') {
      await supabaseAdmin.from(table).update({ status: 'rejete' }).eq('id', order_id);
    } else if (action === 'fraude') {
      await supabaseAdmin.from(table).update({ status: 'fraude' }).eq('id', order_id);
    } else if (action === 'confirmer') {
      if (type === 'depot' && order.transfer_id) {
        const { error: dedupeError } = await supabaseAdmin
          .from('ordre_traite')
          .insert({ transfer_id: order.transfer_id, order_id: order.id });
        if (dedupeError && dedupeError.code !== '23505') throw dedupeError;
        if (dedupeError && dedupeError.code === '23505') {
          return res.status(200).json({ ok: true, already_processed: true });
        }
      }
      await supabaseAdmin.from(table).update({ status: 'paiement_recu' }).eq('id', order_id);
      try {
        if (type === 'depot') await mobcashDeposit(order.id_bet1x, order.montant);
        else await mobcashPayout(order.id_bet1x, order.montant);
        await supabaseAdmin.from(table).update({ status: 'credite' }).eq('id', order_id);
      } catch (mcErr) {
        await supabaseAdmin.from('alertes_etat').insert({ type: 'mobcash_credit_failed', order_id, collection: table });
        await sendTelegramAdmin(`❌ Confirmation manuelle #${order_id} : échec MobCash — ${mcErr.message}`);
        return res.status(502).json({ error: 'Confirmation enregistrée mais crédit MobCash a échoué: ' + mcErr.message });
      }
    }

    await supabaseAdmin.from('audit_logs').insert({
      action: 'admin_action_ordre:' + action,
      actor: caller.email || caller.id,
      target: order_id,
      meta: { type, action },
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
}
