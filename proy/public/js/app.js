// Datos de productos (hardcoded default fallback)
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

// Función para cargar productos desde la API
async function cargarProductosDelAPI() {
    try {
        const response = await fetch('/api/productos');
        if (response.ok) {
            const data = await response.json();
            // Mapear datos de API a estructura local
            data.forEach(prod => {
                const personas = prod.variantes.split('|').map(Number);
                const precios = prod.precios.split('|').map(Number);
                const fileteadoGratis = (prod.fileteadoIncluido || '').split('|').map(Number).filter(x => !isNaN(x));

                if (prod.activo !== 'true' && prod.activo !== true) {
                    return;
                }

                if (prod.tipo === 'cerdo') {
                    PRODUCTOS.cerdo.personas = personas;
                    PRODUCTOS.cerdo.precios = precios;
                    PRODUCTOS.cerdo.fileteadoGratis = fileteadoGratis;
                } else if (prod.tipo === 'vaca') {
                    PRODUCTOS.vaca.personas = personas;
                    PRODUCTOS.vaca.precios = precios;
                    PRODUCTOS.vaca.fileteadoGratis = fileteadoGratis;
                }
            });
        }
    } catch (err) {
        console.error('Error cargando productos de API:', err);
    }
}

let SALSAS = [
    'Mayonesa Casera',
    'Mayonesa con Ajo',
    'Gapanesa',
    'Palta',
    'Ahumadita',
    'Criolla',
    'Garbanzos',
    'Chimi',
    'Cebolla Caramelizada'
];

async function cargarSalsasDelAPI() {
    try {
        const response = await fetch('/api/salsas');
        if (response.ok) {
            const data = await response.json();
            const activas = data
                .filter(salsa => salsa.activo === 'true' || salsa.activo === true)
                .map(salsa => salsa.nombre)
                .filter(Boolean);

            if (activas.length > 0) {
                SALSAS = activas;
            }
        }
    } catch (err) {
        console.error('Error cargando salsas de API:', err);
    }
}

let carrito = [];

// Inicializar la página
document.addEventListener('DOMContentLoaded', () => {
    Promise.all([cargarProductosDelAPI(), cargarSalsasDelAPI()]).then(() => {
        inicializarSelects();
        inicializarSalsas();
        actualizarContadorCarrito();
    });
});

function inicializarSelects() {
    const selectCerdo = document.getElementById('selectCerdo');
    const selectVaca = document.getElementById('selectVaca');

    selectCerdo.addEventListener('change', (e) => actualizarPrecio('cerdo', e.target.value));
    selectVaca.addEventListener('change', (e) => actualizarPrecio('vaca', e.target.value));

    // Inicializar estado del fileteado
    actualizarEstadoFileteado('cerdo');
    actualizarEstadoFileteado('vaca');
}

function actualizarPrecio(producto, indiceString) {
    const indice = parseInt(indiceString);
    const precioDisplay = document.getElementById(`precio${producto.charAt(0).toUpperCase() + producto.slice(1)}`);
    const checkboxFileteado = document.getElementById(`fileteado${producto.charAt(0).toUpperCase() + producto.slice(1)}`);

    if (isNaN(indice)) {
        precioDisplay.textContent = 'Selecciona cantidad';
        return;
    }

    const precioUnitario = PRODUCTOS[producto].precios[indice];
    precioDisplay.textContent = formatearPrecio(precioUnitario);

    // Actualizar estado del fileteado
    actualizarEstadoFileteado(producto, indice);
}

