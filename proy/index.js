require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const GOOGLE_CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Pedidos';
const NUMERO_TEST = process.env.NUMERO_TEST || '5493516622633';
const NUMERO_DUENO = process.env.NUMERO_DUENO || '5493516622633';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PEDIDOS_EN_MEMORIA = 500;

const ENCABEZADOS_PEDIDO = ['ID', 'Fecha', 'Cliente', 'Teléfono', 'Tipo', 'Personas', 'Precio', 'Fileteado', 'Salsas', 'Total', 'Estado'];

const pedidos = [];
const adminTokens = new Map();
const loginAttempts = new Map();
const pedidoAttempts = new Map();
const pedidosEnSheet = new Set();

const app = express();
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-origin' } }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static('public'));

if (!ADMIN_PASSWORD) {
  console.warn('ADVERTENCIA: ADMIN_PASSWORD no esta definido. El panel admin quedara inaccesible.');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generarId() {
  const d = new Date();
  const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let sufijo = '';
  for (let i = 0; i < 4; i++) {
    sufijo += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${yyyymmdd}-${sufijo}`;
}

function fechaArgentina(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) return String(dateInput || '');
  try {
    const fmt = new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Cordoba',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = {};
    fmt.formatToParts(d).forEach(({ type, value }) => { parts[type] = value; });
    return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
  } catch {
    return d.toLocaleString('es-AR');
  }
}

function verificarAdmin(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  const exp = adminTokens.get(token);
  if (!exp || Date.now() > exp) {
    adminTokens.delete(token);
    return res.status(401).json({ error: 'Token expirado' });
  }
  next();
}

function limpiarTokensExpirados() {
  const ahora = Date.now();
  adminTokens.forEach((exp, token) => {
    if (ahora > exp) adminTokens.delete(token);
  });
}

function limitarLogin(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const ahora = Date.now();
  const ventanaMs = 15 * 60 * 1000;
  const maxIntentos = 8;
  const registro = loginAttempts.get(ip) || { count: 0, firstAttempt: ahora };

  if (ahora - registro.firstAttempt > ventanaMs) {
    loginAttempts.set(ip, { count: 1, firstAttempt: ahora });
    return next();
  }

  if (registro.count >= maxIntentos) {
    return res.status(429).json({ success: false, error: 'Demasiados intentos. Proba de nuevo en unos minutos.' });
  }

  registro.count += 1;
  loginAttempts.set(ip, registro);
  next();
}

function limitarPedidos(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const ahora = Date.now();
  const ventanaMs = 60 * 60 * 1000;
  const maxPedidos = 10;
  const registro = pedidoAttempts.get(ip) || { count: 0, firstAttempt: ahora };

  if (ahora - registro.firstAttempt > ventanaMs) {
    pedidoAttempts.set(ip, { count: 1, firstAttempt: ahora });
    return next();
  }

  if (registro.count >= maxPedidos) {
    return res.status(429).json({ success: false, error: 'Demasiados pedidos. Intentá más tarde.' });
  }

  registro.count += 1;
  pedidoAttempts.set(ip, registro);
  next();
}

function validarTelefono(telefono) {
  return typeof telefono === 'string' && /^[0-9+\s()-]{8,20}$/.test(telefono.trim());
}

function normalizarTexto(valor, maxLength) {
  if (typeof valor !== 'string') return '';
  return valor.trim().slice(0, maxLength);
}

function parseListaNumerica(valor) {
  return String(valor || '')
    .split('|')
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

function parseListaIndices(valor) {
  return String(valor || '')
    .split('|')
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

function limitarPedidosEnMemoria() {
  while (pedidos.length > MAX_PEDIDOS_EN_MEMORIA) {
    pedidos.shift();
  }
}

function escapeHtml(valor) {
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderConfirmacion(pedido, yaConfirmado) {
  const item = pedido.items[0] || {};
  const tipo = item.tipo === 'cerdo' ? 'Cerdo' : 'Vaca';
  const emoji = item.tipo === 'cerdo' ? '🐷' : '🐮';
  const fileteado = item.tieneFileteado ? 'Sí' : 'No';
  const salsasTexto = (pedido.salsas || []).length > 0
    ? escapeHtml((pedido.salsas || []).join(', '))
    : '';
  const total = '$' + (pedido.total || 0).toLocaleString('es-AR');

  const icono = yaConfirmado ? '○' : '✓';
  const iconoBg = yaConfirmado ? 'rgba(255,208,0,0.2)' : '#FFD000';
  const iconoColor = yaConfirmado ? '#FFD000' : '#1A1A1A';
  const titulo = yaConfirmado ? 'YA CONFIRMADO' : 'PEDIDO CONFIRMADO';
  const subtitulo = yaConfirmado
    ? 'Este pedido ya fue confirmado anteriormente'
    : 'El pedido fue registrado correctamente';
  const tituloColor = yaConfirmado ? 'rgba(255,255,255,0.55)' : '#FFFFFF';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(titulo)} — GAPATA</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #1A1A1A;
      color: #FFFFFF;
      font-family: 'Oswald', 'Arial Narrow', Arial, sans-serif;
      min-height: 100vh;
    }
    .header {
      background: #FFD000;
      padding: 16px 24px;
      text-align: center;
    }
    .header-brand {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 6px;
      color: #1A1A1A;
      text-transform: uppercase;
    }
    .header-sub {
      font-size: 10px;
      font-weight: 300;
      letter-spacing: 4px;
      color: #1A1A1A;
      opacity: 0.7;
      margin-top: 2px;
    }
    .main {
      max-width: 480px;
      margin: 0 auto;
      padding: 40px 20px;
      text-align: center;
    }
    .icono {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: ${iconoBg};
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 28px;
      font-size: 38px;
      line-height: 1;
      color: ${iconoColor};
    }
    .titulo {
      font-size: 32px;
      font-weight: 700;
      letter-spacing: 4px;
      text-transform: uppercase;
      color: ${tituloColor};
      margin-bottom: 8px;
    }
    .subtitulo {
      font-size: 13px;
      font-weight: 300;
      letter-spacing: 1px;
      color: rgba(255,255,255,0.45);
      margin-bottom: 36px;
    }
    .card {
      border: 1.5px solid #FFD000;
      border-radius: 4px;
      text-align: left;
      overflow: hidden;
    }
    .card-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 14px 20px;
      border-bottom: 1px solid rgba(255,208,0,0.12);
      gap: 16px;
    }
    .card-label {
      font-size: 10px;
      font-weight: 400;
      letter-spacing: 2px;
      color: rgba(255,255,255,0.45);
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .card-valor {
      font-size: 14px;
      font-weight: 500;
      color: #FFFFFF;
      text-align: right;
    }
    .card-total {
      background: #FFD000;
      padding: 18px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card-total-label {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 3px;
      color: #1A1A1A;
      text-transform: uppercase;
    }
    .card-total-valor {
      font-size: 24px;
      font-weight: 700;
      color: #1A1A1A;
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-brand">GAPATA</div>
    <div class="header-sub">PATAS PREMIUM · DESDE 2017</div>
  </header>
  <main class="main">
    <div class="icono">${icono}</div>
    <h1 class="titulo">${escapeHtml(titulo)}</h1>
    <p class="subtitulo">${escapeHtml(subtitulo)}</p>
    <div class="card">
      <div class="card-row">
        <span class="card-label">ID</span>
        <span class="card-valor">${escapeHtml(pedido.id)}</span>
      </div>
      <div class="card-row">
        <span class="card-label">Cliente</span>
        <span class="card-valor">${escapeHtml(pedido.nombreCliente)}</span>
      </div>
      <div class="card-row">
        <span class="card-label">Producto</span>
        <span class="card-valor">${escapeHtml(emoji + ' ' + tipo + ' · ' + (item.cantidad || '') + ' personas')}</span>
      </div>
      <div class="card-row">
        <span class="card-label">Fileteado</span>
        <span class="card-valor">${escapeHtml(fileteado)}</span>
      </div>
      ${salsasTexto ? `<div class="card-row">
        <span class="card-label">Salsas</span>
        <span class="card-valor">${salsasTexto}</span>
      </div>` : ''}
      <div class="card-total">
        <span class="card-total-label">Total</span>
        <span class="card-total-valor">${escapeHtml(total)}</span>
      </div>
    </div>
  </main>
</body>
</html>`;
}

// ─── Validación de pedidos ───────────────────────────────────────────────────

async function construirPedidoValido(body) {
  const nombreCliente = normalizarTexto(body.nombreCliente, 80);
  const telefonoCliente = normalizarTexto(body.telefonoCliente, 20);
  const items = Array.isArray(body.items) ? body.items : [];
  const salsas = Array.isArray(body.salsas)
    ? body.salsas.map(s => normalizarTexto(s, 80)).filter(Boolean).slice(0, 20)
    : [];

  if (!nombreCliente || !validarTelefono(telefonoCliente) || items.length === 0 || items.length > 10) {
    throw new Error('Datos de pedido invalidos');
  }

  const productos = await obtenerProductosActivos();
  const itemsValidados = items.map((item) => validarItemPedido(item, productos));
  const total = itemsValidados.reduce((sum, item) => sum + item.precioUnitario + item.costoFileteado, 0);

  return { nombreCliente, telefonoCliente, items: itemsValidados, salsas, total };
}

function validarItemPedido(item, productos) {
  const cantidad = Number(item?.cantidad);
  const productoTexto = normalizarTexto(item?.producto, 120);
  const producto = productos.find((prod) => productoTexto.startsWith(`${prod.nombre} (`));

  if (!producto || !Number.isFinite(cantidad)) {
    throw new Error('Producto invalido');
  }

  const indice = producto.personas.findIndex((personas) => personas === cantidad);
  if (indice === -1 || producto.precios[indice] == null) {
    throw new Error('Variante invalida');
  }

  const tieneFileteado = item.tieneFileteado === true;
  const fileteadoEsGratis = producto.fileteadoGratis.includes(indice);
  const costoFileteado = (tieneFileteado && !fileteadoEsGratis) ? cantidad * 100 : 0;

  return {
    cantidad,
    producto: `${producto.nombre} (${cantidad} personas)`,
    tipo: producto.tipo,
    precioUnitario: producto.precios[indice],
    tieneFileteado,
    costoFileteado
  };
}

async function obtenerProductosActivos() {
  await asegurarHoja('Productos',
    ['nombre', 'tipo', 'variantes', 'precios', 'fileteadoIncluido', 'activo'],
    [
      ['Cerdo', 'cerdo', '10|15|20|25|30|40|50|100', '99000|130000|164000|195000|225000|282000|335000|655000', '0|1', 'true'],
      ['Vaca', 'vaca', '10|15|20|25|30|40|50|100', '150000|198000|245000|295000|345000|440000|530000|1030000', '0|1|2|3|4|5|6|7', 'true']
    ]
  );

  const productos = await leerHoja('Productos');
  return productos
    .filter((producto) => producto.activo === 'true' || producto.activo === true)
    .map((producto) => ({
      nombre: normalizarTexto(producto.nombre, 80),
      tipo: normalizarTexto(producto.tipo, 40),
      variantes: producto.variantes,
      preciosTexto: producto.precios,
      fileteadoIncluido: producto.fileteadoIncluido,
      activo: producto.activo,
      personas: parseListaNumerica(producto.variantes),
      precios: parseListaNumerica(producto.precios),
      fileteadoGratis: parseListaIndices(producto.fileteadoIncluido)
    }))
    .filter((producto) => producto.nombre && producto.tipo && producto.personas.length === producto.precios.length);
}

function normalizarProductoAdmin(producto) {
  const nombre = normalizarTexto(producto?.nombre, 80);
  const tipo = normalizarTexto(producto?.tipo, 40);
  const variantes = parseListaNumerica(producto?.variantes);
  const precios = parseListaNumerica(producto?.precios);
  const fileteadoIncluido = parseListaIndices(producto?.fileteadoIncluido)
    .filter((indice) => indice < variantes.length);
  const activo = producto?.activo === true || producto?.activo === 'true' ? 'true' : 'false';

  if (!nombre || !tipo || variantes.length === 0 || variantes.length !== precios.length) {
    throw new Error('Producto invalido');
  }

  return [nombre, tipo, variantes.join('|'), precios.join('|'), fileteadoIncluido.join('|'), activo];
}

function normalizarSalsaAdmin(salsa) {
  const nombre = normalizarTexto(salsa?.nombre, 80);
  const imagen = normalizarTexto(salsa?.imagen, 120);
  const activo = salsa?.activo === true || salsa?.activo === 'true' ? 'true' : 'false';

  if (!nombre || !/^[a-z0-9._-]+\.svg$/i.test(imagen)) {
    throw new Error('Salsa invalida');
  }

  return [nombre, imagen, activo];
}

// ─── Rutas API ───────────────────────────────────────────────────────────────

app.post('/api/pedido', limitarPedidos, async (req, res) => {
  try {
    const pedidoValido = await construirPedidoValido(req.body);

    const id = generarId();
    const pedido = {
      id,
      ...pedidoValido,
      estado: 'pendiente',
      fechaCreacion: new Date().toISOString()
    };
    pedidos.push(pedido);
    limitarPedidosEnMemoria();
    await guardarEnSheet(pedido);

    const item = pedido.items[0] || {};
    const emoji = item.tipo === 'cerdo' ? '🐷' : '🐮';
    const tipoNombre = item.tipo ? (item.tipo.charAt(0).toUpperCase() + item.tipo.slice(1)) : 'Pata';
    const fileteadoLinea = item.tieneFileteado
      ? (item.costoFileteado > 0
          ? `\n🔪 *Fileteado:* +$${item.costoFileteado.toLocaleString('es-AR')}`
          : '\n🔪 *Fileteado:* Incluido gratis')
      : '';
    const salsasTexto = pedido.salsas.length > 0
      ? `\n🥫 *Salsas:* ${pedido.salsas.join(', ')}`
      : '';

    const linkConfirmacion = `${BASE_URL}/confirmar/${id}`;
    const mensaje =
      `🛒 *Nuevo Pedido* de ${pedido.nombreCliente}\n\n` +
      `${emoji} *${tipoNombre}* (${item.cantidad} personas): $${item.precioUnitario.toLocaleString('es-AR')}` +
      fileteadoLinea +
      salsasTexto +
      `\n\n*Total: $${pedido.total.toLocaleString('es-AR')}*` +
      `\n*Teléfono:* ${pedido.telefonoCliente}\n\n` +
      `Confirmar pedido: ${linkConfirmacion}`;

    await enviarMensaje(NUMERO_DUENO, mensaje);

    res.json({ success: true, id });
  } catch (err) {
    console.error('Error procesando pedido:', err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

app.get('/confirmar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let pedido = pedidos.find((p) => p.id === id);

    if (!pedido) {
      const encontrado = await buscarPedidoEnSheet(id);
      pedido = encontrado?.pedido;
      if (pedido) {
        pedidos.push(pedido);
        limitarPedidosEnMemoria();
      }
    }

    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    if (pedido.estado === 'confirmado' || pedidosEnSheet.has(id)) {
      return res.send(renderConfirmacion(pedido, true));
    }

    pedido.estado = 'confirmado';
    pedido.fechaConfirmacion = new Date().toISOString();

    await guardarEnSheet(pedido);
    pedidosEnSheet.add(id);

    res.send(renderConfirmacion(pedido, false));
  } catch (err) {
    console.error('Error confirmando pedido:', err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ─── Rutas Admin ─────────────────────────────────────────────────────────────

app.get('/api/admin/session', verificarAdmin, (req, res) => {
  res.json({ success: true });
});

app.post('/api/admin/login', limitarLogin, async (req, res) => {
  try {
    console.log('[admin/login] intento desde IP:', req.ip);
    const { password } = req.body;
    console.log('[admin/login] ADMIN_PASSWORD configurado:', !!ADMIN_PASSWORD);
    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
      console.log('[admin/login] contraseña incorrecta');
      return res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
    }

    limpiarTokensExpirados();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + ADMIN_TOKEN_TTL_MS;
    adminTokens.set(token, expiresAt);

    res.cookie('admin_token', token, {
      httpOnly: true,
      maxAge: ADMIN_TOKEN_TTL_MS,
      sameSite: 'strict',
      secure: IS_PRODUCTION
    });

    console.log('[admin/login] login exitoso');
    res.json({ success: true });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

app.post('/api/admin/logout', verificarAdmin, (req, res) => {
  const token = req.cookies?.admin_token;
  if (token) adminTokens.delete(token);
  res.clearCookie('admin_token', { sameSite: 'strict', secure: IS_PRODUCTION });
  res.json({ success: true });
});

app.get('/api/productos', async (req, res) => {
  try {
    await asegurarHoja('Productos',
      ['nombre', 'tipo', 'variantes', 'precios', 'fileteadoIncluido', 'activo'],
      [
        ['Cerdo', 'cerdo', '10|15|20|25|30|40|50|100', '99000|130000|164000|195000|225000|282000|335000|655000', '0|1', 'true'],
        ['Vaca', 'vaca', '10|15|20|25|30|40|50|100', '150000|198000|245000|295000|345000|440000|530000|1030000', '0|1|2|3|4|5|6|7', 'true']
      ]
    );
    const productos = await leerHoja('Productos');
    res.json(productos);
  } catch (err) {
    console.error('Error leyendo productos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/salsas', async (req, res) => {
  try {
    await asegurarHoja('Salsas',
      ['nombre', 'imagen', 'activo'],
      [
        ['Mayonesa Casera', 'mayonesa-casera.svg', 'true'],
        ['Mayonesa con Ajo', 'mayonesa-con-ajo.svg', 'true'],
        ['Gapanesa', 'gapanesa.svg', 'true'],
        ['Palta', 'palta.svg', 'true'],
        ['Ahumadita', 'ahumadita.svg', 'true'],
        ['Criolla', 'criolla.svg', 'true'],
        ['Garbanzos', 'garbanzos.svg', 'true'],
        ['Chimi', 'chimi.svg', 'true'],
        ['Cebolla Caramelizada', 'cebolla-caramelizada.svg', 'true']
      ]
    );
    const salsas = await leerHoja('Salsas');
    res.json(salsas);
  } catch (err) {
    console.error('Error leyendo salsas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.put('/api/admin/productos', verificarAdmin, async (req, res) => {
  try {
    const productos = req.body;
    if (!Array.isArray(productos)) {
      return res.status(400).json({ error: 'Datos inválidos' });
    }
    const filas = productos.map(normalizarProductoAdmin);
    await escribirHoja('Productos', filas);
    res.json({ success: true });
  } catch (err) {
    console.error('Error guardando productos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.put('/api/admin/salsas', verificarAdmin, async (req, res) => {
  try {
    const salsas = req.body;
    if (!Array.isArray(salsas)) {
      return res.status(400).json({ error: 'Datos inválidos' });
    }
    const filas = salsas.map(normalizarSalsaAdmin);
    await escribirHoja('Salsas', filas);
    res.json({ success: true });
  } catch (err) {
    console.error('Error guardando salsas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/admin/reset-hojas', verificarAdmin, async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });

    const deleteRequests = [];
    spreadsheet.data.sheets.forEach(sheet => {
      if (['Productos', 'Salsas'].includes(sheet.properties.title)) {
        deleteRequests.push({ deleteSheet: { sheetId: sheet.properties.sheetId } });
      }
    });

    if (deleteRequests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: deleteRequests }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error reseteando hojas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── WhatsApp ────────────────────────────────────────────────────────────────

const whatsappClient = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

whatsappClient.on('qr', (qr) => {
  console.log('Escaneá el siguiente código QR con WhatsApp:');
  qrcode.generate(qr, { small: true });
});

whatsappClient.on('authenticated', () => {
  console.log('WhatsApp autenticado correctamente');
});

whatsappClient.on('auth_failure', (msg) => {
  console.error('Falló la autenticación de WhatsApp:', msg);
});

whatsappClient.on('ready', async () => {
  console.log('Cliente de WhatsApp listo y conectado');
  try {
    await enviarMensaje(NUMERO_TEST, 'Hola, mensaje de prueba desde el bot');
  } catch (err) {
    console.error('Error en el envío de prueba:', err.message);
  }
});

whatsappClient.on('disconnected', (reason) => {
  console.log('WhatsApp desconectado:', reason);
});

async function enviarMensaje(numero, texto) {
  const chatId = `${numero}@c.us`;
  console.log('Intentando enviar a:', numero, 'texto:', texto);
  try {
    const mensaje = await whatsappClient.sendMessage(chatId, texto);
    console.log(`Mensaje enviado a ${numero}`);
    return mensaje;
  } catch (err) {
    console.error('Error real de sendMessage:', err.message, err.stack);
    throw err;
  }
}

// ─── Google Sheets ────────────────────────────────────────────────────────────

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

async function asegurarHoja(nombre, encabezados, datosIniciales) {
  const sheets = await getSheetsClient();

  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetExists = spreadsheet.data.sheets.some(s => s.properties.title === nombre);

    if (!sheetExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: nombre } } }] }
      });
    }

    const existingData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${nombre}!A1:Z1000`
    });

    if (!existingData.data.values || existingData.data.values.length === 0) {
      const toInsert = [encabezados, ...datosIniciales];
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${nombre}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: toInsert }
      });
    }
  } catch (err) {
    console.error(`Error asegurando hoja ${nombre}:`, err);
    throw err;
  }
}

async function leerHoja(nombre) {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${nombre}!A:Z`
  });

  const rows = response.data.values || [];
  if (rows.length === 0) return [];

  const encabezados = rows[0];
  return rows.slice(1).map(fila => {
    const obj = {};
    encabezados.forEach((enc, i) => {
      let valor = fila[i] || '';
      if (enc === 'precios' && typeof valor === 'string') {
        valor = valor.replace(/,/g, '');
      }
      obj[enc] = valor;
    });
    return obj;
  });
}

async function escribirHoja(nombre, filas) {
  const sheets = await getSheetsClient();
  const existingData = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${nombre}!A1:Z1000`
  });

  const encabezados = existingData.data.values ? existingData.data.values[0] : [];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${nombre}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [encabezados, ...filas] }
  });
}

function pedidoToRow(pedido) {
  const item = pedido.items[0] || {};
  const tipo = item.tipo ? (item.tipo.charAt(0).toUpperCase() + item.tipo.slice(1)) : '';
  const fileteadoTexto = item.tieneFileteado ? 'Sí' : 'No';

  return [
    pedido.id,
    fechaArgentina(pedido.fechaCreacion),
    pedido.nombreCliente,
    pedido.telefonoCliente,
    tipo,
    item.cantidad || '',
    item.precioUnitario || '',
    fileteadoTexto,
    (pedido.salsas || []).join(', '),
    pedido.total,
    pedido.estado
  ];
}

async function guardarEnSheet(pedido) {
  await asegurarHoja(SHEET_NAME, ENCABEZADOS_PEDIDO, []);

  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:K1`,
    valueInputOption: 'RAW',
    requestBody: { values: [ENCABEZADOS_PEDIDO] }
  });

  const row = pedidoToRow(pedido);
  const existente = await buscarPedidoEnSheet(pedido.id);

  if (existente) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${existente.rowNumber}:K${existente.rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:K`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  }

  console.log(`Pedido ${pedido.id} guardado en Sheets`);
}

async function buscarPedidoEnSheet(id) {
  await asegurarHoja(SHEET_NAME, ENCABEZADOS_PEDIDO, []);

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:K`
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex((row, index) => index > 0 && row[0] === id);
  if (rowIndex === -1) return null;

  const row = rows[rowIndex];
  const tieneFileteado = row[7] === 'Sí' || row[7] === 'Incluido';
  const tipo = (row[4] || '').toLowerCase();

  return {
    rowNumber: rowIndex + 1,
    pedido: {
      id: row[0],
      fechaCreacion: row[1] || '',
      fechaConfirmacion: '',
      nombreCliente: row[2] || '',
      telefonoCliente: row[3] || '',
      items: [{
        tipo,
        cantidad: Number(row[5]) || 0,
        precioUnitario: Number(row[6]) || 0,
        tieneFileteado,
        producto: `${row[4] || ''} (${row[5] || ''} personas)`
      }],
      salsas: row[8] ? row[8].split(', ').filter(Boolean) : [],
      total: Number(row[9]) || 0,
      estado: row[10] || 'pendiente'
    }
  };
}

// ─── Servidor ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  whatsappClient.initialize();
});
