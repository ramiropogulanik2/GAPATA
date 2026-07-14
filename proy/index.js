/* dotenv: lee el archivo .env en la raíz del proyecto y carga cada clave como
   variable de entorno accesible via process.env. Debe ser el primer require para
   que las demás librerías ya vean las variables al inicializarse. */
require('dotenv').config();

/* crypto: módulo nativo de Node.js (no necesita instalarse). Se usa para generar
   tokens de sesión del admin con bytes aleatorios criptográficamente seguros. */
const crypto = require('crypto');

/* express: framework web minimalista. Gestiona el servidor HTTP, las rutas (GET,
   POST, PUT) y los middlewares que procesan cada request/response. */
const express = require('express');

/* helmet: middleware que agrega cabeceras HTTP de seguridad automáticamente
   (Content-Security-Policy, X-Frame-Options, etc.) para proteger contra ataques
   comunes de browsers. */
const helmet = require('helmet');

/* cookie-parser: middleware que parsea las cookies enviadas por el browser en
   cada request y las expone en req.cookies. Se usa para leer el token de admin. */
const cookieParser = require('cookie-parser');

/* googleapis: SDK oficial de Google para Node.js. Da acceso a todos los servicios
   de Google; aquí se usa exclusivamente la API de Google Sheets v4. */
const { google } = require('googleapis');

// ─── Variables de entorno ────────────────────────────────────────────────────
// Todas se leen desde process.env (poblado por dotenv). El valor después de ||
// es el fallback si la variable no está definida en el .env.

/* Puerto en que escucha el servidor Express. En producción (Railway, Heroku, etc.)
   la plataforma inyecta PORT; en local se usa 3000. */
const PORT = process.env.PORT || 3000;

/* URL pública del servidor. Fundamental para armar el link de confirmación de
   pedido que se envía por WhatsApp al dueño. En producción debe ser el dominio
   real (ej: https://gapata.com). */
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

/* Ruta al archivo JSON de credenciales de la cuenta de servicio de Google.
   Se descarga desde Google Cloud Console al crear una Service Account. */
const GOOGLE_CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH;

/* ID del Google Spreadsheet donde se guardan pedidos, productos y salsas.
   Se obtiene de la URL: docs.google.com/spreadsheets/d/ESTE_ID/edit */
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

/* Nombre de la pestaña (hoja) dentro del Spreadsheet donde van los pedidos.
   Por defecto 'Pedidos'. Productos y Salsas tienen hojas con nombre fijo en el código. */
const SHEET_NAME = process.env.SHEET_NAME || 'Pedidos';

/* Número de WhatsApp del dueño del negocio. Es el destinatario del link wa.me que
   arma el frontend: el cliente confirma el pedido enviándole el mensaje desde su
   propio WhatsApp. Formato internacional sin '+' ni espacios (Argentina: 549 + área + número). */
const NUMERO_DUENO = process.env.NUMERO_DUENO || '5493516622633';

/* Contraseña para acceder al panel de administración (/admin). Si no está definida,
   el panel queda bloqueado por seguridad. */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

/* Indica si el entorno es producción (NODE_ENV=production). Afecta la cookie de
   admin: en producción se marca como 'secure' (solo HTTPS). */
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/* Duración del token de sesión del admin: 24 horas expresadas en milisegundos.
   Después de este tiempo el token expira y hay que volver a hacer login. */
const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/* Máximo de pedidos que se mantienen en memoria simultáneamente. Cuando se supera
   este límite se elimina el más antiguo (FIFO). Evita que el array crezca sin límite
   si el servidor corre por mucho tiempo sin reiniciarse. */
const MAX_PEDIDOS_EN_MEMORIA = 500;

/* Nombres de las columnas de la hoja 'Pedidos' en el orden exacto en que se
   escriben. Deben coincidir con pedidoToRow() o los datos quedarán desalineados. */
const ENCABEZADOS_PEDIDO = ['ID', 'Fecha', 'Cliente', 'Teléfono', 'Tipo', 'Personas', 'Precio', 'Fileteado', 'Salsas', 'Total', 'Estado', 'Calle', 'Numero', 'Piso', 'Observaciones', 'Mes', 'Dia', 'Hora'];

// ─── Estado en memoria ───────────────────────────────────────────────────────

/* Array que almacena los pedidos en RAM mientras el servidor está corriendo.
   LIMITACIÓN IMPORTANTE: al reiniciar el servidor se pierde todo lo que haya aquí.
   Por eso cada pedido también se persiste en Google Sheets. Si el servidor se
   reinicia y llega un request de confirmación de un pedido viejo, se recupera
   desde Sheets (ver /confirmar/:id). */
const pedidos = [];

/* Mapa de tokens de sesión del admin: token (string hex) → timestamp de expiración.
   Al usar un Map en lugar de un array se puede borrar tokens individuales en O(1).
   LIMITACIÓN: igual que pedidos, se pierde al reiniciar. Si eso ocurre, el admin
   simplemente debe volver a hacer login. */
const adminTokens = new Map();

/* Registra intentos de login por IP para limitar fuerza bruta.
   Estructura: IP → { count: número de intentos, firstAttempt: timestamp }. */
const loginAttempts = new Map();

/* Registra pedidos realizados por IP para evitar spam.
   Misma estructura que loginAttempts pero con ventana de tiempo más larga. */
const pedidoAttempts = new Map();

/* Set de IDs de pedidos que ya fueron confirmados y guardados en Sheets.
   Permite saber si un pedido ya fue confirmado sin hacer una llamada a Sheets,
   respondiendo inmediatamente con la pantalla de "ya confirmado". */
const pedidosEnSheet = new Set();

// ─── Configuración de Express ────────────────────────────────────────────────

const app = express();

/* helmet protege contra ataques comunes. crossOriginResourcePolicy: 'same-origin'
   asegura que los recursos (imágenes, fuentes, scripts) solo puedan ser cargados
   desde el mismo origen, bloqueando el hotlinking desde otros sitios. */
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-origin' } }));

