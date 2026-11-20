# El Morterito

App web de stock y ventas (minoristas y mayoristas) para El Morterito. Corre en Vercel con la base de datos en Turso, y se entra desde el navegador con una contraseña compartida.

## Uso

- **Vender:** buscar o tocar productos, ajustar cantidades en el ticket y cobrar. También se cargan compras de mercadería y ajustes de stock.
- **Productos:** alta y edición, precios minorista/mayorista y stock mínimo.
- **Movimientos:** historial por fechas; un movimiento mal cargado se borra y el stock se recalcula solo.
- **Informes:** ventas del mes, compras, faltantes y lo más vendido. Se puede imprimir.

## Deploy en Vercel

Variables de entorno del proyecto en Vercel:

| Variable | Qué es |
|---|---|
| `TURSO_DATABASE_URL` | URL de la base en Turso (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | Token de acceso de esa base |
| `APP_PASSWORD` | Contraseña para entrar a la app |

Las tablas se crean solas en el primer uso. Cambiar `APP_PASSWORD` cierra todas las sesiones abiertas.

## Desarrollo

```
npm install
npm test           # pruebas con una base temporal
npm start          # http://localhost:3000 con base local morterito.db (sin contraseña)
```
