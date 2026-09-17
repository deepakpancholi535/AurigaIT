let token = localStorage.getItem('pharmacy_token');
let currentInventoryPage = 1;
let currentHistoryPage = 1;
let activeDispenseMed = null;

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const API_BASE = window.location.origin.includes(':3000') ? '/api' : (window.location.origin.startsWith('http') ? 'http://localhost:3000/api' : '/api');

const api = async (url, opt = {}) => {
  opt.headers = {
    ...(opt.headers || {}),
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
  const r = await fetch(API_BASE + url, opt);
  const text = await r.text();
  let d = {};
  try { d = text ? JSON.parse(text) : {}; } catch (e) {}
  if (r.status === 401 && token) {
    token = null;
    localStorage.removeItem('pharmacy_token');
    logged();
  }
  if (!r.ok) throw new Error(d.error?.message || d.message || `Request failed (${r.status})`);
  return d;
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Toast Notification System
function showToast(msg, type = 'info') {
  const container = $('#toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${esc(msg)}</span><button class="quiet" style="padding:2px 6px;color:inherit;" aria-label="Close toast">✕</button>`;
  toast.querySelector('button').onclick = () => toast.remove();
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// User Session & Auth
function logged() {
  const isLoggedIn = !!token;
  $('#loginView').classList.toggle('hidden', isLoggedIn);
  $('#appView').classList.toggle('hidden', !isLoggedIn);
  $('#logout').classList.toggle('hidden', !isLoggedIn);
  if (isLoggedIn) {
    $('#today').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    loadInventory(1);
    loadAlerts();
  }
}

// Login & Logout
$('#login').onsubmit = async e => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    const formData = Object.fromEntries(new FormData(e.target));
    const d = await api('/auth/login', { method: 'POST', body: JSON.stringify(formData) });
    token = d.token;
    localStorage.setItem('pharmacy_token', token);
    logged();
    showToast('Signed in successfully', 'success');
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
};

$('#logout').onclick = () => {
  token = null;
  localStorage.removeItem('pharmacy_token');
  logged();
  showToast('Signed out', 'info');
};

// Accessible Tab Navigation & Keyboard Handling
const tabButtons = Array.from($$('.tabs button'));
tabButtons.forEach((b, idx) => {
  b.onclick = () => activateTab(b);
  b.onkeydown = e => {
    if (e.key === 'ArrowRight') {
      const next = tabButtons[(idx + 1) % tabButtons.length];
      next.focus();
      activateTab(next);
    } else if (e.key === 'ArrowLeft') {
      const prev = tabButtons[(idx - 1 + tabButtons.length) % tabButtons.length];
      prev.focus();
      activateTab(prev);
    }
  };
});

function activateTab(b) {
  tabButtons.forEach(x => {
    x.classList.remove('active');
    x.setAttribute('aria-selected', 'false');
  });
  b.classList.add('active');
  b.setAttribute('aria-selected', 'true');
  
  $$('.page').forEach(x => x.classList.add('hidden'));
  const pageId = b.dataset.page;
  const pageEl = $('#' + pageId);
  if (pageEl) {
    pageEl.classList.remove('hidden');
    pageEl.focus();
  }

  if (pageId === 'inventory') loadInventory(currentInventoryPage);
  if (pageId === 'alerts') loadAlerts();
  if (pageId === 'history') loadHistory(currentHistoryPage);
}

// Search with Debounce
let searchTimeout;
const performSearch = async query => {
  const q = String(query ?? '').trim();
  if (!q) {
    $('#searchResults').innerHTML = '';
    return;
  }
  try {
    const d = await api('/search?q=' + encodeURIComponent(q));
    $('#searchResults').innerHTML = d.found
      ? d.data.map(m => `
        <article class="result">
          <div>
            <strong>${esc(m.name)}</strong>
            <small>${esc(m.generic_name || m.unit)} · ${m.total_physical_stock} physical stock</small>
            <div class="status ${m.in_date ? '' : 'off'}">${m.in_date ? 'IN DATE' : 'OUT OF DATE'}</div>
          </div>
          <div>
            <div class="stock">${m.sellable_stock}</div>
            <small>${esc(m.unit)} sellable</small>
            ${m.in_date ? `<button type="button" style="margin-top:8px;" onclick="openDispenseModal(${m.id}, '${esc(m.name)}', ${m.sellable_stock})">Dispense</button>` : ''}
          </div>
        </article>
      `).join('')
      : '<div class="result"><strong>No medicines found.</strong><p class="muted">Try searching another name or generic compound.</p></div>';
  } catch (err) {
    $('#searchResults').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
};

$('#search').onsubmit = e => {
  e.preventDefault();
  clearTimeout(searchTimeout);
  const q = new FormData(e.target).get('q');
  performSearch(q);
};

$('#searchInput').oninput = e => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => performSearch(e.target.value), 300);
};

// Safe Modal Helpers
function openModal(dlg) {
  if (!dlg) return;
  if (typeof dlg.showModal === 'function') {
    try {
      dlg.showModal();
    } catch (e) {
      dlg.setAttribute('open', '');
    }
  } else {
    dlg.setAttribute('open', '');
  }
}

function closeModal(dlg) {
  if (!dlg) return;
  if (typeof dlg.close === 'function') {
    try { dlg.close(); } catch (e) {}
  }
  dlg.removeAttribute('open');
}

// Custom Dispense Modal Dialog (Replacing window.prompt)
window.openDispenseModal = (id, name, max) => {
  activeDispenseMed = { id, name, max };
  $('#dispenseMedicineInfo').textContent = `${name} · Available in-date stock: ${max}`;
  const input = $('#dispenseQuantity');
  input.value = '1';
  input.max = max;
  $('#dispenseError').textContent = '';
  openModal($('#dispenseDialog'));
};

$('#cancelDispense').onclick = () => closeModal($('#dispenseDialog'));

$('#dispenseForm').onsubmit = async e => {
  e.preventDefault();
  if (!activeDispenseMed) return;
  const qVal = Number($('#dispenseQuantity').value);
  if (!Number.isInteger(qVal) || qVal < 1) {
    $('#dispenseError').textContent = 'Please enter a positive whole integer.';
    return;
  }
  try {
    const d = await api('/dispense', {
      method: 'POST',
      body: JSON.stringify({
        medicine_id: activeDispenseMed.id,
        quantity: qVal,
        idempotency_key: crypto.randomUUID()
      })
    });
    closeModal($('#dispenseDialog'));
    showToast(`Successfully dispensed ${d.dispensed} unit(s) of ${activeDispenseMed.name}!`, 'success');
    performSearch($('#searchInput').value);
  } catch (err) {
    $('#dispenseError').textContent = err.message;
  }
};

// Custom Batch Viewer Modal (Replacing window.alert)
window.showBatches = async (id, name) => {
  try {
    const d = await api('/medicines/' + id);
    const today = new Date().toISOString().slice(0, 10);
    $('#batchViewTitle').textContent = `${name} · FEFO Batches`;
    const contentHtml = (d.batches && d.batches.length)
      ? `
        <table class="batch-table" role="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Batch No</th>
              <th>Quantity</th>
              <th>Expiry Date</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${d.batches.map((b, i) => {
              const isExpired = b.expiry_date < today;
              return `
                <tr>
                  <td>${i + 1}</td>
                  <td><strong>${esc(b.batch_no)}</strong></td>
                  <td>${b.quantity}</td>
                  <td>${b.expiry_date}</td>
                  <td><span class="pill ${isExpired ? 'bad' : ''}">${isExpired ? 'EXPIRED' : 'IN DATE'}</span></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `
      : '<p class="muted" style="padding:16px 0;">No batches recorded for this medicine.</p>';
    
    $('#batchViewContent').innerHTML = contentHtml;
    openModal($('#batchViewDialog'));
  } catch (err) {
    showToast(err.message, 'error');
  }
};

$('#closeBatchView').onclick = () => closeModal($('#batchViewDialog'));

// Inventory Tab & Pagination
async function loadInventory(page = 1) {
  currentInventoryPage = page;
  try {
    const d = await api('/medicines?page=' + page + '&limit=10');
    $('#inventoryList').innerHTML = d.data.length
      ? d.data.map(m => `
        <div class="row">
          <div>
            <strong>${esc(m.name)}</strong>
            <small>${esc(m.generic_name || '')} · ${m.unit}</small>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <span class="pill ${m.in_date ? '' : 'bad'}">${m.sellable_stock} sellable</span>
            <button type="button" class="quiet btn-show-batches" data-id="${m.id}" data-name="${esc(m.name)}">FEFO batches</button>
            <button type="button" class="btn-new-batch" data-id="${m.id}" data-name="${esc(m.name)}">+ batch</button>
          </div>
        </div>
      `).join('')
      : '<p class="muted">No medicines added yet.</p>';

    renderPagination('#inventoryPagination', d.pagination, p => loadInventory(p));
  } catch (err) {
    $('#inventoryList').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// Event Delegation for Inventory List Buttons
$('#inventoryList').onclick = e => {
  const showBtn = e.target.closest('.btn-show-batches');
  if (showBtn) {
    showBatches(Number(showBtn.dataset.id), showBtn.dataset.name);
    return;
  }
  const newBtn = e.target.closest('.btn-new-batch');
  if (newBtn) {
    newBatch(Number(newBtn.dataset.id), newBtn.dataset.name);
    return;
  }
};

// Add Medicine Modal
$('#newMedicine').onclick = () => {
  $('#medicineForm').reset();
  $('#medicineError').textContent = '';
  openModal($('#medicineDialog'));
};
$('#cancelMedicine').onclick = () => closeModal($('#medicineDialog'));

$('#medicineForm').onsubmit = async e => {
  e.preventDefault();
  $('#medicineError').textContent = '';
  try {
    const body = Object.fromEntries(new FormData(e.target));
    await api('/medicines', { method: 'POST', body: JSON.stringify(body) });
    closeModal($('#medicineDialog'));
    e.target.reset();
    showToast('Medicine added successfully', 'success');
    loadInventory(currentInventoryPage);
  } catch (err) {
    $('#medicineError').textContent = err.message;
  }
};

// Add Batch Modal
window.newBatch = (id, name) => {
  $('#batchForm').reset();
  $('#batchMedicineId').value = id;
  $('#batchMedicine').textContent = `Adding batch for: ${name}`;
  $('#batchError').textContent = '';
  
  const today = new Date().toISOString().slice(0, 10);
  const future = new Date();
  future.setDate(future.getDate() + 90);
  if ($('#batchReceived')) $('#batchReceived').value = today;
  if ($('#batchExpiry')) $('#batchExpiry').value = future.toISOString().slice(0, 10);

  openModal($('#batchDialog'));
};
$('#cancelBatch').onclick = () => closeModal($('#batchDialog'));

$('#batchForm').onsubmit = async e => {
  e.preventDefault();
  $('#batchError').textContent = '';
  const o = Object.fromEntries(new FormData(e.target));
  const id = o.medicine_id;
  delete o.medicine_id;
  try {
    const d = await api('/medicines/' + id + '/batches', {
      method: 'POST',
      body: JSON.stringify({ ...o, quantity: Number(o.quantity) })
    });
    closeModal($('#batchDialog'));
    showToast('Batch added successfully', 'success');
    loadInventory(currentInventoryPage);
    if (d.warning) showToast(d.warning, 'info');
  } catch (err) {
    $('#batchError').textContent = err.message;
  }
};

// Expiry Watch Alerts
async function loadAlerts() {
  try {
    const n = $('#days').value || 30;
    const [a, b] = await Promise.all([
      api('/alerts/expiring-soon?days=' + n),
      api('/alerts/expired')
    ]);
    $('#soon').innerHTML = a.data.length
      ? a.data.map(x => `
        <div class="alert">
          <strong>${esc(x.medicine_name)}</strong><br>
          <small>Batch ${esc(x.batch_no)} · ${x.quantity} unit(s) · expires ${x.expiry_date}</small>
        </div>
      `).join('')
      : '<p class="muted">No stock expiring in this window.</p>';

    $('#expired').innerHTML = b.data.length
      ? b.data.map(x => `
        <div class="alert expired">
          <strong>${esc(x.medicine_name)}</strong><br>
          <small>Batch ${esc(x.batch_no)} · ${x.quantity} unit(s) · expired ${x.expiry_date}</small>
        </div>
      `).join('')
      : '<p class="muted">No expired stock found.</p>';

    $('#alertBadge').textContent = a.data.length + b.data.length;
  } catch (err) {
    $('#soon').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}
$('#days').onchange = loadAlerts;

// Audit Log Tab & Pagination
async function loadHistory(page = 1) {
  currentHistoryPage = page;
  try {
    const d = await api('/dispense-log?page=' + page + '&limit=10');
    $('#historyList').innerHTML = d.data.length
      ? d.data.map(x => `
        <div class="row">
          <div>
            <strong>${esc(x.medicine_name)}</strong>
            <small>${x.created_at} · requested ${x.quantity_requested} unit(s)</small>
          </div>
          <span class="pill ${x.status === 'success' ? '' : 'bad'}">${x.status} · ${x.quantity_dispensed} dispensed</span>
        </div>
      `).join('')
      : '<p class="muted">No dispense history logged yet.</p>';

    renderPagination('#historyPagination', d.pagination, p => loadHistory(p));
  } catch (err) {
    $('#historyList').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// Shared Pagination Component Renderer
function renderPagination(selector, pagination, onPageChange) {
  const container = $(selector);
  if (!container || !pagination || pagination.pages <= 1) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = `
    <span>Page <strong>${pagination.page}</strong> of <strong>${pagination.pages}</strong> (${pagination.total} total items)</span>
    <div class="pagination-controls">
      <button type="button" class="quiet" id="${selector.replace('#', '')}_prev" ${pagination.page <= 1 ? 'disabled' : ''}>Previous</button>
      <button type="button" class="quiet" id="${selector.replace('#', '')}_next" ${pagination.page >= pagination.pages ? 'disabled' : ''}>Next</button>
    </div>
  `;
  const prevBtn = $(`${selector}_prev`);
  const nextBtn = $(`${selector}_next`);
  if (prevBtn) prevBtn.onclick = () => onPageChange(pagination.page - 1);
  if (nextBtn) nextBtn.onclick = () => onPageChange(pagination.page + 1);
}

// Initial session check
logged();