/* express.json() es un middleware que parsea el cuerpo (body) de los requests
   con Content-Type: application/json y lo expone en req.body. Sin esto, req.body
   sería undefined y no se podrían leer los datos enviados desde el formulario.
   El límite de 100kb evita ataques de payload gigante. */
app.use(express.json({ limit: '100kb' }));

/* cookieParser() parsea el header 'Cookie' de cada request y lo convierte en
   el objeto req.cookies, que se usa en verificarAdmin() para leer el token. */
app.use(cookieParser());

/* Sirve archivos estáticos (HTML, CSS, JS, imágenes) desde la carpeta 'public'.
   Así el frontend del cliente y del admin se sirven sin rutas explícitas. */
app.use(express.static('public'));

/* Advertencia temprana: si falta ADMIN_PASSWORD, el panel admin estará
   bloqueado. Esto avisa en los logs al iniciar el servidor. */
if (!ADMIN_PASSWORD) {
  console.warn('ADVERTENCIA: ADMIN_PASSWORD no esta definido. El panel admin quedara inaccesible.');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/* Genera un ID de pedido legible con fecha + sufijo aleatorio.
   Formato: YYYYMMDD-XXXX (ej: 20250510-A7K3).
   Se eligió este esquema en lugar de uuidv4 (que genera strings como
   "f47ac10b-58cc-4372-a567-0e02b2c3d479") porque:
   - Es más corto y legible para el dueño del negocio.
   - Incluye la fecha, por lo que es fácil identificar cuándo se hizo el pedido.
   - El sufijo de 4 caracteres alphanumeric da 36^4 = 1.679.616 combinaciones
     por día, más que suficiente para este volumen de pedidos.
   La aleatoriedad se obtiene con Math.random(), que no es criptográficamente
   segura, pero para IDs de pedidos visibles al público es aceptable. */
function generarId() {
  const d = new Date();
  // Formatea la fecha como YYYYMMDD, rellenando mes y día con cero si es necesario
  const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let sufijo = '';
  // Genera 4 caracteres aleatorios del conjunto de letras y números
  for (let i = 0; i < 4; i++) {
    sufijo += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${yyyymmdd}-${sufijo}`;
}

/* Formatea una fecha en la zona horaria de Córdoba, Argentina (UTC-3).
   Recibe un Date o un string ISO y devuelve "DD/MM/YYYY HH:MM".
   Es importante usar Intl.DateTimeFormat con timeZone explícita porque el
   servidor puede estar en otro país (ej: un servidor en USA en UTC-5),
   y las fechas deben mostrarse siempre en horario argentino. */
function fechaArgentina(dateInput) {
  // Acepta tanto objetos Date como strings (ej: ISO 8601)
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  // Si no es una fecha válida, devuelve el valor original como string
  if (isNaN(d.getTime())) return String(dateInput || '');
  try {
    const fmt = new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Cordoba', // Zona horaria de Córdoba capital
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false // Formato 24 horas (ej: 14:30, no 2:30 PM)
    });
    // formatToParts devuelve un array de partes: [{type:'day',value:'10'}, ...]
    const parts = {};
    fmt.formatToParts(d).forEach(({ type, value }) => { parts[type] = value; });
    return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
  } catch {
    // Fallback si Intl no está disponible (entornos muy viejos de Node)
    return d.toLocaleString('es-AR');
  }
}

/* Middleware de autenticación del admin. Se agrega como segundo argumento en
   las rutas protegidas (ej: app.get('/api/admin/session', verificarAdmin, ...)).
   Verifica que la cookie admin_token exista y no haya expirado. Si pasa,
   llama a next() para que el request continúe; si no, devuelve 401. */
function verificarAdmin(req, res, next) {
  // req.cookies es el objeto poblado por cookieParser()
  const token = req.cookies?.admin_token;
  if (!token) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  // Busca el timestamp de expiración del token en el Map de sesiones
  const exp = adminTokens.get(token);
  if (!exp || Date.now() > exp) {
    // Si el token no existe o ya expiró, lo elimina del Map y rechaza
    adminTokens.delete(token);
    return res.status(401).json({ error: 'Token expirado' });
  }
  // Token válido: continúa al handler de la ruta
  next();
}

/* Limpia del Map adminTokens todos los tokens cuya fecha de expiración ya pasó.
   Se llama en cada login para evitar que el Map crezca indefinidamente con tokens
   viejos que nadie borró (ej: el admin cerró el browser sin hacer logout). */
function limpiarTokensExpirados() {
  const ahora = Date.now();
  adminTokens.forEach((exp, token) => {
    if (ahora > exp) adminTokens.delete(token);
  });
}

/* Middleware de rate limiting para el endpoint de login del admin.
   Permite máximo 8 intentos cada 15 minutos por IP. Si se supera, devuelve 429.
   Protege contra ataques de fuerza bruta donde alguien intenta adivinar la
   contraseña enviando muchos requests automatizados. */
function limitarLogin(req, res, next) {
  // Identifica al cliente por su IP (req.ip es poblado por Express)
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const ahora = Date.now();
  const ventanaMs = 15 * 60 * 1000; // 15 minutos en milisegundos
  const maxIntentos = 8;
  // Recupera el registro existente o crea uno nuevo si es el primer intento
  const registro = loginAttempts.get(ip) || { count: 0, firstAttempt: ahora };

  // Si pasaron más de 15 minutos desde el primer intento, reinicia la ventana
  if (ahora - registro.firstAttempt > ventanaMs) {
    loginAttempts.set(ip, { count: 1, firstAttempt: ahora });
    return next();
  }

  // Si ya alcanzó el límite dentro de la ventana, bloquea el request
  if (registro.count >= maxIntentos) {
    return res.status(429).json({ success: false, error: 'Demasiados intentos. Proba de nuevo en unos minutos.' });
  }

  // Incrementa el contador y deja pasar el request
  registro.count += 1;
  loginAttempts.set(ip, registro);
  next();
}

/* Middleware de rate limiting para el endpoint de creación de pedidos.
   Permite máximo 10 pedidos por hora por IP. Evita que alguien spamee
   el sistema con pedidos falsos o sature el bot de WhatsApp. */
function limitarPedidos(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const ahora = Date.now();
  const ventanaMs = 60 * 60 * 1000; // 1 hora en milisegundos
  const maxPedidos = 10;
  const registro = pedidoAttempts.get(ip) || { count: 0, firstAttempt: ahora };

  // Si pasó más de 1 hora desde el primer pedido, reinicia la ventana
  if (ahora - registro.firstAttempt > ventanaMs) {
    pedidoAttempts.set(ip, { count: 1, firstAttempt: ahora });
    return next();
  }

  // Si alcanzó el límite, rechaza el request
  if (registro.count >= maxPedidos) {
    return res.status(429).json({ success: false, error: 'Demasiados pedidos. Intentá más tarde.' });
  }

  registro.count += 1;
  pedidoAttempts.set(ip, registro);
  next();
}

/* Valida que un número de teléfono sea plausible: solo permite dígitos, +, espacios,
   paréntesis y guiones, con longitud de 8 a 20 caracteres. No valida que el número
   realmente exista; solo evita que se guarden strings arbitrarios. */
function validarTelefono(telefono) {
  return typeof telefono === 'string' && /^[0-9+\s()-]{8,20}$/.test(telefono.trim());
}

/* Sanitiza cualquier valor de texto que llega del usuario:
   - trim() elimina espacios al inicio y al final.
   - slice(0, maxLength) limita la longitud para evitar que se guarden textos
     enormes en Sheets o en memoria.
   Si el valor no es un string, devuelve cadena vacía. */
function normalizarTexto(valor, maxLength) {
  if (typeof valor !== 'string') return '';
  return valor.trim().slice(0, maxLength);
}

/* Parsea una lista de números separados por '|' (formato usado en Sheets para
   guardar múltiples valores en una celda).
   Ejemplo: '10|15|20' → [10, 15, 20].
   Filtra valores no finitos o negativos para evitar datos corruptos. */
function parseListaNumerica(valor) {
  return String(valor || '')
    .split('|')
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

/* Igual que parseListaNumerica, pero para índices (enteros >= 0).
   Se usa para parsear fileteadoIncluido, que contiene los índices de las
   variantes donde el fileteado está incluido sin costo extra. */
function parseListaIndices(valor) {
  return String(valor || '')
    .split('|')
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

/* Aplica el límite MAX_PEDIDOS_EN_MEMORIA al array global pedidos.
   shift() elimina el primer elemento (el más antiguo) hasta que el array
   tenga el tamaño correcto. Se llama siempre después de push() en pedidos. */
function limitarPedidosEnMemoria() {
  while (pedidos.length > MAX_PEDIDOS_EN_MEMORIA) {
    pedidos.shift();
  }
}

/* Escapa caracteres HTML especiales para prevenir XSS al renderizar datos del
   usuario dentro de HTML. Si el dueño o el cliente escriben '<script>' en su
   nombre, esta función lo convierte en '&lt;script&gt;' y el browser lo muestra
   como texto, no lo ejecuta. */
function escapeHtml(valor) {
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Genera el HTML completo de la página de confirmación de pedido que ve el cliente
   (o el dueño) al abrir el link /confirmar/:id.
   Recibe el objeto pedido y un booleano yaConfirmado para mostrar mensajes distintos:
   - yaConfirmado=false: primera vez que se confirma → fondo amarillo, "✓ PEDIDO CONFIRMADO"
   - yaConfirmado=true: ya fue confirmado antes → fondo semitransparente, "○ YA CONFIRMADO"
   Nota: toda la página está inlinada en un string porque no se usa un motor de
   plantillas (ejs, handlebars, etc.). Se optó por simplicidad: una sola página
   que no necesita layout, i18n ni reutilización. */
function renderConfirmacion(pedido, yaConfirmado) {
  const item = pedido.items[0] || {};
  const tipo = item.tipo === 'cerdo' ? 'Cerdo' : 'Vaca';
  const emoji = item.tipo === 'cerdo' ? '🐷' : '🐮';
  const fileteado = item.tieneFileteado ? 'Sí' : 'No';
  // Si no hay salsas, salsasTexto queda vacío y no se renderiza la fila
  const salsasTexto = (pedido.salsas || []).length > 0
    ? escapeHtml((pedido.salsas || []).join(', '))
    : '';
  // toLocaleString('es-AR') formatea el número con separador de miles argentino (punto)
  const total = '$' + (pedido.total || 0).toLocaleString('es-AR');

  // Variables de presentación que cambian según si ya fue confirmado o no
  const icono = yaConfirmado ? '○' : '✓';
  const iconoBg = yaConfirmado ? 'rgba(255,208,0,0.2)' : '#FFD000';
  const iconoColor = yaConfirmado ? '#FFD000' : '#1A1A1A';
  const titulo = yaConfirmado ? 'YA CONFIRMADO' : 'PEDIDO CONFIRMADO';
  const subtitulo = yaConfirmado
    ? 'Este pedido ya fue confirmado anteriormente'
    : 'El pedido fue registrado correctamente';
  const tituloColor = yaConfirmado ? 'rgba(255,255,255,0.55)' : '#FFFFFF';

  // Template literal con HTML + CSS inline. Los valores del pedido se escapan con
  // escapeHtml() para prevenir XSS. Las variables de estilo (colores) son
  // controladas por el servidor, no por el usuario, así que no necesitan escape.
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

/* Valida y construye el objeto pedido a partir del body del request.
   Es async porque necesita consultar los productos activos desde Google Sheets
   para verificar que los ítems del pedido sean válidos.
   Lanza un Error si algún dato no pasa la validación, lo que es capturado
   en el handler de la ruta y devuelto como respuesta 500. */
async function construirPedidoValido(body) {
  // Sanitiza los campos de texto del cliente
  const nombreCliente = normalizarTexto(body.nombreCliente, 80);
  const telefonoCliente = normalizarTexto(body.telefonoCliente, 20);
  const items = Array.isArray(body.items) ? body.items : [];
  // Sanitiza cada salsa: máximo 80 chars, descarta strings vacíos, tope de 20 salsas
  const salsas = Array.isArray(body.salsas)
    ? body.salsas.map(s => normalizarTexto(s, 80)).filter(Boolean).slice(0, 20)
    : [];

  // Sanitiza la dirección de entrega: cada campo con su propio límite de longitud
  const direccionBody = (body.direccion && typeof body.direccion === 'object') ? body.direccion : {};
  const direccion = {
    calle: normalizarTexto(direccionBody.calle, 100),
    numero: normalizarTexto(direccionBody.numero, 20),
    piso: normalizarTexto(direccionBody.piso, 30),
    observaciones: normalizarTexto(direccionBody.observaciones, 300)
  };

  // Calle y número son obligatorios para poder entregar el pedido
  if (!direccion.calle || !direccion.numero) {
    throw new Error('La dirección es obligatoria');
  }

  // Sanitiza la fecha de entrega elegida en el paso 6 (selección en cascada mes/día/hora)
  const fechaEntregaBody = (body.fechaEntrega && typeof body.fechaEntrega === 'object') ? body.fechaEntrega : {};
  const fechaEntrega = {
    mes: normalizarTexto(fechaEntregaBody.mes, 20),
    dia: normalizarTexto(fechaEntregaBody.dia, 20),
    hora: normalizarTexto(fechaEntregaBody.hora, 20)
  };

  // Mes, día y hora son obligatorios: sin fecha de entrega no se puede coordinar el pedido
  if (!fechaEntrega.mes || !fechaEntrega.dia || !fechaEntrega.hora) {
    throw new Error('La fecha de entrega es obligatoria');
  }

  // Validación básica: nombre, teléfono, y entre 1 y 10 ítems
  if (!nombreCliente || !validarTelefono(telefonoCliente) || items.length === 0 || items.length > 10) {
    throw new Error('Datos de pedido invalidos');
  }

  // Obtiene la lista de productos activos desde Sheets para validar los ítems
  const productos = await obtenerProductosActivos();
  // Valida cada ítem contra los productos reales (tipo, variante, precio)
  const itemsValidados = items.map((item) => validarItemPedido(item, productos));
  // El total es la suma de precios base + costos de fileteado de todos los ítems
  const total = itemsValidados.reduce((sum, item) => sum + item.precioUnitario + item.costoFileteado, 0);

  return { nombreCliente, telefonoCliente, direccion, fechaEntrega, items: itemsValidados, salsas, total };
}

/* Valida un ítem individual del pedido contra el catálogo de productos.
   Verifica que el producto exista, que la variante (cantidad de personas) sea válida
   y que el precio corresponda. Calcula el costo del fileteado si aplica.
   Lanza Error si el producto o la variante no existen. */
function validarItemPedido(item, productos) {
  const cantidad = Number(item?.cantidad);
  const productoTexto = normalizarTexto(item?.producto, 120);
  // Busca el producto por nombre: el texto enviado desde el frontend tiene el formato
  // "Cerdo (10 personas)" y debe empezar con el nombre del producto seguido de " ("
  const producto = productos.find((prod) => productoTexto.startsWith(`${prod.nombre} (`));

  if (!producto || !Number.isFinite(cantidad)) {
    throw new Error('Producto invalido');
  }

  // Busca el índice de la variante que coincide con la cantidad solicitada
  const indice = producto.personas.findIndex((personas) => personas === cantidad);
  if (indice === -1 || producto.precios[indice] == null) {
    throw new Error('Variante invalida');
  }

  const tieneFileteado = item.tieneFileteado === true;
  // fileteadoGratis es la lista de índices de variantes donde el fileteado es gratis
  const fileteadoEsGratis = producto.fileteadoGratis.includes(indice);
  // El fileteado cuesta $100 por persona solo si no está incluido gratis en esa variante
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

/* Obtiene todos los productos activos desde la hoja 'Productos' de Sheets.
   asegurarHoja() garantiza que la hoja exista y tenga datos iniciales si está vacía.
   Los valores de variantes, precios y fileteadoIncluido se almacenan en Sheets como
   strings con '|' y aquí se parsean a arrays de números para poder operar con ellos.
   Solo devuelve productos donde nombre, tipo y longitudes coincidan (dato íntegro). */
async function obtenerProductosActivos() {
  // Si la hoja 'Productos' no existe o está vacía, la crea con datos iniciales
  await asegurarHoja('Productos',
    ['nombre', 'tipo', 'variantes', 'precios', 'fileteadoIncluido', 'activo'],
    [
      ['Cerdo', 'cerdo', '10|15|20|25|30|40|50|100', '99000|130000|164000|195000|225000|282000|335000|655000', '0|1', 'true'],
      ['Vaca', 'vaca', '10|15|20|25|30|40|50|100', '150000|198000|245000|295000|345000|440000|530000|1030000', '0|1|2|3|4|5|6|7', 'true']
    ]
  );

  const productos = await leerHoja('Productos');
  return productos
    // Filtra solo los productos marcados como activos
    .filter((producto) => producto.activo === 'true' || producto.activo === true)
    .map((producto) => ({
      nombre: normalizarTexto(producto.nombre, 80),
      tipo: normalizarTexto(producto.tipo, 40),
      variantes: producto.variantes,
      preciosTexto: producto.precios,
      fileteadoIncluido: producto.fileteadoIncluido,
      activo: producto.activo,
      // Convierte los strings de Sheets a arrays de números para operar con ellos
      personas: parseListaNumerica(producto.variantes),
      precios: parseListaNumerica(producto.precios),
      fileteadoGratis: parseListaIndices(producto.fileteadoIncluido)
    }))
    // Descarta filas corruptas donde falten datos o las longitudes no coincidan
    .filter((producto) => producto.nombre && producto.tipo && producto.personas.length === producto.precios.length);
}

/* Valida y normaliza un producto antes de guardarlo desde el panel admin.
   Devuelve un array con los valores en el orden de las columnas de la hoja 'Productos'.
   Asegura que fileteadoIncluido solo contenga índices válidos (dentro del rango de variantes).
   Lanza Error si los datos mínimos no están presentes o las longitudes no coinciden. */
function normalizarProductoAdmin(producto) {
  const nombre = normalizarTexto(producto?.nombre, 80);
  const tipo = normalizarTexto(producto?.tipo, 40);
  const variantes = parseListaNumerica(producto?.variantes);
  const precios = parseListaNumerica(producto?.precios);
  // Filtra índices fuera de rango para que no apunten a variantes inexistentes
  const fileteadoIncluido = parseListaIndices(producto?.fileteadoIncluido)
    .filter((indice) => indice < variantes.length);
  // Normaliza activo a string 'true'/'false' para consistencia con Sheets
  const activo = producto?.activo === true || producto?.activo === 'true' ? 'true' : 'false';

  if (!nombre || !tipo || variantes.length === 0 || variantes.length !== precios.length) {
    throw new Error('Producto invalido');
  }

  // Devuelve los valores en el orden exacto de las columnas de la hoja Productos
  return [nombre, tipo, variantes.join('|'), precios.join('|'), fileteadoIncluido.join('|'), activo];
}

/* Valida y normaliza una salsa antes de guardarla desde el panel admin.
   El campo imagen debe ser un nombre de archivo SVG válido (sin rutas ni caracteres
   especiales) para evitar path traversal o inyección de URLs arbitrarias. */
function normalizarSalsaAdmin(salsa) {
  const nombre = normalizarTexto(salsa?.nombre, 80);
  const imagen = normalizarTexto(salsa?.imagen, 120);
  const activo = salsa?.activo === true || salsa?.activo === 'true' ? 'true' : 'false';

  // Solo acepta nombres de archivo SVG con caracteres seguros (letras, números, punto, guion)
  if (!nombre || !/^[a-z0-9._-]+\.svg$/i.test(imagen)) {
    throw new Error('Salsa invalida');
  }

  return [nombre, imagen, activo];
}

// ─── Rutas API ───────────────────────────────────────────────────────────────

/* POST /api/pedido — Ciclo de vida de un pedido (paso 1 de 2: creación).
   Es el endpoint principal que llama el frontend cuando el cliente confirma su pedido.
   Flujo completo:
   1. limitarPedidos() verifica que la IP no haya superado el límite de pedidos/hora.
   2. construirPedidoValido() valida y sanitiza los datos del body.
   3. Se genera un ID único con generarId() y se crea el objeto pedido.
   4. El pedido se guarda en el array en memoria (pedidos) con estado 'pendiente'.
   5. Se guarda en Google Sheets para persistencia permanente.
   6. Se arma el mensaje de WhatsApp con el detalle del pedido y el link de confirmación.
   7. Se construye un link wa.me hacia NUMERO_DUENO con el mensaje pre-cargado.
   8. Se responde al frontend con { success: true, id, linkWhatsapp }; el cliente es
      redirigido a ese link para enviar el mensaje al dueño desde su propio WhatsApp. */
app.post('/api/pedido', limitarPedidos, async (req, res) => {
  try {
    const pedidoValido = await construirPedidoValido(req.body);

    const id = generarId();
    const pedido = {
      id,
      ...pedidoValido, // Expande: nombreCliente, telefonoCliente, direccion, fechaEntrega, items, salsas, total
      estado: 'pendiente', // Estado inicial antes de que el dueño confirme
      fechaCreacion: new Date().toISOString() // ISO 8601 en UTC para almacenamiento
    };
    pedidos.push(pedido);
    limitarPedidosEnMemoria(); // Evita que el array crezca sin límite
    await guardarEnSheet(pedido); // Persistencia en Google Sheets

    // Arma el mensaje de WhatsApp que el cliente enviará al dueño vía link wa.me
    const item = pedido.items[0] || {};
    const emoji = item.tipo === 'cerdo' ? '🐷' : '🐮';
    // Capitaliza el tipo: 'cerdo' → 'Cerdo'
    const tipoNombre = item.tipo ? (item.tipo.charAt(0).toUpperCase() + item.tipo.slice(1)) : 'Pata';
    // Línea de fileteado: vacía si no lo pidió, precio si tiene costo, "gratis" si está incluido
    const fileteadoLinea = item.tieneFileteado
      ? (item.costoFileteado > 0
          ? `\n🔪 *Fileteado:* +$${item.costoFileteado.toLocaleString('es-AR')}`
          : '\n🔪 *Fileteado:* Incluido gratis')
      : '';
    const salsasTexto = pedido.salsas.length > 0
      ? `\n🥫 *Salsas:* ${pedido.salsas.join(', ')}`
      : '';
    // Dirección de entrega: piso solo si el cliente lo completó
    const direccion = pedido.direccion || {};
    const direccionLinea = direccion.calle
      ? `\n📍 *Dirección:* Calle ${direccion.calle} Nº ${direccion.numero}${direccion.piso ? `, Piso ${direccion.piso}` : ''}`
      : '';
    const observacionesLinea = direccion.observaciones
      ? `\n📝 *Observaciones:* ${direccion.observaciones}`
      : '';
    // Fecha de entrega elegida en el paso 6 (mes/día/hora)
    const fechaEntrega = pedido.fechaEntrega || {};
    const fechaEntregaLinea = fechaEntrega.mes
      ? `📅 *Fecha de entrega:* ${fechaEntrega.dia} de ${fechaEntrega.mes} a las ${fechaEntrega.hora}hs\n\n`
      : '';

    // El link de confirmación lleva al dueño a /confirmar/:id para registrar el pedido
    const linkConfirmacion = `${BASE_URL}/confirmar/${id}`;
    // El asterisco (*texto*) es el formato de negrita de WhatsApp
    const mensaje =
      `🛒 *Nuevo Pedido* de ${pedido.nombreCliente}\n\n` +
      fechaEntregaLinea +
      `${emoji} *${tipoNombre}* (${item.cantidad} personas): $${item.precioUnitario.toLocaleString('es-AR')}` +
      fileteadoLinea +
      salsasTexto +
      direccionLinea +
      observacionesLinea +
      `\n\n*Total: $${pedido.total.toLocaleString('es-AR')}*` +
      `\n*Teléfono:* ${pedido.telefonoCliente}\n\n` +
      `Confirmar pedido: ${linkConfirmacion}`;

    // El cliente abre este link y envía el mensaje al dueño desde su propio WhatsApp
    const mensajeCodificado = encodeURIComponent(mensaje);
    const linkWhatsapp = `https://wa.me/${NUMERO_DUENO}?text=${mensajeCodificado}`;

    res.json({ success: true, id, linkWhatsapp });
  } catch (err) {
    console.error('Error procesando pedido:', err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

/* GET /confirmar/:id — Ciclo de vida de un pedido (paso 2 de 2: confirmación).
   El dueño abre este link desde el mensaje de WhatsApp para confirmar el pedido.
   Flujo:
   1. Busca el pedido primero en memoria (rápido).
   2. Si no está en memoria (ej: el servidor se reinició), lo busca en Sheets.
   3. Si ya está confirmado (estado === 'confirmado' o está en pedidosEnSheet),
      muestra la pantalla de "ya confirmado" sin modificar nada.
   4. Si es la primera confirmación: cambia el estado a 'confirmado', guarda en Sheets
      y agrega el ID al Set pedidosEnSheet para futuras consultas rápidas.
   5. Renderiza y devuelve el HTML de confirmación. */
app.get('/confirmar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Búsqueda O(n) en el array en memoria — aceptable dado el límite de 500 pedidos
    let pedido = pedidos.find((p) => p.id === id);

    // Fallback a Sheets si no está en memoria (servidor reiniciado, pedido muy viejo)
    if (!pedido) {
      const encontrado = await buscarPedidoEnSheet(id);
      pedido = encontrado?.pedido;
      if (pedido) {
        // Re-agrega a memoria para que consultas futuras sean más rápidas
        pedidos.push(pedido);
        limitarPedidosEnMemoria();
      }
    }

    if (!pedido) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    // Si ya fue confirmado, muestra la pantalla de "ya confirmado" sin cambiar nada
    if (pedido.estado === 'confirmado' || pedidosEnSheet.has(id)) {
      return res.send(renderConfirmacion(pedido, true));
    }

    // Primera confirmación: actualiza el estado y guarda en Sheets
    pedido.estado = 'confirmado';
    pedido.fechaConfirmacion = new Date().toISOString();

    await guardarEnSheet(pedido); // Actualiza la fila existente en Sheets con el nuevo estado
    pedidosEnSheet.add(id); // Marca como confirmado para futuras consultas rápidas

    res.send(renderConfirmacion(pedido, false));
  } catch (err) {
    console.error('Error confirmando pedido:', err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ─── Rutas Admin ─────────────────────────────────────────────────────────────

/* GET /api/admin/session — Verifica si el admin tiene una sesión activa.
   El frontend llama a este endpoint al cargar el panel para saber si mostrar
   el login o el panel completo. verificarAdmin() rechaza con 401 si no hay sesión. */
app.get('/api/admin/session', verificarAdmin, (req, res) => {
  res.json({ success: true });
});

/* POST /api/admin/login — Autentica al admin con contraseña y emite un token de sesión.
   Flujo:
   1. limitarLogin() bloquea fuerza bruta por IP.
   2. Compara la contraseña enviada con ADMIN_PASSWORD (variable de entorno).
   3. Genera un token de 32 bytes aleatorios (256 bits) con crypto.randomBytes —
      criptográficamente seguro, imposible de adivinar.
   4. Guarda token → expiración en el Map adminTokens.
   5. Envía el token como cookie httpOnly (el JS del browser no puede leerla,
      protegiéndola de XSS) con SameSite=strict (no se envía en requests cross-site). */
app.post('/api/admin/login', limitarLogin, async (req, res) => {
  try {
    console.log('[admin/login] intento desde IP:', req.ip);
    const { password } = req.body;
    console.log('[admin/login] ADMIN_PASSWORD configurado:', !!ADMIN_PASSWORD);
    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
      console.log('[admin/login] contraseña incorrecta');
      return res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
    }

    limpiarTokensExpirados(); // Borra tokens viejos antes de agregar uno nuevo
    // crypto.randomBytes(32) genera 32 bytes aleatorios; .toString('hex') los convierte
    // a un string de 64 caracteres hexadecimales — el token de sesión
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + ADMIN_TOKEN_TTL_MS; // Timestamp de expiración (24hs)
    adminTokens.set(token, expiresAt);

    res.cookie('admin_token', token, {
      httpOnly: true,    // JS del browser no puede leer esta cookie (protección XSS)
      maxAge: ADMIN_TOKEN_TTL_MS, // Expiración del lado del browser en ms
      sameSite: 'strict', // No se envía en requests iniciados desde otros sitios (protección CSRF)
      secure: IS_PRODUCTION // Solo se envía por HTTPS en producción
    });

    console.log('[admin/login] login exitoso');
    res.json({ success: true });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

/* POST /api/admin/logout — Cierra la sesión del admin.
   Elimina el token del Map en servidor y borra la cookie del browser.
   Requiere sesión activa (verificarAdmin) para evitar que alguien sin sesión
   envíe requests de logout en loop. */
app.post('/api/admin/logout', verificarAdmin, (req, res) => {
  const token = req.cookies?.admin_token;
  if (token) adminTokens.delete(token); // Invalida el token en servidor inmediatamente
  res.clearCookie('admin_token', { sameSite: 'strict', secure: IS_PRODUCTION });
  res.json({ success: true });
});

/* GET /api/productos — Devuelve la lista de productos desde Sheets.
   Disponible sin autenticación porque el frontend del cliente la necesita
   para mostrar el formulario de pedido. asegurarHoja() garantiza que la hoja
   exista con los datos iniciales si es la primera vez que se llama. */
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

/* GET /api/salsas — Devuelve la lista de salsas disponibles desde Sheets.
   También público, ya que el frontend del cliente la necesita para el formulario.
   Si la hoja 'Salsas' no existe, la crea con el menú inicial de salsas. */
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

/* PUT /api/admin/productos — Reemplaza toda la hoja 'Productos' con los datos enviados.
   Solo accesible para el admin (verificarAdmin). Cada producto del array recibido
   se normaliza con normalizarProductoAdmin() antes de escribirlo. */
app.put('/api/admin/productos', verificarAdmin, async (req, res) => {
  try {
    const productos = req.body;
    if (!Array.isArray(productos)) {
      return res.status(400).json({ error: 'Datos inválidos' });
    }
    // Normaliza y valida cada producto; si alguno falla, map() lanza el Error
    const filas = productos.map(normalizarProductoAdmin);
    await escribirHoja('Productos', filas);
    res.json({ success: true });
  } catch (err) {
    console.error('Error guardando productos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/* PUT /api/admin/salsas — Reemplaza toda la hoja 'Salsas' con los datos enviados.
   Mismo patrón que /api/admin/productos pero para salsas. */
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

/* POST /api/admin/reset-hojas — Elimina las hojas 'Productos' y 'Salsas' del Spreadsheet.
   La próxima llamada a /api/productos o /api/salsas las recreará con los datos iniciales.
   Útil para volver al menú de fábrica si el admin editó algo incorrecto. */
app.post('/api/admin/reset-hojas', verificarAdmin, async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    // Obtiene metadata del Spreadsheet para saber el sheetId numérico de cada hoja
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });

    const deleteRequests = [];
    spreadsheet.data.sheets.forEach(sheet => {
      // Solo borra las hojas de catálogo, no la hoja de Pedidos
      if (['Productos', 'Salsas'].includes(sheet.properties.title)) {
        deleteRequests.push({ deleteSheet: { sheetId: sheet.properties.sheetId } });
      }
    });

    // batchUpdate ejecuta múltiples operaciones en una sola llamada a la API de Sheets
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

// ─── Google Sheets ────────────────────────────────────────────────────────────

/* Crea y devuelve un cliente autenticado de la API de Google Sheets.
   Usa autenticación de Cuenta de Servicio (Service Account), que es ideal para
   aplicaciones servidor-a-servidor sin intervención humana.

   Cómo funciona la autenticación:
   1. GOOGLE_CREDENTIALS_PATH apunta a un archivo JSON descargado desde Google Cloud
      Console con las claves privadas de la Service Account.
   2. GoogleAuth lee ese archivo y usa OAuth2 para obtener un access token de Google.
   3. El scope 'https://www.googleapis.com/auth/spreadsheets' limita los permisos
      a solo leer y escribir Sheets (principio de mínimo privilegio).
   4. El Spreadsheet debe tener compartido acceso de editor al email de la Service Account
      (ej: mi-app@mi-proyecto.iam.gserviceaccount.com).
   5. google.sheets({ version: 'v4', auth: authClient }) devuelve el cliente listo
      para hacer llamadas a la API de Sheets v4. */
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_CREDENTIALS_PATH, // Ruta al JSON de credenciales de la Service Account
    scopes: ['https://www.googleapis.com/auth/spreadsheets'] // Permiso: leer y escribir Sheets
  });
  const authClient = await auth.getClient(); // Obtiene el cliente autenticado con token OAuth2
  return google.sheets({ version: 'v4', auth: authClient }); // Retorna el cliente de la API
}

/* Garantiza que una hoja con el nombre dado exista en el Spreadsheet.
   Si no existe, la crea. Si existe pero está vacía, la inicializa con los encabezados
   y los datos iniciales proporcionados.
   Esto permite que el sistema sea auto-configurable: basta con ejecutarlo por primera
   vez y las hojas se crean solas con datos de ejemplo. */
async function asegurarHoja(nombre, encabezados, datosIniciales) {
  const sheets = await getSheetsClient();

  try {
    // Obtiene la lista de hojas del Spreadsheet para saber si la hoja ya existe
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetExists = spreadsheet.data.sheets.some(s => s.properties.title === nombre);

    // Si la hoja no existe, la crea con batchUpdate (permite múltiples operaciones a la vez)
    if (!sheetExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: nombre } } }] }
      });
    }

    // Lee el contenido actual de la hoja (hasta 1000 filas)
    const existingData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${nombre}!A1:Z1000`
    });

    // Si la hoja está vacía, la inicializa con encabezados y datos de ejemplo
    if (!existingData.data.values || existingData.data.values.length === 0) {
      const toInsert = [encabezados, ...datosIniciales]; // Encabezados en fila 1, datos desde fila 2
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${nombre}!A1`, // Empieza a escribir desde la celda A1
        valueInputOption: 'RAW', // 'RAW' guarda el valor literal; 'USER_ENTERED' interpretaría fórmulas
        requestBody: { values: toInsert }
      });
    }
  } catch (err) {
    console.error(`Error asegurando hoja ${nombre}:`, err);
    throw err;
  }
}

