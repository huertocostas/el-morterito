# El Morterito

App web de stock, ventas (minoristas y mayoristas) y caja para El Morterito. Corre en Vercel con la base de datos en Turso, y se entra desde el navegador con una contraseña compartida.

## Uso

- **Apertura de caja:** al entrar cada día se pide con cuánto efectivo se arranca.
- **Vender:** buscar o tocar productos, ajustar cantidades en el ticket, elegir efectivo o transferencia y cobrar.
- **Stock:** tocar un producto y elegir *Entró* (mercadería del proveedor), *Salió* (rotura, vencido) o *Conté* (se escribe lo que hay y la app corrige la diferencia).
- **Productos:** alta, edición, costo y precios, stock mínimo; se borran los que no tienen ventas y se desactivan los que sí.
- **Historial:** movimientos por fechas; uno mal cargado se borra y el stock se recalcula.
- **Gastos:** lo que se paga (proveedores, bolsitas, alquiler...) con su medio de pago.
- **Informes:** por día, semana o mes: cierre de caja, ventas, ganancia, gastos, faltantes y lo más vendido. Se puede imprimir.

## Deploy en Vercel

Variables de entorno del proyecto en Vercel:

| Variable | Qué es |
|---|---|
| `TURSO_DATABASE_URL` | URL de la base en Turso (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | Token de acceso de esa base |
| `APP_PASSWORD` | Contraseña para entrar a la app: 12 caracteres o más, que no se use en otro lado (es la única puerta de entrada) |

Las tablas y columnas nuevas se crean solas en el primer uso. Si se pierde un celular: en la app, Usuarios → "Cerrar la sesión en todos los dispositivos". Si además la contraseña se filtró, cambiar `APP_PASSWORD` (también cierra todas las sesiones). Correcciones de caja, cambios de productos y de usuarios quedan en el Historial con quién los hizo. Cada push a `main` se publica solo.

## Respaldo de la base

Todos los datos del negocio están en la base de Turso (`el-morterito-db`), no en este repositorio.

- **Hacer un respaldo** con la [CLI de Turso](https://docs.turso.tech/cli/introduction) (con sesión iniciada en la cuenta dueña de la base):
  ```
  turso db shell el-morterito-db .dump > respaldo-AAAA-MM-DD.sql
  ```
  Conviene hacerlo una vez por semana y guardar el archivo fuera de la PC (Drive, pendrive). Nunca subirlo a GitHub.
- **Recuperar** en una base nueva:
  ```
  turso db create el-morterito-restaurada
  turso db shell el-morterito-restaurada < respaldo-AAAA-MM-DD.sql
  ```
  Después, en Vercel, cambiar `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` por los de la base restaurada y volver a desplegar.

## Desarrollo

```
npm install
npm test           # pruebas con una base temporal
npm start          # http://localhost:3000 con base local morterito.db (sin contraseña)
```
