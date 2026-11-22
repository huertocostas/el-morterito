// El Morterito — gestión de stock y ventas.
// Local: `node server.mjs` usa el archivo morterito.db. En Vercel: api/index.mjs usa Turso (TURSO_DATABASE_URL).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || pathToFileURL(process.env.MORTERITO_DB || join(import.meta.dirname, 'morterito.db')).href,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const listo = (async () => { await db.executeMultiple(`
CREATE TABLE IF NOT EXISTS productos (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE COLLATE NOCASE,
  categoria TEXT NOT NULL DEFAULT '',
  unidad TEXT NOT NULL DEFAULT 'unidad',
  precio_minorista REAL NOT NULL DEFAULT 0,
  precio_mayorista REAL NOT NULL DEFAULT 0,
  stock_minimo REAL NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1
);
-- Cada fila mueve stock. cantidad con signo: negativo = sale (ventas), positivo = entra (compras).
CREATE TABLE IF NOT EXISTS movimientos (
  id INTEGER PRIMARY KEY,
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('minorista','mayorista','compra','ajuste')),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad REAL NOT NULL,
  precio_unitario REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mov_fecha ON movimientos(fecha);
CREATE VIEW IF NOT EXISTS stock AS
  SELECT p.*, COALESCE(SUM(m.cantidad), 0) AS stock
  FROM productos p LEFT JOIN movimientos m ON m.producto_id = p.id
  GROUP BY p.id;
