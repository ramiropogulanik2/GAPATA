// Datos de productos (fallback si la API no responde)
const PRODUCTOS = {
    cerdo: {
        nombre: 'Cerdo',
        emoji: '🐷',
        personas: [10, 15, 20, 25, 30, 40, 50, 100],
        precios: [99000, 130000, 164000, 195000, 225000, 282000, 335000, 655000],
        fileteadoGratis: [0, 1]
    },
    vaca: {
        nombre: 'Vaca',
        emoji: '🐮',
        personas: [10, 15, 20, 25, 30, 40, 50, 100],
        precios: [150000, 198000, 245000, 295000, 345000, 440000, 530000, 1030000],
        fileteadoGratis: [0, 1, 2, 3, 4, 5, 6, 7]
    }
};

let SALSAS_DATA = [];

// Estado del wizard
const wizard = {
    paso: 1,
    tipoPata: null,       // 'cerdo' | 'vaca'
    indiceVariante: null, // índice en el array de personas
    tieneFileteado: false,
    salsasSeleccionadas: {}
};

// ─── Inicialización ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    bindEventListeners();
    await Promise.all([cargarProductosDelAPI(), cargarSalsasDelAPI()]);
});

function bindEventListeners() {
    document.getElementById('btnArmarPedido').addEventListener('click', () => irAPaso(2));
    document.getElementById('btnAtras').addEventListener('click', irAPasoAnterior);
    document.getElementById('cardCerdo').addEventListener('click', () => seleccionarAnimal('cerdo'));
    document.getElementById('cardVaca').addEventListener('click', () => seleccionarAnimal('vaca'));
    document.getElementById('btnSig3').addEventListener('click', () => irAPaso(4));
    document.getElementById('btnSig4').addEventListener('click', () => irAPaso(5));
    document.getElementById('btnEnviar').addEventListener('click', enviarPedido);

    const playerPhoto = document.getElementById('playerPhoto');
    if (playerPhoto) {
        playerPhoto.addEventListener('error', () => { playerPhoto.parentElement.style.background = '#1A1A1A'; });
    }
    const galeriaImg1 = document.getElementById('galeriaImg1');
    if (galeriaImg1) {
        galeriaImg1.addEventListener('error', () => { galeriaImg1.src = 'images/ingredientes.jpg'; });
    }
}

async function cargarProductosDelAPI() {
    try {
        const response = await fetch('/api/productos');
        if (!response.ok) return;
        const data = await response.json();
        data.forEach(prod => {
            if (prod.activo !== 'true' && prod.activo !== true) return;
            const personas = prod.variantes.split('|').map(Number);
            const precios = prod.precios.split('|').map(Number);
            const fileteadoGratis = (prod.fileteadoIncluido || '').split('|').map(Number).filter(x => !isNaN(x));
            if (prod.tipo === 'cerdo') {
                Object.assign(PRODUCTOS.cerdo, { personas, precios, fileteadoGratis });
            } else if (prod.tipo === 'vaca') {
                Object.assign(PRODUCTOS.vaca, { personas, precios, fileteadoGratis });
            }
        });
    } catch (err) {
        console.error('Error cargando productos:', err);
    }
}

async function cargarSalsasDelAPI() {
    try {
        const response = await fetch('/api/salsas');
        if (!response.ok) throw new Error('API error');
        const data = await response.json();
        const activas = data.filter(s => s.activo === 'true' || s.activo === true);
        SALSAS_DATA = activas.length > 0 ? activas : salsasFallback();
    } catch {
        SALSAS_DATA = salsasFallback();
    }
}

function salsasFallback() {
    return [
        { nombre: 'Mayonesa Casera', imagen: 'mayonesa-casera.jpg' },
        { nombre: 'Mayonesa con Ajo', imagen: 'mayonesa-con-ajo.jpg' },
        { nombre: 'Gapanesa', imagen: 'gapanesa.jpg' },
        { nombre: 'Palta', imagen: 'palta.jpg' },
        { nombre: 'Ahumadita', imagen: 'ahumadita.jpg' },
        { nombre: 'Criolla', imagen: 'criolla.jpg' },
        { nombre: 'Garbanzos', imagen: 'garbanzos.jpg' },
        { nombre: 'Chimi', imagen: 'chimi.jpg' },
        { nombre: 'Cebolla Caramelizada', imagen: 'cebolla-caramelizada.jpg' }
    ];
}

