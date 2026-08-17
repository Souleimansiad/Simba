import { supabaseAdmin } from './_lib/supabase.js';
import { resolveCaller, requireRole } from './_lib/auth.js';
import { sendTelegramAdmin } from './_lib/telegram.js';

const DAYS = 7;

// Récapitulatif des transactions Waafi (notifications reçues) sur les
// derniers jours. Ajouter ?notify=1 pour l'envoyer aussi sur Telegram.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const caller = await resolveCaller(req);
    requireRole(caller, ['createur', 'admin', 'support']);

    const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('waafi_notifications')
      .select('type,montant,created_at')
      .gte('created_at', since);
    if (error) throw error;

    const byType = {};
    let totalMontant = 0;
    for (const n of data || []) {
      byType[n.type] = (byType[n.type] || 0) + 1;
      totalMontant += Number(n.montant || 0);
    }

    const recap = { period_days: DAYS, total_notifications: (data || []).length, total_montant: totalMontant, by_type: byType };

    if (req.query.notify === '1') {
      requireRole(caller, ['createur', 'admin']);
      const lines = Object.entries(byType).map(([type, count]) => `• ${type}: ${count}`);
      await sendTelegramAdmin(`📋 <b>Récap Waafi (${DAYS}j)</b>\nTotal: ${recap.total_notifications} notifications — ${totalMontant} DJF\n` + lines.join('\n'));
    }

    return res.status(200).json(recap);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
}
