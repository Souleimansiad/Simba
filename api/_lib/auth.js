import { supabaseAdmin } from './supabase.js';

// Ordre croissant de privilèges — utile pour des comparaisons futures.
export const ROLE_LEVEL = { observateur: 0, support: 1, agent_paiement: 2, admin: 3, createur: 4 };

/**
 * Résout l'appelant d'une route /api à partir soit du header x-admin-token
 * (bypass local du créateur, ADMIN_URL_TOKEN), soit d'un JWT Supabase
 * (Authorization: Bearer <access_token>) résolu via la table `agents`.
 * Retourne null si l'appelant n'est pas identifiable.
 */
export async function resolveCaller(req) {
  const adminToken = process.env.ADMIN_URL_TOKEN;
  const headerToken = req.headers['x-admin-token'];
  if (adminToken && headerToken && headerToken === adminToken) {
    return { id: 'creator-bypass', role: 'createur', name: 'Créateur', email: null };
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData || !userData.user) return null;

  const { data: agent, error: agentErr } = await supabaseAdmin
    .from('agents')
    .select('id,name,email,role')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (agentErr || !agent) return null;

  return agent;
}

export function hasRole(caller, allowedRoles) {
  return !!caller && allowedRoles.includes(caller.role);
}

/** Lève une erreur avec statusCode si l'appelant n'a pas un des rôles autorisés. */
export function requireRole(caller, allowedRoles) {
  if (!caller) {
    const err = new Error('Authentification requise');
    err.statusCode = 401;
    throw err;
  }
  if (!hasRole(caller, allowedRoles)) {
    const err = new Error('Accès refusé pour ce rôle');
    err.statusCode = 403;
    throw err;
  }
}