-- Egresos de plata (proveedores, bolsitas, alquiler...). Las compras de "Vender" solo mueven stock.
CREATE TABLE IF NOT EXISTS gastos (
  id INTEGER PRIMARY KEY,
  fecha TEXT NOT NULL,
  categoria TEXT NOT NULL,
  concepto TEXT NOT NULL DEFAULT '',
  monto REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos(fecha);
`);
  // columnas agregadas después de la primera versión (la base de Turso ya existe)
  for (const sql of ['ALTER TABLE productos ADD COLUMN costo REAL NOT NULL DEFAULT 0',
    'ALTER TABLE movimientos ADD COLUMN costo_unitario REAL NOT NULL DEFAULT 0']) {
    try { await db.execute(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
})();
listo.catch(() => {}); // el error se informa en cada pedido (await listo), no tira abajo el proceso

const all = async (sql, args = []) => (await db.execute({ sql, args })).rows.map(r => ({ ...r }));
const one = async (sql, args) => (await all(sql, args))[0];

class BadRequest extends Error {}
const check = (ok, msg) => { if (!ok) throw new BadRequest(msg); };
const num = (v, campo, min = 0) => {
  const n = Number(v ?? 0);
  check(Number.isFinite(n) && n >= min, `${campo} inválido`);
  return n;
};
const VENTAS = ['minorista', 'mayorista'];

// ---------- login ----------
// Sin APP_PASSWORD (uso local en la PC del negocio) no se pide contraseña.
const PASSWORD = process.env.APP_PASSWORD || '';
const SESION = PASSWORD && createHmac('sha256', process.env.SESSION_SECRET || PASSWORD).update('morterito-sesion').digest('hex');
const hash = s => createHash('sha256').update(String(s)).digest();
const cookieDe = req => /(?:^|;\s*)sesion=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
const autenticado = req => !PASSWORD || cookieDe(req) === SESION;

const routes = {
  'GET /api/sesion': (_, __, req) => ({ login: !!PASSWORD, ok: autenticado(req) }),

  'POST /api/login': async (b, _, req, res) => {
    if (!PASSWORD) return { ok: true };
    if (!timingSafeEqual(hash(b.password), hash(PASSWORD))) {
      await new Promise(r => setTimeout(r, 800)); // frena intentos a ciegas
      throw new BadRequest('Contraseña incorrecta');
    }
    const https = req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `sesion=${SESION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${https ? '; Secure' : ''}`);
    return { ok: true };
  },

  'POST /api/logout': (_, __, ___, res) => {
    res.setHeader('Set-Cookie', 'sesion=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return { ok: true };
  },

  'GET /api/productos': () =>
    all('SELECT * FROM stock ORDER BY activo DESC, nombre'),

  'POST /api/productos': async (b) => {
    const nombre = String(b.nombre ?? '').trim();
    check(nombre, 'Falta el nombre');
    const p = {
      nombre,
      categoria: String(b.categoria ?? '').trim(),
      unidad: String(b.unidad ?? 'unidad').trim() || 'unidad',
      precio_minorista: num(b.precio_minorista, 'Precio minorista'),
      precio_mayorista: num(b.precio_mayorista, 'Precio mayorista'),
      costo: num(b.costo, 'Costo'),
      stock_minimo: num(b.stock_minimo, 'Stock mínimo'),
      activo: b.activo === false || b.activo === 0 ? 0 : 1,
    };
    // COLLATE NOCASE de SQLite no iguala acentos en mayúscula (Á/á), así que se controla acá
    const clave = nombre.toLocaleLowerCase('es');
    check(!(await all('SELECT id, nombre FROM productos'))
      .some(x => x.id !== Number(b.id) && x.nombre.toLocaleLowerCase('es') === clave), 'Ya existe un producto con ese nombre');
    const cols = Object.keys(p);
    if (b.id) {
      const r = await db.execute({ sql: `UPDATE productos SET ${cols.map(c => `${c}=:${c}`).join(',')} WHERE id=:id`, args: { ...p, id: Number(b.id) } });
      check(r.rowsAffected === 1, 'Producto no encontrado');
      return { id: Number(b.id) };
    }
    const r = await db.execute({ sql: `INSERT INTO productos (${cols}) VALUES (${cols.map(c => ':' + c)})`, args: p });
    return { id: Number(r.lastInsertRowid) };
  },

  // { tipo, fecha, items: [{ producto_id, cantidad, precio_unitario }] }
  'POST /api/movimientos': async (b) => {
    check(['minorista', 'mayorista', 'compra', 'ajuste'].includes(b.tipo), 'Tipo inválido');
    check(/^\d{4}-\d{2}-\d{2}$/.test(b.fecha ?? ''), 'Fecha inválida');
    check(Array.isArray(b.items) && b.items.length, 'No hay productos cargados');
    const ids = [...new Set(b.items.map(it => Number(it.producto_id)))];
    check(ids.every(Number.isInteger), 'Producto inexistente');
    const existen = await all(`SELECT id, costo FROM productos WHERE id IN (${ids.map(() => '?')})`, ids);
    check(existen.length === ids.length, 'Producto inexistente');
    // el costo se guarda en cada venta: si después cambia, la ganancia de meses anteriores no se altera
    const costo = Object.fromEntries(existen.map(p => [p.id, p.costo]));
    // se valida todo antes de escribir; batch = todo o nada
    const stmts = b.items.map(it => {
      // En ajustes la cantidad viene con signo (+ sobrante, - faltante); en el resto, positiva.
      const cant = b.tipo === 'ajuste' ? num(it.cantidad, 'Cantidad', -Infinity) : num(it.cantidad, 'Cantidad');
      check(cant !== 0, 'La cantidad no puede ser 0');
      return {
        sql: 'INSERT INTO movimientos (fecha, tipo, producto_id, cantidad, precio_unitario, costo_unitario) VALUES (?,?,?,?,?,?)',
        args: [b.fecha, b.tipo, Number(it.producto_id), VENTAS.includes(b.tipo) ? -cant : cant, num(it.precio_unitario, 'Precio'),
          costo[Number(it.producto_id)]],
      };
    });
    await db.batch(stmts, 'write');
    return { ok: true, cargados: stmts.length };
  },

  'GET /api/movimientos': (_, q) =>
    all(`SELECT m.*, p.nombre, p.unidad FROM movimientos m JOIN productos p ON p.id = m.producto_id
      WHERE m.fecha BETWEEN ? AND ? ORDER BY m.fecha DESC, m.id DESC`,
    [q.get('desde') || '0000-00-00', q.get('hasta') || '9999-99-99']),

  'DELETE /api/movimientos': async (_, q) => {
    const r = await db.execute({ sql: 'DELETE FROM movimientos WHERE id = ?', args: [Number(q.get('id'))] });
    check(r.rowsAffected === 1, 'Movimiento no encontrado');
    return { ok: true };
  },

  'GET /api/gastos': (_, q) =>
    all('SELECT * FROM gastos WHERE fecha BETWEEN ? AND ? ORDER BY fecha DESC, id DESC',
      [q.get('desde') || '0000-00-00', q.get('hasta') || '9999-99-99']),

  'POST /api/gastos': async (b) => {
    check(/^\d{4}-\d{2}-\d{2}$/.test(b.fecha ?? ''), 'Fecha inválida');
    const categoria = String(b.categoria ?? '').trim();
    check(categoria, 'Elegí una categoría');
    const monto = num(b.monto, 'Monto');
    check(monto > 0, 'El monto tiene que ser mayor a 0');
    const r = await db.execute({ sql: 'INSERT INTO gastos (fecha, categoria, concepto, monto) VALUES (?,?,?,?)',
      args: [b.fecha, categoria, String(b.concepto ?? '').trim(), monto] });
    return { id: Number(r.lastInsertRowid) };
  },

  'DELETE /api/gastos': async (_, q) => {
    const r = await db.execute({ sql: 'DELETE FROM gastos WHERE id = ?', args: [Number(q.get('id'))] });
    check(r.rowsAffected === 1, 'Gasto no encontrado');
    return { ok: true };
  },

  'GET /api/informe': async (_, q) => {
    const mes = q.get('mes') ?? '';
    check(/^\d{4}-\d{2}$/.test(mes), 'Mes inválido');
    const like = [mes + '-%'];
    return {
      // ganancia = (precio - costo al momento de la venta) x cantidad
      ventas: await all(`SELECT tipo, COUNT(*) AS lineas, SUM(-cantidad * precio_unitario) AS total,
          SUM(-cantidad * (precio_unitario - costo_unitario)) AS ganancia,
          SUM(costo_unitario = 0) AS sin_costo
        FROM movimientos WHERE fecha LIKE ? AND tipo IN ('minorista','mayorista') GROUP BY tipo`, like),
      gastos: await all(`SELECT categoria, SUM(monto) AS total FROM gastos WHERE fecha LIKE ?
        GROUP BY categoria ORDER BY total DESC`, like),
      mas_vendidos: await all(`SELECT p.nombre, p.unidad, SUM(-m.cantidad) AS cantidad,
          SUM(-m.cantidad * m.precio_unitario) AS total, SUM(-m.cantidad * (m.precio_unitario - m.costo_unitario)) AS ganancia
        FROM movimientos m JOIN productos p ON p.id = m.producto_id
        WHERE m.fecha LIKE ? AND m.tipo IN ('minorista','mayorista')
        GROUP BY p.id ORDER BY total DESC`, like),
      faltantes: await all(`SELECT nombre, unidad, stock, stock_minimo FROM stock
        WHERE activo = 1 AND stock <= stock_minimo ORDER BY stock - stock_minimo`),
    };
  },
};
const PUBLICAS = ['GET /api/sesion', 'POST /api/login'];

async function leerBody(req) {
  let raw = req.body; // en Vercel ya viene leído
  if (raw === undefined) {
    raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw new BadRequest('Pedido demasiado grande'); }
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString();
  if (typeof raw !== 'string') return raw ?? {};
  try { return JSON.parse(raw || '{}'); } catch { throw new BadRequest('JSON inválido'); }
}

export async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const send = (code, data) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  };
  // en Vercel la página la sirve public/ directamente; esto es para uso local
  if (req.method === 'GET' && url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(readFileSync(join(import.meta.dirname, 'public', 'index.html')));
  }
  const key = `${req.method} ${url.pathname}`;
  const route = routes[key];
  if (!route) return send(404, { error: 'No encontrado' });
  // en internet nunca sin contraseña: si falta APP_PASSWORD en Vercel, la API no responde
  if (process.env.VERCEL && !PASSWORD) return send(503, { error: 'Falta configurar APP_PASSWORD en Vercel' });
  if (!PUBLICAS.includes(key) && !autenticado(req)) return send(401, { error: 'Iniciá sesión' });
  try {
    await listo;
    const body = req.method === 'POST' ? await leerBody(req) : {};
    send(200, await route(body, url.searchParams, req, res));
  } catch (e) {
    if (e instanceof BadRequest) return send(400, { error: e.message });
    if (String(e.message).includes('UNIQUE')) return send(400, { error: 'Ya existe un producto con ese nombre' });
    console.error(e);
    send(500, { error: 'Error interno' });
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const PORT = Number(process.env.PORT) || 3000;
  http.createServer(handler).listen(PORT, '127.0.0.1', () => console.log(`El Morterito en http://localhost:${PORT}`));
}
