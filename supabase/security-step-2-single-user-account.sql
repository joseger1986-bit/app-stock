-- App Stock - Paso seguridad 2
-- Usuario unico de acceso para la app.
-- NO activa RLS sobre las 8 tablas principales de Stock.
-- NO modifica productos, stock, movimientos, transferencias, remitos, categorias, marcas ni ubicaciones.

create table if not exists app_access_account (
  singleton boolean primary key default true,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  email text not null,
  username text not null,
  updated_at timestamptz not null default now(),
  constraint app_access_account_singleton check (singleton),
  constraint app_access_account_email_no_vacio check (btrim(email) <> ''),
  constraint app_access_account_username_no_vacio check (btrim(username) <> '')
);

create unique index if not exists app_access_account_username_unique
  on app_access_account (lower(btrim(username)));

insert into app_access_account (singleton, auth_user_id, email, username)
select
  true,
  u.id,
  lower(u.email),
  split_part(lower(u.email), '@', 1)
from auth.users u
join app_admins a on a.email = lower(u.email)
order by u.created_at asc
limit 1
on conflict (singleton) do update
set
  auth_user_id = excluded.auth_user_id,
  email = excluded.email,
  username = coalesce(nullif(btrim(app_access_account.username), ''), excluded.username),
  updated_at = now();

create or replace function app_login_email_for_username(p_usuario text)
returns table (email text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_usuario text;
begin
  v_usuario := lower(btrim(coalesce(p_usuario, '')));

  if v_usuario = '' then
    return;
  end if;

  return query
  select a.email
  from app_access_account a
  where lower(btrim(a.username)) = v_usuario
     or lower(btrim(a.email)) = v_usuario
  limit 1;
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

alter table app_access_account enable row level security;

drop policy if exists app_access_account_select_admin on app_access_account;
create policy app_access_account_select_admin
on app_access_account
for select
to authenticated
using (app_is_admin());

revoke all on app_access_account from anon, authenticated;

grant execute on function app_login_email_for_username(text) to anon, authenticated;
grant execute on function app_get_access_account() to authenticated;
grant execute on function app_update_access_username(text) to authenticated;

select
  'security_step_2_ok' as resultado,
  email,
  username
from app_access_account
where singleton = true;
