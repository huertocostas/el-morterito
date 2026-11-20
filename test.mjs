// Prueba de punta a punta: `node test.mjs`. Usa una base temporal, no toca morterito.db.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const DB = join(tmpdir(), `morterito-test-${Date.now()}.db`), PORT = 3999;
const srv = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], { env: { ...process.env, MORTERITO_DB: DB, PORT } });
await new Promise(r => srv.stdout.once('data', r));
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

try {
  const { data: { id: yerba } } = await api('POST', '/api/productos', { nombre: 'Yerba orgánica', precio_minorista: 100, precio_mayorista: 80, stock_minimo: 5 });
  const { data: { id: miel } } = await api('POST', '/api/productos', { nombre: 'Miel', unidad: 'kg', precio_minorista: 50, stock_minimo: 1 });
  assert.equal((await api('POST', '/api/productos', { nombre: 'yerba ORGÁNICA' })).status, 400, 'nombre duplicado');

  await api('POST', '/api/movimientos', { tipo: 'compra', fecha: '2026-11-01', items: [{ producto_id: yerba, cantidad: 20, precio_unitario: 60 }, { producto_id: miel, cantidad: 2.5, precio_unitario: 30 }] });
  await api('POST', '/api/movimientos', { tipo: 'minorista', fecha: '2026-11-03', items: [{ producto_id: yerba, cantidad: 3, precio_unitario: 100 }, { producto_id: miel, cantidad: 2, precio_unitario: 50 }] });
  await api('POST', '/api/movimientos', { tipo: 'mayorista', fecha: '2026-11-05', items: [{ producto_id: yerba, cantidad: 10, precio_unitario: 80 }] });
  await api('POST', '/api/movimientos', { tipo: 'ajuste', fecha: '2026-11-06', items: [{ producto_id: yerba, cantidad: -1 }] });
  await api('POST', '/api/movimientos', { tipo: 'minorista', fecha: '2026-10-30', items: [{ producto_id: miel, cantidad: 0.1, precio_unitario: 50 }] }); // otro mes

  // validaciones: nada de esto debe guardarse
  assert.equal((await api('POST', '/api/movimientos', { tipo: 'minorista', fecha: '2026-11-07', items: [{ producto_id: yerba, cantidad: -5, precio_unitario: 1 }] })).status, 400);
  assert.equal((await api('POST', '/api/movimientos', { tipo: 'regalo', fecha: '2026-11-07', items: [{ producto_id: yerba, cantidad: 1 }] })).status, 400);
  // si un ítem falla, no se guarda ninguno de la misma venta
  assert.equal((await api('POST', '/api/movimientos', { tipo: 'minorista', fecha: '2026-11-07', items: [{ producto_id: yerba, cantidad: 1, precio_unitario: 1 }, { producto_id: 999, cantidad: 1 }] })).status, 400);

  const stock = Object.fromEntries((await api('GET', '/api/productos')).data.map(p => [p.nombre, p.stock]));
  assert.equal(stock['Yerba orgánica'], 20 - 3 - 10 - 1);
  assert.ok(Math.abs(stock['Miel'] - 0.4) < 1e-9);

  const inf = (await api('GET', '/api/informe?mes=2026-11')).data;
  assert.deepEqual(Object.fromEntries(inf.ventas.map(v => [v.tipo, v.total])), { minorista: 400, mayorista: 800 });
  assert.equal(inf.compras, 20 * 60 + 2.5 * 30);
  assert.deepEqual(inf.mas_vendidos.map(r => [r.nombre, r.cantidad]), [['Yerba orgánica', 13], ['Miel', 2]]);
  assert.deepEqual(inf.faltantes.map(f => f.nombre).sort(), ['Miel']); // yerba 6 > mín 5; miel 0.4 <= 1

  const movs = (await api('GET', '/api/movimientos?desde=2026-11-01&hasta=2026-11-30')).data;
  assert.equal(movs.length, 6);
  await api('DELETE', '/api/movimientos?id=' + movs.find(m => m.tipo === 'ajuste').id);
  assert.equal((await api('GET', '/api/productos')).data.find(p => p.id === yerba).stock, 7);
  console.log('OK — todas las pruebas pasaron');
} finally {
  srv.kill();
  await new Promise(r => srv.once('exit', r));
  rmSync(DB, { force: true });
}