function actualizarEstadoFileteado(producto, indice = null) {
    const checkboxFileteado = document.getElementById(`fileteado${producto.charAt(0).toUpperCase() + producto.slice(1)}`);
    const labelFileteado = document.getElementById(`fileteadoLabel${producto.charAt(0).toUpperCase() + producto.slice(1)}`);
    const textFileteado = document.getElementById(`fileteadoText${producto.charAt(0).toUpperCase() + producto.slice(1)}`);

    if (indice === null || isNaN(indice)) {
        checkboxFileteado.disabled = true;
        textFileteado.textContent = '+ Fileteado (+$100/persona)';
        return;
    }

    const esGratis = PRODUCTOS[producto].fileteadoGratis.includes(indice);

    if (esGratis) {
        checkboxFileteado.disabled = true;
        checkboxFileteado.checked = true;
        textFileteado.textContent = 'Incluido';
    } else {
        checkboxFileteado.disabled = false;
        checkboxFileteado.checked = false;
        textFileteado.textContent = '+ Fileteado (+$100/persona)';
    }
}

function inicializarSalsas() {
    const salsasGrid = document.getElementById('salsasGrid');
    salsasGrid.innerHTML = '';

    SALSAS.forEach((salsa) => {
        const inicial = salsa.charAt(0);
        const salsaItem = document.createElement('div');
        const salsaImagen = document.createElement('div');
        const salsaNombre = document.createElement('div');
        const checkbox = document.createElement('input');

        salsaItem.className = 'salsa-item';
        salsaImagen.className = 'salsa-imagen';
        salsaNombre.className = 'salsa-nombre';
        checkbox.type = 'checkbox';
        checkbox.dataset.salsa = salsa;

        salsaImagen.textContent = inicial;
        salsaNombre.textContent = salsa;

        salsaItem.appendChild(salsaImagen);
        salsaItem.appendChild(salsaNombre);
        salsaItem.appendChild(checkbox);
        salsasGrid.appendChild(salsaItem);
    });
}

function agregarAlCarrito(producto) {
    const selectElement = document.getElementById(`select${producto.charAt(0).toUpperCase() + producto.slice(1)}`);
    const indice = parseInt(selectElement.value);

    if (isNaN(indice)) {
        alert('Por favor, selecciona una cantidad');
        return;
    }

    const datos = PRODUCTOS[producto];
    const cantidad = datos.personas[indice];
    const precioUnitario = datos.precios[indice];

    // Verificar salsas seleccionadas
    const salsasSeleccionadas = Array.from(document.querySelectorAll('input[data-salsa]:checked'))
        .map(checkbox => checkbox.getAttribute('data-salsa'));

    // Fileteado
    const checkboxFileteado = document.getElementById(`fileteado${producto.charAt(0).toUpperCase() + producto.slice(1)}`);
    const tieneFileteado = checkboxFileteado.checked;

    const item = {
        id: Math.random(),
        producto: `${datos.nombre} (${cantidad} personas)`,
        cantidad: 1,
        precioUnitario: precioUnitario,
        detalles: {
            cantidadPersonas: cantidad,
            tieneFileteado: tieneFileteado,
            salsas: salsasSeleccionadas
        }
    };

    carrito.push(item);
    actualizarContadorCarrito();
    actualizarVistaCarrito();

    // Reset selects
    selectElement.value = '';
    actualizarPrecio(producto, '');

    // Reset checkboxes de salsas
    document.querySelectorAll('input[data-salsa]').forEach(cb => cb.checked = false);

    // Abrir carrito
    abrirCarrito();
}

function actualizarContadorCarrito() {
    const contador = document.getElementById('contadorCarrito');
    contador.textContent = carrito.length;
}

function actualizarVistaCarrito() {
    const carritoItems = document.getElementById('carritoItems');
    const totalCarrito = document.getElementById('totalCarrito');

    if (carrito.length === 0) {
        carritoItems.innerHTML = '<p class="empty-cart">No hay items en el carrito</p>';
        totalCarrito.textContent = '$0';
        return;
    }

    carritoItems.innerHTML = carrito.map(item => `
        <div class="carrito-item">
            <div class="item-info">
                <div class="item-nombre">${item.producto}</div>
                <div class="item-detalle">
                    ${item.detalles.tieneFileteado ? '✓ Con Fileteado · ' : ''}
                    ${item.detalles.salsas.length > 0 ? item.detalles.salsas.length + ' salsa(s)' : ''}
                </div>
            </div>
            <div class="item-precio">${formatearPrecio(item.precioUnitario)}</div>
            <button class="btn-eliminar" onclick="eliminarDelCarrito(${item.id})">✕</button>
        </div>
    `).join('');

    const total = carrito.reduce((sum, item) => sum + item.precioUnitario, 0);
    totalCarrito.textContent = formatearPrecio(total);
}

