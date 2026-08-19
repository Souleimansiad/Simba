-- =====================================================================
-- Simba — schema Postgres (Supabase)
-- Depot/Retrait 1xBet via Waafi
-- =====================================================================
-- Ce fichier est idempotent : il peut être rejoué sans dupliquer les objets.
-- Appliquer avec : supabase db push  (ou coller dans le SQL Editor Supabase)
-- =====================================================================

create extension if not exists pgcrypto;

-- =====================================================================
-- 1. FONCTIONS UTILITAIRES
-- =====================================================================

-- Génère une référence courte lisible (ex: D7F3A9, R2C8E1)
-- search_path inclut "extensions" : c'est le schéma où Supabase installe
-- pgcrypto (gen_random_bytes) par défaut.
create or replace function public.gen_order_ref(p_prefix text)
returns text
language sql
set search_path = public, extensions
as $$
  select p_prefix || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 6));
$$;

-- Trigger générique : maintient updated_at à jour
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =====================================================================
-- 2. TABLES
-- =====================================================================

create table if not exists public.depot_orders (
  id                        text primary key default public.gen_order_ref('D'),
  status                    text not null default 'en_attente'
                              check (status in ('en_attente','paiement_recu','credite','rejete','fraude')),
  montant                   numeric not null check (montant >= 50),
  id_bet1x                  text not null check (char_length(id_bet1x) > 0),
  numero_waafi_expediteur   text not null check (char_length(numero_waafi_expediteur) > 0),
  transfer_id               text,
  whatsapp                  text,
  turnstile_token           text,
  lang                      text not null default 'fr',
  fraud_score               int not null default 0,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
alter table public.depot_orders drop constraint if exists depot_orders_montant_check;
alter table public.depot_orders add constraint depot_orders_montant_check check (montant >= 50);

create table if not exists public.retrait_orders (
  id                        text primary key default public.gen_order_ref('R'),
  status                    text not null default 'en_attente'
                              check (status in ('en_attente','paiement_recu','credite','rejete','fraude')),
  montant                   numeric not null check (montant >= 250),
  id_bet1x                  text not null check (char_length(id_bet1x) > 0),
  numero_waafi_reception    text not null check (char_length(numero_waafi_reception) > 0),
  code_retrait_1x           text not null check (char_length(code_retrait_1x) > 0),
  whatsapp                  text,
  turnstile_token           text,
  lang                      text not null default 'fr',
  fraud_score               int not null default 0,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
alter table public.retrait_orders drop constraint if exists retrait_orders_montant_check;
alter table public.retrait_orders add constraint retrait_orders_montant_check check (montant >= 250);

create table if not exists public.waafi_notifications (
  id             bigserial primary key,
  type           text not null,
  message        text,
  transfer_id    text,
  montant        numeric,
  sender_number  text,
  order_id       text,
  created_at     timestamptz not null default now()
);
alter table public.waafi_notifications add column if not exists sender_number text;

-- Déduplication anti-double-crédit : transfer_id est la clé primaire.
create table if not exists public.ordre_traite (
  transfer_id   text primary key,
  order_id      text not null,
  processed_at  timestamptz not null default now()
);

create table if not exists public.agents (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  email       text not null unique,
  role        text not null check (role in ('createur','admin','agent_paiement','support','observateur')),
  created_at  timestamptz not null default now(),
  created_by  text
);

create table if not exists public.config_reserves (
  id          int primary key default 1 check (id = 1),
  xbet        numeric not null default 0,
  waafi       numeric not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
insert into public.config_reserves (id, xbet, waafi)
  values (1, 0, 0)
  on conflict (id) do nothing;

create table if not exists public.circuit_breakers (
  service         text primary key,
  state           text not null default 'closed' check (state in ('closed','open','half_open')),
  fail_count      int not null default 0,
  last_failure_at timestamptz,
  opened_at       timestamptz
);
insert into public.circuit_breakers (service, state)
  values ('mobcash', 'closed')
  on conflict (service) do nothing;

create table if not exists public.audit_logs (
  id          bigserial primary key,
  action      text not null,
  actor       text,
  target      text,
  meta        jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists public.support_sessions (
  id          bigserial primary key,
  chat_id     text,
  text        text,
  created_at  timestamptz not null default now()
);

create table if not exists public.alertes_etat (
  id          bigserial primary key,
  type        text not null,
  order_id    text,
  collection  text,
  created_at  timestamptz not null default now()
);

-- =====================================================================
-- 3. TRIGGERS updated_at
-- =====================================================================

drop trigger if exists trg_depot_orders_updated_at on public.depot_orders;
create trigger trg_depot_orders_updated_at
  before update on public.depot_orders
  for each row execute function public.set_updated_at();

drop trigger if exists trg_retrait_orders_updated_at on public.retrait_orders;
create trigger trg_retrait_orders_updated_at
  before update on public.retrait_orders
  for each row execute function public.set_updated_at();

drop trigger if exists trg_config_reserves_updated_at on public.config_reserves;
create trigger trg_config_reserves_updated_at
  before update on public.config_reserves
  for each row execute function public.set_updated_at();

-- =====================================================================
-- 4. RÉSOLUTION DE RÔLE (utilisée dans les policies RLS)
-- SECURITY DEFINER : contourne RLS sur `agents` pour éviter la récursion,
-- puisque le propriétaire de la fonction (postgres) n'est pas soumis à la
-- RLS de la table qu'il possède.
-- =====================================================================

create or replace function public.get_my_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.agents where id = auth.uid();
$$;

grant execute on function public.get_my_role() to authenticated;

-- =====================================================================
-- 5. ROW LEVEL SECURITY
-- =====================================================================

alter table public.depot_orders     enable row level security;
alter table public.retrait_orders   enable row level security;
alter table public.waafi_notifications enable row level security;
alter table public.ordre_traite     enable row level security;
alter table public.agents           enable row level security;
alter table public.config_reserves  enable row level security;
alter table public.circuit_breakers enable row level security;
alter table public.audit_logs       enable row level security;
alter table public.support_sessions enable row level security;
alter table public.alertes_etat     enable row level security;

-- --- depot_orders ------------------------------------------------------
-- Le public peut créer un ordre (formulaire) mais jamais le lire en direct :
-- la lecture publique passe uniquement par get_order_status() ci-dessous.
drop policy if exists depot_orders_insert_public on public.depot_orders;
create policy depot_orders_insert_public on public.depot_orders
  for insert to anon, authenticated
  with check (status = 'en_attente' and fraud_score = 0);

drop policy if exists depot_orders_select_staff on public.depot_orders;
create policy depot_orders_select_staff on public.depot_orders
  for select to authenticated
  using (public.get_my_role() in ('createur','admin','agent_paiement','support','observateur'));

-- --- retrait_orders ------------------------------------------------------
drop policy if exists retrait_orders_insert_public on public.retrait_orders;
create policy retrait_orders_insert_public on public.retrait_orders
  for insert to anon, authenticated
  with check (status = 'en_attente' and fraud_score = 0);

drop policy if exists retrait_orders_select_staff on public.retrait_orders;
create policy retrait_orders_select_staff on public.retrait_orders
  for select to authenticated
  using (public.get_my_role() in ('createur','admin','agent_paiement','support','observateur'));

-- Aucune policy UPDATE/DELETE pour anon/authenticated : toute mutation
-- (confirmation, rejet, fraude, crédit) passe par les routes /api qui
-- utilisent la clé service_role et contournent RLS, afin de centraliser
-- l'audit et la logique anti-fraude.

-- --- waafi_notifications -------------------------------------------------
drop policy if exists waafi_notifications_select_staff on public.waafi_notifications;
create policy waafi_notifications_select_staff on public.waafi_notifications
  for select to authenticated
  using (public.get_my_role() in ('createur','admin','support'));

-- --- ordre_traite ---------------------------------------------------------
-- Aucune policy : verrouillée entièrement, accès service_role uniquement.

-- --- agents -----------------------------------------------------------
drop policy if exists agents_select_self_or_admin on public.agents;
create policy agents_select_self_or_admin on public.agents
  for select to authenticated
  using (id = auth.uid() or public.get_my_role() in ('createur','admin'));

-- Création/mise à jour des agents : uniquement via api/admin-create-agent.js
-- (service_role), jamais directement depuis le client.

-- --- config_reserves ----------------------------------------------------
drop policy if exists config_reserves_select_staff on public.config_reserves;
create policy config_reserves_select_staff on public.config_reserves
  for select to authenticated
  using (public.get_my_role() in ('createur','admin','agent_paiement','support','observateur'));

drop policy if exists config_reserves_update_admin on public.config_reserves;
create policy config_reserves_update_admin on public.config_reserves
  for update to authenticated
  using (public.get_my_role() in ('createur','admin'))
  with check (public.get_my_role() in ('createur','admin'));

-- --- circuit_breakers -----------------------------------------------------
drop policy if exists circuit_breakers_select_staff on public.circuit_breakers;
create policy circuit_breakers_select_staff on public.circuit_breakers
  for select to authenticated
  using (public.get_my_role() in ('createur','admin','agent_paiement','support'));

-- --- audit_logs -----------------------------------------------------------
drop policy if exists audit_logs_select_admin on public.audit_logs;
create policy audit_logs_select_admin on public.audit_logs
  for select to authenticated
  using (public.get_my_role() in ('createur','admin'));

-- --- support_sessions -------------------------------------------------
drop policy if exists support_sessions_select_staff on public.support_sessions;
create policy support_sessions_select_staff on public.support_sessions
  for select to authenticated
  using (public.get_my_role() in ('createur','admin','support'));

-- --- alertes_etat -----------------------------------------------------
drop policy if exists alertes_etat_select_admin on public.alertes_etat;
create policy alertes_etat_select_admin on public.alertes_etat
  for select to authenticated
  using (public.get_my_role() in ('createur','admin'));

-- =====================================================================
-- 6. SUIVI PUBLIC SÉCURISÉ — get_order_status()
-- Fonction SECURITY DEFINER : retourne UNE seule ligne identifiée par son
-- id (qui joue le rôle de jeton non-devinable), sans jamais exposer le
-- reste de la table. C'est la seule voie de lecture publique des ordres.
-- =====================================================================

create or replace function public.get_order_status(p_order_id text, p_type text)
returns table (
  id          text,
  type        text,
  status      text,
  montant     numeric,
  created_at  timestamptz,
  updated_at  timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if p_type = 'depot' then
    return query
      select d.id, 'depot'::text, d.status, d.montant, d.created_at, d.updated_at
      from public.depot_orders d
      where d.id = p_order_id;
  elsif p_type = 'retrait' then
    return query
      select r.id, 'retrait'::text, r.status, r.montant, r.created_at, r.updated_at
      from public.retrait_orders r
      where r.id = p_order_id;
  end if;
  return;
end;
$$;

revoke all on function public.get_order_status(text, text) from public;
grant execute on function public.get_order_status(text, text) to anon, authenticated;

-- =====================================================================
-- 7. REALTIME
-- =====================================================================

-- 7a. postgres_changes pour l'admin (authentifié, protégé par RLS ci-dessus)
alter publication supabase_realtime add table public.depot_orders;
alter publication supabase_realtime add table public.retrait_orders;

-- 7b. Broadcast from Database pour le suivi public (#suivi-XXXX)
-- Canal nommé "order-updates:<id>" — postgres_changes ne conviendrait pas
-- ici car un visiteur anonyme n'a pas de policy SELECT sur les tables.
create or replace function public.broadcast_order_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform realtime.broadcast_changes(
    'order-updates:' || coalesce(new.id, old.id),
    tg_op,
    tg_op,
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  return new;
end;
$$;

drop trigger if exists trg_depot_orders_broadcast on public.depot_orders;
create trigger trg_depot_orders_broadcast
  after insert or update on public.depot_orders
  for each row execute function public.broadcast_order_update();

drop trigger if exists trg_retrait_orders_broadcast on public.retrait_orders;
create trigger trg_retrait_orders_broadcast
  after insert or update on public.retrait_orders
  for each row execute function public.broadcast_order_update();

-- Les fonctions trigger ne doivent être invocables qu'en contexte trigger,
-- jamais directement via /rest/v1/rpc/broadcast_order_update.
revoke execute on function public.broadcast_order_update() from public, anon, authenticated;

-- Autorise la réception des broadcasts sur les canaux "order-updates:*"
-- uniquement (pas d'accès aux autres canaux realtime éventuels).
drop policy if exists order_updates_broadcast_read on realtime.messages;
create policy order_updates_broadcast_read on realtime.messages
  for select to anon, authenticated
  using (realtime.topic() like 'order-updates:%');

-- =====================================================================
-- 8. DATABASE WEBHOOKS -> /api/hooks/* (Vercel)
-- Implémentés via pg_net (net.http_post, async) plutôt que le wizard
-- Database Webhooks du dashboard, pour rester dans une migration versionnée.
-- Le header x-webhook-secret doit correspondre à SUPABASE_WEBHOOK_SECRET
-- côté Vercel. Mettre à jour l'URL si le domaine de déploiement change.
-- =====================================================================

create extension if not exists pg_net;

create or replace function public.webhook_depot_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://simba-simba23.vercel.app/api/hooks/depot-created',
    body := jsonb_build_object('type', tg_op, 'table', tg_table_name, 'record', to_jsonb(new)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', '4ef525a3f217ce593e8a3ebaf359a27de49dea01')
  );
  return new;
end;
$$;

drop trigger if exists trg_webhook_depot_created on public.depot_orders;
create trigger trg_webhook_depot_created
  after insert on public.depot_orders
  for each row execute function public.webhook_depot_created();

create or replace function public.webhook_depot_updated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://simba-simba23.vercel.app/api/hooks/depot-updated',
    body := jsonb_build_object('type', tg_op, 'table', tg_table_name, 'record', to_jsonb(new), 'old_record', to_jsonb(old)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', '4ef525a3f217ce593e8a3ebaf359a27de49dea01')
  );
  return new;
end;
$$;

drop trigger if exists trg_webhook_depot_updated on public.depot_orders;
create trigger trg_webhook_depot_updated
  after update on public.depot_orders
  for each row execute function public.webhook_depot_updated();

create or replace function public.webhook_retrait_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://simba-simba23.vercel.app/api/hooks/retrait-created',
    body := jsonb_build_object('type', tg_op, 'table', tg_table_name, 'record', to_jsonb(new)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', '4ef525a3f217ce593e8a3ebaf359a27de49dea01')
  );
  return new;
end;
$$;

drop trigger if exists trg_webhook_retrait_created on public.retrait_orders;
create trigger trg_webhook_retrait_created
  after insert on public.retrait_orders
  for each row execute function public.webhook_retrait_created();

create or replace function public.webhook_retrait_updated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://simba-simba23.vercel.app/api/hooks/retrait-updated',
    body := jsonb_build_object('type', tg_op, 'table', tg_table_name, 'record', to_jsonb(new), 'old_record', to_jsonb(old)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', '4ef525a3f217ce593e8a3ebaf359a27de49dea01')
  );
  return new;
end;
$$;

drop trigger if exists trg_webhook_retrait_updated on public.retrait_orders;
create trigger trg_webhook_retrait_updated
  after update on public.retrait_orders
  for each row execute function public.webhook_retrait_updated();

revoke execute on function public.webhook_depot_created() from public, anon, authenticated;
revoke execute on function public.webhook_depot_updated() from public, anon, authenticated;
revoke execute on function public.webhook_retrait_created() from public, anon, authenticated;
revoke execute on function public.webhook_retrait_updated() from public, anon, authenticated;

-- =====================================================================
-- Fin du schéma
-- =====================================================================
