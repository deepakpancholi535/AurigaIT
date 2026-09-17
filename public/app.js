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

// Safe Modal Helpers
function openModal(dlg) {
  if (!dlg) return;
  if (typeof dlg.showModal === 'function') {
    try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); }
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
  $('#outboxBtn').classList.toggle('hidden', !isLoggedIn);
  if (isLoggedIn) {
    const todayStr = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    $('#today').textContent = todayStr;
    if ($('#clockSimDate')) $('#clockSimDate').value = new Date().toISOString().slice(0, 10);
    loadInventory(1);
    loadAlerts();
    checkOutbox();
  }
}

// Level 3 — Outbox Notification Check
async function checkOutbox() {
  try {
    const d = await api('/outbox');
    const count = d.total || (d.outbox ? d.outbox.length : 0);
    $('#outboxBadge').textContent = count;
  } catch (e) {}
}

$('#outboxBtn').onclick = async () => {
  try {
    const d = await api('/outbox');
    const list = d.outbox || [];
    $('#outboxBadge').textContent = list.length;
    
    const html = list.length
      ? `
        <table class="batch-table" role="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Medicine</th>
              <th>Sellable Stock</th>
              <th>Threshold</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(item => `
              <tr>
                <td><span class="pill bad">${esc(item.type)}</span></td>
                <td><strong>${esc(item.medicine_name)}</strong></td>
                <td>${item.sellable_stock}</td>
                <td>${item.threshold}</td>
                <td><small>${esc(item.timestamp)}</small></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `
      : '<p class="muted" style="padding:16px 0;">No re-order notification alerts in outbox.</p>';
      
    $('#outboxContent').innerHTML = html;
    openModal($('#outboxDialog'));
  } catch (e) {
    showToast('Unable to fetch outbox notifications', 'error');
  }
};

$('#closeOutbox').onclick = () => closeModal($('#outboxDialog'));
$('#clearOutboxBtn').onclick = async () => {
  try {
    await api('/outbox', { method: 'DELETE' });
    showToast('Outbox notifications cleared', 'success');
    $('#outboxBadge').textContent = '0';
    $('#outboxContent').innerHTML = '<p class="muted" style="padding:16px 0;">No re-order notification alerts in outbox.</p>';
  } catch (e) {
    showToast('Failed to clear outbox', 'error');
  }
};

// Level 1 — System Clock POST /clock Automation
$('#runClockBtn').onclick = async () => {
  try {
    const dateVal = $('#clockSimDate').value || new Date().toISOString().slice(0, 10);
    const d = await api('/clock', {
      method: 'POST',
      body: JSON.stringify({ date: dateVal })
    });
    showToast(`Clock set to ${d.date}: ${d.expiring_soon_count} expiring soon, ${d.quarantined_count} quarantined!`, 'info');
    loadInventory(currentInventoryPage);
    loadAlerts();
    checkOutbox();
  } catch (e) {
    showToast(e.message, 'error');
  }
};

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

// Accessible Tab Navigation
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
            ${m.in_date ? `<button type="button" class="btn-dispense" style="margin-top:8px;" data-id="${m.id}" data-name="${esc(m.name)}" data-max="${m.sellable_stock}">Dispense</button>` : ''}
          </div>
        </article>
      `).join('')
      : '<div class="result"><strong>No medicines found.</strong><p class="muted">Try searching another name or generic compound.</p></div>';
  } catch (err) {
    $('#searchResults').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
};

// Event Delegation for Search Results Dispense Button
$('#searchResults').onclick = e => {
  const btn = e.target.closest('.btn-dispense');
  if (btn) {
    openDispenseModal(Number(btn.dataset.id), btn.dataset.name, Number(btn.dataset.max));
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

// Custom Dispense Modal Dialog
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
    checkOutbox();
  } catch (err) {
    $('#dispenseError').textContent = err.message;
  }
};

// Custom Batch Viewer Modal
window.showBatches = async (id, name) => {
  try {
    const d = await api('/medicines/' + id);
    const today = d.today;
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
              const isQuarantined = !!b.quarantined;
              let statusPill = '<span class="pill">IN DATE</span>';
              if (isQuarantined) statusPill = '<span class="pill bad">QUARANTINED</span>';
              else if (isExpired) statusPill = '<span class="pill bad">EXPIRED</span>';
              return `
                <tr>
                  <td>${i + 1}</td>
                  <td><strong>${esc(b.batch_no)}</strong></td>
                  <td>${b.quantity}</td>
                  <td>${b.expiry_date}</td>
                  <td>${statusPill}</td>
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

// Level 2 — Import Messy Batches Dialog
$('#importBatchesBtn').onclick = async () => {
  try {
    const d = await api('/medicines?limit=100');
    const select = $('#importMedicineSelect');
    select.innerHTML = '<option value="">-- Select Target Medicine (Optional) --</option>' +
      d.data.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    
    $('#importDataInput').value = '';
    $('#importReport').innerHTML = '';
    openModal($('#importDialog'));
  } catch (e) {
    showToast(e.message, 'error');
  }
};

$('#cancelImport').onclick = () => closeModal($('#importDialog'));

$('#loadSampleImportBtn').onclick = () => {
  const sample = [
    { batch_no: "M-DIRTY-101", quantity: "150 units", expiry_date: "25/12/2028" },
    { batch_no: "M-DIRTY-101", quantity: "50 units", expiry_date: "25/12/2028" },
    { batch_no: "M-BAD-99", quantity: "invalid", expiry_date: "not-a-date" }
  ];
  $('#importDataInput').value = JSON.stringify(sample, null, 2);
};

$('#importForm').onsubmit = async e => {
  e.preventDefault();
  let medId = $('#importMedicineSelect').value;
  const rawText = $('#importDataInput').value.trim();
  if (!rawText) return alert('Please enter or paste batch data.');

  let parsedItems = [];
  try {
    parsedItems = JSON.parse(rawText);
  } catch (x) {
    return alert('Invalid JSON payload. Click "Load Sample Dirty Data" for a valid format.');
  }

  if (!medId) {
    const opts = Array.from($('#importMedicineSelect').options).map(o => o.value).filter(Boolean);
    if (opts.length > 0) medId = opts[0];
  }

  try {
    const d = await api('/batches/import', {
      method: 'POST',
      body: JSON.stringify({ medicine_id: medId ? Number(medId) : undefined, items: parsedItems })
    });

    $('#importReport').innerHTML = `
      <div style="background:var(--color-surface-alt); padding:12px; border:1px solid var(--color-border); border-radius:4px; font-size:13px; margin-top:10px;">
        <strong>Import Report Output:</strong><br>
        <span class="pill" style="margin-right:6px;">Imported: ${d.imported}</span>
        <span class="pill warn" style="margin-right:6px;">Deduped: ${d.deduped}</span>
        <span class="pill bad">Rejected: ${d.rejected}</span>
      </div>
    `;

    showToast(`Import finished: ${d.imported} imported, ${d.deduped} deduped, ${d.rejected} rejected`, 'success');
    loadInventory(currentInventoryPage);
  } catch (err) {
    $('#importReport').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
};

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
    checkOutbox();
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
          <small>Batch ${esc(x.batch_no)} · ${x.quantity} unit(s) · ${x.quarantined ? 'quarantined' : 'expired'} ${x.expiry_date}</small>
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