/* Lee todos los datos de una hoja y los devuelve como array de objetos.
   La primera fila se usa como encabezados (claves de los objetos).
   Ejemplo: si la hoja tiene columnas [nombre, precio] y dos filas de datos,
   devuelve [{nombre:'Cerdo', precio:'99000'}, {nombre:'Vaca', precio:'150000'}].
   Nota especial: la columna 'precios' puede tener comas como separador de miles
   (ej: '99,000') porque Sheets a veces formatea números así. Se limpian con replace. */
async function leerHoja(nombre) {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${nombre}!A:Z` // Lee todas las columnas (hasta columna Z)
  });

  const rows = response.data.values || [];
  if (rows.length === 0) return [];

  const encabezados = rows[0]; // Primera fila = nombres de columnas
  return rows.slice(1).map(fila => { // Resto de filas = datos
    const obj = {};
    encabezados.forEach((enc, i) => {
      let valor = fila[i] || ''; // Si la celda está vacía, usa string vacío
      // Limpia comas de miles que Sheets puede agregar al campo 'precios'
      if (enc === 'precios' && typeof valor === 'string') {
        valor = valor.replace(/,/g, '');
      }
      obj[enc] = valor;
    });
    return obj;
  });
}

/* Reemplaza los datos de una hoja manteniendo los encabezados de la primera fila.
   Lee los encabezados actuales primero, luego sobreescribe toda la hoja con
   [encabezados, ...filas]. Se usa en las rutas de admin para guardar cambios
   al catálogo de productos o salsas. */
async function escribirHoja(nombre, filas) {
  const sheets = await getSheetsClient();
  // Lee los encabezados actuales para no sobreescribirlos
  const existingData = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${nombre}!A1:Z1000`
  });

  const encabezados = existingData.data.values ? existingData.data.values[0] : [];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${nombre}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [encabezados, ...filas] } // Encabezados + nuevas filas
  });
}

