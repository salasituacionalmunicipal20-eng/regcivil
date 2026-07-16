-- Centro de Reportes y visibilidad compartida entre usuarios autenticados.
-- Aplicado al proyecto Supabase el 2026-07-16.

create or replace function public.rc_centro_reportes(
  p_desde date default null,
  p_hasta date default null,
  p_tipo text default null,
  p_funcionario text default null,
  p_origen text default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with filtrados as (
    select id, tipo, titular, cedula_titular, numero_acta, ano, fecha,
           legacy, owner_usuario, created_at, datos
    from public.rc_tramites
    where (p_desde is null or fecha >= p_desde)
      and (p_hasta is null or fecha <= p_hasta)
      and (p_tipo is null or p_tipo = '' or tipo = p_tipo)
      and (p_funcionario is null or p_funcionario = '' or owner_usuario = p_funcionario)
      and (p_origen is null or p_origen = '' or
           (p_origen = 'archivo' and legacy is true) or
           (p_origen = 'sistema' and legacy is false))
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrados),
    'archivo', (select count(*) from filtrados where legacy is true),
    'nuevos', (select count(*) from filtrados where legacy is false),
    'fecha_min', (select min(fecha) from filtrados),
    'fecha_max', (select max(fecha) from filtrados),
    'por_tipo', coalesce((
      select jsonb_object_agg(tipo, cantidad)
      from (select tipo, count(*) cantidad from filtrados group by tipo order by count(*) desc) x
    ), '{}'::jsonb),
    'por_funcionario', coalesce((
      select jsonb_object_agg(funcionario, cantidad)
      from (
        select coalesce(nullif(owner_usuario, ''), 'Sin funcionario') funcionario, count(*) cantidad
        from filtrados group by 1 order by count(*) desc
      ) x
    ), '{}'::jsonb),
    'por_mes', coalesce((
      select jsonb_object_agg(mes, cantidad)
      from (
        select to_char(fecha, 'YYYY-MM') mes, count(*) cantidad
        from filtrados where fecha is not null group by 1 order by 1
      ) x
    ), '{}'::jsonb),
    'copias_por_tipo', coalesce((
      select jsonb_object_agg(tipo_copia, cantidad)
      from (
        select coalesce(nullif(datos->>'tipo_copia', ''), 'Sin clasificación') tipo_copia, count(*) cantidad
        from filtrados where tipo = 'copia_acta' group by 1 order by count(*) desc
      ) x
    ), '{}'::jsonb),
    'preview', coalesce((
      select jsonb_agg(to_jsonb(x))
      from (
        select id, tipo, titular, cedula_titular, numero_acta, ano, fecha,
               legacy, owner_usuario
        from filtrados order by fecha desc nulls last, created_at desc limit 100
      ) x
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.rc_centro_reportes(date, date, text, text, text) from public, anon;
grant execute on function public.rc_centro_reportes(date, date, text, text, text) to authenticated, service_role;

drop policy if exists rc_tram_sel on public.rc_tramites;
create policy rc_tram_sel on public.rc_tramites
for select to authenticated
using (true);

notify pgrst, 'reload schema';
