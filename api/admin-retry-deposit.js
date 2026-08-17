import { supabaseAdmin } from './_lib/supabase.js';
import { resolveCaller, requireRole } from './_lib/auth.js';
import { mobcashDeposit } from './_lib/mobcash.js';
import { sendTelegramAdmin } from './_lib/telegram.js';

// Relance un dépôt dont le crédit MobCash a échoué après réception du paiement.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const caller = await resolveCaller(req);
    requireRole(caller, ['createur', 'admin']);

    const { order_id } = req.body || {};
    if (!order_id) return res.status(400).json({ error: 'order_id requis' });

    const { data: order, error: fetchErr } = await supabaseAdmin.from('depot_orders').select('*').eq('id', order_id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!order) return res.status(404).json({ error: 'Ordre introuvable' });
    if (order.status === 'credite') return res.status(200).json({ ok: true, already_credited: true });

    await mobcashDeposit(order.id_bet1x, order.montant);
    await supabaseAdmin.from('depot_orders').update({ status: 'credite' }).eq('id', order_id);
    await supabaseAdmin.from('audit_logs').insert({
      action: 'admin_retry_deposit', actor: caller.email || caller.id, target: order_id,
    });
    await sendTelegramAdmin(`✅ Dépôt #${order_id} crédité après relance manuelle.`);

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
}
