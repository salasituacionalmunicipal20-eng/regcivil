-- Numeración de actas: correlativo AUTOMÁTICO por tipo y año, con número de inicio configurable.
-- La sugerencia del formulario es informativa; el TRIGGER asigna el valor definitivo (no editable por el usuario).

-- 1) Config: desde qué número arranca cada (tipo, año). Aquí se fija el 273.
create table if not exists public.rc_numero_inicio (
  tipo  text    not null,
  ano   integer not null,
  desde bigint  not null check (desde >= 1),
  primary key (tipo, ano)
);
alter table public.rc_numero_inicio enable row level security;
-- Sin políticas: solo lo leen las funciones security definer (trigger + RPC). Acceso directo denegado.
revoke all on table public.rc_numero_inicio from anon, authenticated;

-- 2) Trigger: numero_acta = (máximo de actas NUEVAS vs. piso configurado) + 1. Ignora lo que mande el form.
--    IMPORTANTE: el archivo histórico migrado (legacy=true) NO cuenta para la serie nueva; solo fija el piso la config.
create or replace function public.rc_asignar_numero_consecutivo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_siguiente bigint;
  v_piso bigint;
begin
  if coalesce(new.legacy, false) = false
     and new.tipo in (
       'nacimiento', 'matrimonio', 'defuncion', 'union_estable',
       'disolucion', 'naturalizacion', 'permiso', 'traslado'
     )
     and new.ano is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.tipo || ':' || new.ano::text, 0));

    -- piso = (número de inicio configurado) - 1, o 0 si no hay config para ese tipo/año
    select coalesce((select desde - 1 from public.rc_numero_inicio
                      where tipo = new.tipo and ano = new.ano), 0)
      into v_piso;

    select greatest(
             coalesce(max(case when numero_acta ~ '^[0-9]+$' then numero_acta::bigint end), 0),
             v_piso
           ) + 1
      into v_siguiente
      from public.rc_tramites
     where tipo = new.tipo
       and ano = new.ano
       and coalesce(legacy, false) = false;  -- solo actas nuevas; el histórico no mueve la serie

    new.numero_acta := v_siguiente::text;
  end if;

  return new;
end;
$$;
revoke all on function public.rc_asignar_numero_consecutivo() from public, anon, authenticated;

drop trigger if exists rc_tramites_numero_consecutivo_trg on public.rc_tramites;
create trigger rc_tramites_numero_consecutivo_trg
before insert on public.rc_tramites
for each row execute function public.rc_asignar_numero_consecutivo();

-- 3) Índice único: no se repite número por tipo y año en los registros nuevos.
create unique index if not exists rc_tramites_numero_nuevo_uq
on public.rc_tramites(tipo, ano, numero_acta)
where legacy = false
  and ano is not null
  and numero_acta is not null
  and tipo in (
    'nacimiento', 'matrimonio', 'defuncion', 'union_estable',
    'disolucion', 'naturalizacion', 'permiso', 'traslado'
  );

-- 4) RPC de sugerencia para el formulario (mismo cálculo que el trigger, para que muestre el 273).
drop function if exists public.rc_siguiente_numero(text, integer);
drop function if exists public.rc_siguiente_numero(text, bigint);
drop function if exists public.rc_siguiente_numero(text, smallint);
drop function if exists public.rc_siguiente_numero(text, numeric);
create or replace function public.rc_siguiente_numero(p_tipo text, p_ano integer)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
           coalesce((select max(case when numero_acta ~ '^[0-9]+$' then numero_acta::bigint end)
                       from public.rc_tramites where tipo = p_tipo and ano = p_ano
                         and coalesce(legacy, false) = false), 0),
           coalesce((select desde - 1 from public.rc_numero_inicio
                       where tipo = p_tipo and ano = p_ano), 0)
         ) + 1;
$$;
grant execute on function public.rc_siguiente_numero(text, integer) to authenticated;

-- 5) Número de INICIO por tipo para el año 2026 (el "próximo" número de cada serie).
--    El primero de cada año NUEVO reinicia en 1 (no se siembra 2027+; sin config = arranca en 1).
insert into public.rc_numero_inicio (tipo, ano, desde) values
  ('nacimiento',     2026, 273),  -- acta de nacimiento
  ('defuncion',      2026, 346),  -- acta de defunción
  ('matrimonio',     2026, 54),   -- acta de matrimonio
  ('union_estable',  2026, 59),   -- unión estable de hecho
  ('disolucion',     2026, 13),   -- disolución de unión estable de hecho
  ('naturalizacion', 2026, 3)     -- naturalización / nacionalidad
on conflict (tipo, ano) do update set desde = excluded.desde;

notify pgrst, 'reload schema';
