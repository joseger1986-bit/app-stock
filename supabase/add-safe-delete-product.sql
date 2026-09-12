-- App Stock - Eliminación segura de productos
-- Proyecto Supabase esperado: pektqgzlddeqwcnrnuno
--
-- IMPORTANTE:
-- - No borra stock con cantidad distinta de cero.
-- - No borra movimientos, pedidos, transferencias ni remitos/historial.
-- - Solo permite eliminar un producto sin stock y sin historial relacionado.
-- - Usa app_stock_access_allowed(), por lo que requiere sesión válida y dispositivo aprobado.

create or replace function eliminar_producto_seguro(p_producto_id uuid)
returns table (
  producto_id uuid,
  eliminado boolean,
  mensaje text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_producto productos%rowtype;
  v_stock_con_cantidad integer;
  v_stock_total numeric(12, 2);
  v_movimientos integer;
  v_transferencias integer;
  v_pedidos integer;
begin
  if not app_stock_access_allowed() then
    raise exception 'No autorizado';
  end if;

  select *
    into v_producto
  from productos p
  where p.id = p_producto_id
  for update;

  if not found then
    raise exception 'El producto no existe o ya fue eliminado.';
  end if;

  select
    count(*) filter (where s.cantidad <> 0),
    coalesce(sum(s.cantidad), 0)
    into v_stock_con_cantidad, v_stock_total
  from stock s
  where s.producto_id = p_producto_id;

  select count(*)
    into v_movimientos
  from movimientos_stock ms
  where ms.producto_id = p_producto_id;

  select count(*)
    into v_transferencias
  from transferencia_detalle td
  where td.producto_id = p_producto_id;

  select count(*)
    into v_pedidos
  from pedido_detalle pd
  where pd.producto_id = p_producto_id;

  if v_stock_con_cantidad > 0 then
    raise exception 'No se puede eliminar "%": tiene stock cargado (%). Primero debe quedar en 0 en todas las ubicaciones.',
      v_producto.nombre,
      v_stock_total;
  end if;

  if v_movimientos > 0 then
    raise exception 'No se puede eliminar "%": tiene movimientos de stock relacionados.',
      v_producto.nombre;
  end if;

  if v_transferencias > 0 then
    raise exception 'No se puede eliminar "%": tiene transferencias/remitos relacionados.',
      v_producto.nombre;
  end if;

  if v_pedidos > 0 then
    raise exception 'No se puede eliminar "%": tiene pedidos relacionados.',
      v_producto.nombre;
  end if;

  delete from stock s
  where s.producto_id = p_producto_id;

  delete from productos p
  where p.id = p_producto_id;

  producto_id := p_producto_id;
  eliminado := true;
  mensaje := format('Producto "%s" eliminado correctamente.', v_producto.nombre);
  return next;
end;
$$;

revoke all on function eliminar_producto_seguro(uuid) from public;
grant execute on function eliminar_producto_seguro(uuid) to authenticated;
