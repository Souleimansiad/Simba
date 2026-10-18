-- Migration : dépôt par capture de paiement (bucket privé, colonnes, submit_depot_order).
-- À coller dans Supabase > SQL Editor puis Run. Peut être rejouée sans risque.

alter table public.depot_orders alter column numero_waafi_expediteur drop not null;
alter table public.depot_orders add column if not exists receipt_path text;
alter table public.depot_orders add column if not exists receipt_data jsonb;

-- =====================================================================
-- 6ter. CAPTURES DE PAIEMENT WAAFI + submit_depot_order()
-- Bucket privé "receipts" : le public peut y déposer une image (nom
-- imposé UUID.jpg, 5 Mo max, images uniquement) mais jamais la relire ;
-- seul le personnel y accède (URL signée depuis le panneau admin).
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists receipts_insert_public on storage.objects;
create policy receipts_insert_public on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'receipts' and name ~ '^[A-Za-z0-9-]{8,64}\.jpg$');

drop policy if exists receipts_select_staff on storage.objects;
create policy receipts_select_staff on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts'
         and public.get_my_role() in ('createur','admin','agent_paiement','support','observateur'));

-- Création d'un dépôt avec capture. Le chemin doit avoir le format imposé
-- ci-dessus (évite d'injecter du HTML via un nom de fichier dans le panneau
-- admin) et pointer vers une capture réellement déposée. Le client ne fournit
-- NI Transfer ID NI données lues : receipt_data et transfer_id sont écrits
-- uniquement par le serveur (api/hooks/depot-created.js, lecture IA de
-- l'image stockée), donc non falsifiables par le client.
create or replace function public.submit_depot_order(
  p_montant numeric,
  p_id_bet1x text,
  p_whatsapp text,
  p_receipt_path text,
  p_lang text default 'fr'
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id text;
begin
  if p_receipt_path is null
     or p_receipt_path !~ '^[A-Za-z0-9-]{8,64}\.jpg$'
     or not exists (select 1 from storage.objects where bucket_id = 'receipts' and name = p_receipt_path) then
    raise exception 'Capture de paiement manquante ou invalide';
  end if;

  insert into public.depot_orders (montant, id_bet1x, whatsapp, receipt_path, lang)
  values (p_montant, p_id_bet1x, p_whatsapp, p_receipt_path, coalesce(p_lang, 'fr'))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.submit_depot_order(numeric, text, text, text, text) from public;
grant execute on function public.submit_depot_order(numeric, text, text, text, text) to anon, authenticated;

