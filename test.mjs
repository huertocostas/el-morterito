// Prueba de punta a punta: `node test.mjs`. Usa una base temporal, no toca morterito.db.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';

const DB = join(tmpdir(), `morterito-test-${Date.now()}.db`), PORT = 3999;
// base con el esquema de la primera versión (sin costo), como la que ya existe en Turso
const vieja = createClient({ url: pathToFileURL(DB).href });
await vieja.executeMultiple(`
CREATE TABLE productos (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL UNIQUE COLLATE NOCASE, categoria TEXT NOT NULL DEFAULT '',
  unidad TEXT NOT NULL DEFAULT 'unidad', precio_minorista REAL NOT NULL DEFAULT 0, precio_mayorista REAL NOT NULL DEFAULT 0,
  stock_minimo REAL NOT NULL DEFAULT 0, activo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE movimientos (id INTEGER PRIMARY KEY, fecha TEXT NOT NULL, tipo TEXT NOT NULL, producto_id INTEGER NOT NULL,
  cantidad REAL NOT NULL, precio_unitario REAL NOT NULL DEFAULT 0);
CREATE VIEW stock AS SELECT p.*, COALESCE(SUM(m.cantidad), 0) AS stock FROM productos p LEFT JOIN movimientos m ON m.producto_id = p.id GROUP BY p.id;
INSERT INTO productos (nombre) VALUES ('Viejo');`);
vieja.close();
const srv = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')],
  { env: { ...process.env, MORTERITO_DB: DB, PORT, APP_PASSWORD: 'clave-test', TURSO_DATABASE_URL: '' } });
srv.stderr.pipe(process.stderr);
await new Promise(r => srv.stdout.once('data', r));
let cookie = '';
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, body: body && JSON.stringify(body), headers: { cookie } });
  cookie = r.headers.get('set-cookie')?.split(';')[0] ?? cookie;
  return { status: r.status, data: await r.json() };
};

