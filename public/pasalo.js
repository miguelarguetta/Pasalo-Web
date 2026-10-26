const API_URL = '/api';

// ---------- Autenticación ----------
function getToken() { return localStorage.getItem('token_pasalo'); }
function setToken(token) { localStorage.setItem('token_pasalo', token); }
function fetchAuth(url, options = {}) {
  const token = getToken();
  const headers = { ...options.headers, 'Authorization': token ? `Bearer ${token}` : '' };
  return fetch(url, { ...options, headers });
}

async function getUsuarioActual() {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetchAuth(`${API_URL}/me`);
    if (!res.ok) { setToken(''); return null; }
    const data = await res.json();
    if (data.usuario && data.usuario.rol === 'Admin') {
      localStorage.setItem('es_admin', 'true');
    } else {
      localStorage.removeItem('es_admin');
    }
    return data.usuario;
  } catch { return null; }
}

async function requireAuth() {
  const user = await getUsuarioActual();
  if (!user) { window.location.href = 'login.html'; return null; }
  return user;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

async function cargarCategoriasSelect(selectIds = []) {
  try {
    const res = await fetch(`${API_URL}/categorias`);
    const categorias = await res.json();
    selectIds.forEach(id => {
      const select = document.getElementById(id);
      if (!select) return;
      select.innerHTML = select.dataset.defaultOption || '<option value="">Selecciona Categoría</option>';
      categorias.forEach(cat => {
        select.innerHTML += `<option value="${cat.id}">${escapeHtml(cat.nombre)}</option>`;
      });
    });
  } catch (err) { console.error('Error categorías:', err); }
}

function abrirModal(id) { document.getElementById(id)?.classList.add('active'); }
function cerrarModal(id) { document.getElementById(id)?.classList.remove('active'); }

// ---------- Menú de Usuario y Hamburguesa ----------
function toggleMenuUsuario() {
  const dropdown = document.getElementById('dropdownUsuario');
  if (dropdown) dropdown.classList.toggle('active');
}

document.addEventListener('click', (e) => {
  // Cerrar dropdown de usuario al hacer clic fuera
  const container = document.querySelector('.user-menu-container');
  const dropdown = document.getElementById('dropdownUsuario');
  if (container && dropdown && !container.contains(e.target)) {
    dropdown.classList.remove('active');
  }
  
  // Cerrar menú hamburguesa al hacer clic en un enlace
  if (e.target.closest('nav a')) {
    document.querySelector('nav')?.classList.remove('active');
  }
});

// ---------- Chat ----------
let chatActiveContext = { receptor_id: null, publicacion_id: null, nombre: null };

async function abrirModalBandejaMensajes() {
  const user = await requireAuth();
  if (!user) return;
  abrirModal('modalChat');
  await cargarConversacionesBandeja();
}

async function cargarConversacionesBandeja() {
  try {
    const res = await fetchAuth(`${API_URL}/conversaciones`);
    if (!res.ok) return;
    const conversaciones = await res.json();
    const listContainer = document.getElementById('listaConversaciones');
    if (!listContainer) return;
    listContainer.innerHTML = '';
    if (!conversaciones.length) {
      listContainer.innerHTML = '<p style="font-size:0.8rem;color:#94a3b8;">Sin chats activos</p>';
      return;
    }
    conversaciones.forEach(c => {
      const nombreSeguro = escapeHtml(c.contacto_nombre).replace(/'/g, "\\'");
      listContainer.innerHTML += `
        <div class="conv-item" onclick="seleccionarConversacion(${c.contacto_id}, ${c.publicacion_id}, '${nombreSeguro}')">
          <strong>${escapeHtml(c.contacto_nombre)}</strong>
          <div style="font-size:0.75rem;color:#cbd5e1;">Prod: ${escapeHtml(c.publicacion_titulo)}</div>
        </div>`;
    });
  } catch (err) { console.error('Error chats:', err); }
}

async function seleccionarConversacion(contactoId, publicacionId, contactoNombre) {
  chatActiveContext = { receptor_id: contactoId, publicacion_id: publicacionId, nombre: contactoNombre };
  const title = document.getElementById('chatTitle');
  if (title) title.textContent = `Chat con ${contactoNombre}`;
  const chatBox = document.getElementById('chatMessages');
  if (chatBox) chatBox.innerHTML = '<p style="font-size:0.8rem; color:#94a3b8;">Cargando mensajes...</p>';
  
  const modalHeader = document.querySelector('#modalChat .modal-header');
  const oldBtn = document.getElementById('btnCerrarTrato');
  if (oldBtn) oldBtn.remove();

  try {
    const res = await fetch(`${API_URL}/publicaciones/${publicacionId}`);
    if (res.ok) {
      const pub = await res.json();
      const user = await getUsuarioActual();
      if (user && Number(pub.usuario_id) === Number(user.id) && pub.estado === 'Disponible') {
        const btnHTML = document.createElement('button');
        btnHTML.id = 'btnCerrarTrato';
        btnHTML.className = 'btn-primary';
        btnHTML.style.background = '#10b981';
        btnHTML.innerHTML = '<i class="fa-solid fa-handshake"></i> Cerrar Trato';
        btnHTML.onclick = cerrarTrato;
        modalHeader.insertBefore(btnHTML, modalHeader.querySelector('button'));
      }
    }
  } catch (err) { console.error(err); }
  cargarMensajes();
}

async function iniciarChatDirecto(vendedorId, publicacionId, vendedorNombre) {
  const user = await requireAuth();
  if (!user) return;
  chatActiveContext = { receptor_id: vendedorId, publicacion_id: publicacionId, nombre: vendedorNombre };
  const title = document.getElementById('chatTitle');
  if (title) title.textContent = `Chat con ${vendedorNombre}`;
  abrirModal('modalChat');
  
  const modalHeader = document.querySelector('#modalChat .modal-header');
  const oldBtn = document.getElementById('btnCerrarTrato');
  if (oldBtn) oldBtn.remove();

  if (Number(vendedorId) === Number(user.id)) {
    const btnHTML = document.createElement('button');
    btnHTML.id = 'btnCerrarTrato';
    btnHTML.className = 'btn-primary';
    btnHTML.style.background = '#10b981';
    btnHTML.innerHTML = '<i class="fa-solid fa-handshake"></i> Cerrar Trato';
    btnHTML.onclick = cerrarTrato;
    modalHeader.insertBefore(btnHTML, modalHeader.querySelector('button'));
  }
  await cargarConversacionesBandeja();
  cargarMensajes();
}

async function cerrarTrato() {
  if (!chatActiveContext.publicacion_id) return;
  if (!confirm('¿Marcar esta publicación como VENDIDA? Se generará una boleta digital.')) return;

  const res = await fetchAuth(`${API_URL}/publicaciones/${chatActiveContext.publicacion_id}/vender`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comprador_id: chatActiveContext.receptor_id })
  });

  if (res.ok) {
    const data = await res.json();
    mostrarBoletaPDF(data.boleta);
    await cargarMensajes();
    const oldBtn = document.getElementById('btnCerrarTrato');
    if (oldBtn) oldBtn.remove();
  } else {
    alert('No se pudo cerrar el trato. Asegúrate de ser el dueño del artículo.');
  }
}

