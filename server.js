const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

// El frontend y la API se sirven desde el mismo dominio HTTPS en Render.
// No es necesario habilitar CORS para sitios externos.
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render está detrás de un proxy HTTPS.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '10mb' }));

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET debe configurarse en Render con al menos 32 caracteres.');
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRES = '7d';

// Para Aiven, pegar el certificado CA en DB_SSL_CA (formato PEM completo).
// Se admite tanto un valor multilínea como uno con saltos escapados (\n).
if (IS_PRODUCTION && !process.env.DB_SSL_CA) {
  throw new Error('Falta DB_SSL_CA: configura el certificado CA de Aiven en Render.');
}
const dbCa = process.env.DB_SSL_CA?.replace(/\\n/g, '\n');
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pasalo',
  ...(dbCa ? { ssl: { ca: dbCa, rejectUnauthorized: true } } : {}),
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true
});

function sendServerError(err, res) {
  console.error('[Pásalo] Error interno:', err);
  res.status(500).json({ error: 'Error interno del servidor. Inténtalo nuevamente.' });
}

// Limita intentos de registro e inicio de sesión por IP en una instancia.
// Para mayor escala, migrar a limitación centralizada (por ejemplo Redis).
const loginAttempts = new Map();
function authRateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip;
  const last = loginAttempts.get(ip);
  if (!last || now > last.expires) {
    loginAttempts.set(ip, { count: 1, expires: now + 15 * 60 * 1000 });
  } else {
    last.count++;
    if (last.count > 30) {
      return res.status(429).json({ error: 'Demasiados intentos. Prueba más tarde.' });
    }
  }
  if (loginAttempts.size > 5000) {
    for (const [key, entry] of loginAttempts) {
      if (entry.expires < now) loginAttempts.delete(key);
    }
  }
  next();
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    console.error('[Pásalo] Base de datos no disponible:', err.message);
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

async function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado, falta el token' });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    const [rows] = await pool.query(
      'SELECT id, email, rol FROM usuarios WHERE id = ?', [payload.id]
    );
    if (!rows.length) return res.status(401).json({ error: 'Sesión inválida' });
    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }
    sendServerError(err, res);
  }
}

function adminRequired(req, res, next) {
  if (req.user.rol !== 'Admin') {
    return res.status(403).json({ error: 'Acceso denegado. Solo administradores.' });
  }
  next();
}

const isNonEmptyString = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// --- RUTAS PÚBLICAS ---
app.get('/api/categorias', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, nombre FROM categorias ORDER BY nombre ASC');
    res.json(rows);
  } catch (err) { sendServerError(err, res); }
});

