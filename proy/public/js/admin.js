let productos = [];
let salsas = [];

document.addEventListener('DOMContentLoaded', () => {
    bindAdminListeners();
    checkAuth();
});

function bindAdminListeners() {
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('btnReset').addEventListener('click', resetHojas);
    document.getElementById('btnLogout').addEventListener('click', logout);
    document.getElementById('tabBtnProductos').addEventListener('click', (e) => switchTab('productos', e.currentTarget));
    document.getElementById('tabBtnSalsas').addEventListener('click', (e) => switchTab('salsas', e.currentTarget));
    document.getElementById('saveProductsBtn').addEventListener('click', guardarProductos);
    document.getElementById('saveSalsasBtn').addEventListener('click', guardarSalsas);
}

async function checkAuth() {
    try {
        const response = await fetch('/api/admin/session', { credentials: 'include' });
        if (response.status === 401) {
            showLoginPanel();
        } else {
            await loadData();
            showAdminPanel();
        }
    } catch (err) {
        console.error('Error checking auth:', err);
        showLoginPanel();
    }
}

async function handleLogin(event) {
    event.preventDefault();
    const password = document.getElementById('passwordInput').value;

    try {
        const response = await fetch('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ password })
        });

        if (response.ok) {
            await loadData();
            showAdminPanel();
            document.getElementById('passwordInput').value = '';
        } else {
            const data = await response.json().catch(() => ({}));
            const errorMsg = document.getElementById('loginError');
            errorMsg.textContent = data.error || 'Contraseña incorrecta';
            errorMsg.classList.add('show');
        }
    } catch (err) {
        console.error('Error logging in:', err);
        const errorMsg = document.getElementById('loginError');
        errorMsg.textContent = 'Error al intentar iniciar sesión';
        errorMsg.classList.add('show');
    }
}

