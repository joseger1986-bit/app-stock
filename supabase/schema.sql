create extension if not exists pgcrypto;

create table if not exists categorias (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  constraint categorias_nombre_no_vacio check (btrim(nombre) <> '')
);

create unique index if not exists categorias_nombre_unico
  on categorias (lower(nombre));

create table if not exists marcas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  constraint marcas_nombre_no_vacio check (btrim(nombre) <> '')
);

create unique index if not exists marcas_nombre_unico
  on marcas (lower(nombre));

create table if not exists ubicaciones (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  constraint ubicaciones_nombre_no_vacio check (btrim(nombre) <> '')
);

create unique index if not exists ubicaciones_nombre_unico
  on ubicaciones (lower(nombre));

create table if not exists productos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  categoria_id uuid references categorias(id),
  marca_id uuid references marcas(id),
  costo numeric(12, 2),
  precio_venta numeric(12, 2),
  stock_minimo numeric(12, 2),
  unidad_stock text not null default 'unidad',
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  constraint productos_nombre_no_vacio check (btrim(nombre) <> ''),
  constraint productos_costo_no_negativo check (costo is null or costo >= 0),
  constraint productos_precio_venta_no_negativo check (precio_venta is null or precio_venta >= 0),
  constraint productos_stock_minimo_no_negativo check (stock_minimo is null or stock_minimo >= 0),
  constraint productos_unidad_stock_valida check (unidad_stock in ('unidad', 'docena'))
);

create index if not exists productos_nombre_idx
  on productos using gin (to_tsvector('simple', nombre));

create index if not exists productos_categoria_idx
  on productos (categoria_id);

create index if not exists productos_marca_idx
  on productos (marca_id);

create index if not exists productos_activo_idx
  on productos (activo);

create table if not exists stock (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references productos(id),
  ubicacion_id uuid not null references ubicaciones(id),
  cantidad numeric(12, 2) not null default 0,
  constraint stock_cantidad_no_negativa check (cantidad >= 0),
  constraint stock_producto_ubicacion_unico unique (producto_id, ubicacion_id)
);

create index if not exists stock_producto_idx
  on stock (producto_id);

create index if not exists stock_ubicacion_idx
  on stock (ubicacion_id);

create sequence if not exists transferencia_numero_seq;

create table if not exists transferencias (
  id uuid primary key default gen_random_uuid(),
  numero text not null unique,
  fecha date not null default current_date,
  origen_id uuid not null references ubicaciones(id),
  destino_id uuid not null references ubicaciones(id),
  observaciones text,
  created_at timestamptz not null default now(),
  constraint transferencias_origen_destino_distintos check (origen_id <> destino_id)
);

create index if not exists transferencias_fecha_idx
  on transferencias (fecha);

create index if not exists transferencias_origen_idx
  on transferencias (origen_id);

create index if not exists transferencias_destino_idx
  on transferencias (destino_id);

create table if not exists transferencia_detalle (
  id uuid primary key default gen_random_uuid(),
  transferencia_id uuid not null references transferencias(id) on delete restrict,
  producto_id uuid not null references productos(id),
  cantidad numeric(12, 2) not null,
  constraint transferencia_detalle_cantidad_positiva check (cantidad > 0)
);

create index if not exists transferencia_detalle_transferencia_idx
  on transferencia_detalle (transferencia_id);

create index if not exists transferencia_detalle_producto_idx
  on transferencia_detalle (producto_id);

create table if not exists movimientos_stock (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references productos(id),
  ubicacion_id uuid not null references ubicaciones(id),
  tipo text not null,
  cantidad numeric(12, 2) not null,
  transferencia_id uuid references transferencias(id),
  observaciones text,
  created_at timestamptz not null default now(),
  constraint movimientos_stock_tipo_valido check (
    tipo in (
      'stock inicial',
      'ingreso',
      'transferencia salida',
      'transferencia entrada',
      'ajuste'
    )
  ),
  constraint movimientos_stock_cantidad_no_cero check (cantidad <> 0)
);

create index if not exists movimientos_stock_producto_idx
  on movimientos_stock (producto_id);

create index if not exists movimientos_stock_ubicacion_idx
  on movimientos_stock (ubicacion_id);

create index if not exists movimientos_stock_created_at_idx
  on movimientos_stock (created_at desc);

create index if not exists movimientos_stock_transferencia_idx
  on movimientos_stock (transferencia_id);

insert into categorias (nombre)
values
  ('Medias Importadas'),
  ('Medias Pamel'),
  ('Lencería'),
  ('Ropa Interior Hombre'),
  ('Ropa Interior Dama'),
  ('Blanquería'),
  ('Indumentaria'),
  ('Colegial')
on conflict do nothing;

insert into ubicaciones (nombre)
values
  ('Depósito Minorista'),
  ('La Gran Barata Peatonal'),
  ('La Gran Barata Avenida de Mayo')
on conflict do nothing;

create or replace function transferir_stock(
  p_origen_id uuid,
  p_destino_id uuid,
  p_fecha date,
  p_observaciones text,
  p_items jsonb
)
returns uuid
language plpgsql
as $$
declare
  v_transferencia_id uuid;
  v_numero text;
  v_item_count integer;
  v_invalid_count integer;
begin
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
