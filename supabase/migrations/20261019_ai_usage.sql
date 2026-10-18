-- Migration : suivi des coûts de l'IA (table ai_usage). Peut être rejouée sans risque.

-- Suivi de la consommation de l'IA de lecture des captures (OpenRouter).
-- Une ligne par appel, coût réel (usage.cost renvoyé par OpenRouter) inclus.
-- "cle" = nom de la variable d'environnement de la clé utilisée, JAMAIS la clé.
-- Écrit uniquement par le serveur (service_role).
create table if not exists public.ai_usage (
  id                bigserial primary key,
  created_at        timestamptz not null default now(),
  order_id          text,
  model             text not null,
  cle               text not null,
  succes            boolean not null,
  http_status       int,
  erreur            text,
  prompt_tokens     int,
  completion_tokens int,
  cout_usd          numeric(12,6) not null default 0,
  latence_ms        int
);
create index if not exists ai_usage_created_at_idx on public.ai_usage (created_at desc);
alter table public.ai_usage enable row level security;

drop policy if exists ai_usage_select_admin on public.ai_usage;
create policy ai_usage_select_admin on public.ai_usage
  for select to authenticated
  using (public.get_my_role() in ('createur','admin'));

-- Cumuls calculés en SQL (aujourd'hui = jour de Djibouti, 7 et 30 jours glissants).
create or replace function public.ai_usage_summary()
returns table (periode text, appels bigint, echecs bigint, cout_usd numeric)
language sql
stable
set search_path = public
as $$
  select p.periode,
         count(u.id),
         count(*) filter (where u.succes is false),
         coalesce(sum(u.cout_usd), 0)
  from (values
    ('aujourd_hui', date_trunc('day', now() at time zone 'Africa/Djibouti') at time zone 'Africa/Djibouti'),
    ('7_jours',  now() - interval '7 days'),
    ('30_jours', now() - interval '30 days')
  ) as p(periode, depuis)
  left join public.ai_usage u on u.created_at >= p.depuis
  group by p.periode;
$$;

revoke all on function public.ai_usage_summary() from public, anon, authenticated;
grant execute on function public.ai_usage_summary() to service_role;
