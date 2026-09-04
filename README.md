# App Stock

Aplicación web interna para control de stock y transferencias.

## Estructura

- `index.html`: pantalla base y navegación principal.
- `styles.css`: estilos responsive para PC y celular.
- `app.js`: navegación, conexión Supabase y carga inicial de maestros.
- `config.example.js`: ejemplo de configuración local.
- `supabase/schema.sql`: tablas, relaciones, índices, datos iniciales y función segura de transferencia.

## Conectar con Supabase

1. Entrar al proyecto Supabase independiente llamado `app stock`.
2. Abrir SQL Editor.
3. Ejecutar el contenido de `supabase/schema.sql`.
4. Copiar `config.example.js` como `config.js`.
5. Completar `supabaseUrl` y `supabaseAnonKey` con los datos del proyecto Supabase.

`config.js` queda fuera de Git para no subir claves al repositorio.

## Despliegue en Vercel

El repositorio no sube `config.js`. En producción Vercel lo genera durante el build desde variables de entorno.

Configurar en Vercel, dentro del proyecto:

- `APP_STOCK_SUPABASE_URL`: URL del proyecto Supabase de App Stock.
- `APP_STOCK_SUPABASE_PUBLISHABLE_KEY`: clave pública/publishable del proyecto Supabase de App Stock.

Build command:

```bash
npm run build
```

Output directory:

```bash
dist
```

Después del primer deploy, la URL de Vercel cuenta como un origen nuevo del navegador. El mismo dispositivo físico puede quedar pendiente una vez para esa URL; aprobarlo desde un dispositivo ya autorizado.
