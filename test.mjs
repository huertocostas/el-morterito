// Prueba de punta a punta: `node test.mjs`. Usa una base temporal, no toca morterito.db.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { createHmac } from 'node:crypto';

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
// simula una falla pasajera de la base: otra conexión la tiene trabada mientras el servidor arranca
const traba = createClient({ url: pathToFileURL(DB).href });
const trabaTx = await traba.transaction('write');
const srv = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')],
  { env: { ...process.env, MORTERITO_DB: DB, PORT, APP_PASSWORD: 'clave-test', TURSO_DATABASE_URL: '' } });
srv.stderr.pipe(process.stderr);
await new Promise(r => srv.stdout.once('data', r));
// cookies como un navegador: sesion y usuario por separado; Max-Age=0 las borra
const jar = new Map();
let cookie = '';
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, body: body && JSON.stringify(body), headers: { cookie } });
  for (const c of r.headers.getSetCookie()) {
    const [par] = c.split(';'), [k, v] = par.split('=');
    if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v);
  }
  cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return { status: r.status, data: await r.json() };
};

try {
  // login: sin sesión no se ve nada
  assert.equal((await api('GET', '/api/productos')).status, 401);
  assert.deepEqual((await api('GET', '/api/sesion')).data, { login: true, ok: false, usuario: null });
  assert.equal((await api('POST', '/api/login', { password: 'otra' })).status, 400);
  assert.equal((await api('GET', '/api/productos')).status, 401);
  assert.equal((await api('POST', '/api/login', { password: 'clave-test' })).status, 200);

  // falla pasajera: con la base trabada, preparar la base falla y se avisa con el detalle...
  const fallo = await api('GET', '/api/productos');
  assert.equal(fallo.status, 500);
  assert.match(fallo.data.error, /probá de nuevo.*Código/);
  assert.doesNotMatch(fallo.data.error, /SQLITE|database|locked/i, 'el detalle técnico no se muestra');
  // ...y apenas se libera, el siguiente pedido funciona (antes quedaba en "Error interno" hasta reiniciar)
  await trabaTx.rollback(); trabaTx.close(); traba.close();
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

  // apertura de caja: una por día, se puede corregir, admite 0, no negativos ni vacío
  assert.deepEqual((await api('GET', '/api/apertura?fecha=2026-11-03')).data, { monto: null });
  assert.equal((await api('POST', '/api/apertura', { fecha: '2026-11-03', monto: '' })).status, 400);
  assert.equal((await api('POST', '/api/apertura', { fecha: '2026-11-03', monto: -5 })).status, 400);
  assert.equal((await api('POST', '/api/apertura', { fecha: '2026-11-03', monto: 1000 })).status, 200);
  assert.equal((await api('POST', '/api/apertura', { fecha: '2026-11-03', monto: '2000' })).status, 200); // corrección
  assert.deepEqual((await api('GET', '/api/apertura?fecha=2026-11-03')).data, { monto: 2000 });
  assert.equal((await api('POST', '/api/apertura', { fecha: '2026-11-04', monto: 0 })).status, 200);
  assert.equal((await api('GET', '/api/informe?desde=2026-11-03&hasta=2026-11-03')).data.apertura, 2000);
  assert.equal((await api('GET', '/api/informe?desde=2026-11-04&hasta=2026-11-04')).data.apertura, 0);
  assert.equal((await api('GET', '/api/informe?desde=2026-11-02&hasta=2026-11-08')).data.apertura, null); // semana: no aplica

  // borrar productos: sin ventas se borra (con su stock inicial); con ventas no (409); inexistente 400
  const { data: { id: prueba } } = await api('POST', '/api/productos', { nombre: 'Producto de prueba', precio_minorista: 10 });
  await api('POST', '/api/movimientos', { tipo: 'ajuste', fecha: '2026-11-03', items: [{ producto_id: prueba, cantidad: 5 }] });
  assert.equal((await api('DELETE', '/api/productos?id=' + prueba)).status, 200);
  assert.equal((await api('GET', '/api/productos')).data.some(p => p.id === prueba), false);
  assert.equal((await api('GET', '/api/movimientos')).data.some(m => m.producto_id === prueba), false);
  const conVentas = await api('DELETE', '/api/productos?id=' + yerba);
  assert.equal(conVentas.status, 409);
  assert.match(conVentas.data.error, /venta/);
  assert.equal((await api('GET', '/api/productos')).data.some(p => p.id === yerba), true);
  assert.equal((await api('DELETE', '/api/productos?id=99999')).status, 400);

  // datos mal formados: siempre un 400 con mensaje, nunca un 500
  for (const ruta of ['productos', 'movimientos', 'gastos'])
    for (const id of ['abc', '', '-1', '1.5']) assert.equal((await api('DELETE', `/api/${ruta}?id=${id}`)).status, 400, `${ruta} id=${id}`);
  assert.equal((await api('POST', '/api/movimientos', { tipo: 'compra', fecha: '2026-11-03', items: [null] })).status, 400);
  assert.equal((await api('POST', '/api/movimientos', { tipo: 'compra', fecha: '2026-11-03', items: 'x' })).status, 400);
  const neg = await api('POST', '/api/movimientos', { tipo: 'minorista', medio_pago: 'efectivo', fecha: '2026-11-03', items: [{ producto_id: yerba, cantidad: -1 }] });
  assert.deepEqual([neg.status, neg.data.error], [400, 'Cantidad: valor inválido']);
  const roto = await fetch(`http://127.0.0.1:${PORT}/api/gastos`, { method: 'POST', body: '{roto', headers: { cookie } });
  assert.deepEqual([roto.status, (await roto.json()).error], [400, 'JSON inválido']);
  assert.equal((await api('GET', '/api/nada')).status, 404);

  // fechas: tienen que existir y ser razonables
  const compraEn = fecha => api('POST', '/api/movimientos', { tipo: 'compra', fecha, items: [{ producto_id: yerba, cantidad: 1 }] });
  for (const f of ['2026-02-31', '2026-13-01', '9999-12-31', '1999-01-01', '2026-2-3']) assert.equal((await compraEn(f)).status, 400, f);
  for (const f of ['2028-02-29', '2026-12-31']) assert.equal((await compraEn(f)).status, 200, f);
  assert.equal((await api('POST', '/api/apertura', { fecha: '2026-02-30', monto: 1 })).status, 400);
  assert.equal((await api('GET', '/api/informe?desde=2026-11-30&hasta=2026-11-01')).status, 400); // al revés

  // ventas a $0 no; compras y ajustes sí van sin precio
  const venta0 = await api('POST', '/api/movimientos', { tipo: 'mayorista', medio_pago: 'efectivo', fecha: '2026-11-04', items: [{ producto_id: yerba, cantidad: 1, precio_unitario: 0 }] });
  assert.deepEqual([venta0.status, /precio \$0/.test(venta0.data.error)], [400, true]);

  // productos desactivados: no se venden (aunque se mande a mano), pero se les puede ajustar el stock
  const viejo = (await api('GET', '/api/productos')).data.find(p => p.nombre === 'Viejo');
  await api('POST', '/api/productos', { ...viejo, activo: false });
  const ventaInactivo = await api('POST', '/api/movimientos', { tipo: 'minorista', medio_pago: 'efectivo', fecha: '2026-11-04', items: [{ producto_id: viejo.id, cantidad: 1, precio_unitario: 5 }] });
  assert.deepEqual([ventaInactivo.status, /desactivado/.test(ventaInactivo.data.error)], [400, true]);
  assert.equal((await api('POST', '/api/movimientos', { tipo: 'ajuste', fecha: '2026-11-04', items: [{ producto_id: viejo.id, cantidad: 2 }] })).status, 200);

  // gastos: solo categorías de la lista
  assert.equal((await api('POST', '/api/gastos', { fecha: '2026-11-04', categoria: 'Cualquiera', monto: 10, medio_pago: 'efectivo' })).status, 400);

  // sección Stock: entró / salió / conté
  const stockDe = async id => (await api('GET', '/api/productos')).data.find(p => p.id === id).stock;
  const s0 = await stockDe(yerba);
  const st = (accion, cantidad) => api('POST', '/api/stock', { producto_id: yerba, accion, cantidad, fecha: '2026-11-05' });
  assert.equal((await st('entrada', 4)).data.movimiento, 4);
  assert.equal((await st('salida', 1.5)).data.movimiento, -1.5);
  assert.equal(await stockDe(yerba), s0 + 2.5);
  assert.equal((await st('contar', 10)).data.movimiento, 10 - (s0 + 2.5)); // corrige la diferencia
  assert.equal(await stockDe(yerba), 10);
  assert.equal((await st('contar', 10)).data.movimiento, 0); // ya estaba bien: no se registra nada
  assert.equal((await st('contar', 0)).status, 200); // contar 0 vale (se terminó)
  assert.equal(await stockDe(yerba), 0);
  for (const [a, c] of [['entrada', 0], ['salida', -1], ['entrada', ''], ['robo', 1]]) assert.equal((await st(a, c)).status, 400, `${a} ${c}`);
  assert.equal((await api('POST', '/api/stock', { producto_id: 99999, accion: 'entrada', cantidad: 1, fecha: '2026-11-05' })).status, 400);
  const tipos = (await api('GET', '/api/movimientos?desde=2026-11-05&hasta=2026-11-05')).data.map(m => m.tipo);
  assert.ok(tipos.includes('compra') && tipos.includes('ajuste')); // entrada = compra; salida y conté = ajuste

  // cierre de caja con conteo: esperado = apertura + ventas en efectivo − gastos en efectivo
  // (el 3/11: apertura 2000 + ventas efectivo 400 − gastos efectivo 150 = 2250)
  const cierre = await api('POST', '/api/cierre', { fecha: '2026-11-03', contado: 2200 });
  assert.deepEqual(cierre.data, { contado: 2200, esperado: 2250, diferencia: -50 });
  assert.equal((await api('POST', '/api/cierre', { fecha: '2026-11-03', contado: '' })).status, 400);
  assert.equal((await api('POST', '/api/cierre', { fecha: '2026-11-03', contado: -1 })).status, 400);
  assert.deepEqual((await api('POST', '/api/cierre', { fecha: '2026-11-03', contado: 2250 })).data.diferencia, 0); // se corrige
  const infCierre = (await api('GET', '/api/informe?desde=2026-11-03&hasta=2026-11-03')).data.cierre;
  assert.deepEqual([infCierre.contado, infCierre.esperado], [2250, 2250]);
  assert.equal((await api('GET', '/api/informe?desde=2026-11-02&hasta=2026-11-08')).data.cierre, null); // semana: no aplica

  // la apertura de un día no se acumula con la del anterior: cada día arranca con la suya
  await api('POST', '/api/apertura', { fecha: '2026-11-20', monto: 1000 });
  await api('POST', '/api/movimientos', { tipo: 'minorista', medio_pago: 'efectivo', fecha: '2026-11-20', items: [{ producto_id: yerba, cantidad: 1, precio_unitario: 500 }] });
  await api('POST', '/api/apertura', { fecha: '2026-11-21', monto: 300 });
  assert.equal((await api('POST', '/api/cierre', { fecha: '2026-11-20', contado: 1500 })).data.esperado, 1500); // 1000 + 500
  assert.equal((await api('POST', '/api/cierre', { fecha: '2026-11-21', contado: 300 })).data.esperado, 300);   // solo la del 21
  assert.equal((await api('GET', '/api/informe?desde=2026-11-21&hasta=2026-11-21')).data.apertura, 300);

  // granel por kg: minorista fracciona desde 100 g al precio por kg; mayorista desde 1 kg
  const { data: { id: granel } } = await api('POST', '/api/productos', { nombre: 'Mix energético', unidad: 'kg', costo: 9000, precio_minorista: 18000, precio_mayorista: 15000 });
  await api('POST', '/api/stock', { producto_id: granel, accion: 'entrada', cantidad: 5, fecha: '2026-11-22' });
  const vender = (tipo, cantidad, precio) => api('POST', '/api/movimientos', { tipo, medio_pago: 'efectivo', fecha: '2026-11-22', items: [{ producto_id: granel, cantidad, precio_unitario: precio }] });
  const chico = await vender('minorista', 0.05, 18000);
  assert.deepEqual([chico.status, chico.data.error], [400, '"Mix energético": se fracciona desde 100 g']);
  assert.equal((await vender('minorista', 0.1, 18000)).status, 200);   // 100 g justo
  assert.equal((await vender('minorista', 0.15, 18000)).status, 200);  // 150 g
  const mayChico = await vender('mayorista', 0.5, 15000);
  assert.deepEqual([mayChico.status, mayChico.data.error], [400, '"Mix energético": la venta mayorista es desde 1 kg']);
  assert.equal((await vender('mayorista', 1.5, 15000)).status, 200);
  // montos y ganancia respetando el precio por kg: 250 g minorista = $4.500 (ganancia $2.250); 1,5 kg mayorista = $22.500 (ganancia $9.000)
  const inf22 = (await api('GET', '/api/informe?desde=2026-11-22&hasta=2026-11-22')).data;
  const v22 = t => inf22.ventas.find(x => x.tipo === t);
  assert.deepEqual([Math.round(v22('minorista').total), Math.round(v22('minorista').ganancia)], [4500, 2250]);
  assert.deepEqual([v22('mayorista').total, v22('mayorista').ganancia], [22500, 9000]);
  assert.ok(Math.abs((await api('GET', '/api/productos')).data.find(p => p.id === granel).stock - (5 - 0.25 - 1.5)) < 1e-9); // descuenta en kg
  // los productos por unidad no tienen mínimo de peso
  assert.equal((await api('POST', '/api/movimientos', { tipo: 'mayorista', medio_pago: 'efectivo', fecha: '2026-11-22', items: [{ producto_id: yerba, cantidad: 1, precio_unitario: 80 }] })).status, 200);

  // ---------- usuarios ----------
  // mientras no haya usuarios, se registra sin PIN (como antes)
  assert.equal((await api('POST', '/api/gastos', { fecha: '2026-11-06', categoria: 'Otros', monto: 1, medio_pago: 'efectivo' })).status, 200);
  // administrar usuarios pide la contraseña del negocio
  assert.equal((await api('POST', '/api/usuarios', { admin: 'mal', nombre: 'Ana', pin: '1234' })).status, 400);
  const { data: { id: ana } } = await api('POST', '/api/usuarios', { admin: 'clave-test', nombre: 'Ana', pin: '1234' });
  await api('POST', '/api/usuarios', { admin: 'clave-test', nombre: 'Beto', pin: '5678' });
  assert.equal((await api('POST', '/api/usuarios', { admin: 'clave-test', nombre: 'Caro', pin: '1234' })).status, 400, 'PIN repetido');
  assert.equal((await api('POST', '/api/usuarios', { admin: 'clave-test', nombre: 'ana', pin: '9999' })).status, 400, 'nombre repetido');
  assert.equal((await api('POST', '/api/usuarios', { admin: 'clave-test', nombre: 'Dani', pin: '12' })).status, 400, 'PIN corto');
  const usuarios = (await api('GET', '/api/usuarios')).data;
  assert.deepEqual(usuarios.map(u => u.nombre), ['Ana', 'Beto']);
  assert.ok(!('pin' in usuarios[0]), 'el PIN nunca sale del servidor');
  // con usuarios cargados, registrar algo sin PIN da 403 (la pantalla pide el PIN)
  const sinPin = await api('POST', '/api/gastos', { fecha: '2026-11-06', categoria: 'Otros', monto: 1, medio_pago: 'efectivo' });
  assert.equal(sinPin.status, 403);
  assert.equal((await api('POST', '/api/usuario/entrar', { pin: '0000' })).status, 400);
  assert.deepEqual((await api('POST', '/api/usuario/entrar', { pin: '1234' })).data, { id: ana, nombre: 'Ana' });
  assert.equal((await api('GET', '/api/sesion')).data.usuario, ana);
  // lo que registra queda a su nombre
  await api('POST', '/api/movimientos', { tipo: 'minorista', medio_pago: 'efectivo', fecha: '2026-11-07', items: [{ producto_id: yerba, cantidad: 1, precio_unitario: 100 }] });
  await api('POST', '/api/gastos', { fecha: '2026-11-07', categoria: 'Otros', monto: 7, medio_pago: 'efectivo' });
  await api('POST', '/api/stock', { producto_id: yerba, accion: 'entrada', cantidad: 3, fecha: '2026-11-07' });
  const movs7 = (await api('GET', '/api/movimientos?desde=2026-11-07&hasta=2026-11-07')).data;
  assert.ok(movs7.length >= 2 && movs7.every(m => m.usuario === 'Ana'));
  assert.equal((await api('GET', '/api/gastos?desde=2026-11-07&hasta=2026-11-07')).data[0].usuario, 'Ana');
  assert.deepEqual((await api('GET', '/api/informe?desde=2026-11-07&hasta=2026-11-07')).data.por_usuario.map(x => [x.usuario, x.total]), [['Ana', 100]]);
  // cambiar de persona
  await api('POST', '/api/usuario/entrar', { pin: '5678' });
  // con usuarios, apertura y cierre se confirman con el PIN de quien los hace
  assert.equal((await api('POST', '/api/cierre', { fecha: '2026-11-07', contado: 0 })).status, 400);              // sin PIN
  assert.equal((await api('POST', '/api/cierre', { fecha: '2026-11-07', contado: 0, pin: '0000' })).status, 400); // PIN mal
  assert.equal((await api('POST', '/api/apertura', { fecha: '2026-11-07', monto: 50 })).status, 400);
  assert.equal((await api('POST', '/api/cierre', { fecha: '2026-11-07', contado: 0, pin: '5678' })).status, 200);
  // la sesión es de Beto, pero la apertura la confirma Ana con su PIN: queda a nombre de Ana
  assert.equal((await api('POST', '/api/apertura', { fecha: '2026-11-07', monto: 50, pin: '1234' })).status, 200);
  const caja7 = (await api('GET', '/api/caja?desde=2026-11-07&hasta=2026-11-07')).data;
  assert.deepEqual(caja7.aperturas.map(a => [a.monto, a.usuario]), [[50, 'Ana']]);
  assert.deepEqual(caja7.cierres.map(c => [c.contado, c.usuario]), [[0, 'Beto']]);
  assert.equal((await api('GET', '/api/informe?desde=2026-11-07&hasta=2026-11-07')).data.cierre.usuario, 'Beto');
  // baja: Beto ya no puede registrar con su cookie ni volver a entrar; su PIN queda libre
  const beto = usuarios.find(u => u.nombre === 'Beto').id;
  assert.equal((await api('POST', '/api/usuarios', { admin: 'clave-test', id: beto, activo: false })).status, 200);
  assert.equal((await api('POST', '/api/gastos', { fecha: '2026-11-07', categoria: 'Otros', monto: 1, medio_pago: 'efectivo' })).status, 403);
  assert.equal((await api('POST', '/api/usuario/entrar', { pin: '5678' })).status, 400);
  // cambiar el PIN de Ana
  await api('POST', '/api/usuarios', { admin: 'clave-test', id: ana, pin: '4321' });
  assert.equal((await api('POST', '/api/usuario/entrar', { pin: '1234' })).status, 400);
  assert.equal((await api('POST', '/api/usuario/entrar', { pin: '4321' })).status, 200);
  // una cookie de usuario falsificada no sirve
  jar.set('usuario', `${ana}.${'0'.repeat(64)}`); cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  assert.equal((await api('GET', '/api/sesion')).data.usuario, null);
  // cada registro guarda la hora en que se hizo (la pone el servidor)
  const reciente = iso => typeof iso === 'string' && Math.abs(Date.parse(iso) - Date.now()) < 60 * 1000;
  await api('POST', '/api/usuario/entrar', { pin: '4321' }); // la prueba anterior dejó una cookie falsa
  await api('POST', '/api/movimientos', { tipo: 'minorista', medio_pago: 'efectivo', fecha: '2026-11-08', items: [{ producto_id: yerba, cantidad: 1, precio_unitario: 100 }, { producto_id: miel, cantidad: 1, precio_unitario: 50 }] });
  const ticket = (await api('GET', '/api/movimientos?desde=2026-11-08&hasta=2026-11-08')).data;
  assert.ok(ticket.length === 2 && ticket.every(m => reciente(m.creado)) && ticket[0].creado === ticket[1].creado, 'una sola hora por ticket');
  await api('POST', '/api/gastos', { fecha: '2026-11-08', categoria: 'Otros', monto: 3, medio_pago: 'efectivo' });
  assert.ok(reciente((await api('GET', '/api/gastos?desde=2026-11-08&hasta=2026-11-08')).data[0].creado));
  await api('POST', '/api/apertura', { fecha: '2026-11-08', monto: 10, pin: '4321' });
  await api('POST', '/api/cierre', { fecha: '2026-11-08', contado: 10, pin: '4321' });
  const caja8 = (await api('GET', '/api/caja?desde=2026-11-08&hasta=2026-11-08')).data;
  assert.ok(reciente(caja8.aperturas[0].creado) && reciente(caja8.cierres[0].creado));
  assert.ok(reciente((await api('GET', '/api/informe?desde=2026-11-08&hasta=2026-11-08')).data.cierre.creado));
  // lo registrado antes de esta versión no tiene hora (y no rompe nada)
  assert.ok((await api('GET', '/api/movimientos?desde=2026-11-01&hasta=2026-11-01')).data.length >= 0);

  // borrar deja rastro: qué, de qué día, quién y cuándo
  const gasto8 = (await api('GET', '/api/gastos?desde=2026-11-08&hasta=2026-11-08')).data[0];
  assert.equal((await api('DELETE', '/api/gastos?id=' + gasto8.id)).status, 200);
  const venta8 = (await api('GET', '/api/movimientos?desde=2026-11-08&hasta=2026-11-08')).data.find(m => m.tipo === 'minorista');
  await api('DELETE', '/api/movimientos?id=' + venta8.id);
  const borr = (await api('GET', '/api/caja?desde=2026-11-08&hasta=2026-11-08')).data.borrados;
  assert.equal(borr.length, 2);
  assert.ok(borr.every(b => b.usuario === 'Ana' && reciente(b.creado) && b.fecha === '2026-11-08'));
  const plata = n => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n);
  assert.ok(borr.some(b => b.detalle === `Gasto: Otros ${plata(3)}`)
    && borr.some(b => b.detalle === `Venta minorista: ${venta8.nombre} x 1 ${venta8.unidad} (${plata(venta8.precio_unitario)})`), JSON.stringify(borr));
  // sin identificarse (hay usuarios cargados) no se puede borrar
  const jarU = jar.get('usuario'); jar.delete('usuario'); cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const otro = (await api('GET', '/api/movimientos?desde=2026-11-08&hasta=2026-11-08')).data[0];
  assert.equal((await api('DELETE', '/api/movimientos?id=' + otro.id)).status, 403);
  jar.set('usuario', jarU); cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

  // lo que se pisa queda en el historial: corrección de apertura y de cierre, con el valor anterior y quién lo había hecho
  await api('POST', '/api/apertura', { fecha: '2026-11-08', monto: 25, pin: '4321' });
  await api('POST', '/api/cierre', { fecha: '2026-11-08', contado: 40, pin: '4321' });
  const corr = (await api('GET', '/api/caja?desde=2026-11-08&hasta=2026-11-08')).data.borrados.filter(b => b.accion === 'Corrección');
  assert.equal(corr.length, 2, JSON.stringify(corr));
  assert.ok(corr.some(b => b.detalle.startsWith(`Apertura de caja: ${plata(10)} → ${plata(25)} (la había cargado Ana)`)), JSON.stringify(corr));
  assert.ok(corr.some(b => b.detalle.startsWith(`Cierre de caja: contado ${plata(10)} → ${plata(40)}`)) && corr.every(b => b.usuario === 'Ana'));
  // cambios de producto (precio, costo, unidad) quedan anotados; sin PIN no se pueden hacer
  const yerbaP = (await api('GET', '/api/productos')).data.find(p => p.id === yerba);
  assert.equal((await api('POST', '/api/productos', { ...yerbaP, precio_minorista: yerbaP.precio_minorista + 1 })).status, 200);
  const hoyAr = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const registroHoy = async () => (await api('GET', `/api/caja?desde=${hoyAr}&hasta=${hoyAr}`)).data.borrados;
  assert.ok((await registroHoy()).some(b => b.accion === 'Cambio' && b.usuario === 'Ana'
    && b.detalle === `Producto "${yerbaP.nombre}": minorista ${plata(yerbaP.precio_minorista)} → ${plata(yerbaP.precio_minorista + 1)}`));
  jar.delete('usuario'); cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  assert.equal((await api('POST', '/api/productos', { ...yerbaP })).status, 403, 'cambiar un producto pide PIN');
  jar.set('usuario', jarU); cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  // cambiarle el PIN a alguien queda anotado y le cierra el turno que tenía abierto
  const turnoViejo = jar.get('usuario');
  await api('POST', '/api/usuarios', { admin: 'clave-test', id: ana, pin: '8765' });
  assert.ok((await registroHoy()).some(b => b.accion === 'Usuarios' && b.detalle === '"Ana": PIN cambiado'));
  jar.set('usuario', turnoViejo); cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  assert.equal((await api('POST', '/api/gastos', { fecha: '2026-11-08', categoria: 'Otros', monto: 1, medio_pago: 'efectivo' })).status, 403, 'turno viejo ya no vale');
  assert.equal((await api('POST', '/api/usuario/entrar', { pin: '8765' })).status, 200);
  assert.equal((await api('POST', '/api/gastos', { fecha: '2026-11-08', categoria: 'Otros', monto: 1, medio_pago: 'efectivo' })).status, 200);
  await api('POST', '/api/usuarios', { admin: 'clave-test', id: ana, pin: '4321' }); // las pruebas de abajo usan este
  await api('POST', '/api/usuario/entrar', { pin: '4321' });

  // textos con largo máximo
  assert.equal((await api('POST', '/api/productos', { nombre: 'x'.repeat(81), precio_minorista: 1 })).status, 400);
  assert.equal((await api('POST', '/api/gastos', { fecha: '2026-11-08', categoria: 'Otros', monto: 1, medio_pago: 'efectivo', concepto: 'y'.repeat(151) })).status, 400);

  // salir de usuario mantiene la sesión del negocio
  await api('POST', '/api/usuario/salir');
  assert.equal((await api('GET', '/api/productos')).status, 200);

  // errores forzados: cuerpos raros, números absurdos y tickets enormes dan 400 (nunca 500)
  await api('POST', '/api/usuario/entrar', { pin: '4321' }); // la prueba anterior salió del usuario
  const crudo = (path, body) => fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', body, headers: { cookie } }).then(r => r.status);
  for (const body of ['null', '[]', '123', 'true']) assert.equal(await crudo('/api/gastos', body), 400, `cuerpo ${body}`);
  const vtaRara = item => api('POST', '/api/movimientos', { tipo: 'minorista', medio_pago: 'efectivo', fecha: '2026-11-09', items: Array.isArray(item) ? item : [{ producto_id: yerba, cantidad: 1, precio_unitario: 10, ...item }] });
  for (const item of [{ precio_unitario: 1e308 }, { precio_unitario: 2e9 }, { cantidad: 2e6 }, { cantidad: 'Infinity' }])
    assert.equal((await vtaRara(item)).status, 400, JSON.stringify(item));
  assert.equal((await vtaRara(Array.from({ length: 201 }, () => ({ producto_id: yerba, cantidad: 1, precio_unitario: 1 })))).status, 400, '201 renglones');
  assert.equal((await api('POST', '/api/gastos', { fecha: '2026-11-09', categoria: 'Otros', monto: 1e20, medio_pago: 'efectivo' })).status, 400);
  assert.equal(await crudo('/api/gastos', JSON.stringify({ x: 'y'.repeat(1.2e6) })), 400, 'pedido de más de 1 MB');
  assert.equal((await api('GET', '/api/sesion')).status, 200, 'la conexión sigue sana después de un pedido enorme');

  // usuarios dados de baja: cargarlo de nuevo con el mismo nombre lo reactiva; reactivar pide PIN nuevo
  const otraVez = await api('POST', '/api/usuarios', { admin: 'clave-test', nombre: 'beto', pin: '6789' });
  assert.deepEqual([otraVez.status, otraVez.data.reactivado], [200, true]);
  assert.ok((await api('GET', '/api/usuarios')).data.find(u => u.nombre === 'Beto').activo);
  await api('POST', '/api/usuarios', { admin: 'clave-test', id: otraVez.data.id, activo: false });
  assert.equal((await api('POST', '/api/usuarios', { admin: 'clave-test', id: otraVez.data.id, activo: true })).status, 400, 'reactivar sin PIN nuevo');

  // el turno de usuario también vence en el servidor (14 h) y no se puede falsificar
  const firmaU = (id, t) => createHmac('sha256', 'clave-test').update(`usuario:${id}:${t}`).digest('hex');
  const turno = horas => { const t = (Date.now() - horas * 3600e3).toString(36); return `${ana}.${t}.${firmaU(ana, t)}`; };
  const sesionCon = u => fetch(`http://127.0.0.1:${PORT}/api/sesion`, { headers: { cookie: `sesion=${jar.get('sesion')}; usuario=${u}` } }).then(r => r.json());
  assert.equal((await sesionCon(turno(1))).usuario, ana);
  assert.equal((await sesionCon(turno(15))).usuario, null, 'turno vencido');

  // sesiones: vencen del lado del servidor a los 30 días y no se pueden falsificar
  const conCookie = c => fetch(`http://127.0.0.1:${PORT}/api/productos`, { headers: { cookie: c } }).then(r => r.status);
  const firmar = t => createHmac('sha256', 'clave-test|clave-test').update('sesion:' + t).digest('hex'); // misma receta que el servidor
  const tViejo = (Date.now() - 31 * 24 * 60 * 60 * 1000).toString(36), tNuevo = Date.now().toString(36);
  assert.equal(await conCookie(`sesion=${tNuevo}.${firmar(tNuevo)}`), 200);
  assert.equal(await conCookie(`sesion=${tViejo}.${firmar(tViejo)}`), 401, 'sesión vencida');
  assert.equal(await conCookie(`sesion=${tNuevo}.${'a'.repeat(64)}`), 401, 'firma falsa');
  assert.equal(await conCookie(`sesion=${createHmac('sha256', 'clave-test').update('morterito-sesion').digest('hex')}`), 401, 'formato viejo');

  await api('POST', '/api/logout');
  assert.equal((await api('GET', '/api/productos')).status, 401);

  // PINs: el límite es por dispositivo; otro dispositivo (otra sesión) en la misma red no queda bloqueado
  await api('POST', '/api/login', { password: 'clave-test' });
  for (let i = 0; i < 8; i++) await api('POST', '/api/usuario/entrar', { pin: '000' + i });
  assert.equal((await api('POST', '/api/usuario/entrar', { pin: '4321' })).status, 429, 'este dispositivo, bloqueado');
  const otroDispositivo = `sesion=${tNuevo}.${firmar(tNuevo)}`;
  const enOtro = await fetch(`http://127.0.0.1:${PORT}/api/usuario/entrar`, { method: 'POST', headers: { cookie: otroDispositivo }, body: JSON.stringify({ pin: '4321' }) });
  assert.equal(enOtro.status, 200, 'el otro dispositivo sigue pudiendo entrar');
  await api('POST', '/api/logout');

  // celular perdido: cerrar la sesión en todos los dispositivos deja afuera a los demás y no a este
  await api('POST', '/api/login', { password: 'clave-test' });
  assert.equal(await conCookie(otroDispositivo), 200);
  assert.equal((await api('POST', '/api/sesiones/cerrar', { admin: 'mal' })).status, 400);
  assert.equal((await api('POST', '/api/sesiones/cerrar', { admin: 'clave-test' })).status, 200);
  assert.equal(await conCookie(otroDispositivo), 401, 'el otro dispositivo quedó afuera');
  assert.equal((await api('GET', '/api/productos')).status, 200, 'este dispositivo sigue adentro');
  assert.ok((await registroHoy()).some(b => b.accion === 'Seguridad'));

  // muchos PIN equivocados al mismo tiempo: el límite no se saltea (antes contaba y después anotaba)
  const simultaneos = await Promise.all(Array.from({ length: 20 }, (_, i) => api('POST', '/api/usuario/entrar', { pin: String(5000 + i) })));
  assert.ok(simultaneos.filter(r => r.status === 400).length <= 8 && simultaneos.some(r => r.status === 429), simultaneos.map(r => r.status).join(','));
  await api('POST', '/api/logout');

  // límite de intentos: tras 8 contraseñas incorrectas se bloquea (aunque después pongan la correcta)
  for (let i = 0; i < 8; i++) assert.equal((await api('POST', '/api/login', { password: 'no-' + i })).status, 400);
  const bloqueado = await api('POST', '/api/login', { password: 'clave-test' });
  assert.deepEqual([bloqueado.status, /Demasiados intentos/.test(bloqueado.data.error)], [429, true]);
  console.log('OK — todas las pruebas pasaron');
} finally {
  srv.kill();
  await new Promise(r => srv.once('exit', r));
  try { rmSync(DB, { force: true }); } catch {} // que la limpieza no tape el error real de la prueba
}