/* Convierte un objeto pedido a un array plano con los valores en el orden exacto
   de ENCABEZADOS_PEDIDO: [ID, Fecha, Cliente, Teléfono, Tipo, Personas, Precio,
   Fileteado, Salsas, Total, Estado, Calle, Numero, Piso, Observaciones, Mes, Dia, Hora].
   Este array es lo que se escribe directamente en una fila de Google Sheets. */
function pedidoToRow(pedido) {
  const item = pedido.items[0] || {};
  // Capitaliza el tipo para mostrarlo legible en Sheets: 'cerdo' → 'Cerdo'
  const tipo = item.tipo ? (item.tipo.charAt(0).toUpperCase() + item.tipo.slice(1)) : '';
  const fileteadoTexto = item.tieneFileteado ? 'Sí' : 'No';
  const direccion = pedido.direccion || {};
  const fechaEntrega = pedido.fechaEntrega || {};

  return [
    pedido.id,
    fechaArgentina(pedido.fechaCreacion), // Fecha legible en zona horaria argentina
    pedido.nombreCliente,
    pedido.telefonoCliente,
    tipo,
    item.cantidad || '',
    item.precioUnitario || '',
    fileteadoTexto,
    (pedido.salsas || []).join(', '), // Array de salsas → string separado por coma
    pedido.total,
    pedido.estado, // 'pendiente' o 'confirmado'
    direccion.calle || '',
    direccion.numero || '',
    direccion.piso || '',
    direccion.observaciones || '',
    fechaEntrega.mes || '',
    fechaEntrega.dia || '',
    fechaEntrega.hora || ''
  ];
}

