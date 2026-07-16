-- Numeración atómica de actas nuevas por tipo y año.
-- La sugerencia del formulario es informativa; este disparador asigna el valor definitivo.

create or replace function public.rc_asignar_numero_consecutivo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_siguiente bigint;
begin
  if coalesce(new.legacy, false) = false
     and new.tipo in (
       'nacimiento', 'matrimonio', 'defuncion', 'union_estable',
       'disolucion', 'naturalizacion', 'permiso', 'traslado'
     )
     and new.ano is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.tipo || ':' || new.ano::text, 0));

    select coalesce(
             max(case when numero_acta ~ '^[0-9]+$' then numero_acta::bigint end),
             0
           ) + 1
      into v_siguiente
      from public.rc_tramites
     where tipo = new.tipo
       and ano = new.ano;

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

create unique index if not exists rc_tramites_numero_nuevo_uq
on public.rc_tramites(tipo, ano, numero_acta)
where legacy = false
  and ano is not null
  and numero_acta is not null
  and tipo in (
    'nacimiento', 'matrimonio', 'defuncion', 'union_estable',
    'disolucion', 'naturalizacion', 'permiso', 'traslado'
  );

notify pgrst, 'reload schema';
