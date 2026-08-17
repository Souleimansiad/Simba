import { supabaseAdmin } from './_lib/supabase.js';
import { resolveCaller, requireRole } from './_lib/auth.js';

const VALID_ROLES = ['admin', 'agent_paiement', 'support', 'observateur'];

// Crée un compte agent : utilise l'API Admin Supabase (clé service_role),
// jamais exposée côté client.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const caller = await resolveCaller(req);
    requireRole(caller, ['createur', 'admin']);

    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password || !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Paramètres invalides' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (min. 8 caractères)' });

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (createErr) throw createErr;

    const { error: insertErr } = await supabaseAdmin.from('agents').insert({
      id: created.user.id, name, email, role, created_by: caller.email || caller.id,
    });
    if (insertErr) {
      await supabaseAdmin.auth.admin.deleteUser(created.user.id);
      throw insertErr;
    }

    await supabaseAdmin.from('audit_logs').insert({
      action: 'admin_create_agent', actor: caller.email || caller.id, target: email, meta: { role },
    });

    return res.status(200).json({ ok: true, id: created.user.id });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
}
