import { supabaseAdmin } from './_lib/supabase.js';
import { resolveCaller, requireRole } from './_lib/auth.js';

// Marge appliquée pour estimer le bénéfice (placeholder — ajuster selon le
// modèle de commission réel de Simba).
const PROFIT_MARGIN_RATE = Number(process.env.PROFIT_MARGIN_RATE || 0.02);

function rangeToDates(range) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (range === 'today') return { from: startOfDay(now), to: now };
  if (range === 'yesterday') {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    return { from: startOfDay(y), to: startOfDay(now) };
  }
  if (range === '7d') { const from = new Date(now); from.setDate(from.getDate() - 7); return { from, to: now }; }
  if (range === '30d') { const from = new Date(now); from.setDate(from.getDate() - 30); return { from, to: now }; }
  return { from: null, to: now };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const caller = await resolveCaller(req);
    requireRole(caller, ['createur', 'admin', 'agent_paiement', 'support', 'observateur']);

    const range = req.query.range || 'today';
    const { from, to } = rangeToDates(range);

    let depotQuery = supabaseAdmin.from('depot_orders').select('id,montant,status,created_at');
    let retraitQuery = supabaseAdmin.from('retrait_orders').select('id,montant,status,created_at');
    if (from) { depotQuery = depotQuery.gte('created_at', from.toISOString()); retraitQuery = retraitQuery.gte('created_at', from.toISOString()); }
    if (to) { depotQuery = depotQuery.lte('created_at', to.toISOString()); retraitQuery = retraitQuery.lte('created_at', to.toISOString()); }

    const [{ data: depots, error: dErr }, { data: retraits, error: rErr }] = await Promise.all([depotQuery, retraitQuery]);
    if (dErr) throw dErr;
    if (rErr) throw rErr;

    const allOrders = [
      ...(depots || []).map((o) => ({ ...o, type: 'depot' })),
      ...(retraits || []).map((o) => ({ ...o, type: 'retrait' })),
    ];

    const volume = allOrders.reduce((sum, o) => sum + Number(o.montant || 0), 0);
    const creditedVolume = allOrders.filter((o) => o.status === 'credite').reduce((sum, o) => sum + Number(o.montant || 0), 0);

    const byHourMap = new Map();
    for (const o of allOrders) {
      const hour = new Date(o.created_at).getHours();
      const key = String(hour).padStart(2, '0') + 'h';
      byHourMap.set(key, (byHourMap.get(key) || 0) + Number(o.montant || 0));
    }
    const byHour = Array.from({ length: 24 }, (_, h) => {
      const key = String(h).padStart(2, '0') + 'h';
      return { hour: key, volume: byHourMap.get(key) || 0 };
    }).filter((h) => h.volume > 0 || range === 'today');

    const profitByDayMap = new Map();
    for (const o of allOrders) {
      if (o.status !== 'credite') continue;
      const day = new Date(o.created_at).toISOString().slice(0, 10);
      profitByDayMap.set(day, (profitByDayMap.get(day) || 0) + Number(o.montant || 0) * PROFIT_MARGIN_RATE);
    }
    const profitByDay = Array.from(profitByDayMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, profit]) => ({ day, profit: Math.round(profit) }));

    const totals = {
      orders: allOrders.length,
      depots: (depots || []).length,
      retraits: (retraits || []).length,
      volume,
    };
    if (caller.role === 'createur') {
      totals.profit = Math.round(creditedVolume * PROFIT_MARGIN_RATE);
    }

    return res.status(200).json({ totals, byHour, profitByDay });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
}
