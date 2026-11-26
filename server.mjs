// El Morterito — gestión de stock y ventas.
// Local: `node server.mjs` usa el archivo morterito.db. En Vercel: api/index.mjs usa Turso (TURSO_DATABASE_URL).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, createHmac, timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || pathToFileURL(process.env.MORTERITO_DB || join(import.meta.dirname, 'morterito.db')).href,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function iniciar() { await db.executeMultiple(`
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
-- efectivo con el que se abre la caja cada día
CREATE TABLE IF NOT EXISTS aperturas (
  fecha TEXT PRIMARY KEY,
  monto REAL NOT NULL
);
-- quién atiende: cada persona entra con su PIN (guardado con sal y scrypt, nunca en texto)
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pin TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1
);
-- cierre de caja: lo que se contó y lo que tenía que haber en ese momento
-- intentos fallidos de contraseña o PIN, para limitarlos (se borran solos después de un día)
CREATE TABLE IF NOT EXISTS intentos (clave TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_intentos ON intentos(clave, ts);
-- registro de lo que se borró (quién, cuándo y qué), para que no se pueda borrar sin dejar rastro
CREATE TABLE IF NOT EXISTS borrados (
  id INTEGER PRIMARY KEY,
  fecha TEXT NOT NULL,
  creado TEXT NOT NULL,
  usuario_id INTEGER,
  detalle TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cierres (
  fecha TEXT PRIMARY KEY,
  contado REAL NOT NULL,
  esperado REAL NOT NULL,
  usuario_id INTEGER
);
`);
  // columnas agregadas después de la primera versión (la base de Turso ya existe)
  for (const sql of ['ALTER TABLE productos ADD COLUMN costo REAL NOT NULL DEFAULT 0',
    'ALTER TABLE movimientos ADD COLUMN costo_unitario REAL NOT NULL DEFAULT 0',
    "ALTER TABLE movimientos ADD COLUMN medio_pago TEXT NOT NULL DEFAULT ''", // ventas viejas quedan sin dato
    "ALTER TABLE gastos ADD COLUMN medio_pago TEXT NOT NULL DEFAULT 'efectivo'",
    'ALTER TABLE movimientos ADD COLUMN usuario_id INTEGER', // quién lo hizo (null = antes de haber usuarios)
    'ALTER TABLE gastos ADD COLUMN usuario_id INTEGER',
    'ALTER TABLE aperturas ADD COLUMN usuario_id INTEGER',
    // momento en que se registró (ISO, UTC); lo de antes queda sin hora
    'ALTER TABLE movimientos ADD COLUMN creado TEXT', 'ALTER TABLE gastos ADD COLUMN creado TEXT',
    'ALTER TABLE aperturas ADD COLUMN creado TEXT', 'ALTER TABLE cierres ADD COLUMN creado TEXT']) {
    try { await db.execute(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
}
// Se prepara la base una vez por servidor. Si falla (p. ej. Turso no responde un momento), se olvida
// el fallo y el próximo pedido vuelve a intentar: antes quedaba trabado en "Error interno" hasta reiniciarse.
let listo = null;
const preparar = () => (listo ??= iniciar().catch(e => { listo = null; throw e; }));

const all = async (sql, args = []) => (await db.execute({ sql, args })).rows.map(r => ({ ...r }));
const one = async (sql, args) => (await all(sql, args))[0];

class BadRequest extends Error {}
class Conflict extends BadRequest {} // 409: la pantalla ofrece una alternativa (desactivar)
class SinUsuario extends BadRequest {} // 403: hay usuarios cargados y nadie ingresó su PIN
class Demasiados extends BadRequest {} // 429: demasiados intentos fallidos de contraseña o PIN
const check = (ok, msg) => { if (!ok) throw new BadRequest(msg); };
// número con mínimo y máximo: sin tope, un 1e308 se guardaba y dejaba totales infinitos o ilegibles
const MAX_PLATA = 1e9, MAX_CANTIDAD = 1e6; // $1.000 millones por operación; un millón de unidades o kg
const num = (v, campo, min = 0, max = MAX_PLATA) => {
  const n = Number(v ?? 0);
  check(Number.isFinite(n) && n >= min && n <= max, `${campo}: valor inválido`);
  return n;
};
// texto libre: sin espacios de más y con un largo máximo (que nadie guarde textos enormes)
const texto = (v, campo, max) => { const s = String(v ?? '').trim(); check(s.length <= max, `${campo}: máximo ${max} caracteres`); return s; };
// id de ?id=…; uno inválido (texto, vacío) es un 400 claro y no un error de la base
const idDe = q => { const id = Number(q.get('id')); check(Number.isInteger(id) && id > 0, 'Identificador inválido'); return id; };
const VENTAS = ['minorista', 'mayorista'];
const MEDIOS = ['efectivo', 'transferencia'];
const CATEGORIAS_GASTO = ['Mercadería', 'Bolsitas y descartables', 'Alquiler', 'Servicios', 'Sueldos', 'Impuestos', 'Marketing', 'Otros'];
// fecha que existe de verdad (no 31/02) y en un rango razonable (no año 9999)
const fechaOk = s => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s ?? '')) return false;
  const [y, m, d] = s.split('-').map(Number), f = new Date(Date.UTC(y, m - 1, d));
  return y >= 2020 && y <= 2100 && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
};

// ---------- login ----------
// Sin APP_PASSWORD (uso local en la PC del negocio) no se pide contraseña.
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRETO = process.env.SESSION_SECRET || PASSWORD || 'morterito-local';
const hash = s => createHash('sha256').update(String(s)).digest();
// compara firmas sin filtrar información por el tiempo que tarda
const igual = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// sesión del negocio = "momento.firma": vence a los 30 días también del lado del servidor
// (no alcanza con que el navegador borre la cookie) y cambiar APP_PASSWORD invalida todas
const DURA_SESION = 30 * 24 * 60 * 60;
const firmaSesion = t => createHmac('sha256', `${SECRETO}|${PASSWORD}`).update('sesion:' + t).digest('hex');
const nuevaSesion = () => { const t = Date.now().toString(36); return `${t}.${firmaSesion(t)}`; };
const autenticado = req => {
  if (!PASSWORD) return true;
  const m = /(?:^|;\s*)sesion=([a-z0-9]{1,12})\.([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return !!m && igual(m[2], firmaSesion(m[1])) && Date.now() - parseInt(m[1], 36) < DURA_SESION * 1000;
};
const esperar = ms => new Promise(r => setTimeout(r, ms));
const ahora = () => new Date().toISOString(); // la hora la pone el servidor, no el reloj de cada dispositivo
const esHttps = req => req.headers['x-forwarded-proto'] === 'https';
const cookie = (req, nombre, valor, segundos) =>
  `${nombre}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${segundos}${esHttps(req) ? '; Secure' : ''}`;

// ---------- usuarios: quién está atendiendo ----------
// La contraseña del negocio abre la app en el dispositivo; el PIN dice quién atiende (cookie firmada, dura un turno).
const TURNO = 14 * 60 * 60; // el PIN se vuelve a pedir al día siguiente
// "id.momento.firma": el turno vence a las 14 h también en el servidor (no solo en el navegador)
const firmaUsuario = (id, t) => createHmac('sha256', SECRETO).update(`usuario:${id}:${t}`).digest('hex');
const nuevoTurno = id => { const t = Date.now().toString(36); return `${id}.${t}.${firmaUsuario(id, t)}`; };
const usuarioCookie = req => {
  const m = /(?:^|;\s*)usuario=(\d{1,9})\.([a-z0-9]{1,12})\.([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m && igual(m[3], firmaUsuario(m[1], m[2])) && Date.now() - parseInt(m[2], 36) < TURNO * 1000 ? Number(m[1]) : null;
};

// ---------- límite de intentos (contraseña del negocio y PINs) ----------
// Se cuenta en la base (en Vercel no hay memoria compartida entre pedidos): más de 8 fallos
// desde la misma IP en 15 minutos bloquean ese tipo de intento hasta que pase la ventana.
const VENTANA_INTENTOS = 15 * 60 * 1000, MAX_FALLOS = 8;
const ipDe = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'desconocida').split(',')[0].trim();
// PIN y administración solo se usan en un dispositivo que ya entró con la contraseña del negocio: se cuentan
// por dispositivo (su sesión), así un dueño que se equivoca no bloquea al otro en el mismo wifi del local
const dispositivoDe = req => /(?:^|;\s*)sesion=([a-z0-9]{1,12})\./.exec(req.headers.cookie || '')?.[1];
async function frenarSiAbusa(req, tipo) {
  const clave = `${tipo}:${(tipo !== 'login' && dispositivoDe(req)) || ipDe(req)}`;
  const { n } = await one('SELECT COUNT(*) AS n FROM intentos WHERE clave = ? AND ts > ?', [clave, Date.now() - VENTANA_INTENTOS]);
  if (n >= MAX_FALLOS) throw new Demasiados('Demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo.');
  return clave;
}
async function anotarFallo(clave) {
  if (clave) await db.batch([
    { sql: 'INSERT INTO intentos (clave, ts) VALUES (?, ?)', args: [clave, Date.now()] },
    { sql: 'DELETE FROM intentos WHERE ts < ?', args: [Date.now() - 24 * 60 * 60 * 1000] }, // limpieza
  ], 'write');
  await esperar(800); // además, cada fallo tarda
}
const hashPin = (pin, sal = randomBytes(16).toString('hex')) => `${sal}:${scryptSync(String(pin), sal, 32).toString('hex')}`;
const pinCoincide = (pin, guardado) => {
  const [sal, h] = guardado.split(':');
  return timingSafeEqual(Buffer.from(h, 'hex'), scryptSync(String(pin), sal, 32));
};
// para administrar usuarios hay que volver a escribir la contraseña del negocio
const esAdmin = b => !PASSWORD || timingSafeEqual(hash(b.admin ?? ''), hash(PASSWORD));
// id de quien atiende; si hay usuarios cargados es obligatorio para registrar algo
async function quien(req) {
  const id = usuarioCookie(req);
  const u = id && await one('SELECT id FROM usuarios WHERE id = ? AND activo = 1', [id]);
  if (u) return u.id;
  if (await one('SELECT 1 AS hay FROM usuarios WHERE activo = 1 LIMIT 1')) throw new SinUsuario('Ingresá tu PIN para registrar quién atiende');
  return null;
}
// apertura y cierre de caja se confirman con el PIN de quien los hace (aunque la sesión sea de otra persona)
async function confirmarConPin(b, req) {
  const activos = await all('SELECT id, pin FROM usuarios WHERE activo = 1');
  if (!activos.length) return null; // sin usuarios cargados no se pide
  const pin = String(b.pin ?? '');
  check(pin, 'Poné tu PIN para confirmar');
  const clave = await frenarSiAbusa(req, 'pin');
  const u = /^\d{4,8}$/.test(pin) && activos.find(u => pinCoincide(pin, u.pin));
  if (!u) { await anotarFallo(clave); throw new BadRequest('PIN incorrecto'); }
  return u.id;
}

// borrar deja rastro: qué era, de qué día, quién lo borró y cuándo
const plata = n => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n);
const PLURAL = { unidad: 'unidades', paquete: 'paquetes', litro: 'litros' };
const cuanto = (n, u) => u === 'kg' && Math.abs(n) < 1 ? `${Math.round(n * 1000)} g` // fracciones: "150 g" mejor que "0,15 kg"
  : `${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 3 }).format(n)} ${Math.abs(n) === 1 ? u : PLURAL[u] ?? u}`;
const registroBorrado = (fecha, uid, detalle) =>
  ({ sql: 'INSERT INTO borrados (fecha, creado, usuario_id, detalle) VALUES (?, ?, ?, ?)', args: [fecha, ahora(), uid, detalle] });
// shortcut: Argentina es UTC-3 todo el año (sin horario de verano); si el negocio cambia de país, usar Intl con su zona
const hoyArgentina = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

// efectivo que tiene que haber en la caja un día: apertura + ventas en efectivo − gastos en efectivo
async function efectivoEsperado(fecha) {
  const r = await one(`SELECT
      COALESCE((SELECT monto FROM aperturas WHERE fecha = :f), 0)
    + COALESCE((SELECT SUM(-cantidad * precio_unitario) FROM movimientos WHERE fecha = :f AND tipo IN ('minorista','mayorista') AND medio_pago = 'efectivo'), 0)
    - COALESCE((SELECT SUM(monto) FROM gastos WHERE fecha = :f AND medio_pago = 'efectivo'), 0) AS esperado`, { f: fecha });
  return Math.round(r.esperado * 100) / 100;
}

const routes = {
  'GET /api/sesion': (_, __, req) => ({ login: !!PASSWORD, ok: autenticado(req), usuario: usuarioCookie(req) }),

  'POST /api/login': async (b, _, req, res) => {
    if (!PASSWORD) return { ok: true };
    // el límite de intentos usa la base; si la base no responde, se puede entrar igual (sin límite)
    let clave = null;
    try { await preparar(); clave = await frenarSiAbusa(req, 'login'); } catch (e) { if (e instanceof Demasiados) throw e; }
    if (!timingSafeEqual(hash(b.password), hash(PASSWORD))) {
      await anotarFallo(clave).catch(() => esperar(800));
      throw new BadRequest('Contraseña incorrecta');
    }
    res.setHeader('Set-Cookie', cookie(req, 'sesion', nuevaSesion(), DURA_SESION));
    return { ok: true };
  },

  'POST /api/logout': (_, __, req, res) => {
    res.setHeader('Set-Cookie', [cookie(req, 'sesion', '', 0), cookie(req, 'usuario', '', 0)]);
    return { ok: true };
  },

  'GET /api/usuarios': () => all('SELECT id, nombre, activo FROM usuarios ORDER BY activo DESC, nombre'),

  // alta, cambio de PIN o baja (activo: false). Pide la contraseña del negocio en "admin".
  'POST /api/usuarios': async (b, _, req) => {
    const clave = await frenarSiAbusa(req, 'admin');
    if (!esAdmin(b)) { await anotarFallo(clave); throw new BadRequest('La contraseña del negocio no es correcta'); }
    const activos = await all('SELECT id, nombre, pin FROM usuarios WHERE activo = 1');
    const pin = String(b.pin ?? '');
    if (pin) {
      check(/^\d{4,8}$/.test(pin), 'El PIN tiene que ser de 4 a 8 números');
      // el PIN identifica a la persona: no puede repetirse entre usuarios activos
      check(!activos.some(u => u.id !== Number(b.id) && pinCoincide(pin, u.pin)), 'Ese PIN ya lo usa otra persona');
    }
    if (b.id) {
      const id = Number(b.id);
      check(Number.isInteger(id) && id > 0, 'Usuario inexistente');
      const actual = await one('SELECT activo FROM usuarios WHERE id = ?', [id]);
      check(actual, 'Usuario inexistente');
      // al reactivar, su PIN viejo puede estar usándolo otra persona (y no se puede saber: está cifrado)
      check(!(b.activo && !actual.activo && !pin), 'Para volver a activarlo, poné un PIN nuevo');
      const sets = [], args = [];
      if (pin) { sets.push('pin = ?'); args.push(hashPin(pin)); }
      if (b.activo !== undefined) { sets.push('activo = ?'); args.push(b.activo ? 1 : 0); }
      check(sets.length, 'No hay nada para cambiar');
      const r = await db.execute({ sql: `UPDATE usuarios SET ${sets.join(', ')} WHERE id = ?`, args: [...args, id] });
      check(r.rowsAffected === 1, 'Usuario inexistente');
      return { id };
    }
    const nombre = texto(b.nombre, 'Nombre', 40);
    check(nombre, 'Falta el nombre');
    check(pin, 'Falta el PIN');
    // mismo nombre (sin importar mayúsculas ni tildes): si estaba dado de baja, vuelve con el PIN nuevo
    const comparable = nombre.toLocaleLowerCase('es');
    const mismo = (await all('SELECT id, nombre, activo FROM usuarios')).find(u => u.nombre.toLocaleLowerCase('es') === comparable);
    check(!mismo?.activo, 'Ya hay un usuario con ese nombre');
    if (mismo) {
      await db.execute({ sql: 'UPDATE usuarios SET pin = ?, activo = 1 WHERE id = ?', args: [hashPin(pin), mismo.id] });
      return { id: mismo.id, reactivado: true };
    }
    const r = await db.execute({ sql: 'INSERT INTO usuarios (nombre, pin) VALUES (?, ?)', args: [nombre, hashPin(pin)] });
    return { id: Number(r.lastInsertRowid) };
  },

  'POST /api/usuario/entrar': async (b, _, req, res) => {
    const pin = String(b.pin ?? '');
    const clave = await frenarSiAbusa(req, 'pin');
    const u = /^\d{4,8}$/.test(pin) && (await all('SELECT id, nombre, pin FROM usuarios WHERE activo = 1')).find(u => pinCoincide(pin, u.pin));
    if (!u) { await anotarFallo(clave); throw new BadRequest('PIN incorrecto'); }
    res.setHeader('Set-Cookie', cookie(req, 'usuario', nuevoTurno(u.id), TURNO));
    return { id: u.id, nombre: u.nombre };
  },

  'POST /api/usuario/salir': (_, __, req, res) => {
    res.setHeader('Set-Cookie', cookie(req, 'usuario', '', 0));
    return { ok: true };
  },

  'GET /api/productos': () =>
    all('SELECT * FROM stock ORDER BY activo DESC, nombre'),

  'POST /api/productos': async (b) => {
    const nombre = texto(b.nombre, 'Nombre', 80);
    check(nombre, 'Falta el nombre');
    const p = {
      nombre,
      categoria: texto(b.categoria, 'Categoría', 50),
      unidad: texto(b.unidad ?? 'unidad', 'Unidad', 20) || 'unidad',
      precio_minorista: num(b.precio_minorista, 'Precio minorista'),
      precio_mayorista: num(b.precio_mayorista, 'Precio mayorista'),
      costo: num(b.costo, 'Costo'),
      stock_minimo: num(b.stock_minimo, 'Stock mínimo', 0, MAX_CANTIDAD),
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

  // borra un producto y sus movimientos de stock; si tiene ventas no, para no alterar informes pasados
  'DELETE /api/productos': async (_, q, req) => {
    const id = idDe(q);
    const p = await one('SELECT nombre FROM productos WHERE id = ?', [id]);
    check(p, 'Producto no encontrado');
    const { n } = await one(`SELECT COUNT(*) AS n FROM movimientos WHERE producto_id = ? AND tipo IN ('minorista','mayorista')`, [id]);
    if (n) throw new Conflict(`No se puede borrar: tiene ${n} venta(s) registrada(s) y los informes de esos días quedarían mal.`);
    const uid = await quien(req);
    await db.batch([
      registroBorrado(hoyArgentina(), uid, `Producto "${p.nombre}"`),
      { sql: 'DELETE FROM movimientos WHERE producto_id = ?', args: [id] },
      { sql: 'DELETE FROM productos WHERE id = ?', args: [id] },
    ], 'write');
    return { ok: true };
  },

  // { tipo, fecha, medio_pago, items: [{ producto_id, cantidad, precio_unitario }] }
  'POST /api/movimientos': async (b, _, req) => {
    check(['minorista', 'mayorista', 'compra', 'ajuste'].includes(b.tipo), 'Tipo inválido');
    check(fechaOk(b.fecha), 'Fecha inválida');
    check(Array.isArray(b.items) && b.items.length, 'No hay productos cargados');
    check(b.items.every(it => it && typeof it === 'object'), 'Producto inexistente');
    check(b.items.length <= 200, 'Demasiados productos en un solo ticket (máximo 200)');
    const venta = VENTAS.includes(b.tipo);
    const uid = await quien(req);
    check(!venta || MEDIOS.includes(b.medio_pago), 'Elegí el medio de pago');
    const ids = [...new Set(b.items.map(it => Number(it.producto_id)))];
    check(ids.every(Number.isInteger), 'Producto inexistente');
    const existen = await all(`SELECT id, nombre, costo, activo, unidad FROM productos WHERE id IN (${ids.map(() => '?')})`, ids);
    const prod = Object.fromEntries(existen.map(p => [p.id, p]));
    check(existen.length === ids.length, 'Producto inexistente');
    const inactivo = existen.find(p => !p.activo);
    check(!venta || !inactivo, `"${inactivo?.nombre}" está desactivado: activalo en Productos para venderlo`);
    // el costo se guarda en cada venta: si después cambia, la ganancia de meses anteriores no se altera
    const costo = Object.fromEntries(existen.map(p => [p.id, p.costo]));
    // se valida todo antes de escribir; batch = todo o nada
    const creado = ahora();
    const stmts = b.items.map(it => {
      // En ajustes la cantidad viene con signo (+ sobrante, - faltante); en el resto, positiva.
      const cant = b.tipo === 'ajuste' ? num(it.cantidad, 'Cantidad', -MAX_CANTIDAD, MAX_CANTIDAD) : num(it.cantidad, 'Cantidad', 0, MAX_CANTIDAD);
      check(cant !== 0, 'La cantidad no puede ser 0');
      const precio = num(it.precio_unitario, 'Precio');
      check(!venta || precio > 0, 'Hay un producto con precio $0: cargale el precio antes de cobrar');
      // por kilo: el minorista fracciona desde 100 g y el mayorista vende desde 1 kg (precio por kg en los dos)
      const p = prod[Number(it.producto_id)], minimo = { minorista: 0.1, mayorista: 1 }[b.tipo];
      check(!(minimo && p.unidad === 'kg' && cant + 1e-9 < minimo),
        b.tipo === 'mayorista' ? `"${p.nombre}": la venta mayorista es desde 1 kg` : `"${p.nombre}": se fracciona desde 100 g`);
      return {
        sql: 'INSERT INTO movimientos (fecha, tipo, producto_id, cantidad, precio_unitario, costo_unitario, medio_pago, usuario_id, creado) VALUES (?,?,?,?,?,?,?,?,?)',
        args: [b.fecha, b.tipo, Number(it.producto_id), venta ? -cant : cant, precio,
          costo[Number(it.producto_id)], venta ? b.medio_pago : '', uid, creado],
      };
    });
    await db.batch(stmts, 'write');
    return { ok: true, cargados: stmts.length };
  },

  // sección Stock: entró mercadería, salió (rotura, vencido, consumo) o "conté y hay X"
  'POST /api/stock': async (b, _, req) => {
    check(['entrada', 'salida', 'contar'].includes(b.accion), 'Acción inválida');
    check(fechaOk(b.fecha), 'Fecha inválida');
    const id = Number(b.producto_id);
    check(Number.isInteger(id) && id > 0, 'Producto inexistente');
    const uid = await quien(req);
    const p = await one('SELECT costo, stock FROM stock WHERE id = ?', [id]);
    check(p, 'Producto inexistente');
    check(b.cantidad !== '' && b.cantidad != null, 'Poné la cantidad');
    const cant = num(b.cantidad, 'Cantidad', 0, MAX_CANTIDAD);
    check(b.accion === 'contar' || cant > 0, 'La cantidad tiene que ser mayor a 0');
    // al contar, la diferencia se calcula contra el stock de este momento (no el que tenía la pantalla)
    const mov = b.accion === 'entrada' ? cant : b.accion === 'salida' ? -cant : Math.round((cant - p.stock) * 1000) / 1000;
    if (mov === 0) return { ok: true, movimiento: 0 };
    await db.execute({
      sql: "INSERT INTO movimientos (fecha, tipo, producto_id, cantidad, precio_unitario, costo_unitario, medio_pago, usuario_id, creado) VALUES (?,?,?,?,0,?,'',?,?)",
      args: [b.fecha, b.accion === 'entrada' ? 'compra' : 'ajuste', id, mov, p.costo, uid, ahora()],
    });
    return { ok: true, movimiento: mov };
  },

  // aperturas y cierres de caja de un período, con quién los hizo (para el historial)
  'GET /api/caja': async (_, q) => {
    const r = [q.get('desde') || '0000-00-00', q.get('hasta') || '9999-99-99'];
    return {
      aperturas: await all(`SELECT a.fecha, a.monto, a.creado, u.nombre AS usuario FROM aperturas a
        LEFT JOIN usuarios u ON u.id = a.usuario_id WHERE a.fecha BETWEEN ? AND ? ORDER BY a.fecha DESC`, r),
      cierres: await all(`SELECT c.fecha, c.contado, c.esperado, c.creado, u.nombre AS usuario FROM cierres c
        LEFT JOIN usuarios u ON u.id = c.usuario_id WHERE c.fecha BETWEEN ? AND ? ORDER BY c.fecha DESC`, r),
      borrados: await all(`SELECT b.fecha, b.creado, b.detalle, u.nombre AS usuario FROM borrados b
        LEFT JOIN usuarios u ON u.id = b.usuario_id WHERE b.fecha BETWEEN ? AND ? ORDER BY b.creado DESC`, r),
    };
  },

  'GET /api/movimientos': (_, q) =>
    all(`SELECT m.*, p.nombre, p.unidad, u.nombre AS usuario FROM movimientos m JOIN productos p ON p.id = m.producto_id
      LEFT JOIN usuarios u ON u.id = m.usuario_id
      WHERE m.fecha BETWEEN ? AND ? ORDER BY m.fecha DESC, m.id DESC`,
    [q.get('desde') || '0000-00-00', q.get('hasta') || '9999-99-99']),

  'DELETE /api/movimientos': async (_, q, req) => {
    const id = idDe(q);
    const m = await one(`SELECT m.fecha, m.tipo, m.cantidad, m.precio_unitario, p.nombre, p.unidad FROM movimientos m
      JOIN productos p ON p.id = m.producto_id WHERE m.id = ?`, [id]);
    check(m, 'Movimiento no encontrado');
    const uid = await quien(req);
    const venta = VENTAS.includes(m.tipo), cant = venta ? -m.cantidad : m.cantidad;
    const nombres = { minorista: 'Venta minorista', mayorista: 'Venta mayorista', compra: 'Compra', ajuste: 'Ajuste' };
    const detalle = `${nombres[m.tipo]}: ${m.nombre} x ${cuanto(cant, m.unidad)}${venta ? ` (${plata(cant * m.precio_unitario)})` : ''}`;
    await db.batch([registroBorrado(m.fecha, uid, detalle), { sql: 'DELETE FROM movimientos WHERE id = ?', args: [id] }], 'write');
    return { ok: true };
  },

  'GET /api/gastos': (_, q) =>
    all('SELECT g.*, u.nombre AS usuario FROM gastos g LEFT JOIN usuarios u ON u.id = g.usuario_id WHERE g.fecha BETWEEN ? AND ? ORDER BY g.fecha DESC, g.id DESC',
      [q.get('desde') || '0000-00-00', q.get('hasta') || '9999-99-99']),

  'POST /api/gastos': async (b, _, req) => {
    check(fechaOk(b.fecha), 'Fecha inválida');
    const categoria = String(b.categoria ?? '').trim();
    check(CATEGORIAS_GASTO.includes(categoria), 'Elegí una categoría de la lista');
    const monto = num(b.monto, 'Monto');
    check(monto > 0, 'El monto tiene que ser mayor a 0');
    check(MEDIOS.includes(b.medio_pago), 'Elegí con qué se pagó');
    const uid = await quien(req);
    const r = await db.execute({ sql: 'INSERT INTO gastos (fecha, categoria, concepto, monto, medio_pago, usuario_id, creado) VALUES (?,?,?,?,?,?,?)',
      args: [b.fecha, categoria, texto(b.concepto, 'Detalle', 150), monto, b.medio_pago, uid, ahora()] });
    return { id: Number(r.lastInsertRowid) };
  },

  'DELETE /api/gastos': async (_, q, req) => {
    const id = idDe(q);
    const g = await one('SELECT fecha, categoria, concepto, monto FROM gastos WHERE id = ?', [id]);
    check(g, 'Gasto no encontrado');
    const uid = await quien(req);
    const detalle = `Gasto: ${g.categoria}${g.concepto ? ` (${g.concepto})` : ''} ${plata(g.monto)}`;
    await db.batch([registroBorrado(g.fecha, uid, detalle), { sql: 'DELETE FROM gastos WHERE id = ?', args: [id] }], 'write');
    return { ok: true };
  },

  'GET /api/apertura': async (_, q) => {
    const fecha = q.get('fecha') ?? '';
    check(fechaOk(fecha), 'Fecha inválida');
    return { monto: (await one('SELECT monto FROM aperturas WHERE fecha = ?', [fecha]))?.monto ?? null };
  },

  // se puede volver a mandar para corregir el monto del día
  'POST /api/apertura': async (b, _, req) => {
    check(fechaOk(b.fecha), 'Fecha inválida');
    check(b.monto !== '' && b.monto != null, 'Poné con cuánto efectivo empezás (puede ser 0)');
    const monto = num(b.monto, 'Monto');
    const uid = await confirmarConPin(b, req);
    await db.execute({ sql: `INSERT INTO aperturas (fecha, monto, usuario_id, creado) VALUES (?, ?, ?, ?)
        ON CONFLICT(fecha) DO UPDATE SET monto = excluded.monto, usuario_id = excluded.usuario_id, creado = excluded.creado`,
      args: [b.fecha, monto, uid, ahora()] });
    return { ok: true };
  },

  // cerrar la caja: se guarda lo contado y lo que tenía que haber (calculado acá, en este momento)
  'POST /api/cierre': async (b, _, req) => {
    check(fechaOk(b.fecha), 'Fecha inválida');
    check(b.contado !== '' && b.contado != null, 'Poné cuánto efectivo contaste');
    const contado = num(b.contado, 'Efectivo contado');
    const uid = await confirmarConPin(b, req);
    const esperado = await efectivoEsperado(b.fecha);
    await db.execute({
      sql: `INSERT INTO cierres (fecha, contado, esperado, usuario_id, creado) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(fecha) DO UPDATE SET contado = excluded.contado, esperado = excluded.esperado, usuario_id = excluded.usuario_id, creado = excluded.creado`,
      args: [b.fecha, contado, esperado, uid, ahora()],
    });
    return { contado, esperado, diferencia: Math.round((contado - esperado) * 100) / 100 };
  },

  // informe de un período (día, semana o mes): ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD
  'GET /api/informe': async (_, q) => {
    const rango = [q.get('desde') ?? '', q.get('hasta') ?? ''];
    check(rango.every(fechaOk) && rango[0] <= rango[1], 'Período inválido');
    return {
      // solo en el informe de un día: la caja se cuenta día por día
      apertura: rango[0] === rango[1] ? (await one('SELECT monto FROM aperturas WHERE fecha = ?', [rango[0]]))?.monto ?? null : null,
      cierre: rango[0] === rango[1] ? (await one(`SELECT c.contado, c.esperado, c.creado, u.nombre AS usuario FROM cierres c
        LEFT JOIN usuarios u ON u.id = c.usuario_id WHERE c.fecha = ?`, [rango[0]])) ?? null : null,
      // cuánto vendió cada persona (null = ventas de antes de haber usuarios)
      por_usuario: await all(`SELECT u.nombre AS usuario, COUNT(DISTINCT m.id) AS lineas, SUM(-m.cantidad * m.precio_unitario) AS total
        FROM movimientos m LEFT JOIN usuarios u ON u.id = m.usuario_id
        WHERE m.fecha BETWEEN ? AND ? AND m.tipo IN ('minorista','mayorista') GROUP BY m.usuario_id ORDER BY total DESC`, rango),
      // ganancia = (precio - costo al momento de la venta) x cantidad
      ventas: await all(`SELECT tipo, COUNT(*) AS lineas, SUM(-cantidad * precio_unitario) AS total,
          SUM(-cantidad * (precio_unitario - costo_unitario)) AS ganancia,
          SUM(costo_unitario = 0) AS sin_costo
        FROM movimientos WHERE fecha BETWEEN ? AND ? AND tipo IN ('minorista','mayorista') GROUP BY tipo`, rango),
      // cierre de caja: lo cobrado y lo pagado por cada medio de pago
      ventas_medio: await all(`SELECT medio_pago, SUM(-cantidad * precio_unitario) AS total
        FROM movimientos WHERE fecha BETWEEN ? AND ? AND tipo IN ('minorista','mayorista') GROUP BY medio_pago`, rango),
      gastos_medio: await all(`SELECT medio_pago, SUM(monto) AS total FROM gastos WHERE fecha BETWEEN ? AND ?
        GROUP BY medio_pago`, rango),
      gastos: await all(`SELECT categoria, SUM(monto) AS total FROM gastos WHERE fecha BETWEEN ? AND ?
        GROUP BY categoria ORDER BY total DESC`, rango),
      mas_vendidos: await all(`SELECT p.nombre, p.unidad, SUM(-m.cantidad) AS cantidad,
          SUM(-m.cantidad * m.precio_unitario) AS total, SUM(-m.cantidad * (m.precio_unitario - m.costo_unitario)) AS ganancia
        FROM movimientos m JOIN productos p ON p.id = m.producto_id
        WHERE m.fecha BETWEEN ? AND ? AND m.tipo IN ('minorista','mayorista')
        GROUP BY p.id ORDER BY total DESC`, rango),
      faltantes: await all(`SELECT nombre, unidad, stock, stock_minimo FROM stock
        WHERE activo = 1 AND stock <= stock_minimo ORDER BY stock - stock_minimo`),
    };
  },
};
const PUBLICAS = ['GET /api/sesion', 'POST /api/login'];
const SIN_BASE = [...PUBLICAS, 'POST /api/logout']; // funcionan aunque la base no responda

async function leerBody(req) {
  let raw;
  try { raw = req.body; } catch { throw new BadRequest('JSON inválido'); } // en Vercel ya viene leído (y tira si no es JSON)
  if (raw === undefined) {
    // se lee todo aunque sea grande (descartando lo que sobra): cortar a la mitad dejaba la conexión rota
    raw = ''; let largo = 0;
    for await (const chunk of req) { largo += chunk.length; if (largo <= 1e6) raw += chunk; }
    if (largo > 1e6) throw new BadRequest('Pedido demasiado grande');
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString();
  let b = raw;
  if (typeof raw === 'string') { try { b = JSON.parse(raw || '{}'); } catch { throw new BadRequest('JSON inválido'); } }
  // tiene que ser un objeto: con null, una lista o un número las rutas fallaban con error 500
  check(b && typeof b === 'object' && !Array.isArray(b), 'JSON inválido');
  return b;
}

export async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const send = (code, data) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  };
  // en Vercel la página la sirve public/ directamente; esto es para uso local
  const estatico = { '/': ['index.html', 'text/html; charset=utf-8'], '/logo.jpg': ['logo.jpg', 'image/jpeg'],
    '/logo-chico.jpg': ['logo-chico.jpg', 'image/jpeg'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
    '/sw.js': ['sw.js', 'text/javascript'], '/robots.txt': ['robots.txt', 'text/plain'], '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'] }[url.pathname];
  if (req.method === 'GET' && estatico) {
    res.setHeader('Content-Type', estatico[1]);
    return res.end(readFileSync(join(import.meta.dirname, 'public', estatico[0])));
  }
  const key = `${req.method} ${url.pathname}`;
  const route = routes[key];
  if (!route) return send(404, { error: 'No encontrado' });
  // en internet nunca sin contraseña: si falta APP_PASSWORD en Vercel, la API no responde
  if (process.env.VERCEL && !PASSWORD) return send(503, { error: 'Falta configurar APP_PASSWORD en Vercel' });
  if (!PUBLICAS.includes(key) && !autenticado(req)) return send(401, { error: 'Iniciá sesión' });
  try {
    if (!SIN_BASE.includes(key)) await preparar();
    const body = req.method === 'POST' ? await leerBody(req) : {};
    send(200, await route(body, url.searchParams, req, res));
  } catch (e) {
    if (e instanceof BadRequest) return send(e instanceof Conflict ? 409 : e instanceof SinUsuario ? 403 : e instanceof Demasiados ? 429 : 400, { error: e.message });
    if (String(e.message).includes('UNIQUE')) return send(400, { error: 'Ya existe uno con ese nombre' });
    console.error(e);
    // solo lo ven usuarios con sesión (los dueños): el detalle sirve para diagnosticar desde una captura
    send(500, { error: `No se pudo completar, probá de nuevo en unos segundos. (Detalle: ${e.message})` });
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const PORT = Number(process.env.PORT) || 3000;
  http.createServer(handler).listen(PORT, '127.0.0.1', () => console.log(`El Morterito en http://localhost:${PORT}`));
}
