-- App Stock - Seguridad paso 1
-- Crea la infraestructura de usuarios administradores y dispositivos.
-- Este paso NO activa RLS en las tablas funcionales de Stock.
-- Reemplazar ADMIN_EMAIL_AQUI por el email exacto del usuario administrador creado en Supabase Auth.

create extension if not exists pgcrypto;

create table if not exists app_admins (
  email text primary key,
  created_at timestamptz not null default now(),
  constraint app_admins_email_no_vacio check (btrim(email) <> '')
);

insert into app_admins (email)
values (lower(btrim('ADMIN_EMAIL_AQUI')))
on conflict (email) do nothing;

create table if not exists dispositivos_autorizados (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text not null,
  nombre text,
  estado text not null default 'pendiente',
  secret_hash text not null,
  fecha_solicitud timestamptz not null default now(),
  fecha_aprobacion timestamptz,
  ultimo_acceso timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dispositivos_estado_valido check (estado in ('pendiente', 'aprobado', 'revocado')),
  constraint dispositivos_secret_hash_no_vacio check (btrim(secret_hash) <> '')
);

create index if not exists dispositivos_user_id_idx
  on dispositivos_autorizados (user_id);

create index if not exists dispositivos_estado_idx
  on dispositivos_autorizados (estado);

create index if not exists dispositivos_user_estado_idx
  on dispositivos_autorizados (user_id, estado);

create or replace function app_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists dispositivos_touch_updated_at on dispositivos_autorizados;
create trigger dispositivos_touch_updated_at
before update on dispositivos_autorizados
for each row execute function app_touch_updated_at();

create or replace function app_current_user_email()
returns text
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function app_hash_device_secret(p_secret text)
returns text
language sql
immutable
as $$
  select encode(extensions.digest(convert_to(coalesce(p_secret, ''), 'UTF8'), 'sha256'::text), 'hex');
$$;

create or replace function app_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from app_admins
    where email = app_current_user_email()
  );
$$;

create or replace function app_request_headers()
returns jsonb
language plpgsql
stable
as $$
declare
  v_headers jsonb;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := '{}'::jsonb;
  end;

  return coalesce(v_headers, '{}'::jsonb);
end;
$$;

create or replace function app_request_device_id()
returns uuid
language plpgsql
stable
as $$
declare
  v_id text;
begin
  v_id := app_request_headers() ->> 'x-app-device-id';
  if v_id is null or btrim(v_id) = '' then
    return null;
  end if;
  return v_id::uuid;
exception when others then
  return null;
end;
$$;

create or replace function app_request_device_secret()
returns text
language sql
stable
as $$
  select nullif(app_request_headers() ->> 'x-app-device-secret', '');
$$;

create or replace function app_current_device_approved()
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
      where d.id = app_request_device_id()
        and d.user_id = auth.uid()
        and d.estado = 'aprobado'
        and d.secret_hash = app_hash_device_secret(app_request_device_secret())
    );
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
  where dispositivos_autorizados.user_id = auth.uid();

  if not found then
    raise exception 'El dispositivo ya pertenece a otro usuario';
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
    app_is_admin()
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
    app_is_admin()
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
  order by d.fecha_solicitud desc;
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

  update dispositivos_autorizados
  set
    estado = p_estado,
    fecha_aprobacion = case
      when p_estado = 'aprobado' then coalesce(fecha_aprobacion, now())
      else fecha_aprobacion
    end
  where id = p_device_id;
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

  update dispositivos_autorizados
  set nombre = nullif(btrim(p_nombre), '')
  where id = p_device_id;
end;
$$;

alter table app_admins enable row level security;
alter table dispositivos_autorizados enable row level security;

drop policy if exists app_admins_select_admin on app_admins;
create policy app_admins_select_admin
on app_admins
for select
to authenticated
using (app_is_admin());

drop policy if exists dispositivos_select_own_or_admin on dispositivos_autorizados;
create policy dispositivos_select_own_or_admin
on dispositivos_autorizados
for select
to authenticated
using (user_id = auth.uid() or app_is_admin());

revoke all on app_admins from anon, authenticated;
revoke all on dispositivos_autorizados from anon, authenticated;

grant execute on function app_is_admin() to authenticated;
grant execute on function app_current_device_approved() to authenticated;
grant execute on function app_register_device(uuid, text, text) to authenticated;
grant execute on function app_current_device_status(uuid, text) to authenticated;
grant execute on function app_list_devices() to authenticated;
grant execute on function app_set_device_status(uuid, text) to authenticated;
grant execute on function app_rename_device(uuid, text) to authenticated;

select
  'security_step_1_ok' as resultado,
  (select count(*) from app_admins) as administradores,
  (select count(*) from dispositivos_autorizados) as dispositivos;
