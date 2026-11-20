# El Morterito

Gestión de stock y ventas (minoristas y mayoristas) para El Morterito. Corre en una sola PC, sin internet ni servidor externo.

## Instalación

1. Instalar [Node.js](https://nodejs.org) versión 22.5 o más nueva (trae SQLite incorporado, no hace falta nada más).
2. Copiar esta carpeta a la PC.
3. Doble clic en `iniciar.bat`. Se abre el navegador en http://localhost:3000.
   La ventana negra tiene que quedar abierta mientras se usa la app.

## Uso

- **Vender:** buscar o tocar productos, ajustar cantidades en el ticket y cobrar. También se cargan compras de mercadería y ajustes de stock.
- **Productos:** alta y edición, precios minorista/mayorista y stock mínimo.
- **Movimientos:** historial por fechas; un movimiento mal cargado se borra y el stock se recalcula solo.
- **Informes:** ventas del mes, compras, faltantes y lo más vendido. Se puede imprimir.

## Respaldo

Todos los datos están en `morterito.db` (se crea solo la primera vez). Para hacer un respaldo, copiar ese archivo a un pendrive o a la nube. Ese archivo no se sube a GitHub.

## Desarrollo

```
node test.mjs
```

Corre las pruebas con una base temporal, sin tocar `morterito.db`.
