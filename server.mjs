// El Morterito — gestión de stock y ventas. Requiere Node 22.5+ (trae SQLite incorporado).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.MORTERITO_DB || join(import.meta.dirname, 'morterito.db');
const PORT = Number(process.env.PORT) || 3000;
const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA foreign_keys = ON;
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
`);

class BadRequest extends Error {}
const check = (ok, msg) => { if (!ok) throw new BadRequest(msg); };
const num = (v, campo, min = 0) => {
  const n = Number(v ?? 0);
  check(Number.isFinite(n) && n >= min, `${campo} inválido`);
  return n;
};
const VENTAS = ['minorista', 'mayorista'];

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const routes = {
  'GET /api/productos': () =>
    db.prepare('SELECT * FROM stock ORDER BY activo DESC, nombre').all(),

  'POST /api/productos': (b) => {
    const nombre = String(b.nombre ?? '').trim();
    check(nombre, 'Falta el nombre');
    const p = {
      nombre,
      categoria: String(b.categoria ?? '').trim(),
      unidad: String(b.unidad ?? 'unidad').trim() || 'unidad',
      precio_minorista: num(b.precio_minorista, 'Precio minorista'),
      precio_mayorista: num(b.precio_mayorista, 'Precio mayorista'),
      stock_minimo: num(b.stock_minimo, 'Stock mínimo'),
      activo: b.activo === false || b.activo === 0 ? 0 : 1,
    };
    // COLLATE NOCASE de SQLite no iguala acentos en mayúscula (Á/á), así que se controla acá
    const clave = nombre.toLocaleLowerCase('es');
    check(!db.prepare('SELECT id, nombre FROM productos').all()
      .some(x => x.id !== Number(b.id) && x.nombre.toLocaleLowerCase('es') === clave), 'Ya existe un producto con ese nombre');
    const cols = Object.keys(p);
    if (b.id) {
      const r = db.prepare(`UPDATE productos SET ${cols.map(c => `${c}=:${c}`).join(',')} WHERE id=:id`)
        .run({ ...p, id: Number(b.id) });
      check(r.changes === 1, 'Producto no encontrado');
      return { id: Number(b.id) };
    }
    const r = db.prepare(`INSERT INTO productos (${cols}) VALUES (${cols.map(c => ':' + c)})`).run(p);
    return { id: Number(r.lastInsertRowid) };
  },

  // { tipo, fecha, items: [{ producto_id, cantidad, precio_unitario }] }
  'POST /api/movimientos': (b) => {
    check(['minorista', 'mayorista', 'compra', 'ajuste'].includes(b.tipo), 'Tipo inválido');
    check(/^\d{4}-\d{2}-\d{2}$/.test(b.fecha ?? ''), 'Fecha inválida');
    check(Array.isArray(b.items) && b.items.length, 'No hay productos cargados');
    const ins = db.prepare('INSERT INTO movimientos (fecha, tipo, producto_id, cantidad, precio_unitario) VALUES (?,?,?,?,?)');
    const existe = db.prepare('SELECT 1 FROM productos WHERE id = ?');
    return tx(() => {
      for (const it of b.items) {
        check(existe.get(Number(it.producto_id)), 'Producto inexistente');
        // En ajustes la cantidad viene con signo (+ sobrante, - faltante); en el resto, positiva.
        const cant = b.tipo === 'ajuste' ? num(it.cantidad, 'Cantidad', -Infinity) : num(it.cantidad, 'Cantidad');
        check(cant !== 0, 'La cantidad no puede ser 0');
        ins.run(b.fecha, b.tipo, Number(it.producto_id), VENTAS.includes(b.tipo) ? -cant : cant,
          num(it.precio_unitario, 'Precio'));
      }
      return { ok: true, cargados: b.items.length };
    });
  },

  'GET /api/movimientos': (_, q) => {
    const desde = q.get('desde') || '0000-00-00', hasta = q.get('hasta') || '9999-99-99';
    return db.prepare(`SELECT m.*, p.nombre, p.unidad FROM movimientos m JOIN productos p ON p.id = m.producto_id
      WHERE m.fecha BETWEEN ? AND ? ORDER BY m.fecha DESC, m.id DESC`).all(desde, hasta);
  },

  'DELETE /api/movimientos': (_, q) => {
    const r = db.prepare('DELETE FROM movimientos WHERE id = ?').run(Number(q.get('id')));
    check(r.changes === 1, 'Movimiento no encontrado');
    return { ok: true };
  },

  'GET /api/informe': (_, q) => {
    const mes = q.get('mes') ?? '';
    check(/^\d{4}-\d{2}$/.test(mes), 'Mes inválido');
    const like = mes + '-%';
    return {
      ventas: db.prepare(`SELECT tipo, COUNT(*) AS lineas, SUM(-cantidad * precio_unitario) AS total
        FROM movimientos WHERE fecha LIKE ? AND tipo IN ('minorista','mayorista') GROUP BY tipo`).all(like),
      compras: db.prepare(`SELECT COALESCE(SUM(cantidad * precio_unitario), 0) AS total
        FROM movimientos WHERE fecha LIKE ? AND tipo = 'compra'`).get(like).total,
      mas_vendidos: db.prepare(`SELECT p.nombre, p.unidad, SUM(-m.cantidad) AS cantidad,
          SUM(-m.cantidad * m.precio_unitario) AS total
        FROM movimientos m JOIN productos p ON p.id = m.producto_id
        WHERE m.fecha LIKE ? AND m.tipo IN ('minorista','mayorista')
        GROUP BY p.id ORDER BY total DESC`).all(like),
      faltantes: db.prepare(`SELECT nombre, unidad, stock, stock_minimo FROM stock
        WHERE activo = 1 AND stock <= stock_minimo ORDER BY stock - stock_minimo`).all(),
    };
  },
};

const html = readFileSync(join(import.meta.dirname, 'index.html'));

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  const route = routes[`${req.method} ${url.pathname}`];
  const send = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (!route) return send(404, { error: 'No encontrado' });
  try {
    let body = {};
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw new BadRequest('Pedido demasiado grande'); }
      try { body = JSON.parse(raw || '{}'); } catch { throw new BadRequest('JSON inválido'); }
    }
    send(200, route(body, url.searchParams));
  } catch (e) {
    if (e instanceof BadRequest) return send(400, { error: e.message });
    if (String(e.message).includes('UNIQUE')) return send(400, { error: 'Ya existe un producto con ese nombre' });
    console.error(e);
    send(500, { error: 'Error interno: ' + e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`El Morterito en http://localhost:${PORT}  (base: ${DB_PATH})`));
