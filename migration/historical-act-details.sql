-- Detalles relacionales recuperados del respaldo lógico de Registro Civil.
-- Se mantienen separados de rc_tramites para no reescribir ni reinterpretar
-- los datos históricos ya migrados.

create table if not exists public.rc_detalles_historicos (
  act_key text primary key,
  tipo text not null,
  ano integer,
  numero_acta integer,
  fuente text not null,
  datos jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rc_tramites_detalle_links (
  legacy_source_id text primary key,
  act_key text not null references public.rc_detalles_historicos(act_key) on delete restrict,
  confianza text not null,
  created_at timestamptz not null default now()
);

create index if not exists rc_detalles_historicos_tipo_ano_acta_idx
on public.rc_detalles_historicos(tipo, ano, numero_acta);

create index if not exists rc_tramites_detalle_links_act_key_idx
on public.rc_tramites_detalle_links(act_key);

alter table public.rc_detalles_historicos enable row level security;
alter table public.rc_tramites_detalle_links enable row level security;

drop policy if exists rc_detalles_historicos_select_authenticated on public.rc_detalles_historicos;
create policy rc_detalles_historicos_select_authenticated on public.rc_detalles_historicos
for select to authenticated using (true);

drop policy if exists rc_tramites_detalle_links_select_authenticated on public.rc_tramites_detalle_links;
create policy rc_tramites_detalle_links_select_authenticated on public.rc_tramites_detalle_links
for select to authenticated using (true);

revoke all on table public.rc_detalles_historicos from public, anon;
revoke all on table public.rc_tramites_detalle_links from public, anon;
grant select on table public.rc_detalles_historicos to authenticated;
grant select on table public.rc_tramites_detalle_links to authenticated;
grant all on table public.rc_detalles_historicos to service_role;
grant all on table public.rc_tramites_detalle_links to service_role;

notify pgrst, 'reload schema';