app.get('/api/publicaciones', async (req, res) => {
  const { busqueda, categoria_id, tipo, precio_min, precio_max, orden } = req.query;
  let sql = `SELECT p.*, c.nombre AS categoria_nombre, u.nombre AS vendedor_nombre, u.reputacion 
             FROM publicaciones p JOIN categorias c ON p.categoria_id = c.id JOIN usuarios u ON p.usuario_id = u.id WHERE p.estado = 'Disponible'`;
  const params = [];
  if (busqueda) { sql += ' AND (p.titulo LIKE ? OR p.materia LIKE ?)'; params.push(`%${busqueda}%`, `%${busqueda}%`); }
  if (categoria_id) { sql += ' AND p.categoria_id = ?'; params.push(categoria_id); }
  if (tipo) { sql += ' AND p.tipo = ?'; params.push(tipo); }
  if (precio_min) { sql += ' AND p.precio >= ?'; params.push(precio_min); }
  if (precio_max) { sql += ' AND p.precio <= ?'; params.push(precio_max); }
  
  if (orden === 'menor_precio') sql += ' ORDER BY p.precio ASC';
  else if (orden === 'mayor_precio') sql += ' ORDER BY p.precio DESC';
  else sql += ' ORDER BY p.id DESC';
  
  try {
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { sendServerError(err, res); }
});

app.get('/api/publicaciones/destacadas', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.id, p.titulo, p.descripcion, p.precio, p.imagen, p.tipo, c.nombre AS categoria_nombre
      FROM publicaciones p
      JOIN categorias c ON p.categoria_id = c.id
      WHERE p.estado = 'Disponible' AND p.imagen IS NOT NULL AND p.imagen != ''
      ORDER BY p.id DESC
      LIMIT 3
    `);
    res.json(rows);
  } catch (err) { sendServerError(err, res); }
});

app.get('/api/publicaciones/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.*, c.nombre AS categoria_nombre, u.nombre AS vendedor_nombre, u.reputacion
      FROM publicaciones p JOIN categorias c ON p.categoria_id = c.id JOIN usuarios u ON p.usuario_id = u.id
      WHERE p.id = ?
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'No encontrada' });
    res.json(rows[0]);
  } catch (err) { sendServerError(err, res); }
});

// --- RUTAS DE AUTENTICACIÓN ---
app.post('/api/register', authRateLimit, async (req, res) => {
  const { nombre, email, password, carrera } = req.body || {};
  if (!isNonEmptyString(nombre, 100) || !isNonEmptyString(email, 150) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' || password.length < 8 || password.length > 128 ||
      (carrera != null && typeof carrera !== 'string')) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }

  try {
    const [exists] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [email.trim().toLowerCase()]);
    if (exists.length) return res.status(409).json({ error: 'El email ya está registrado' });

    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      'INSERT INTO usuarios (nombre, email, password_hash, carrera, verificado) VALUES (?, ?, ?, ?, TRUE)',
      [nombre.trim(), email.trim().toLowerCase(), hash, carrera || null]
    );

    const user = { id: result.insertId, nombre: nombre.trim(), email: email.trim().toLowerCase(), carrera, rol: 'Usuario' };
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.status(201).json({ success: true, usuario: user, token });
  } catch (err) { sendServerError(err, res); }
});

app.post('/api/login', authRateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!isNonEmptyString(email, 150) || typeof password !== 'string') {
    return res.status(400).json({ error: 'Correo y contraseña requeridos' });
  }
  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email.trim().toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Credenciales inválidas' });

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    delete user.password_hash;
    res.json({ success: true, usuario: user, token });
  } catch (err) { sendServerError(err, res); }
});

app.get('/api/me', authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, nombre, email, carrera, reputacion, avatar, rol FROM usuarios WHERE id = ?', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ usuario: rows[0] });
  } catch (err) { sendServerError(err, res); }
});

// --- RUTAS PROTEGIDAS (CRUD Publicaciones) ---
app.get('/api/mis-publicaciones', authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.*, c.nombre AS categoria_nombre FROM publicaciones p
      JOIN categorias c ON p.categoria_id = c.id WHERE p.usuario_id = ? ORDER BY p.id DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) { sendServerError(err, res); }
});

app.post('/api/publicaciones', authRequired, async (req, res) => {
  const { titulo, descripcion, precio, tipo, materia, carrera, categoria_id, imagen } = req.body;
  try {
    const [result] = await pool.query(
      `INSERT INTO publicaciones (usuario_id, titulo, descripcion, precio, tipo, materia, carrera, imagen, fecha, categoria_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?)`,
      [req.user.id, titulo, descripcion, precio || 0, tipo, materia, carrera, imagen || null, categoria_id]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) { sendServerError(err, res); }
});

app.put('/api/publicaciones/:id', authRequired, async (req, res) => {
  const { titulo, descripcion, precio, tipo, estado, imagen } = req.body;
  try {
    const [check] = await pool.query('SELECT usuario_id FROM publicaciones WHERE id = ?', [req.params.id]);
    if (!check.length) return res.status(404).json({ error: 'No encontrada' });
    
    if (check[0].usuario_id !== req.user.id && req.user.rol !== 'Admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    if (imagen) {
      await pool.query(
        `UPDATE publicaciones SET titulo=?, descripcion=?, precio=?, tipo=?, estado=?, imagen=? WHERE id=?`,
        [titulo, descripcion, precio || 0, tipo, estado, imagen, req.params.id]
      );
    } else {
      await pool.query(
        `UPDATE publicaciones SET titulo=?, descripcion=?, precio=?, tipo=?, estado=? WHERE id=?`,
        [titulo, descripcion, precio || 0, tipo, estado, req.params.id]
      );
    }
    res.json({ success: true });
  } catch (err) { sendServerError(err, res); }
});

app.delete('/api/publicaciones/:id', authRequired, async (req, res) => {
  try {
    const [check] = await pool.query('SELECT usuario_id FROM publicaciones WHERE id = ?', [req.params.id]);
    if (!check.length) return res.status(404).json({ error: 'No encontrada' });
    
    if (check[0].usuario_id !== req.user.id && req.user.rol !== 'Admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    await pool.query('DELETE FROM publicaciones WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { sendServerError(err, res); }
});

// --- RUTAS DE ADMIN ---
app.get('/api/admin/estadisticas', authRequired, adminRequired, async (req, res) => {
  try {
    const [usuarios] = await pool.query('SELECT COUNT(*) as total FROM usuarios');
    const [pubs] = await pool.query('SELECT COUNT(*) as total FROM publicaciones');
    const [msgs] = await pool.query('SELECT COUNT(*) as total FROM mensajes');
    res.json({ usuarios: usuarios[0].total, publicaciones: pubs[0].total, mensajes: msgs[0].total });
  } catch (err) { sendServerError(err, res); }
});

app.get('/api/admin/graficos', authRequired, adminRequired, async (req, res) => {
  try {
    const [categorias] = await pool.query(`
      SELECT c.nombre, COUNT(p.id) as cantidad
      FROM categorias c
      LEFT JOIN publicaciones p ON p.categoria_id = c.id
      GROUP BY c.id
      ORDER BY cantidad DESC
    `);

    const [actividad] = await pool.query(`
      SELECT DATE(fecha) as dia, COUNT(*) as cantidad
      FROM publicaciones
      WHERE fecha >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY DATE(fecha)
      ORDER BY dia ASC
    `);

    res.json({ categorias, actividad });
  } catch (err) { sendServerError(err, res); }
});

// --- MENSAJES Y NOTIFICACIONES ---
app.get('/api/mensajes', authRequired, async (req, res) => {
  const { publicacion_id } = req.query;
  try {
    const [rows] = await pool.query(`
      SELECT m.*, e.nombre AS emisor_nombre, r.nombre AS receptor_nombre
      FROM mensajes m JOIN usuarios e ON m.emisor_id = e.id JOIN usuarios r ON m.receptor_id = r.id
      WHERE m.publicacion_id = ? AND (m.emisor_id = ? OR m.receptor_id = ?) ORDER BY m.fecha ASC
    `, [publicacion_id, req.user.id, req.user.id]);
    res.json(rows);
  } catch (err) { sendServerError(err, res); }
});

app.post('/api/mensajes', authRequired, async (req, res) => {
  const { receptor_id, publicacion_id, contenido } = req.body;
  try {
    const [result] = await pool.query(
      'INSERT INTO mensajes (emisor_id, receptor_id, publicacion_id, contenido) VALUES (?, ?, ?, ?)',
      [req.user.id, receptor_id, publicacion_id, contenido]
    );
    
    await pool.query(
      'INSERT INTO notificaciones (usuario_id, mensaje) VALUES (?, ?)',
      [receptor_id, `Tienes un nuevo mensaje sobre un artículo.`]
    );

    res.json({ success: true, id: result.insertId });
  } catch (err) { sendServerError(err, res); }
});

app.get('/api/conversaciones', authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT p.id AS publicacion_id, p.titulo AS publicacion_titulo, u.id AS contacto_id, u.nombre AS contacto_nombre
      FROM mensajes m JOIN publicaciones p ON m.publicacion_id = p.id JOIN usuarios u ON u.id = IF(m.emisor_id = ?, m.receptor_id, m.emisor_id)
      WHERE m.emisor_id = ? OR m.receptor_id = ? ORDER BY p.id DESC
    `, [req.user.id, req.user.id, req.user.id]);
    res.json(rows);
  } catch (err) { sendServerError(err, res); }
});