async function resetHojas() {
    if (!confirm('¿Estás seguro? Esto eliminará todos los datos de Productos y Salsas y los recreará con los valores iniciales.')) {
        return;
    }

    try {
        const response = await fetch('/api/admin/reset-hojas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });

        if (response.ok) {
            alert('Datos reseteados. Recargando página...');
            location.reload();
        } else {
            alert('Error al resetear datos');
        }
    } catch (err) {
        console.error('Error:', err);
        alert('Error al resetear datos');
    }
}

async function logout() {
    try {
        await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' });
    } finally {
        location.reload();
    }
}

function showLoginPanel() {
    document.getElementById('loginPanel').style.display = 'flex';
    document.getElementById('adminPanel').classList.remove('show');
}

function showAdminPanel() {
    document.getElementById('loginPanel').style.display = 'none';
    document.getElementById('adminPanel').classList.add('show');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function loadData() {
    await cargarProductos();
    await cargarSalsas();
}

async function cargarProductos() {
    try {
        const response = await fetch('/api/productos');
        if (response.ok) {
            productos = await response.json();
            renderTablaProductos();
        }
    } catch (err) {
        console.error('Error cargando productos:', err);
    }
}

async function cargarSalsas() {
    try {
        const response = await fetch('/api/salsas');
        if (response.ok) {
            salsas = await response.json();
            renderTablaSalsas();
        }
    } catch (err) {
        console.error('Error cargando salsas:', err);
    }
}

function crearInput(tipo, valor, placeholder) {
    const input = document.createElement('input');
    input.type = tipo;
    if (valor !== undefined) input.value = valor;
    if (placeholder) input.placeholder = placeholder;
    return input;
}

function renderTablaProductos() {
    const tbody = document.getElementById('productsTable');
    tbody.innerHTML = '';

    productos.forEach((producto, index) => {
        const tr = document.createElement('tr');
        const variantes = producto.variantes ? producto.variantes.split('|') : [];
        const precios = producto.precios ? producto.precios.split('|') : [];
        const fileteadoIncluido = producto.fileteadoIncluido ? producto.fileteadoIncluido.split('|') : [];
        const activo = producto.activo === 'true' || producto.activo === true;

        // Nombre
        const tdNombre = document.createElement('td');
        const inputNombre = crearInput('text', producto.nombre || '');
        inputNombre.addEventListener('change', (e) => updateProducto(index, 'nombre', null, e.target.value));
        tdNombre.appendChild(inputNombre);

        // Tipo
        const tdTipo = document.createElement('td');
        const inputTipo = crearInput('text', producto.tipo || '');
        inputTipo.addEventListener('change', (e) => updateProducto(index, 'tipo', null, e.target.value));
        tdTipo.appendChild(inputTipo);

        // Variantes (solo lectura)
        const tdVariantes = document.createElement('td');
        tdVariantes.style.fontSize = '11px';
        tdVariantes.textContent = variantes.join(', ');

        // Precios
        const tdPrecios = document.createElement('td');
        const divPrecios = document.createElement('div');
        divPrecios.style.cssText = 'max-height:100px;overflow-y:auto;display:flex;flex-direction:column;gap:4px';
        variantes.forEach((v, i) => {
            const input = crearInput('text', precios[i] || '', `Personas: ${v}`);
            input.style.width = '100%';
            input.addEventListener('change', (e) => updateProducto(index, 'precio', i, e.target.value));
            divPrecios.appendChild(input);
        });
        tdPrecios.appendChild(divPrecios);

        // Fileteado incluido
        const tdFileteado = document.createElement('td');
        const divFileteado = document.createElement('div');
        divFileteado.style.cssText = 'max-height:100px;overflow-y:auto;display:flex;flex-direction:column;gap:4px';
        variantes.forEach((v, i) => {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:11px';
            const cb = crearInput('checkbox');
            cb.checked = fileteadoIncluido.includes(String(i));
            cb.addEventListener('change', (e) => updateProducto(index, 'fileteado', i, e.target.checked));
            label.appendChild(cb);
            label.appendChild(document.createTextNode(`${escapeHtml(v)} personas`));
            divFileteado.appendChild(label);
        });
        tdFileteado.appendChild(divFileteado);

        // Activo toggle
        const tdActivo = document.createElement('td');
        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'toggle';
        const toggleCb = crearInput('checkbox');
        toggleCb.checked = activo;
        toggleCb.addEventListener('change', (e) => updateProducto(index, 'activo', null, e.target.checked));
        const toggleSpan = document.createElement('span');
        toggleSpan.className = 'slider';
        toggleLabel.appendChild(toggleCb);
        toggleLabel.appendChild(toggleSpan);
        tdActivo.appendChild(toggleLabel);

        tr.append(tdNombre, tdTipo, tdVariantes, tdPrecios, tdFileteado, tdActivo);
        tbody.appendChild(tr);
    });
}

function renderTablaSalsas() {
    const tbody = document.getElementById('salsasTable');
    tbody.innerHTML = '';

    salsas.forEach((salsa, index) => {
        const tr = document.createElement('tr');
        const activo = salsa.activo === 'true' || salsa.activo === true;

        // Nombre
        const tdNombre = document.createElement('td');
        const inputNombre = crearInput('text', salsa.nombre || '');
        inputNombre.addEventListener('change', (e) => updateSalsa(index, 'nombre', e.target.value));
        tdNombre.appendChild(inputNombre);

        // Imagen
        const tdImagen = document.createElement('td');
        const inputImagen = crearInput('text', salsa.imagen || '');
        inputImagen.addEventListener('change', (e) => updateSalsa(index, 'imagen', e.target.value));
        tdImagen.appendChild(inputImagen);

        // Activo toggle
        const tdActivo = document.createElement('td');
        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'toggle';
        const toggleCb = crearInput('checkbox');
        toggleCb.checked = activo;
        toggleCb.addEventListener('change', (e) => updateSalsa(index, 'activo', e.target.checked));
        const toggleSpan = document.createElement('span');
        toggleSpan.className = 'slider';
        toggleLabel.appendChild(toggleCb);
        toggleLabel.appendChild(toggleSpan);
        tdActivo.appendChild(toggleLabel);

        tr.append(tdNombre, tdImagen, tdActivo);
        tbody.appendChild(tr);
    });
}

function updateProducto(index, field, subIndex, value) {
    if (field === 'nombre' || field === 'tipo') {
        productos[index][field] = value;
    } else if (field === 'precio') {
        const precios = productos[index].precios.split('|');
        precios[subIndex] = value;
        productos[index].precios = precios.join('|');
    } else if (field === 'fileteado') {
        let fileteado = productos[index].fileteadoIncluido.split('|').filter(x => x);
        const idxStr = String(subIndex);
        if (value && !fileteado.includes(idxStr)) {
            fileteado.push(idxStr);
        } else if (!value) {
            fileteado = fileteado.filter(x => x !== idxStr);
        }
        productos[index].fileteadoIncluido = fileteado.join('|');
    } else if (field === 'activo') {
        productos[index].activo = value ? 'true' : 'false';
    }
}

function updateSalsa(index, field, value) {
    if (field === 'activo') {
        salsas[index].activo = value ? 'true' : 'false';
    } else {
        salsas[index][field] = value;
    }
}

async function guardarProductos() {
    const btn = document.getElementById('saveProductsBtn');
    const msg = document.getElementById('productsMessage');

    btn.disabled = true;
    btn.textContent = 'GUARDANDO...';

    try {
        const response = await fetch('/api/admin/productos', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(productos)
        });

        if (response.ok) {
            msg.textContent = '✓ Productos guardados correctamente';
            msg.classList.add('show', 'success');
            msg.classList.remove('error');
            setTimeout(() => msg.classList.remove('show'), 3000);
        } else {
            throw new Error('Error guardando');
        }
    } catch (err) {
        console.error('Error:', err);
        msg.textContent = '✗ Error al guardar productos';
        msg.classList.add('show', 'error');
        msg.classList.remove('success');
    } finally {
        btn.disabled = false;
        btn.textContent = 'GUARDAR PRODUCTOS';
    }
}

async function guardarSalsas() {
    const btn = document.getElementById('saveSalsasBtn');
    const msg = document.getElementById('salsasMessage');

    btn.disabled = true;
    btn.textContent = 'GUARDANDO...';

    try {
        const response = await fetch('/api/admin/salsas', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(salsas)
        });

        if (response.ok) {
            msg.textContent = '✓ Salsas guardadas correctamente';
            msg.classList.add('show', 'success');
            msg.classList.remove('error');
            setTimeout(() => msg.classList.remove('show'), 3000);
        } else {
            throw new Error('Error guardando');
        }
    } catch (err) {
        console.error('Error:', err);
        msg.textContent = '✗ Error al guardar salsas';
        msg.classList.add('show', 'error');
        msg.classList.remove('success');
    } finally {
        btn.disabled = false;
        btn.textContent = 'GUARDAR SALSAS';
    }
}

function switchTab(tab, btn) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    btn.classList.add('active');
}
