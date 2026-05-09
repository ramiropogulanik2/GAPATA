let productos = [];
let salsas = [];

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
});

async function checkAuth() {
    try {
        const response = await fetch('/api/admin/session');
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
            body: JSON.stringify({ password })
        });

        if (response.ok) {
            await loadData();
            showAdminPanel();
            document.getElementById('passwordInput').value = '';
        } else {
            const errorMsg = document.getElementById('loginError');
            errorMsg.textContent = 'Contraseña incorrecta';
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
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            alert('Datos reseteados. Recargarando página...');
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
        await fetch('/api/admin/logout', { method: 'POST' });
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

function renderTablaProductos() {
    const tbody = document.getElementById('productsTable');
    tbody.innerHTML = '';

    productos.forEach((producto, index) => {
        const row = document.createElement('tr');

        const variantes = producto.variantes ? producto.variantes.split('|') : [];
        const precios = producto.precios ? producto.precios.split('|') : [];
        const fileteadoIncluido = producto.fileteadoIncluido ? producto.fileteadoIncluido.split('|') : [];
        const activo = producto.activo === 'true' || producto.activo === true;

        row.innerHTML = `
            <td><input type="text" value="${escapeHtml(producto.nombre)}" onchange="updateProducto(${index}, 'nombre', this.value)"></td>
            <td><input type="text" value="${escapeHtml(producto.tipo)}" onchange="updateProducto(${index}, 'tipo', this.value)"></td>
            <td style="font-size: 11px;">${variantes.join(', ')}</td>
            <td>
                <div style="max-height: 100px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;">
                    ${variantes.map((v, i) => `
                        <input type="text" value="${escapeHtml(precios[i] || '')}" placeholder="Personas: ${escapeHtml(v)}" onchange="updateProducto(${index}, 'precio', ${i}, this.value)" style="width: 100%;">
                    `).join('')}
                </div>
            </td>
            <td>
                <div style="max-height: 100px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;">
                    ${variantes.map((v, i) => `
                        <label style="display: flex; align-items: center; gap: 5px; font-size: 11px;">
                            <input type="checkbox" ${fileteadoIncluido.includes(String(i)) ? 'checked' : ''} onchange="updateProducto(${index}, 'fileteado', ${i}, this.checked)">
                            ${escapeHtml(v)} personas
                        </label>
                    `).join('')}
                </div>
            </td>
            <td>
                <label class="toggle">
                    <input type="checkbox" ${activo ? 'checked' : ''} onchange="updateProducto(${index}, 'activo', this.checked)">
                    <span class="slider"></span>
                </label>
            </td>
        `;

        tbody.appendChild(row);
    });
}

function renderTablaSalsas() {
    const tbody = document.getElementById('salsasTable');
    tbody.innerHTML = '';

    salsas.forEach((salsa, index) => {
        const row = document.createElement('tr');
        const activo = salsa.activo === 'true' || salsa.activo === true;

        row.innerHTML = `
            <td><input type="text" value="${escapeHtml(salsa.nombre)}" onchange="updateSalsa(${index}, 'nombre', this.value)"></td>
            <td><input type="text" value="${escapeHtml(salsa.imagen)}" onchange="updateSalsa(${index}, 'imagen', this.value)"></td>
            <td>
                <label class="toggle">
                    <input type="checkbox" ${activo ? 'checked' : ''} onchange="updateSalsa(${index}, 'activo', this.checked)">
                    <span class="slider"></span>
                </label>
            </td>
        `;

        tbody.appendChild(row);
    });
}

function updateProducto(index, field, subIndex, value) {
    if (field === 'nombre' || field === 'tipo') {
        productos[index][field] = value;
    } else if (field === 'precio') {
        let precios = productos[index].precios.split('|');
        precios[subIndex] = value;
        productos[index].precios = precios.join('|');
    } else if (field === 'fileteado') {
        let fileteado = productos[index].fileteadoIncluido.split('|').filter(x => x);
        const idxStr = String(subIndex);
        if (value && !fileteado.includes(idxStr)) {
            fileteado.push(idxStr);
        } else if (!value && fileteado.includes(idxStr)) {
            fileteado = fileteado.filter(x => x !== idxStr);
        }
        productos[index].fileteadoIncluido = fileteado.join('|');
    } else if (field === 'activo') {
        productos[index].activo = value ? 'true' : 'false';
    }
}

function updateSalsa(index, field, value) {
    salsas[index][field] = value;
    if (field === 'activo') {
        salsas[index].activo = value ? 'true' : 'false';
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

function switchTab(tab) {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

    // Show selected tab
    document.getElementById(`tab-${tab}`).classList.add('active');
    event.target.classList.add('active');
}