// --- RUTAS DE RESEÑAS ---
app.get('/api/resenas/:vendedor_id', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT r.*, u.nombre AS comprador_nombre 
      FROM resenas r JOIN usuarios u ON r.usuario_id = u.id WHERE r.vendedor_id = ? ORDER BY r.fecha DESC
    `, [req.params.vendedor_id]);
    res.json(rows);
  } catch (err) { sendServerError(err, res); }
});

app.post('/api/resenas', authRequired, async (req, res) => {
  const { vendedor_id, publicacion_id, calificacion, comentario } = req.body;
  if (Number(req.user.id) === Number(vendedor_id)) {
    return res.status(400).json({ error: 'No puedes calificarte a ti mismo.' });
  }
  if (!Number.isInteger(Number(calificacion)) || Number(calificacion) < 1 || Number(calificacion) > 5) {
    return res.status(400).json({ error: 'La calificación debe ser de 1 a 5.' });
  }

  try {
    const [publicacion] = await pool.query('SELECT usuario_id FROM publicaciones WHERE id = ?', [publicacion_id]);
    if (!publicacion.length || Number(publicacion[0].usuario_id) !== Number(vendedor_id)) {
      return res.status(400).json({ error: 'El vendedor no coincide con la publicación.' });
    }
    await pool.query(
      'INSERT INTO resenas (usuario_id, vendedor_id, publicacion_id, calificacion, comentario) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, vendedor_id, publicacion_id, calificacion, comentario]
    );

    await pool.query(
      'INSERT INTO notificaciones (usuario_id, mensaje) VALUES (?, ?)',
      [vendedor_id, `Alguien te ha dejado una calificación de ${calificacion} estrellas.`]
    );

    const [promedio] = await pool.query('SELECT AVG(calificacion) AS nuevo_promedio FROM resenas WHERE vendedor_id = ?', [vendedor_id]);
    const nuevoPromedio = promedio[0].nuevo_promedio || 0;
    await pool.query('UPDATE usuarios SET reputacion = ? WHERE id = ?', [nuevoPromedio.toFixed(1), vendedor_id]);

    res.json({ success: true, nueva_reputacion: nuevoPromedio.toFixed(1) });
  } catch (err) { sendServerError(err, res); }
});

// --- RUTA PARA EL PERFIL PÚBLICO (CORREGIDA CON AVATAR) ---
app.get('/api/usuarios/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, nombre, carrera, reputacion, verificado, avatar FROM usuarios WHERE id = ?',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (err) { sendServerError(err, res); }
});

// --- RUTAS DE FAVORITOS ---
app.get('/api/favoritos', authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.*, c.nombre AS categoria_nombre, u.nombre AS vendedor_nombre, u.reputacion
      FROM favoritos f JOIN publicaciones p ON f.publicacion_id = p.id
      JOIN categorias c ON p.categoria_id = c.id JOIN usuarios u ON p.usuario_id = u.id
      WHERE f.usuario_id = ? ORDER BY f.fecha DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) { sendServerError(err, res); }
});

app.post('/api/favoritos/:publicacion_id', authRequired, async (req, res) => {
  const pubId = req.params.publicacion_id;
  try {
    const [exists] = await pool.query('SELECT id FROM favoritos WHERE usuario_id = ? AND publicacion_id = ?', [req.user.id, pubId]);
    if (exists.length > 0) {
      await pool.query('DELETE FROM favoritos WHERE usuario_id = ? AND publicacion_id = ?', [req.user.id, pubId]);
      res.json({ success: true, action: 'removed' });
    } else {
      await pool.query('INSERT INTO favoritos (usuario_id, publicacion_id) VALUES (?, ?)', [req.user.id, pubId]);
      res.json({ success: true, action: 'added' });
    }
  } catch (err) { sendServerError(err, res); }
});

app.get('/api/favoritos/ids', authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT publicacion_id FROM favoritos WHERE usuario_id = ?', [req.user.id]);
    res.json(rows.map(r => r.publicacion_id));
  } catch (err) { sendServerError(err, res); }
});

// --- RUTAS DE NOTIFICACIONES ---
app.get('/api/notificaciones', authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM notificaciones WHERE usuario_id = ? AND leida = FALSE ORDER BY fecha DESC LIMIT 10',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { sendServerError(err, res); }
});

app.put('/api/notificaciones/leer', authRequired, async (req, res) => {
  try {
    await pool.query('UPDATE notificaciones SET leida = TRUE WHERE usuario_id = ?', [req.user.id]);
    res.json({ success: true });
  } catch (err) { sendServerError(err, res); }
});

// --- RUTA PARA CERRAR TRATO ---
app.put('/api/publicaciones/:id/vender', authRequired, async (req, res) => {
  // La web también puede cerrar trato sin enviar cuerpo en la petición PUT.
  const { comprador_id } = req.body || {};
  try {
    const [check] = await pool.query('SELECT usuario_id, titulo, precio FROM publicaciones WHERE id = ?', [req.params.id]);
    if (!check.length) return res.status(404).json({ error: 'No encontrada' });
    
    if (check[0].usuario_id !== req.user.id && req.user.rol !== 'Admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    await pool.query(
      "UPDATE publicaciones SET estado = 'Vendida', comprador_id = ? WHERE id = ?", 
      [comprador_id || null, req.params.id]
    );
    
    let nombreComprador = "Comprador no registrado";
    if (comprador_id) {
      const [comprador] = await pool.query('SELECT nombre FROM usuarios WHERE id = ?', [comprador_id]);
      if (comprador.length) nombreComprador = comprador[0].nombre;
    }

    res.json({ 
      success: true, 
      boleta: {
        articulo: check[0].titulo,
        precio: check[0].precio,
        comprador: nombreComprador,
        fecha: new Date().toLocaleDateString()
      }
    });
  } catch (err) { sendServerError(err, res); }
});

// --- RUTAS DE PERFIL ---
app.put('/api/perfil', authRequired, async (req, res) => {
  const { nombre, carrera, avatar } = req.body;
  try {
    if (avatar) {
      await pool.query(
        'UPDATE usuarios SET nombre = ?, carrera = ?, avatar = ? WHERE id = ?',
        [nombre, carrera, avatar, req.user.id]
      );
    } else {
      await pool.query(
        'UPDATE usuarios SET nombre = ?, carrera = ? WHERE id = ?',
        [nombre, carrera, req.user.id]
      );
    }
    res.json({ success: true });
  } catch (err) { sendServerError(err, res); }
});

app.put('/api/perfil/password', authRequired, async (req, res) => {
  const { password_actual, password_nueva } = req.body;
  
  if (!password_nueva || password_nueva.length < 8) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
  }

  try {
    const [rows] = await pool.query('SELECT password_hash FROM usuarios WHERE id = ?', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const ok = await bcrypt.compare(password_actual, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'La contraseña actual es incorrecta.' });

    const nuevoHash = await bcrypt.hash(password_nueva, 12);
    await pool.query('UPDATE usuarios SET password_hash = ? WHERE id = ?', [nuevoHash, req.user.id]);

    res.json({ success: true, message: 'Contraseña actualizada correctamente.' });
  } catch (err) { sendServerError(err, res); }
});

// --- RUTA PARA EL DASHBOARD ---
app.get('/api/dashboard', authRequired, async (req, res) => {
  try {
    const [ventas] = await pool.query(
      "SELECT SUM(precio) as total_ganado, COUNT(*) as num_ventas FROM publicaciones WHERE usuario_id = ? AND estado = 'Vendida'",
      [req.user.id]
    );
    const [enVenta] = await pool.query(
      "SELECT COUNT(*) as num_activas FROM publicaciones WHERE usuario_id = ? AND estado = 'Disponible'",
      [req.user.id]
    );
    const [mensajes] = await pool.query(
      "SELECT COUNT(*) as num_mensajes FROM mensajes WHERE receptor_id = ?",
      [req.user.id]
    );
    const [categorias] = await pool.query(`
      SELECT c.nombre, COUNT(*) as cantidad
      FROM publicaciones p JOIN categorias c ON p.categoria_id = c.id
      WHERE p.usuario_id = ? AND p.estado = 'Vendida' GROUP BY c.nombre
    `, [req.user.id]);

    res.json({
      ganado: ventas[0].total_ganado || 0,
      ventas: ventas[0].num_ventas || 0,
      activas: enVenta[0].num_activas || 0,
      mensajes: mensajes[0].num_mensajes || 0,
      categorias: categorias
    });
  } catch (err) { sendServerError(err, res); }
});

// Recuperación pendiente de correo verificado y token temporal seguro.
// No hacer restablecimiento basado únicamente en correo y carrera.
app.post('/api/recuperar-password', (_req, res) => {
  res.status(501).json({
    error: 'La recuperación automática todavía no está disponible. Contacta al administrador del sitio.'
  });
});

// --- RUTAS DE PREGUNTAS Y RESPUESTAS ---
app.get('/api/preguntas/:publicacion_id', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.*, u.nombre AS comprador_nombre 
      FROM preguntas p
      JOIN usuarios u ON p.usuario_id = u.id
      WHERE p.publicacion_id = ?
      ORDER BY p.fecha_pregunta DESC
    `, [req.params.publicacion_id]);
    res.json(rows);
  } catch (err) { sendServerError(err, res); }
});