try {
  // login: sin sesión no se ve nada
  assert.equal((await api('GET', '/api/productos')).status, 401);
  assert.deepEqual((await api('GET', '/api/sesion')).data, { login: true, ok: false });
  assert.equal((await api('POST', '/api/login', { password: 'otra' })).status, 400);
  assert.equal((await api('GET', '/api/productos')).status, 401);
  assert.equal((await api('POST', '/api/login', { password: 'clave-test' })).status, 200);
  assert.equal((await api('GET', '/api/productos')).status, 200);

  // la base vieja se migró: el producto que ya existía tiene costo 0
  assert.equal((await api('GET', '/api/productos')).data.find(p => p.nombre === 'Viejo').costo, 0);
  const { data: { id: yerba } } = await api('POST', '/api/productos', { nombre: 'Yerba orgánica', precio_minorista: 100, precio_mayorista: 80, stock_minimo: 5, costo: 60 });
  const { data: { id: miel } } = await api('POST', '/api/productos', { nombre: 'Miel', unidad: 'kg', precio_minorista: 50, stock_minimo: 1 });
  assert.equal((await api('POST', '/api/productos', { nombre: 'yerba ORGÁNICA' })).status, 400, 'nombre duplicado');

  await api('POST', '/api/movimientos', { tipo: 'compra', fecha: '2026-11-01', items: [{ producto_id: yerba, cantidad: 20, precio_unitario: 60 }, { producto_id: miel, cantidad: 2.5, precio_unitario: 30 }] });
  await api('POST', '/api/movimientos', { tipo: 'minorista', medio_pago: 'efectivo', fecha: '2026-11-03', items: [{ producto_id: yerba, cantidad: 3, precio_unitario: 100 }, { producto_id: miel, cantidad: 2, precio_unitario: 50 }] });
  await api('POST', '/api/movimientos', { tipo: 'mayorista', medio_pago: 'transferencia', fecha: '2026-11-05', items: [{ producto_id: yerba, cantidad: 10, precio_unitario: 80 }] });
  await api('POST', '/api/movimientos', { tipo: 'ajuste', fecha: '2026-11-06', items: [{ producto_id: yerba, cantidad: -1 }] });
  await api('POST', '/api/movimientos', { tipo: 'minorista', medio_pago: 'efectivo', fecha: '2026-10-30', items: [{ producto_id: miel, cantidad: 0.1, precio_unitario: 50 }] }); // otro mes

  // validaciones: nada de esto debe guardarse
  assert.equal((await api('POST', '/api/movimientos', { tipo: 'minorista', medio_pago: 'efectivo', fecha: '2026-11-07', items: [{ producto_id: yerba, cantidad: -5, precio_unitario: 1 }] })).status, 400);
  assert.equal((await api('POST', '/api/movimientos', { tipo: 'regalo', fecha: '2026-11-07', items: [{ producto_id: yerba, cantidad: 1 }] })).status, 400);
  // si un ítem falla, no se guarda ninguno de la misma venta
  assert.equal((await api('POST', '/api/movimientos', { tipo: 'minorista', medio_pago: 'efectivo', fecha: '2026-11-07', items: [{ producto_id: yerba, cantidad: 1, precio_unitario: 1 }, { producto_id: 999, cantidad: 1 }] })).status, 400);

  const stock = Object.fromEntries((await api('GET', '/api/productos')).data.map(p => [p.nombre, p.stock]));
  assert.equal(stock['Yerba orgánica'], 20 - 3 - 10 - 1);
  assert.ok(Math.abs(stock['Miel'] - 0.4) < 1e-9);

  const inf = (await api('GET', '/api/informe?desde=2026-11-01&hasta=2026-11-30')).data;
  assert.deepEqual(Object.fromEntries(inf.ventas.map(v => [v.tipo, v.total])), { minorista: 400, mayorista: 800 });
  // yerba cuesta 60: minorista 3x40 + miel sin costo 2x50 = 220; mayorista 10x20 = 200
  assert.deepEqual(Object.fromEntries(inf.ventas.map(v => [v.tipo, v.ganancia])), { minorista: 220, mayorista: 200 });
  assert.deepEqual(Object.fromEntries(inf.ventas.map(v => [v.tipo, v.sin_costo])), { minorista: 1, mayorista: 0 });
  assert.deepEqual(inf.mas_vendidos.map(r => [r.nombre, r.cantidad, r.ganancia]), [['Yerba orgánica', 13, 320], ['Miel', 2, 100]]);

  // cambiar el costo después no altera la ganancia ya registrada
  assert.equal((await api('POST', '/api/productos', { id: yerba, nombre: 'Yerba orgánica', precio_minorista: 100, precio_mayorista: 80, stock_minimo: 5, costo: 75 })).status, 200);
  assert.equal((await api('GET', '/api/informe?desde=2026-11-01&hasta=2026-11-30')).data.ventas.find(v => v.tipo === 'mayorista').ganancia, 200);

  // gastos
  assert.equal((await api('POST', '/api/gastos', { fecha: '2026-11-02', categoria: 'Mercadería', concepto: 'Nutryser', monto: 1000, medio_pago: 'transferencia' })).status, 200);
  await api('POST', '/api/gastos', { fecha: '2026-11-04', categoria: 'Bolsitas y descartables', monto: 50, medio_pago: 'efectivo' });
  await api('POST', '/api/gastos', { fecha: '2026-11-09', categoria: 'Mercadería', monto: 500, medio_pago: 'efectivo' });
  await api('POST', '/api/gastos', { fecha: '2026-10-20', categoria: 'Alquiler', monto: 9999, medio_pago: 'efectivo' }); // otro mes
  assert.equal((await api('POST', '/api/gastos', { fecha: '2026-11-04', categoria: 'Otros', monto: 0 })).status, 400);
  assert.equal((await api('POST', '/api/gastos', { fecha: '2026-11-04', categoria: '', monto: 10 })).status, 400);
  assert.deepEqual((await api('GET', '/api/informe?desde=2026-11-01&hasta=2026-11-30')).data.gastos,
    [{ categoria: 'Mercadería', total: 1500 }, { categoria: 'Bolsitas y descartables', total: 50 }]);
  const gNov = (await api('GET', '/api/gastos?desde=2026-11-01&hasta=2026-11-31')).data;
  assert.equal(gNov.length, 3);
  await api('DELETE', '/api/gastos?id=' + gNov.find(g => g.monto === 500).id);
  assert.equal((await api('GET', '/api/informe?desde=2026-11-01&hasta=2026-11-30')).data.gastos[0].total, 1000);
  assert.deepEqual(inf.faltantes.map(f => f.nombre).sort(), ['Miel', 'Viejo']); // yerba 6 > mín 5; miel 0.4 <= 1; viejo 0 <= 0

  const movs = (await api('GET', '/api/movimientos?desde=2026-11-01&hasta=2026-11-30')).data;
  assert.equal(movs.length, 6);
  await api('DELETE', '/api/movimientos?id=' + movs.find(m => m.tipo === 'ajuste').id);
  assert.equal((await api('GET', '/api/productos')).data.find(p => p.id === yerba).stock, 7);

  // medio de pago: obligatorio en ventas y gastos
  const venta1 = { tipo: 'minorista', fecha: '2026-11-03', items: [{ producto_id: yerba, cantidad: 1, precio_unitario: 100 }] };
  assert.equal((await api('POST', '/api/movimientos', venta1)).status, 400);
  assert.equal((await api('POST', '/api/movimientos', { ...venta1, medio_pago: 'tarjeta' })).status, 400);
  assert.equal((await api('POST', '/api/gastos', { fecha: '2026-11-03', categoria: 'Otros', monto: 10 })).status, 400);
  // compras y ajustes no llevan medio de pago
  assert.equal((await api('POST', '/api/movimientos', { tipo: 'compra', fecha: '2026-11-03', items: [{ producto_id: yerba, cantidad: 1 }] })).status, 200);

  // cierre del 3/11: efectivo = venta 400 (yerba 300 + miel 100); transferencia = 2 x 100
  await api('POST', '/api/movimientos', { ...venta1, medio_pago: 'transferencia', items: [{ producto_id: yerba, cantidad: 2, precio_unitario: 100 }] });
  await api('POST', '/api/gastos', { fecha: '2026-11-03', categoria: 'Mercadería', concepto: 'reposición', monto: 150, medio_pago: 'efectivo' });
  await api('POST', '/api/gastos', { fecha: '2026-11-03', categoria: 'Mercadería', monto: 30, medio_pago: 'transferencia' });
  const porMedio = filas => Object.fromEntries(filas.map(x => [x.medio_pago, x.total]));
  const dia = (await api('GET', '/api/informe?desde=2026-11-03&hasta=2026-11-03')).data;
  assert.deepEqual(porMedio(dia.ventas_medio), { efectivo: 400, transferencia: 200 });
  assert.deepEqual(porMedio(dia.gastos_medio), { efectivo: 150, transferencia: 30 });
  // semana lun 2 a dom 8: suma la mayorista del 5 (transferencia 800) y los gastos del 2 y del 4
  const semana = (await api('GET', '/api/informe?desde=2026-11-02&hasta=2026-11-08')).data;
  assert.deepEqual(porMedio(semana.ventas_medio), { efectivo: 400, transferencia: 1000 });
  assert.deepEqual(porMedio(semana.gastos_medio), { efectivo: 200, transferencia: 1030 });
  assert.equal((await api('GET', '/api/informe?desde=3-11&hasta=2026-11-03')).status, 400);
  assert.equal((await api('GET', '/api/informe?mes=2026-11')).status, 400);

  await api('POST', '/api/logout');
  assert.equal((await api('GET', '/api/productos')).status, 401);
  console.log('OK — todas las pruebas pasaron');
} finally {
  srv.kill();
  await new Promise(r => srv.once('exit', r));
  rmSync(DB, { force: true });
}
