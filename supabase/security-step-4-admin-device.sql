-- App Stock - Seguridad paso 4
-- Convierte la administracion de Seguridad en permiso por DISPOSITIVO.
-- NO borra datos.
-- NO modifica productos, stock, movimientos, transferencias, remitos, categorias, marcas ni ubicaciones.
-- NO cambia RLS de las 8 tablas principales de Stock.
-- Marca como UNICO dispositivo administrador el dispositivo confirmado del celular actual.

alter table dispositivos_autorizados
  add column if not exists es_admin boolean not null default false;

create unique index if not exists dispositivos_unico_admin_idx
  on dispositivos_autorizados (es_admin)
  where es_admin = true;

do $$
declare
  v_admin_device_id uuid;
  v_matches integer;
begin
  select count(*)
    into v_matches
  from dispositivos_autorizados d
  where d.id::text like '197bfd3f%';

  if v_matches = 0 then
    raise exception 'No se encontro ningun dispositivo cuyo id empiece con 197bfd3f';
  end if;

  if v_matches > 1 then
    raise exception 'Hay mas de un dispositivo cuyo id empieza con 197bfd3f. Usar el UUID completo.';
  end if;

  select d.id
    into v_admin_device_id
  from dispositivos_autorizados d
  where d.id::text like '197bfd3f%'
  order by d.id::text
  limit 1;

  update dispositivos_autorizados d
  set es_admin = false
  where d.es_admin = true
    and d.id <> v_admin_device_id;

  update dispositivos_autorizados d
  set es_admin = true
  where d.id = v_admin_device_id;

  update dispositivos_autorizados d
  set
    estado = 'aprobado',
    fecha_aprobacion = coalesce(d.fecha_aprobacion, now())
  where d.id = v_admin_device_id;
end;
$$;

create or replace function app_is_admin_account()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from app_admins a
    where a.email = app_current_user_email()
  );
$$;

create or replace function app_device_is_admin(
  p_device_id uuid,
  p_device_secret text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from dispositivos_autorizados d
      where d.id = p_device_id
        and d.user_id = auth.uid()
        and d.estado = 'aprobado'
        and d.es_admin = true
        and d.secret_hash = app_hash_device_secret(p_device_secret)
    );
$$;

create or replace function app_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_device_is_admin(app_request_device_id(), app_request_device_secret());
$$;

