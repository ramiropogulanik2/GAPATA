require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

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

const pedidos = [];
const adminTokens = new Map();
const loginAttempts = new Map();
const pedidosEnSheet = new Set();

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static('public'));

if (!ADMIN_PASSWORD) {
  console.warn('ADVERTENCIA: ADMIN_PASSWORD no esta definido. El panel admin quedara inaccesible.');
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

async function construirPedidoValido(body) {
  const nombreCliente = normalizarTexto(body.nombreCliente, 80);
  const telefonoCliente = normalizarTexto(body.telefonoCliente, 20);
  const items = Array.isArray(body.items) ? body.items : [];

  if (!nombreCliente || !validarTelefono(telefonoCliente) || items.length === 0 || items.length > 10) {
    throw new Error('Datos de pedido invalidos');
  }

  const productos = await obtenerProductosActivos();
  const itemsValidados = items.map((item) => validarItemPedido(item, productos));
  const total = itemsValidados.reduce((sum, item) => sum + item.precioUnitario, 0);

  return {
    nombreCliente,
    telefonoCliente,
    items: itemsValidados,
    total
  };
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

  return {
    cantidad,
    producto: `${producto.nombre} (${cantidad} personas)`,
    precioUnitario: producto.precios[indice]
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

  return [
    nombre,
    tipo,
    variantes.join('|'),
    precios.join('|'),
    fileteadoIncluido.join('|'),
    activo
  ];
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

app.post('/api/pedido', async (req, res) => {
  try {
    const pedidoValido = await construirPedidoValido(req.body);

    const id = uuidv4();
    const pedido = {
      id,
      ...pedidoValido,
      estado: 'pendiente',
      fechaCreacion: new Date().toISOString()
    };
    pedidos.push(pedido);
    limitarPedidosEnMemoria();
    await guardarEnSheet(pedido);

    const detalleItems = pedido.items
      .map((it) => `- ${it.cantidad} x ${it.producto} ($${it.precioUnitario})`)
      .join('\n');

    const linkConfirmacion = `${BASE_URL}/confirmar/${id}`;
    const nombreCliente = pedido.nombreCliente;
    const total = pedido.total;
    const telefonoCliente = pedido.telefonoCliente;

    const mensaje =
      `🛒 *Nuevo Pedido* de ${nombreCliente}:\n\n` +
      `${detalleItems}\n\n` +
      `*Total:* $${total}\n` +
      `*Teléfono:* ${telefonoCliente}\n\n` +
      `Confirmar pedido: ${linkConfirmacion}`;

    await enviarMensaje(NUMERO_DUENO, mensaje);

    res.json({ success: true, id });
  } catch (err) {
    console.error('Error procesando pedido:', err);
    res.status(500).json({ success: false, error: err.message });
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
      return res.send(`<h1>Pedido ya confirmado</h1><p>ID: ${pedido.id}</p><p>Cliente: ${escapeHtml(pedido.nombreCliente)}</p>`);
    }

    pedido.estado = 'confirmado';
    pedido.fechaConfirmacion = new Date().toISOString();

    await guardarEnSheet(pedido);
    pedidosEnSheet.add(id);

    res.send(`<h1>Pedido confirmado</h1><p>ID: ${pedido.id}</p><p>Cliente: ${escapeHtml(pedido.nombreCliente)}</p>`);
  } catch (err) {
    console.error('Error confirmando pedido:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoints Admin
app.get('/api/admin/session', verificarAdmin, (req, res) => {
  res.json({ success: true });
});

app.post('/api/admin/login', limitarLogin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
    }

    limpiarTokensExpirados();
    const token = uuidv4();
    const expiresAt = Date.now() + ADMIN_TOKEN_TTL_MS;
    adminTokens.set(token, expiresAt);

    res.cookie('admin_token', token, {
      httpOnly: true,
      maxAge: ADMIN_TOKEN_TTL_MS,
      sameSite: 'strict',
      secure: IS_PRODUCTION
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ success: false, error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reset-hojas', verificarAdmin, async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID
    });

    const deleteRequests = [];
    spreadsheet.data.sheets.forEach(sheet => {
      if (['Productos', 'Salsas'].includes(sheet.properties.title)) {
        deleteRequests.push({
          deleteSheet: { sheetId: sheet.properties.sheetId }
        });
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
    res.status(500).json({ error: err.message });
  }
});

const whatsappClient = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
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
  console.log("Intentando enviar a:", numero, "texto:", texto);
  try {
    const mensaje = await whatsappClient.sendMessage(chatId, texto);
    console.log(`Mensaje enviado a ${numero}`);
    return mensaje;
  } catch (err) {
    console.error("Error real de sendMessage:", err.message, err.stack);
    throw err;
  }
}

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
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID
    });

    const sheetExists = spreadsheet.data.sheets.some(s => s.properties.title === nombre);

    if (!sheetExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{
            addSheet: {
              properties: { title: nombre }
            }
          }]
        }
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
        requestBody: {
          values: toInsert
        }
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
  const datos = rows.slice(1);

  return datos.map(fila => {
    const obj = {};
    encabezados.forEach((encabezado, i) => {
      let valor = fila[i] || '';
      // Cleanup: si es campo de precios, remover todos los separadores de miles
      if (encabezado === 'precios' && typeof valor === 'string') {
        valor = valor.replace(/,/g, ''); // Remover todas las comas
      }
      obj[encabezado] = valor;
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

  const toInsert = [encabezados, ...filas];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${nombre}!A1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: toInsert
    }
  });
}

async function guardarEnSheet(pedido) {
  const encabezados = ['id', 'fechaCreacion', 'fechaConfirmacion', 'nombreCliente', 'telefonoCliente', 'items', 'total', 'estado'];
  await asegurarHoja(SHEET_NAME, encabezados, []);

  const sheets = await getSheetsClient();
  await asegurarEncabezadosPedido(sheets, encabezados);
  const row = pedidoToRow(pedido);
  const existente = await buscarPedidoEnSheet(pedido.id);

  if (existente) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${existente.rowNumber}:H${existente.rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:H`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  }

  console.log(`Pedido ${pedido.id} guardado en Sheets`);
}

function pedidoToRow(pedido) {
  return [
    pedido.id,
    pedido.fechaCreacion || '',
    pedido.fechaConfirmacion || '',
    pedido.nombreCliente,
    pedido.telefonoCliente,
    JSON.stringify(pedido.items),
    pedido.total,
    pedido.estado
  ];
}

async function asegurarEncabezadosPedido(sheets, encabezados) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:H1`,
    valueInputOption: 'RAW',
    requestBody: { values: [encabezados] }
  });
}

async function buscarPedidoEnSheet(id) {
  await asegurarHoja(SHEET_NAME, ['id', 'fechaCreacion', 'fechaConfirmacion', 'nombreCliente', 'telefonoCliente', 'items', 'total', 'estado'], []);

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:H`
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex((row, index) => index > 0 && row[0] === id);
  if (rowIndex === -1) return null;

  const row = rows[rowIndex];
  let items = [];
  try {
    items = JSON.parse(row[5] || '[]');
  } catch (err) {
    items = [];
  }

  return {
    rowNumber: rowIndex + 1,
    pedido: {
      id: row[0],
      fechaCreacion: row[1] || new Date().toISOString(),
      fechaConfirmacion: row[2] || '',
      nombreCliente: row[3] || '',
      telefonoCliente: row[4] || '',
      items,
      total: Number(row[6]) || 0,
      estado: row[7] || 'pendiente'
    }
  };
}

function escapeHtml(valor) {
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  whatsappClient.initialize();
});
