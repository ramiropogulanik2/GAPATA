// Modal de alerta/confirmación con estilo de marca, en reemplazo de alert()/confirm() nativos.
// Compartido entre index.html y admin.html.

/* Muestra el modal con un mensaje y un solo botón "Aceptar".
   tipo: 'error' (⚠️) o 'exito' (✅). Devuelve una Promise que resuelve cuando se cierra,
   para poder encadenar código después de que el usuario lo confirme (ej: recargar la página). */
function mostrarAlerta(mensaje, tipo = 'error') {
    return mostrarModalAlerta(mensaje, tipo, false);
}

/* Muestra el modal con botones "Confirmar" y "Cancelar".
   Devuelve una Promise<boolean>: true si el usuario confirma, false si cancela. */
function mostrarConfirm(mensaje) {
    return mostrarModalAlerta(mensaje, 'error', true).then((resultado) => resultado === true);
}

function mostrarModalAlerta(mensaje, tipo, esConfirm) {
    const overlay = document.getElementById('modal-alerta');
    const icono = document.getElementById('modalAlertaIcono');
    const titulo = document.getElementById('modalAlertaTitulo');
    const texto = document.getElementById('modalAlertaMensaje');
    const btnAceptar = document.getElementById('modalAlertaAceptar');
    const btnCancelar = document.getElementById('modalAlertaCancelar');

    icono.textContent = tipo === 'exito' ? '✅' : '⚠️';
    titulo.textContent = esConfirm ? 'Confirmar' : (tipo === 'exito' ? 'Listo' : 'Atención');
    texto.textContent = mensaje;
    btnCancelar.classList.toggle('oculto', !esConfirm);

    overlay.classList.add('show');

    return new Promise((resolve) => {
        const cerrar = (resultado) => {
            overlay.classList.remove('show');
            btnAceptar.removeEventListener('click', onAceptar);
            btnCancelar.removeEventListener('click', onCancelar);
            resolve(resultado);
        };
        const onAceptar = () => cerrar(true);
        const onCancelar = () => cerrar(false);

        btnAceptar.addEventListener('click', onAceptar);
        btnCancelar.addEventListener('click', onCancelar);
    });
}