// ─── Navegación wizard ────────────────────────────────────────────────────────

function irAPaso(numeroPaso) {
    if (numeroPaso === 4 && wizard.indiceVariante === null) {
        alert('Por favor, seleccioná una cantidad de personas');
        return;
    }

    const pasoActual = document.getElementById(`paso-${wizard.paso}`);
    const pasoNuevo = document.getElementById(`paso-${numeroPaso}`);
    if (!pasoNuevo) return;

    pasoActual.classList.add('saliendo');
    setTimeout(() => {
        pasoActual.classList.remove('active', 'saliendo');
        pasoNuevo.classList.add('active');
        wizard.paso = numeroPaso;
        actualizarProgreso();

        if (numeroPaso === 3) renderVariantes();
        if (numeroPaso === 4) renderSalsas();
        if (numeroPaso === 5) renderResumen();

        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 200);
}

function irAPasoAnterior() {
    if (wizard.paso > 1) irAPaso(wizard.paso - 1);
}

function actualizarProgreso() {
    const progressBar = document.getElementById('progressBar');
    const wizardNav = document.getElementById('wizardNav');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    if (wizard.paso === 1) {
        progressBar.classList.add('hidden');
        wizardNav.classList.add('hidden');
    } else {
        progressBar.classList.remove('hidden');
        wizardNav.classList.remove('hidden');
        const pct = ((wizard.paso - 1) / 4) * 100;
        progressFill.style.width = `${pct}%`;
        progressText.textContent = `Paso ${wizard.paso - 1} de 4`;
    }
}

// ─── Paso 2: Elegí tu pata ────────────────────────────────────────────────────

function seleccionarAnimal(tipo) {
    wizard.tipoPata = tipo;
    wizard.indiceVariante = null;
    wizard.tieneFileteado = false;

    document.getElementById('cardCerdo').classList.toggle('seleccionado', tipo === 'cerdo');
    document.getElementById('cardVaca').classList.toggle('seleccionado', tipo === 'vaca');

    setTimeout(() => irAPaso(3), 250);
}

// ─── Paso 3: Cantidad y fileteado ─────────────────────────────────────────────

function renderVariantes() {
    const tipo = wizard.tipoPata;
    const producto = PRODUCTOS[tipo];
    const grid = document.getElementById('variantesGrid');
    grid.innerHTML = '';

    producto.personas.forEach((personas, indice) => {
        const precio = producto.precios[indice];
        const btn = document.createElement('button');
        btn.className = 'variante-btn' + (wizard.indiceVariante === indice ? ' seleccionado' : '');
        btn.innerHTML = `<span class="v-personas">${personas} personas</span><span class="v-precio">${formatearPrecio(precio)}</span>`;
        btn.onclick = () => seleccionarVariante(indice);
        grid.appendChild(btn);
    });

    actualizarFileteado();
}

function seleccionarVariante(indice) {
    wizard.indiceVariante = indice;
    document.querySelectorAll('.variante-btn').forEach((btn, i) => {
        btn.classList.toggle('seleccionado', i === indice);
    });
    actualizarFileteado();
}

function actualizarFileteado() {
    const tipo = wizard.tipoPata;
    const indice = wizard.indiceVariante;
    const checkbox = document.getElementById('checkFileteado');
    const texto = document.getElementById('fileteadoTexto');

    if (indice === null) {
        checkbox.disabled = true;
        checkbox.checked = false;
        wizard.tieneFileteado = false;
        return;
    }

    const esGratis = PRODUCTOS[tipo].fileteadoGratis.includes(indice);

    if (esGratis) {
        checkbox.disabled = true;
        checkbox.checked = true;
        texto.textContent = 'Fileteado incluido gratis';
        wizard.tieneFileteado = true;
    } else {
        checkbox.disabled = false;
        checkbox.checked = wizard.tieneFileteado && !esGratis ? wizard.tieneFileteado : false;
        texto.textContent = '+ Fileteado (+$100/persona)';
        wizard.tieneFileteado = checkbox.checked;
    }

    checkbox.onchange = () => {
        wizard.tieneFileteado = checkbox.checked;
    };
}

// ─── Paso 4: Salsas ───────────────────────────────────────────────────────────

function renderSalsas() {
    const grid = document.getElementById('salsasGrid');
    grid.innerHTML = '';

    SALSAS_DATA.forEach(salsa => {
        const cantidad = wizard.salsasSeleccionadas[salsa.nombre] || 0;
        const div = document.createElement('div');
        div.className = 'salsa-item' + (cantidad > 0 ? ' seleccionado' : '');

        const inicial = salsa.nombre.charAt(0).toUpperCase();
        const imgBase = salsa.imagen ? salsa.imagen.replace(/\.\w+$/, '') : '';
        const imgSrc = imgBase ? `images/salsas/${imgBase}.jpg` : '';
        div.innerHTML = `
            <div class="salsa-imagen">
                ${imgSrc
                    ? `<img src="${imgSrc}" alt="${salsa.nombre}" onerror="this.style.display='none';this.parentElement.textContent='${inicial}'">`
                    : inicial}
            </div>
            <div class="salsa-nombre">${salsa.nombre}</div>
            <div class="salsa-cantidad-ctrl">
                <button class="salsa-ctrl-btn salsa-menos${cantidad === 0 ? ' invisible' : ''}">−</button>
                <span class="salsa-cnt">${cantidad > 0 ? cantidad : ''}</span>
                <button class="salsa-ctrl-btn salsa-mas">+</button>
            </div>
        `;

        div.querySelector('.salsa-menos').addEventListener('click', (e) => { e.stopPropagation(); ajustarSalsa(salsa.nombre, -1, div); });
        div.querySelector('.salsa-mas').addEventListener('click', (e) => { e.stopPropagation(); ajustarSalsa(salsa.nombre, 1, div); });
        div.addEventListener('click', () => { if ((wizard.salsasSeleccionadas[salsa.nombre] || 0) === 0) ajustarSalsa(salsa.nombre, 1, div); });

        grid.appendChild(div);
    });
    actualizarContadorSalsas();
}

function ajustarSalsa(nombre, delta, card) {
    const actual = wizard.salsasSeleccionadas[nombre] || 0;
    const nueva = Math.max(0, actual + delta);

    if (nueva === 0) {
        delete wizard.salsasSeleccionadas[nombre];
    } else {
        wizard.salsasSeleccionadas[nombre] = nueva;
    }

    card.classList.toggle('seleccionado', nueva > 0);
    card.querySelector('.salsa-cnt').textContent = nueva > 0 ? nueva : '';
    card.querySelector('.salsa-menos').classList.toggle('invisible', nueva === 0);
    actualizarContadorSalsas();
}

function actualizarContadorSalsas() {
    const el = document.getElementById('salsasContador');
    if (!el) return;
    const total = Object.values(wizard.salsasSeleccionadas).reduce((s, c) => s + c, 0);
    if (total === 0) {
        el.textContent = 'Ninguna salsa seleccionada';
        el.classList.remove('tiene-seleccion');
    } else {
        el.textContent = `${total} porción${total === 1 ? '' : 'es'} seleccionada${total === 1 ? '' : 's'}`;
        el.classList.add('tiene-seleccion');
    }
}

// ─── Paso 5: Resumen y envío ──────────────────────────────────────────────────

function renderResumen() {
    const tipo = wizard.tipoPata;
    const indice = wizard.indiceVariante;
    const producto = PRODUCTOS[tipo];
    const personas = producto.personas[indice];
    const precio = producto.precios[indice];
    const esGratis = producto.fileteadoGratis.includes(indice);
    const costoFileteado = (wizard.tieneFileteado && !esGratis) ? personas * 100 : 0;
    const total = precio + costoFileteado;

    const salsasEntries = Object.entries(wizard.salsasSeleccionadas).filter(([, c]) => c > 0);
    const salsasTexto = salsasEntries.length > 0
        ? salsasEntries.map(([nombre, cant]) => cant > 1 ? `${nombre} ×${cant}` : nombre).join(', ')
        : 'Sin salsas';

    let fileteadoTexto = 'No';
    if (wizard.tieneFileteado) {
        fileteadoTexto = esGratis ? 'Incluido gratis' : '+' + formatearPrecio(costoFileteado);
    }

    document.getElementById('resumenCard').innerHTML = `
        <div class="resumen-row">
            <span class="resumen-label">${producto.emoji} PATA:</span>
            <span class="resumen-valor">${producto.nombre} · ${personas} personas</span>
        </div>
        <div class="resumen-row">
            <span class="resumen-label">🔪 FILETEADO:</span>
            <span class="resumen-valor">${fileteadoTexto}</span>
        </div>
        <div class="resumen-row">
            <span class="resumen-label">🥫 SALSAS:</span>
            <span class="resumen-valor">${salsasTexto}</span>
        </div>
        <div class="resumen-total">
            <span>TOTAL</span>
            <span>${formatearPrecio(total)}</span>
        </div>
    `;
}

async function enviarPedido() {
    const nombre = document.getElementById('inputNombre').value.trim();
    const telefono = document.getElementById('inputTelefono').value.trim();

    if (!nombre) { alert('Por favor, completá tu nombre'); return; }
    if (!telefono) { alert('Por favor, completá tu número de WhatsApp'); return; }

    const tipo = wizard.tipoPata;
    const indice = wizard.indiceVariante;
    const producto = PRODUCTOS[tipo];
    const personas = producto.personas[indice];
    const precio = producto.precios[indice];

    const payload = {
        nombreCliente: nombre,
        telefonoCliente: telefono,
        salsas: Object.entries(wizard.salsasSeleccionadas)
            .filter(([, c]) => c > 0)
            .map(([nombre, cant]) => cant > 1 ? `${nombre} ×${cant}` : nombre),
        items: [{
            cantidad: personas,
            producto: `${producto.nombre} (${personas} personas)`,
            precioUnitario: precio,
            tieneFileteado: wizard.tieneFileteado
        }]
    };

    const btn = document.getElementById('btnEnviar');
    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
        const response = await fetch('/api/pedido', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (response.ok && result.success) {
            document.getElementById('successMessage').classList.add('show');
            animarConfeti();

            setTimeout(() => {
                resetWizard();
                btn.disabled = false;
                btn.textContent = 'ENVIAR PEDIDO POR WHATSAPP';
            }, 3000);
        } else {
            alert('Error: ' + (result.error || 'No se pudo enviar el pedido'));
            btn.disabled = false;
            btn.textContent = 'ENVIAR PEDIDO POR WHATSAPP';
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Error al enviar el pedido. Intenta de nuevo.');
        btn.disabled = false;
        btn.textContent = 'ENVIAR PEDIDO POR WHATSAPP';
    }
}

function resetWizard() {
    wizard.paso = 1;
    wizard.tipoPata = null;
    wizard.indiceVariante = null;
    wizard.tieneFileteado = false;
    wizard.salsasSeleccionadas = {};

    document.getElementById('inputNombre').value = '';
    document.getElementById('inputTelefono').value = '';
    document.getElementById('successMessage').classList.remove('show');
    document.getElementById('cardCerdo').classList.remove('seleccionado');
    document.getElementById('cardVaca').classList.remove('seleccionado');

    document.querySelectorAll('.paso').forEach(p => p.classList.remove('active', 'saliendo'));
    document.getElementById('paso-1').classList.add('active');
    actualizarProgreso();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

function formatearPrecio(precio) {
    return '$' + precio.toLocaleString('es-AR');
}

function animarConfeti() {
    const container = document.getElementById('confetti');
    const colors = ['#FFD000', '#1A1A1A', '#FFFFFF', '#FFD000', '#FFB800'];
    const shapes = ['2px', '50%', '0'];

    for (let i = 0; i < 70; i++) {
        const confetti = document.createElement('div');
        confetti.classList.add('confetti');
        const size = Math.random() * 8 + 6;
        confetti.style.left = Math.random() * 100 + '%';
        confetti.style.top = '-20px';
        confetti.style.width = size + 'px';
        confetti.style.height = (Math.random() > 0.5 ? size : size * 2) + 'px';
        confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        confetti.style.borderRadius = shapes[Math.floor(Math.random() * shapes.length)];
        confetti.style.animationDuration = (Math.random() * 1.8 + 2) + 's';
        confetti.style.animationDelay = Math.random() * 0.8 + 's';
        container.appendChild(confetti);
        setTimeout(() => confetti.remove(), 4000);
    }
}