create or replace function app_register_device(
  p_device_id uuid,
  p_device_secret text,
  p_nombre text default null
)
returns table (
  id uuid,
  user_email text,
  nombre text,
  estado text,
  fecha_solicitud timestamptz,
  fecha_aprobacion timestamptz,
  ultimo_acceso timestamptz,
  is_admin boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Usuario no autenticado';
  end if;

  if not app_is_admin_account() then
    raise exception 'Usuario no autorizado para App Stock';
  end if;

  if p_device_id is null then
    raise exception 'Dispositivo inválido';
  end if;

  if p_device_secret is null or length(p_device_secret) < 24 then
    raise exception 'Credencial de dispositivo inválida';
  end if;

  insert into dispositivos_autorizados (
    id,
    user_id,
    user_email,
    nombre,
    estado,
    secret_hash,
    fecha_solicitud,
    ultimo_acceso
  )
  values (
    p_device_id,
    auth.uid(),
    app_current_user_email(),
    nullif(btrim(p_nombre), ''),
    'pendiente',
    app_hash_device_secret(p_device_secret),
    now(),
    now()
  )
  on conflict on constraint dispositivos_autorizados_pkey do update
  set
    ultimo_acceso = now(),
    nombre = coalesce(nullif(btrim(excluded.nombre), ''), dispositivos_autorizados.nombre),
    user_email = excluded.user_email
  where dispositivos_autorizados.user_id = auth.uid()
    and dispositivos_autorizados.secret_hash = app_hash_device_secret(p_device_secret);

  if not found then
    raise exception 'El dispositivo ya pertenece a otro usuario o la credencial local no coincide';
  end if;

  return query
  select
    d.id,
    d.user_email,
    d.nombre,
    d.estado,
    d.fecha_solicitud,
    d.fecha_aprobacion,
    d.ultimo_acceso,
    app_device_is_admin(p_device_id, p_device_secret)
  from dispositivos_autorizados d
  where d.id = p_device_id
    and d.user_id = auth.uid();
end;
$$;

create or replace function app_current_device_status(
  p_device_id uuid,
  p_device_secret text
)
returns table (
  id uuid,
  user_email text,
  nombre text,
  estado text,
  fecha_solicitud timestamptz,
  fecha_aprobacion timestamptz,
  ultimo_acceso timestamptz,
  is_admin boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Usuario no autenticado';
  end if;

  update dispositivos_autorizados d
  set ultimo_acceso = now()
  where d.id = p_device_id
    and d.user_id = auth.uid()
    and d.secret_hash = app_hash_device_secret(p_device_secret);

  return query
  select
    d.id,
    d.user_email,
    d.nombre,
    d.estado,
    d.fecha_solicitud,
    d.fecha_aprobacion,
    d.ultimo_acceso,
    app_device_is_admin(p_device_id, p_device_secret)
  from dispositivos_autorizados d
  where d.id = p_device_id
    and d.user_id = auth.uid()
    and d.secret_hash = app_hash_device_secret(p_device_secret);
end;
$$;

create or replace function app_list_devices()
returns table (
  id uuid,
  user_email text,
  nombre text,
  estado text,
  fecha_solicitud timestamptz,
  fecha_aprobacion timestamptz,
  ultimo_acceso timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not app_is_admin() then
    raise exception 'No autorizado';
  end if;

  return query
  select
    d.id,
    d.user_email,
    d.nombre,
    d.estado,
    d.fecha_solicitud,
    d.fecha_aprobacion,
    d.ultimo_acceso
  from dispositivos_autorizados d
  order by
    case when d.es_admin then 0 else 1 end,
    d.fecha_solicitud desc;
end;
$$;

create or replace function app_set_device_status(
  p_device_id uuid,
  p_estado text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not app_is_admin() then
    raise exception 'No autorizado';
  end if;

  if p_estado not in ('pendiente', 'aprobado', 'revocado') then
    raise exception 'Estado de dispositivo inválido';
  end if;

  if p_device_id = app_request_device_id() and p_estado <> 'aprobado' then
    raise exception 'No podés revocar el dispositivo administrador desde este dispositivo';
  end if;

  update dispositivos_autorizados d
  set
    estado = p_estado,
    fecha_aprobacion = case
      when p_estado = 'aprobado' then coalesce(d.fecha_aprobacion, now())
      else d.fecha_aprobacion
    end
  where d.id = p_device_id;
end;
$$;

create or replace function app_rename_device(
  p_device_id uuid,
  p_nombre text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not app_is_admin() then
    raise exception 'No autorizado';
  end if;

  update dispositivos_autorizados d
  set nombre = nullif(btrim(p_nombre), '')
  where d.id = p_device_id;
end;
$$;

create or replace function app_get_access_account()
returns table (
  email text,
  username text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not app_is_admin() then
    raise exception 'No autorizado';
  end if;

  return query
  select a.email, a.username
  from app_access_account a
  where a.singleton = true
  limit 1;
end;
$$;

create or replace function app_update_access_username(p_username text)
returns table (
  email text,
  username text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
begin
  if auth.uid() is null or not app_is_admin() then
    raise exception 'No autorizado';
  end if;

  v_username := lower(btrim(coalesce(p_username, '')));

  if v_username = '' then
    raise exception 'El usuario no puede estar vacio';
  end if;

  update app_access_account a
  set
    username = v_username,
    updated_at = now()
  where a.singleton = true;

  return query
  select a.email, a.username
  from app_access_account a
  where a.singleton = true
  limit 1;
end;
$$;

grant execute on function app_is_admin_account() to authenticated;
grant execute on function app_device_is_admin(uuid, text) to authenticated;
grant execute on function app_is_admin() to authenticated;
grant execute on function app_register_device(uuid, text, text) to authenticated;
grant execute on function app_current_device_status(uuid, text) to authenticated;
grant execute on function app_list_devices() to authenticated;
grant execute on function app_set_device_status(uuid, text) to authenticated;
grant execute on function app_rename_device(uuid, text) to authenticated;
grant execute on function app_get_access_account() to authenticated;
grant execute on function app_update_access_username(text) to authenticated;

select
  'security_step_4_admin_device_ok' as resultado,
  count(*) filter (where es_admin = true) as dispositivos_admin,
  count(*) filter (where estado = 'aprobado') as dispositivos_aprobados,
  count(*) filter (where estado = 'pendiente') as dispositivos_pendientes,
  count(*) filter (where estado = 'revocado') as dispositivos_revocados
from dispositivos_autorizados;
