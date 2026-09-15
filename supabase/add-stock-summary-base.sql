-- App Stock - Resumen de stock / foto base
-- Migracion aditiva e idempotente.
-- No modifica productos, stock real, movimientos, transferencias, remitos ni pedidos.

create table if not exists public.stock_base_fotos (
  id uuid primary key default gen_random_uuid(),
  fecha date not null default current_date,
  nombre text,
  activa boolean not null default true,
  creado_por uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.stock_base_detalle (
  id uuid primary key default gen_random_uuid(),
  foto_id uuid not null references public.stock_base_fotos(id) on delete cascade,
  producto_id uuid not null references public.productos(id),
  categoria_id uuid references public.categorias(id),
  ubicacion_id uuid not null references public.ubicaciones(id),
  unidad_stock text not null check (unidad_stock in ('unidad', 'docena')),
  cantidad_inicial numeric(12,2) not null default 0,
  producto_nombre text not null,
  categoria_nombre text,
  ubicacion_nombre text not null,
  created_at timestamptz not null default now(),
  constraint stock_base_detalle_unico unique (foto_id, producto_id, ubicacion_id)
);

create index if not exists stock_base_fotos_activa_idx
  on public.stock_base_fotos (activa);

create index if not exists stock_base_fotos_fecha_idx
  on public.stock_base_fotos (fecha desc, created_at desc);

create index if not exists stock_base_detalle_foto_idx
  on public.stock_base_detalle (foto_id);

create index if not exists stock_base_detalle_producto_idx
  on public.stock_base_detalle (producto_id);

create index if not exists stock_base_detalle_categoria_idx
  on public.stock_base_detalle (categoria_id);

create index if not exists stock_base_detalle_ubicacion_idx
  on public.stock_base_detalle (ubicacion_id);

alter table public.stock_base_fotos enable row level security;
alter table public.stock_base_detalle enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'stock_base_fotos'
      and policyname = 'stock_base_fotos_select_autorizado'
  ) then
    create policy stock_base_fotos_select_autorizado
      on public.stock_base_fotos
      for select
      to authenticated
      using (public.app_stock_access_allowed());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'stock_base_fotos'
      and policyname = 'stock_base_fotos_insert_autorizado'
  ) then
    create policy stock_base_fotos_insert_autorizado
      on public.stock_base_fotos
      for insert
      to authenticated
      with check (public.app_stock_access_allowed());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'stock_base_fotos'
      and policyname = 'stock_base_fotos_update_autorizado'
  ) then
    create policy stock_base_fotos_update_autorizado
      on public.stock_base_fotos
      for update
      to authenticated
      using (public.app_stock_access_allowed())
      with check (public.app_stock_access_allowed());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'stock_base_detalle'
      and policyname = 'stock_base_detalle_select_autorizado'
  ) then
    create policy stock_base_detalle_select_autorizado
      on public.stock_base_detalle
      for select
      to authenticated
      using (public.app_stock_access_allowed());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'stock_base_detalle'
      and policyname = 'stock_base_detalle_insert_autorizado'
  ) then
    create policy stock_base_detalle_insert_autorizado
      on public.stock_base_detalle
      for insert
      to authenticated
      with check (public.app_stock_access_allowed());
  end if;
end $$;

grant select, insert, update on public.stock_base_fotos to authenticated;
grant select, insert on public.stock_base_detalle to authenticated;

create or replace function public.crear_stock_base(
  p_fecha date default current_date,
  p_nombre text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_foto_id uuid;
begin
  if not public.app_stock_access_allowed() then
    raise exception 'No autorizado para crear stock base';
  end if;

  update public.stock_base_fotos
  set activa = false
  where activa = true;

  insert into public.stock_base_fotos (fecha, nombre, activa, creado_por)
  values (
    coalesce(p_fecha, current_date),
    nullif(btrim(p_nombre), ''),
    true,
    auth.uid()
  )
  returning id into v_foto_id;

  insert into public.stock_base_detalle (
    foto_id,
    producto_id,
    categoria_id,
    ubicacion_id,
    unidad_stock,
    cantidad_inicial,
    producto_nombre,
    categoria_nombre,
    ubicacion_nombre
  )
  select
    v_foto_id,
    p.id,
    p.categoria_id,
    s.ubicacion_id,
    coalesce(p.unidad_stock, 'unidad'),
    coalesce(s.cantidad, 0),
    p.nombre,
    c.nombre,
    u.nombre
  from public.stock s
  join public.productos p on p.id = s.producto_id
  left join public.categorias c on c.id = p.categoria_id
  join public.ubicaciones u on u.id = s.ubicacion_id
  where p.activo is distinct from false;

  return v_foto_id;
end;
$$;

revoke all on function public.crear_stock_base(date, text) from public;
grant execute on function public.crear_stock_base(date, text) to authenticated;

select
  'add_stock_summary_base_ok' as resultado,
  count(*) filter (where activa) as fotos_activas
from public.stock_base_fotos;
