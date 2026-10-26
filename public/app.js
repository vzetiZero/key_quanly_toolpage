const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { username: '', licenses: [], events: [], page: 'overview', toastTimer: null };
const pageInfo = {
  overview: ['Tổng quan', 'Theo dõi key, thời hạn và thiết bị đang sử dụng ứng dụng.'],
  licenses: ['Quản lý License', 'Tạo key, thay đổi thời hạn, giới hạn thiết bị hoặc thu hồi quyền sử dụng.'],
  devices: ['Thiết bị', 'Tra cứu và giải phóng thiết bị đã kích hoạt license.'],
  activity: ['Lịch sử hoạt động', 'Nhật ký phát hành, kích hoạt, thu hồi và cập nhật license.'],
  account: ['Tài khoản', 'Cập nhật thông tin bảo mật cho tài khoản quản trị.']
};

document.addEventListener('DOMContentLoaded', init);

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Lỗi HTTP ${response.status}`);
  return data;
}
function body(data) { return JSON.stringify(data); }
function showToast(message, bad = false) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.toggle('bad', bad); toast.classList.add('show');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function dateLabel(value) {
  if (!value) return 'Vĩnh viễn';
  return new Date(value).toLocaleDateString('vi-VN', { year: 'numeric', month: 'short', day: 'numeric' });
}
function statusOf(item) {
  if (item.status !== 'active') return ['revoked', 'Đã thu hồi'];
  if (item.expiresAt && Date.parse(item.expiresAt) < Date.now()) return ['expired', 'Hết hạn'];
  return ['active', 'Hoạt động'];
}
function safeKey(item) { return item.key === 'viet' ? 'viet' : `•••• •••• ${item.key.slice(-4)}`; }

async function init() {
  $('#login-form').addEventListener('submit', login);
  $('#logout-button').addEventListener('click', logout);
  $$('.nav-link').forEach((button) => button.addEventListener('click', () => changePage(button.dataset.page)));
  $$('[data-go]').forEach((button) => button.addEventListener('click', () => changePage(button.dataset.go)));
  $('#new-license-button').addEventListener('click', () => openLicenseDialog());
  $('#generate-key').addEventListener('click', () => { $('#license-key').value = generateKey(); });
  $('#license-plan').addEventListener('change', () => { $('#expiry-field').hidden = $('#license-plan').value === 'permanent'; });
  $('#license-form').addEventListener('submit', saveLicense);
  $('#license-rows').addEventListener('click', licenseAction);
  $('#device-list').addEventListener('click', licenseAction);
  $('#copy-key').addEventListener('click', async () => { await navigator.clipboard.writeText($('#created-key').textContent); showToast('Đã sao chép key.'); });
  $('#close-created').addEventListener('click', () => $('#key-created-dialog').close());
  $('#password-form').addEventListener('submit', changePassword);
  $('#forced-password-form').addEventListener('submit', forcedPassword);
  $$('[data-search]').forEach((input) => input.addEventListener('input', render));
  $('[data-status-filter]').addEventListener('change', render);
  try {
    const me = await api('/api/auth/me');
    state.username = me.username;
    enterApp();
    if (me.mustChangePassword) $('#change-password-dialog').showModal();
    await loadData();
  } catch { $('#login-screen').hidden = false; }
}

async function login(event) {
  event.preventDefault(); const button = $('button[type="submit"]', event.currentTarget); button.disabled = true;
  $('#login-message').textContent = '';
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: body({ username: $('#login-user').value, password: $('#login-password').value }) });
    state.username = data.username; enterApp();
    if (data.mustChangePassword) $('#change-password-dialog').showModal();
    await loadData();
  } catch (error) { $('#login-message').textContent = error.message; }
  finally { button.disabled = false; }
}
function enterApp() { $('#login-screen').hidden = true; $('#app').hidden = false; $('#admin-name').textContent = state.username; }
async function logout() { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.reload(); }
async function loadData() {
  try {
    const data = await api('/api/admin/overview');
    state.licenses = data.licenses || []; state.events = data.events || [];
    $('#stat-total').textContent = data.stats.total;
    $('#stat-active').textContent = data.stats.active;
    $('#stat-devices').textContent = data.stats.devices;
    $('#stat-soon').textContent = state.licenses.filter((item) => item.status === 'active' && item.expiresAt && Date.parse(item.expiresAt) >= Date.now() && Date.parse(item.expiresAt) < Date.now() + 30 * 86400000).length;
    $('#nav-count').textContent = data.stats.total;
    render();
  } catch (error) { showToast(error.message, true); }
}
function changePage(page) {
  state.page = page;
  $$('.nav-link').forEach((button) => button.classList.toggle('selected', button.dataset.page === page));
  $$('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== page && !(page === 'licenses' && panel.dataset.panel === 'overview'); });
  const [title, description] = pageInfo[page] || pageInfo.overview;
  $('#page-title').textContent = title; $('#page-description').textContent = description; $('#crumb-page').textContent = title;
  $('#new-license-button').hidden = !['overview', 'licenses'].includes(page);
  $('#stats-grid').hidden = !['overview', 'licenses'].includes(page);
  $('.master-panel').hidden = !['overview', 'licenses'].includes(page);
  if (page === 'licenses') $('#license-rows').closest('.panel').querySelector('.panel-head h2').textContent = 'Tất cả License';
  render();
}
function render() {
  const query = ($('[data-search]').value || '').trim().toLowerCase();
  const filter = $('[data-status-filter]').value;
  const matches = state.licenses.filter((item) => {
    const status = statusOf(item)[0];
    const text = [item.name, item.key, item.notes, ...item.devices.map((device) => `${device.name} ${device.code} ${device.fingerprint}`)].join(' ').toLowerCase();
    return (!query || text.includes(query)) && (filter === 'all' || status === filter);
  });
  const panel = $('#license-rows').closest('.panel');
  const showLicensePanel = ['overview','licenses'].includes(state.page);
  panel.hidden = !showLicensePanel;
  if (state.page === 'overview') matches.splice(6);
  $('#license-rows').innerHTML = matches.map((item) => {
    const [status, label] = statusOf(item);
    const plan = item.plan === 'permanent' ? 'Vĩnh viễn' : item.plan === 'pro' ? 'Pro' : 'Tiêu chuẩn';
    return `<tr><td><code class="key-display">${escapeHtml(safeKey(item))}</code><span class="cell-sub">${escapeHtml(item.name)}</span></td><td><span class="plan-pill">${plan}</span></td><td><span class="device-count">${item.devices.length} / ${item.maxDevices}</span><span class="cell-sub">${item.devices[0] ? escapeHtml(item.devices[0].name) : 'Chưa kích hoạt'}</span></td><td>${dateLabel(item.expiresAt)}</td><td><span class="status-pill status-${status}">${label}</span></td><td><div class="row-actions"><button class="action-btn" title="Sửa" data-action="edit" data-id="${item.id}">✎</button><button class="action-btn" title="${item.status === 'active' ? 'Thu hồi' : 'Mở lại'}" data-action="toggle" data-id="${item.id}">⏻</button><button class="action-btn danger" title="Xóa" data-action="delete" data-id="${item.id}">×</button></div></td></tr>`;
  }).join('');
  $('#empty-state').hidden = matches.length > 0;
  $('#row-count').textContent = `${matches.length} license${matches.length === 1 ? '' : 's'}`;
  renderDevices(query); renderActivity();
}
function renderDevices(query = '') {
  const devices = state.licenses.flatMap((license) => license.devices.map((device) => ({ ...device, license })));
  const filtered = devices.filter((device) => `${device.name} ${device.code} ${device.fingerprint} ${device.license.name}`.toLowerCase().includes(query));
  $('#device-list').innerHTML = filtered.map((device) => `<article class="device-item"><span class="device-icon">▣</span><span><strong>${escapeHtml(device.name)}</strong><small>${escapeHtml(device.platform)} · hoạt động ${dateLabel(device.lastSeenAt)}</small><small>Mã máy <span class="device-key">${escapeHtml(device.code)}</span> · key ${escapeHtml(safeKey(device.license))} · ${escapeHtml(device.license.name)}</small></span><button class="action-btn danger" data-action="release" data-id="${device.license.id}" data-fingerprint="${device.fingerprint}" title="Gỡ thiết bị">Gỡ</button></article>`).join('') || '<div class="empty"><strong>Chưa có thiết bị nào được kích hoạt.</strong></div>';
}
function renderActivity() {
  $('#activity-list').innerHTML = state.events.map((item) => `<article class="activity-item"><i class="activity-dot"></i><span><strong>${escapeHtml(eventLabel(item.type))}</strong><small>${escapeHtml(item.detail || item.license_id || '')}</small></span><small>${new Date(item.at).toLocaleString('vi-VN')}</small></article>`).join('') || '<div class="empty"><strong>Chưa có hoạt động.</strong></div>';
}
function eventLabel(type) { return ({ 'license.created':'Tạo license mới', 'license.updated':'Cập nhật license', 'license.deleted':'Xóa license', 'device.activated':'Thiết bị kích hoạt', 'device.checked':'Thiết bị xác thực', 'device.released':'Gỡ thiết bị' })[type] || type; }
function generateKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return `N247-${chars.slice(0,4).join('')}-${chars.slice(4,8).join('')}-${chars.slice(8,12).join('')}-${chars.slice(12).join('')}`;
}
function openLicenseDialog(item = null) {
  $('#license-form').dataset.editId = item?.id || '';
  $('#dialog-title').textContent = item ? 'Chỉnh sửa License' : 'Tạo license mới';
  $('#save-license').textContent = item ? 'Lưu thay đổi' : 'Tạo license';
  $('#license-name').value = item?.name || '';
  $('#license-key').value = '';
  $('#license-key').disabled = Boolean(item);
  $('#license-plan').value = item?.plan || 'standard';
  $('#license-expiry').value = item?.expiresAt?.slice(0,10) || '';
  $('#expiry-field').hidden = $('#license-plan').value === 'permanent';
  $('#license-seats').value = item?.maxDevices || 1;
  $('#license-notes').value = item?.notes || '';
  $('#license-dialog').showModal();
}
async function saveLicense(event) {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { $('#license-dialog').close(); return; }
  const form = $('#license-form'); const editId = form.dataset.editId;
  const payload = { name:$('#license-name').value.trim(), plan:$('#license-plan').value, expiresAt:$('#license-expiry').value || null, maxDevices:Number($('#license-seats').value), notes:$('#license-notes').value.trim() };
  try {
    if (editId) await api(`/api/admin/licenses/${editId}`, { method:'PATCH', body:body(payload) });
    else {
      payload.key = $('#license-key').value.trim();
      const created = await api('/api/admin/licenses', { method:'POST', body:body(payload) });
      $('#created-key').textContent = created.key; $('#key-created-dialog').showModal();
    }
    $('#license-dialog').close(); await loadData(); showToast(editId ? 'Đã cập nhật license.' : 'Đã tạo license.');
  } catch (error) { showToast(error.message, true); }
}
async function licenseAction(event) {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const item = state.licenses.find((license) => license.id === button.dataset.id); if (!item) return;
  const action = button.dataset.action;
  try {
    if (action === 'edit') openLicenseDialog(item);
    if (action === 'toggle') {
      const status = item.status === 'active' ? 'revoked' : 'active';
      if (status === 'revoked' && !confirm(`Thu hồi key của ${item.name}? Thiết bị sẽ bị chặn ở lần kiểm tra license tiếp theo.`)) return;
      await api(`/api/admin/licenses/${item.id}`, { method:'PATCH', body:body({ status }) }); await loadData();
    }
    if (action === 'delete') {
      if (!confirm(`Xóa hẳn license của ${item.name}?`)) return;
      await api(`/api/admin/licenses/${item.id}`, { method:'DELETE' }); await loadData(); showToast('Đã xóa license.');
    }
    if (action === 'release') {
      if (!confirm('Gỡ thiết bị này để license có thể kích hoạt trên máy khác?')) return;
      await api(`/api/admin/licenses/${item.id}`, { method:'PATCH', body:body({ releaseFingerprint:button.dataset.fingerprint }) }); await loadData(); showToast('Đã giải phóng thiết bị.');
    }
  } catch (error) { showToast(error.message, true); }
}
async function changePassword(event) {
  event.preventDefault();
  const current = $('#old-password').value; const password = $('#new-password').value;
  if (password !== $('#confirm-password').value) { $('#password-message').textContent = 'Mật khẩu xác nhận chưa khớp.'; return; }
  try { await api('/api/auth/password', { method:'PUT', body:body({ current, password }) }); $('#password-form').reset(); $('#password-message').textContent = 'Đã đổi mật khẩu.'; showToast('Mật khẩu đã được cập nhật.'); }
  catch (error) { $('#password-message').textContent = error.message; }
}
async function forcedPassword(event) {
  event.preventDefault();
  const password = $('#forced-new-password').value;
  if (password !== $('#forced-confirm-password').value) { $('#forced-message').textContent = 'Mật khẩu xác nhận chưa khớp.'; return; }
  try {
    await api('/api/auth/password', { method:'PUT', body:body({ current:$('#forced-old-password').value, password }) });
    $('#change-password-dialog').close(); showToast('Đã thay mật khẩu quản trị.'); await loadData();
  } catch (error) { $('#forced-message').textContent = error.message; }
}
