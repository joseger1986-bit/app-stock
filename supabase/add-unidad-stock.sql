alter table productos
add column if not exists unidad_stock text not null default 'unidad';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'productos_unidad_stock_valida'
  ) then
    alter table productos
    add constraint productos_unidad_stock_valida
    check (unidad_stock in ('unidad', 'docena'));
  end if;
end;
$$;
