import { supabaseAdmin } from './supabase.js';

// URL signée (7 jours) vers la capture de paiement d'un dépôt, pour les
// alertes Telegram : le bucket "receipts" est privé, donc pas de lien public.
export async function receiptSignedUrl(path) {
  if (!path) return null;
  try {
    const { data } = await supabaseAdmin.storage.from('receipts').createSignedUrl(path, 7 * 24 * 3600);
    return (data && data.signedUrl) || null;
  } catch {
    return null;
  }
}