/* Guarda o actualiza un pedido en la hoja de pedidos de Google Sheets.
   Si el pedido ya existe (buscarPedidoEnSheet lo encuentra por ID), actualiza
   esa fila específica. Si no existe, agrega una nueva fila al final.
   Esto permite tanto la creación inicial del pedido como la actualización de su
   estado cuando el dueño confirma el pedido. */
async function guardarEnSheet(pedido) {
  // Asegura que la hoja de pedidos exista (sin datos iniciales, solo encabezados)
  await asegurarHoja(SHEET_NAME, ENCABEZADOS_PEDIDO, []);

  const sheets = await getSheetsClient();
  // Siempre escribe los encabezados en la primera fila para que no se pierdan
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:R1`,
    valueInputOption: 'RAW',
    requestBody: { values: [ENCABEZADOS_PEDIDO] }
  });

  const row = pedidoToRow(pedido);
  const existente = await buscarPedidoEnSheet(pedido.id); // Busca si ya existe una fila con este ID

  if (existente) {
    // El pedido ya existe: actualiza la fila en su posición exacta (rowNumber)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${existente.rowNumber}:R${existente.rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  } else {
    // Pedido nuevo: agrega una fila al final de la hoja con append()
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:R`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  }

  console.log(`Pedido ${pedido.id} guardado en Sheets`);
}

