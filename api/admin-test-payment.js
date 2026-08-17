import { resolveCaller, requireRole } from './_lib/auth.js';
import { mobcashDeposit, mobcashPayout } from './_lib/mobcash.js';

// Test manuel de l'API MobCash depuis l'écran admin "Test Paiement".
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const caller = await resolveCaller(req);
    requireRole(caller, ['createur', 'admin']);

    const { userId, amount, operation } = req.body || {};
    if (!userId || !amount || !['deposit', 'payout'].includes(operation)) {
      return res.status(400).json({ error: 'Paramètres invalides' });
    }

    const result = operation === 'deposit'
      ? await mobcashDeposit(userId, amount)
      : await mobcashPayout(userId, amount);

    return res.status(200).json({ ok: true, operation, result });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
}
