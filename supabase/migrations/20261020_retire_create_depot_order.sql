-- Migration : retire l'ancien chemin de création de dépôt (sans capture de paiement).
-- Peut être rejouée sans risque.
--
-- 1. create_depot_order() : ancienne fonction publique (Transfer ID et numéro
--    expéditeur saisis par le client). Remplacée par submit_depot_order().
-- 2. depot_orders_insert_public : règle qui laissait n'importe qui insérer une
--    ligne DIRECTEMENT dans depot_orders (API REST) en fournissant lui-même
--    receipt_data / transfer_id, ce qui contournait la lecture de la capture
--    côté serveur. Toute création passe désormais par submit_depot_order()
--    (SECURITY DEFINER, qui n'a pas besoin de cette règle).
drop function if exists public.create_depot_order(numeric, text, text, text, text, text);
drop policy if exists depot_orders_insert_public on public.depot_orders;
