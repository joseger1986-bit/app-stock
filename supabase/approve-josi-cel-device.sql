-- App Stock - Reautorizar celular Josi
-- NO borra datos.
-- NO modifica productos, stock, movimientos, transferencias, remitos ni datos comerciales.
-- Actualiza solamente el registro del dispositivo indicado.

do $$
declare
  v_device_id uuid := 'f97bfd3f-39d6-41c0-b632-7646be239bb7';
  v_found integer;
begin
  select count(*)
    into v_found
  from dispositivos_autorizados d
  where d.id = v_device_id;

  if v_found = 0 then
    raise exception 'No existe el dispositivo % en dispositivos_autorizados', v_device_id;
  end if;

  update dispositivos_autorizados d
  set
    nombre = 'Josi cel',
    estado = 'aprobado',
    fecha_aprobacion = coalesce(d.fecha_aprobacion, now()),
    updated_at = now()
  where d.id = v_device_id;
end;
$$;

select
  id,
  nombre,
  estado,
  fecha_aprobacion,
  ultimo_acceso
from dispositivos_autorizados
where id = 'f97bfd3f-39d6-41c0-b632-7646be239bb7';
