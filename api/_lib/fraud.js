/**
 * Score de fraude simple, appliqué à la création d'un ordre.
 * type = 'depot' | 'retrait' — le contrôle du Transfer ID ne s'applique
 * qu'aux dépôts (preuve de paiement Waafi entrant).
 */
export function computeFraudScore(order, type) {
  let score = 0;
  const reasons = [];
  const montant = Number(order.montant) || 0;

  if (montant > 200000) {
    score += 50;
    reasons.push('Montant > 200000 DJF');
  } else if (montant > 100000) {
    score += 35;
    reasons.push('Montant > 100000 DJF');
  }

  if (type === 'depot') {
    if (!order.transfer_id) {
      score += 40;
      reasons.push('Transfer ID manquant');
    } else if (!/^\d{6,}$/.test(String(order.transfer_id))) {
      score += 40;
      reasons.push('Transfer ID < 6 chiffres');
    }
  }

  return { score, reasons, isFraud: score >= 60 };
}