async function cargarMensajes() {
  if (!chatActiveContext.publicacion_id) return;
  try {
    const res = await fetchAuth(`${API_URL}/mensajes?publicacion_id=${chatActiveContext.publicacion_id}`);
    if (!res.ok) return;
    const mensajes = await res.json();
    const user = await getUsuarioActual();
    const chatBox = document.getElementById('chatMessages');
    if (!chatBox) return;
    chatBox.innerHTML = '';
    if(mensajes.length === 0) {
      chatBox.innerHTML = '<p style="font-size:0.8rem; color:#94a3b8; text-align:center;">No hay mensajes aún.</p>';
      return;
    }
    mensajes.forEach(msg => {
      const isSent = user && Number(msg.emisor_id) === Number(user.id);
      chatBox.innerHTML += `<div class="chat-message ${isSent ? 'sent' : 'received'}">${escapeHtml(msg.contenido)}</div>`;
    });
    chatBox.scrollTop = chatBox.scrollHeight;
  } catch (err) { console.error('Error mensajes:', err); }
}

async function enviarMensaje(e) {
  e.preventDefault();
  const user = await requireAuth();
  if (!user) return;
  const textoInput = document.getElementById('mensajeTexto');
  const texto = textoInput.value.trim();
  if (!texto || !chatActiveContext.publicacion_id) return;
  textoInput.disabled = true;
  const res = await fetchAuth(`${API_URL}/mensajes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receptor_id: chatActiveContext.receptor_id, publicacion_id: chatActiveContext.publicacion_id, contenido: texto })
  });
  textoInput.disabled = false;
  if (!res.ok) return alert('Error al enviar.');
  textoInput.value = '';
  textoInput.focus();
  cargarMensajes();
}

// ---------- Notificaciones ----------
async function revisarNotificaciones() {
  const user = await getUsuarioActual();
  if (!user) return;
  try {
    const res = await fetchAuth(`${API_URL}/notificaciones`);
    if (!res.ok) return;
    const notifs = await res.json();
    const campana = document.getElementById('campanaNotificaciones');
    const badge = document.getElementById('badgeNotificaciones');
    if (!campana) return;
    if (notifs.length > 0) {
      badge.style.display = 'flex';
      badge.textContent = notifs.length;
    } else {
      badge.style.display = 'none';
    }
  } catch (err) { console.error(err); }
}

async function abrirNotificaciones() {
  const user = await getUsuarioActual();
  if (!user) return;
  const res = await fetchAuth(`${API_URL}/notificaciones`);
  if (res.ok) {
    const notifs = await res.json();
    if (notifs.length === 0) return alert("No tienes notificaciones nuevas.");
    let texto = "🔔 TUS NOTIFICACIONES:\n\n";
    notifs.forEach(n => { texto += `- ${n.mensaje}\n`; });
    alert(texto);
    await fetchAuth(`${API_URL}/notificaciones/leer`, { method: 'PUT' });
    const badge = document.getElementById('badgeNotificaciones');
    if (badge) badge.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (typeof getUsuarioActual === 'function') {
    revisarNotificaciones();
    setInterval(revisarNotificaciones, 3000);
  }
});

// ---------- Modo Claro / Oscuro ----------
function toggleTema() {
  document.body.classList.toggle('light-mode');
  const isLight = document.body.classList.contains('light-mode');
  localStorage.setItem('tema_pasalo', isLight ? 'light' : 'dark');
  actualizarIconoTema();
}

function actualizarIconoTema() {
  const icon = document.getElementById('iconoTema');
  if (!icon) return;
  if (document.body.classList.contains('light-mode')) {
    icon.className = 'fa-solid fa-moon';
  } else {
    icon.className = 'fa-solid fa-sun';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const temaGuardado = localStorage.getItem('tema_pasalo');
  if (temaGuardado === 'light') {
    document.body.classList.add('light-mode');
  }
  actualizarIconoTema();
});

// ---------- BOLETA DIGITAL Y PDF ----------
function mostrarBoletaPDF(datos) {
  let modal = document.getElementById('modalBoleta');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modalBoleta';
    modal.className = 'modal';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="modal-content" style="max-width: 450px; text-align: center;">
      <div class="modal-header" style="border: none; justify-content: center; padding-bottom: 0;">
        <h2 style="color: var(--accent); font-size: 2rem;"><i class="fa-solid fa-check-circle"></i></h2>
      </div>
      <h3 style="margin-bottom: 1.5rem; font-size: 1.5rem;">¡Trato Cerrado!</h3>
      <div style="background: rgba(0,0,0,0.2); padding: 1.5rem; border-radius: 12px; border: 1px dashed var(--border); text-align: left; margin-bottom: 1.5rem;">
        <p style="margin-bottom: 0.5rem;"><strong>Artículo:</strong> ${escapeHtml(datos.articulo)}</p>
        <p style="margin-bottom: 0.5rem;"><strong>Comprador:</strong> ${escapeHtml(datos.comprador)}</p>
        <p style="margin-bottom: 0.5rem;"><strong>Precio Final:</strong> $${Number(datos.precio).toFixed(2)}</p>
        <p><strong>Fecha:</strong> ${datos.fecha}</p>
      </div>
      <div style="display: flex; gap: 1rem; justify-content: center;">
        <button class="btn-primary" style="background: #ef4444;" onclick="document.getElementById('modalBoleta').classList.remove('active')">Cerrar</button>
        <button class="btn-primary" onclick='descargarPDF(${JSON.stringify(datos)})'><i class="fa-solid fa-file-pdf"></i> Descargar PDF</button>
      </div>
    </div>
  `;
  modal.classList.add('active');
}

function descargarPDF(datos) {
  if (!window.jspdf) return alert("Error: La librería de PDFs no está cargada.");
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(22); doc.setTextColor(16, 185, 129);
  doc.text("Pásalo - Boleta de Venta", 105, 20, null, null, "center");
  doc.setFontSize(12); doc.setTextColor(100);
  doc.text("Comprobante de Transacción Académica", 105, 30, null, null, "center");
  doc.setDrawColor(200); doc.line(20, 35, 190, 35);
  doc.setFontSize(14); doc.setTextColor(0);
  doc.text(`Artículo:`, 20, 50); doc.setFontSize(12); doc.text(datos.articulo, 60, 50);
  doc.setFontSize(14); doc.text(`Comprador:`, 20, 65); doc.setFontSize(12); doc.text(datos.comprador, 60, 65);
  doc.setFontSize(14); doc.text(`Precio:`, 20, 80); doc.setFontSize(12); doc.text(`$${Number(datos.precio).toFixed(2)}`, 60, 80);
  doc.setFontSize(14); doc.text(`Fecha:`, 20, 95); doc.setFontSize(12); doc.text(datos.fecha, 60, 95);
  doc.setDrawColor(200); doc.line(20, 105, 190, 105);
  doc.setFontSize(10); doc.setTextColor(150);
  doc.text("Este documento es un comprobante interno generado por Pásalo.", 105, 120, null, null, "center");
  doc.save(`Boleta_Pasalo_${datos.articulo.replace(/\s+/g, '_')}.pdf`);
}

// ---------- Cerrar Sesión ----------
function cerrarSesion() {
  localStorage.removeItem('token_pasalo');
  localStorage.removeItem('es_admin');
  window.location.href = 'login.html';
}