app.post('/api/preguntas', authRequired, async (req, res) => {
  const { publicacion_id, pregunta } = req.body;
  if (!pregunta || pregunta.trim().length === 0) return res.status(400).json({ error: 'La pregunta no puede estar vacía.' });
  
  try {
    const [result] = await pool.query(
      'INSERT INTO preguntas (publicacion_id, usuario_id, pregunta) VALUES (?, ?, ?)',
      [publicacion_id, req.user.id, pregunta.trim()]
    );

    const [pub] = await pool.query('SELECT usuario_id FROM publicaciones WHERE id = ?', [publicacion_id]);
    if (pub.length > 0) {
      const vendedorId = pub[0].usuario_id;
      await pool.query(
        'INSERT INTO notificaciones (usuario_id, mensaje) VALUES (?, ?)',
        [vendedorId, `Alguien ha hecho una pregunta sobre tu artículo.`]
      );
    }

    res.json({ success: true, id: result.insertId });
  } catch (err) { sendServerError(err, res); }
});

app.put('/api/preguntas/:id/responder', authRequired, async (req, res) => {
  const { respuesta, publicacion_id } = req.body;
  
  try {
    const [check] = await pool.query('SELECT usuario_id FROM publicaciones WHERE id = ?', [publicacion_id]);
    if (check.length === 0 || check[0].usuario_id !== req.user.id) {
      return res.status(403).json({ error: 'Solo el dueño del artículo puede responder.' });
    }

    if (!isNonEmptyString(respuesta, 5000)) {
      return res.status(400).json({ error: 'La respuesta no es válida.' });
    }
    const [result] = await pool.query(
      'UPDATE preguntas SET respuesta = ? WHERE id = ? AND publicacion_id = ?',
      [respuesta.trim(), req.params.id, publicacion_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Pregunta no encontrada.' });
    res.json({ success: true });
  } catch (err) { sendServerError(err, res); }
});

// Servir las páginas originales y sus recursos sin exponer el backend ni .env.
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor Pásalo escuchando en puerto ${PORT}`);
});