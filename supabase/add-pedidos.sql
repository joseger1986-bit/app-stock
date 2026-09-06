-- App Stock - Pedidos
-- Agrega pedidos de locales al Depósito Minorista de forma aditiva.
-- NO borra datos.
-- NO modifica productos, stock, movimientos, transferencias, remitos, usuarios ni dispositivos.

create sequence if not exists pedido_numero_seq;

create table if not exists pedidos (
  id uuid primary key default gen_random_uuid(),
  numero text not null unique default ('P-' || lpad(nextval('pedido_numero_seq')::text, 8, '0')),
  fecha_hora timestamptz not null default now(),
  origen_id uuid not null references ubicaciones(id),
  destino_id uuid not null references ubicaciones(id),
  estado text not null default 'pendiente',
  observacion_general text,
  creado_por uuid default auth.uid() references auth.users(id) on delete set null,
  creado_email text,
  transferencia_id uuid unique references transferencias(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pedidos_estado_valido check (estado in ('pendiente', 'finalizado')),
  constraint pedidos_origen_destino_distintos check (origen_id <> destino_id)
);

create index if not exists pedidos_estado_idx
  on pedidos (estado);

create index if not exists pedidos_fecha_hora_idx
  on pedidos (fecha_hora desc);

create index if not exists pedidos_destino_idx
  on pedidos (destino_id);

create index if not exists pedidos_transferencia_idx
  on pedidos (transferencia_id);

alter table pedidos
  alter column creado_por set default auth.uid();

create table if not exists pedido_detalle (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references pedidos(id) on delete cascade,
  producto_id uuid not null references productos(id),
  cantidad_pedida numeric(12, 2) not null,
  cantidad_real numeric(12, 2) not null default 0,
  preparado boolean not null default false,
  observacion text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pedido_detalle_cantidad_pedida_positiva check (cantidad_pedida > 0),
  constraint pedido_detalle_cantidad_real_no_negativa check (cantidad_real >= 0),
  constraint pedido_detalle_producto_unico unique (pedido_id, producto_id)
);

create index if not exists pedido_detalle_pedido_idx
  on pedido_detalle (pedido_id);

create index if not exists pedido_detalle_producto_idx
  on pedido_detalle (producto_id);

drop trigger if exists pedidos_touch_updated_at on pedidos;
create trigger pedidos_touch_updated_at
before update on pedidos
for each row execute function app_touch_updated_at();

drop trigger if exists pedido_detalle_touch_updated_at on pedido_detalle;
create trigger pedido_detalle_touch_updated_at
before update on pedido_detalle
for each row execute function app_touch_updated_at();

alter table pedidos enable row level security;
alter table pedido_detalle enable row level security;

drop policy if exists pedidos_app_select on pedidos;
drop policy if exists pedidos_app_insert on pedidos;
drop policy if exists pedidos_app_update on pedidos;
create policy pedidos_app_select on pedidos
for select to authenticated
using (app_stock_access_allowed());
create policy pedidos_app_insert on pedidos
for insert to authenticated
with check (app_stock_access_allowed());
create policy pedidos_app_update on pedidos
for update to authenticated
using (app_stock_access_allowed())
with check (app_stock_access_allowed());

drop policy if exists pedido_detalle_app_select on pedido_detalle;
drop policy if exists pedido_detalle_app_insert on pedido_detalle;
drop policy if exists pedido_detalle_app_update on pedido_detalle;
drop policy if exists pedido_detalle_app_delete on pedido_detalle;
create policy pedido_detalle_app_select on pedido_detalle
for select to authenticated
using (app_stock_access_allowed());
create policy pedido_detalle_app_insert on pedido_detalle
for insert to authenticated
with check (app_stock_access_allowed());
create policy pedido_detalle_app_update on pedido_detalle
for update to authenticated
using (app_stock_access_allowed())
with check (app_stock_access_allowed());
create policy pedido_detalle_app_delete on pedido_detalle
for delete to authenticated
using (app_stock_access_allowed());

create or replace function finalizar_pedido(p_pedido_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pedido pedidos%rowtype;
  v_transferencia_id uuid;
  v_items jsonb;
  v_invalid_count integer;
begin
  if not app_stock_access_allowed() then
    raise exception 'No autorizado';
  end if;

  select *
    into v_pedido
  from pedidos p
  where p.id = p_pedido_id
  for update;

  if not found then
    raise exception 'Pedido inexistente';
  end if;

  if v_pedido.estado <> 'pendiente' then
    raise exception 'El pedido ya fue finalizado';
  end if;

  select count(*)
    into v_invalid_count
  from pedido_detalle d
  where d.pedido_id = p_pedido_id
    and (d.cantidad_pedida <= 0 or d.cantidad_real < 0);

  if v_invalid_count > 0 then
    raise exception 'El pedido tiene cantidades inválidas';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'producto_id', d.producto_id,
        'cantidad', d.cantidad_real
      )
      order by pr.nombre
    ),
    '[]'::jsonb
  )
    into v_items
  from pedido_detalle d
  join productos pr on pr.id = d.producto_id
  where d.pedido_id = p_pedido_id
    and d.cantidad_real > 0;

  if jsonb_array_length(v_items) = 0 then
    raise exception 'El pedido no tiene cantidades reales para enviar';
  end if;

  v_transferencia_id := transferir_stock(
    v_pedido.origen_id,
    v_pedido.destino_id,
    current_date,
    nullif(btrim(
      concat_ws(
        E'\n',
        'Pedido ' || v_pedido.numero,
        v_pedido.observacion_general
      )
    ), ''),
    v_items
  );

  update pedidos p
  set
    estado = 'finalizado',
    transferencia_id = v_transferencia_id
  where p.id = p_pedido_id
    and p.estado = 'pendiente';

  if not found then
    raise exception 'El pedido ya fue finalizado';
  end if;

  return v_transferencia_id;
end;
$$;

revoke all on pedidos from anon, authenticated;
revoke all on pedido_detalle from anon, authenticated;
revoke all on sequence pedido_numero_seq from anon, authenticated;

grant select, insert, update on pedidos to authenticated;
grant select, insert, update, delete on pedido_detalle to authenticated;
grant usage, select on sequence pedido_numero_seq to authenticated;
grant execute on function finalizar_pedido(uuid) to authenticated;

select
  'pedidos_ok' as resultado,
  (select count(*) from pedidos) as pedidos,
  (select count(*) from pedido_detalle) as detalle;
