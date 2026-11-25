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
  assert.match(fallo.data.error, /probá de nuevo.*Detalle/);
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
  // salir de usuario mantiene la sesión del negocio
  await api('POST', '/api/usuario/salir');
  assert.equal((await api('GET', '/api/productos')).status, 200);

  await api('POST', '/api/logout');
  assert.equal((await api('GET', '/api/productos')).status, 401);
  console.log('OK — todas las pruebas pasaron');
} finally {
  srv.kill();
  await new Promise(r => srv.once('exit', r));
  try { rmSync(DB, { force: true }); } catch {} // que la limpieza no tape el error real de la prueba
}