function eliminarDelCarrito(id) {
    carrito = carrito.filter(item => item.id !== id);
    actualizarContadorCarrito();
    actualizarVistaCarrito();
}

function abrirCarrito() {
    const modal = document.getElementById('carritoModal');
    const overlay = document.getElementById('modalOverlay');
    modal.classList.add('open');
    overlay.classList.add('open');
}

function cerrarCarrito() {
    const modal = document.getElementById('carritoModal');
    const overlay = document.getElementById('modalOverlay');
    modal.classList.remove('open');
    overlay.classList.remove('open');

    // Limpiar mensaje de éxito
    const successMessage = document.getElementById('successMessage');
    successMessage.classList.remove('show');
}

function formatearPrecio(precio) {
    return '$' + precio.toLocaleString('es-AR');
}

async function enviarPedido() {
    const nombre = document.getElementById('inputNombre').value.trim();
    const telefono = document.getElementById('inputTelefono').value.trim();

    // Validación
    if (!nombre) {
        alert('Por favor, completa tu nombre');
        return;
    }

    if (!telefono) {
        alert('Por favor, completa tu número de WhatsApp');
        return;
    }

    if (carrito.length === 0) {
        alert('Por favor, agrega al menos un item al carrito');
        return;
    }

    // Preparar datos
    const total = carrito.reduce((sum, item) => sum + item.precioUnitario, 0);
    const items = carrito.map(item => ({
        cantidad: item.detalles.cantidadPersonas,
        producto: item.producto,
        precioUnitario: item.precioUnitario
    }));

    const payload = {
        nombreCliente: nombre,
        telefonoCliente: telefono,
        items: items,
        total: total
    };

    const btnEnviar = document.querySelector('.btn-enviar');
    btnEnviar.disabled = true;
    btnEnviar.textContent = 'Enviando...';

    try {
        const response = await fetch('/api/pedido', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (response.ok && result.success) {
            // Mostrar éxito
            const successMessage = document.getElementById('successMessage');
            successMessage.classList.add('show');

            // Animar confeti
            animarConfeti();

            // Limpiar carrito
            setTimeout(() => {
                carrito = [];
                actualizarContadorCarrito();
                actualizarVistaCarrito();
                document.getElementById('inputNombre').value = '';
                document.getElementById('inputTelefono').value = '';
                btnEnviar.disabled = false;
                btnEnviar.textContent = 'ENVIAR PEDIDO POR WHATSAPP';

                setTimeout(() => {
                    cerrarCarrito();
                }, 2000);
            }, 1500);
        } else {
            alert('Error: ' + (result.error || 'No se pudo enviar el pedido'));
            btnEnviar.disabled = false;
            btnEnviar.textContent = 'ENVIAR PEDIDO POR WHATSAPP';
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Error al enviar el pedido. Intenta de nuevo.');
        btnEnviar.disabled = false;
        btnEnviar.textContent = 'ENVIAR PEDIDO POR WHATSAPP';
    }
}

function animarConfeti() {
    const container = document.getElementById('confetti');
    const colors = ['var(--amarillo)', 'var(--negro)', 'var(--blanco)'];

    for (let i = 0; i < 50; i++) {
        const confetti = document.createElement('div');
        confetti.classList.add('confetti');
        confetti.style.left = Math.random() * 100 + '%';
        confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        confetti.style.animationDuration = (Math.random() * 1.5 + 2) + 's';
        confetti.style.animationDelay = Math.random() * 0.5 + 's';
        container.appendChild(confetti);

        setTimeout(() => confetti.remove(), 3000);
    }
}

// Abrir carrito al hacer clic en botón flotante
document.getElementById('btnCarrito').addEventListener('click', abrirCarrito);