/* Busca un pedido en la hoja de Sheets por su ID y devuelve su posición y datos.
   Retorna null si no lo encuentra.
   El resultado incluye:
   - rowNumber: número de fila en la hoja (necesario para saber dónde escribir al actualizar)
   - pedido: objeto reconstruido desde los valores de la fila para poder usarlo en memoria
   Se usa tanto para verificar si existe antes de guardar, como para recuperar
   pedidos viejos cuando el servidor se reinicia y el array en memoria está vacío. */
async function buscarPedidoEnSheet(id) {
  await asegurarHoja(SHEET_NAME, ENCABEZADOS_PEDIDO, []);

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:R` // Lee las 18 columnas de pedidos
  });

  const rows = response.data.values || [];
  // Busca la fila donde la columna A (ID) coincide con el ID buscado
  // index > 0 salta la fila de encabezados (fila 0)
  const rowIndex = rows.findIndex((row, index) => index > 0 && row[0] === id);
  if (rowIndex === -1) return null;

  const row = rows[rowIndex];
  // Reconstruye el estado del fileteado desde el texto guardado en Sheets
  const tieneFileteado = row[7] === 'Sí' || row[7] === 'Incluido';
  const tipo = (row[4] || '').toLowerCase(); // 'Cerdo' → 'cerdo' para consistencia interna

  return {
    rowNumber: rowIndex + 1, // +1 porque Sheets usa índices base 1 (fila 1 = encabezados)
    pedido: {
      id: row[0],
      fechaCreacion: row[1] || '',
      fechaConfirmacion: '', // No se guarda en Sheets, queda vacío al recuperar
      nombreCliente: row[2] || '',
      telefonoCliente: row[3] || '',
      items: [{
        tipo,
        cantidad: Number(row[5]) || 0,
        precioUnitario: Number(row[6]) || 0,
        tieneFileteado,
        producto: `${row[4] || ''} (${row[5] || ''} personas)` // Reconstruye el string de producto
      }],
      salsas: row[8] ? row[8].split(', ').filter(Boolean) : [], // Reconstruye el array de salsas
      total: Number(row[9]) || 0,
      estado: row[10] || 'pendiente',
      // Reconstruye la dirección para no pisarla con vacío al re-guardar la fila
      direccion: {
        calle: row[11] || '',
        numero: row[12] || '',
        piso: row[13] || '',
        observaciones: row[14] || ''
      },
      // Reconstruye la fecha de entrega para no pisarla con vacío al re-guardar la fila
      fechaEntrega: {
        mes: row[15] || '',
        dia: row[16] || '',
        hora: row[17] || ''
      }
    }
  };
}

// ─── Servidor ─────────────────────────────────────────────────────────────────

/* Inicia el servidor Express en el puerto configurado.
   El envío de WhatsApp ya no depende del servidor: cada pedido devuelve un link
   wa.me que el cliente abre para mandar el mensaje al dueño desde su propio WhatsApp. */
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
