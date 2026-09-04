-- App Stock - RLS final
-- Protege las 8 tablas principales de Stock.
-- NO borra datos.
-- NO recrea tablas.
-- NO toca ubicaciones, Auth, app_admins, dispositivos_autorizados ni app_access_account.

create or replace function app_stock_access_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from app_access_account a
      where a.singleton = true
        and a.auth_user_id = auth.uid()
    )
    and app_current_device_approved();
$$;

create or replace function transferir_stock(
  p_origen_id uuid,
  p_destino_id uuid,
  p_fecha date,
  p_observaciones text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_transferencia_id uuid;
  v_numero text;
  v_item_count integer;
  v_invalid_count integer;
begin
  if not app_stock_access_allowed() then
    raise exception 'No autorizado';
  end if;

  if p_origen_id = p_destino_id then
    raise exception 'El origen y el destino deben ser distintos';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'La transferencia debe tener al menos un producto';
  end if;

  create temp table tmp_transfer_items (
    producto_id uuid primary key,
    cantidad numeric(12, 2) not null
  ) on commit drop;

  insert into tmp_transfer_items (producto_id, cantidad)
  select producto_id, sum(cantidad)
  from jsonb_to_recordset(p_items) as item(producto_id uuid, cantidad numeric)
  group by producto_id;

  select count(*) into v_item_count
  from tmp_transfer_items;

  select count(*) into v_invalid_count
  from tmp_transfer_items
  where cantidad <= 0;

  if v_item_count = 0 or v_invalid_count > 0 then
    raise exception 'Todas las cantidades deben ser mayores a cero';
  end if;

  if not exists (select 1 from ubicaciones where id = p_origen_id and activo = true) then
    raise exception 'La ubicación de origen no existe o está inactiva';
  end if;

  if not exists (select 1 from ubicaciones where id = p_destino_id and activo = true) then
    raise exception 'La ubicación de destino no existe o está inactiva';
  end if;

  if exists (
    select 1
    from tmp_transfer_items item
    left join productos producto on producto.id = item.producto_id and producto.activo = true
    where producto.id is null
  ) then
    raise exception 'La transferencia contiene productos inexistentes o inactivos';
  end if;

  insert into stock (producto_id, ubicacion_id, cantidad)
  select producto_id, p_origen_id, 0
  from tmp_transfer_items
  on conflict (producto_id, ubicacion_id) do nothing;

  insert into stock (producto_id, ubicacion_id, cantidad)
  select producto_id, p_destino_id, 0
  from tmp_transfer_items
  on conflict (producto_id, ubicacion_id) do nothing;

  perform 1
  from stock s
  join tmp_transfer_items item on item.producto_id = s.producto_id
  where s.ubicacion_id = p_origen_id
  for update;

  if exists (
    select 1
    from tmp_transfer_items item
    join stock s on s.producto_id = item.producto_id and s.ubicacion_id = p_origen_id
    where s.cantidad < item.cantidad
  ) then
    raise exception 'Stock insuficiente en la ubicación de origen';
  end if;

  v_numero := 'R-' || lpad(nextval('transferencia_numero_seq')::text, 8, '0');

  insert into transferencias (numero, fecha, origen_id, destino_id, observaciones)
  values (v_numero, coalesce(p_fecha, current_date), p_origen_id, p_destino_id, nullif(btrim(p_observaciones), ''))
  returning id into v_transferencia_id;

  insert into transferencia_detalle (transferencia_id, producto_id, cantidad)
  select v_transferencia_id, producto_id, cantidad
  from tmp_transfer_items;

  update stock s
  set cantidad = s.cantidad - item.cantidad
  from tmp_transfer_items item
  where s.producto_id = item.producto_id
    and s.ubicacion_id = p_origen_id;

  update stock s
  set cantidad = s.cantidad + item.cantidad
  from tmp_transfer_items item
  where s.producto_id = item.producto_id
    and s.ubicacion_id = p_destino_id;

  insert into movimientos_stock (
    producto_id,
    ubicacion_id,
    tipo,
    cantidad,
    transferencia_id,
    observaciones
  )
  select
    producto_id,
    p_origen_id,
    'transferencia salida',
    cantidad * -1,
    v_transferencia_id,
    nullif(btrim(p_observaciones), '')
  from tmp_transfer_items;

  insert into movimientos_stock (
    producto_id,
    ubicacion_id,
    tipo,
    cantidad,
    transferencia_id,
    observaciones
  )
  select
    producto_id,
    p_destino_id,
    'transferencia entrada',
    cantidad,
    v_transferencia_id,
    nullif(btrim(p_observaciones), '')
  from tmp_transfer_items;

  return v_transferencia_id;
end;
$$;

alter table categorias enable row level security;
alter table marcas enable row level security;
alter table ubicaciones enable row level security;
alter table productos enable row level security;
alter table stock enable row level security;
alter table transferencias enable row level security;
alter table transferencia_detalle enable row level security;
alter table movimientos_stock enable row level security;

drop policy if exists categorias_app_select on categorias;
drop policy if exists categorias_app_insert on categorias;
drop policy if exists categorias_app_update on categorias;
create policy categorias_app_select on categorias
for select to authenticated
using (app_stock_access_allowed());
create policy categorias_app_insert on categorias
for insert to authenticated
with check (app_stock_access_allowed());
create policy categorias_app_update on categorias
for update to authenticated
using (app_stock_access_allowed())
with check (app_stock_access_allowed());

drop policy if exists marcas_app_select on marcas;
drop policy if exists marcas_app_insert on marcas;
drop policy if exists marcas_app_update on marcas;
create policy marcas_app_select on marcas
for select to authenticated
using (app_stock_access_allowed());
create policy marcas_app_insert on marcas
for insert to authenticated
with check (app_stock_access_allowed());
create policy marcas_app_update on marcas
for update to authenticated
using (app_stock_access_allowed())
with check (app_stock_access_allowed());

drop policy if exists ubicaciones_app_select on ubicaciones;
create policy ubicaciones_app_select on ubicaciones
for select to authenticated
using (app_stock_access_allowed());

drop policy if exists productos_app_select on productos;
drop policy if exists productos_app_insert on productos;
drop policy if exists productos_app_update on productos;
create policy productos_app_select on productos
for select to authenticated
using (app_stock_access_allowed());
create policy productos_app_insert on productos
for insert to authenticated
with check (app_stock_access_allowed());
create policy productos_app_update on productos
for update to authenticated
using (app_stock_access_allowed())
with check (app_stock_access_allowed());

drop policy if exists stock_app_select on stock;
drop policy if exists stock_app_insert on stock;
drop policy if exists stock_app_update on stock;
create policy stock_app_select on stock
for select to authenticated
using (app_stock_access_allowed());
create policy stock_app_insert on stock
for insert to authenticated
with check (app_stock_access_allowed());
create policy stock_app_update on stock
for update to authenticated
using (app_stock_access_allowed())
with check (app_stock_access_allowed());

drop policy if exists transferencias_app_select on transferencias;
create policy transferencias_app_select on transferencias
for select to authenticated
using (app_stock_access_allowed());

drop policy if exists transferencia_detalle_app_select on transferencia_detalle;
create policy transferencia_detalle_app_select on transferencia_detalle
for select to authenticated
using (app_stock_access_allowed());

drop policy if exists movimientos_stock_app_select on movimientos_stock;
drop policy if exists movimientos_stock_app_insert on movimientos_stock;
create policy movimientos_stock_app_select on movimientos_stock
for select to authenticated
using (app_stock_access_allowed());
create policy movimientos_stock_app_insert on movimientos_stock
for insert to authenticated
with check (app_stock_access_allowed());

revoke all on categorias from anon, authenticated;
revoke all on marcas from anon, authenticated;
revoke all on ubicaciones from anon, authenticated;
revoke all on productos from anon, authenticated;
revoke all on stock from anon, authenticated;
revoke all on transferencias from anon, authenticated;
revoke all on transferencia_detalle from anon, authenticated;
revoke all on movimientos_stock from anon, authenticated;
revoke all on sequence transferencia_numero_seq from anon, authenticated;

grant select, insert, update on categorias to authenticated;
grant select, insert, update on marcas to authenticated;
grant select on ubicaciones to authenticated;
grant select, insert, update on productos to authenticated;
grant select, insert, update on stock to authenticated;
grant select on transferencias to authenticated;
grant select on transferencia_detalle to authenticated;
grant select, insert on movimientos_stock to authenticated;

grant execute on function app_stock_access_allowed() to authenticated;
grant execute on function transferir_stock(uuid, uuid, date, text, jsonb) to authenticated;

select
  'security_step_3_rls_ok' as resultado,
  (select count(*) from app_access_account where username = 'deposito') as usuario_deposito,
  (select count(*) from dispositivos_autorizados where estado = 'aprobado') as dispositivos_aprobados;

select
  c.relname as tabla,
  c.relrowsecurity as rls_activado,
  c.relforcerowsecurity as rls_forzado
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'categorias',
    'marcas',
    'ubicaciones',
    'productos',
    'stock',
    'transferencias',
    'transferencia_detalle',
    'movimientos_stock'
  )
order by c.relname;

select
  'productos' as tabla,
  count(*) as registros
from productos
union all
select 'stock', count(*) from stock
union all
select 'movimientos_stock', count(*) from movimientos_stock
union all
select 'transferencias', count(*) from transferencias
union all
select 'transferencia_detalle', count(*) from transferencia_detalle
union all
select 'categorias', count(*) from categorias
union all
select 'marcas', count(*) from marcas
union all
select 'ubicaciones', count(*) from ubicaciones
order by tabla;

select
  nombre,
  activo
from ubicaciones
where nombre in (
  'Depósito Minorista',
  'La Gran Barata Avenida de Mayo',
  'La Gran Barata Peatonal'
)
order by nombre;

select
  username,
  email
from app_access_account;

select
  nombre,
  user_email,
  estado,
  fecha_aprobacion,
  ultimo_acceso
from dispositivos_autorizados
order by fecha_solicitud desc;
