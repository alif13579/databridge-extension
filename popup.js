// ══════════════════════════════
// 🔧 কনফিগ
// ══════════════════════════════
const FIREBASE_URL = CONFIG.FIREBASE_URL;
const FIREBASE_WEB_API_KEY = CONFIG.FIREBASE_WEB_API_KEY;
const PAGINATION_LIMIT = CONFIG.PAGINATION_LIMIT || 20;
const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = CONFIG.SUPABASE_ANON_KEY;
// users/{uid}/connections/extensions/{id} is meant to hold only CURRENTLY ACTIVE
// extensions (so the Android app knows how many/which are live right now). Nothing
// previously re-confirmed presence after initial Google-login, so an entry from a
// browser that just closed/uninstalled without clicking Disconnect stayed "connected"
// forever. Agreed cleanup threshold: 1 day — see touchExtensionConnection() (heartbeat)
// and loadHistory()'s pruning below.
const EXTENSION_STALE_MS = 24 * 60 * 60 * 1000;

// ══════════════════════════════
// 🌐 গ্লোবাল স্টেট
// ══════════════════════════════
let currentExtensionID = null;
let currentContainerID = null;
let currentUserId = null;
let historyItems = [];
let sseSource = null;
let containerSseSource = null;
let scanSseSource = null;
let searchQuery = '';
let refreshInterval = null;
let isInitialized = false;
let sortOrder = 'newest';

let currentGoogleUid = null;
let currentGoogleEmail = null;
let currentGoogleName = null;
let currentGooglePhotoUrl = null;
let currentIdToken = null;
let currentRefreshToken = null;
function normalizePhoneKey(text) {
  let s = (text || '').replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (/^0\d{10}$/.test(s)) s = '880' + s.slice(1);
  return s.replace(/\D/g, '');
}

function shouldIndexInNumbers(item, actionType) {
  if (!item || item.type !== 'phone' || actionType !== 'remark') return false;
  return normalizePhoneKey(item.cleaned || item.text || '').length >= 7;
}

async function removeNumbersIndex(item, actionId) {
  if (!item || item.type !== 'phone') return;
  const cleanPhone = normalizePhoneKey(item.cleaned || item.text || '');
  if (cleanPhone.length < 7) return;
  await fetch(`${FIREBASE_URL}/numbers/${cleanPhone}/${actionId}.json`, { method: 'DELETE' }).catch(() => {});
}

async function syncNumbersIndex(item, actionId, remarks, timestamp, actionType) {
  if (!shouldIndexInNumbers(item, actionType)) {
    await removeNumbersIndex(item, actionId);
    return;
  }
  const cleanPhone = normalizePhoneKey(item.cleaned || item.text || '');
  const numberData = {
    record_id: item.id,
    storage_ref: currentContainerID || currentExtensionID || '',
    lifecycle: currentContainerID ? 'AUTHENTICATED_PERSISTENT' : 'EPHEMERAL_SESSION',
    timestamp,
    remarks: remarks || '',
    source: 'extension'
  };
  await fetch(`${FIREBASE_URL}/numbers/${cleanPhone}/${actionId}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(numberData)
  }).catch(() => {});
}

// ══════════════════════════════
// 🎛️ UI হেলপার
// ══════════════════════════════
function showLoading(text = "Processing...") {
  const overlay = document.getElementById('loading-overlay');
  const textEl = document.getElementById('loading-text');
  if (overlay) overlay.style.display = 'flex';
  if (textEl) textEl.textContent = text;
}
function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.style.display = 'none';
}
function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const tabEl = document.getElementById(`tab-${tab}`);
  const navEl = document.getElementById(`nav-${tab}`);
  if (tabEl) tabEl.classList.add('active');
  if (navEl) navEl.classList.add('active');
}
function setupNavigation() {
  ['history', 'scan', 'dashboard', 'run', 'routing', 'connect', 'settings'].forEach(tab => {
    const el = document.getElementById(`nav-${tab}`);
    if (el) el.addEventListener('click', () => {
      switchTab(tab);
      if (tab === 'history' && isInitialized) loadHistory(false);
      if (tab === 'scan') loadScanHistory();
      if (tab === 'run') loadRunReport(false);
      if (tab === 'routing') loadRoutingTab();
      if (tab === 'dashboard') {
        loadDashboardTabAndAutoGenerate();
        restorePerfModePreference();
      }
    });
  });
}

// ══════════════════════════════
// 🔍 ডায়নামিক পাথ রেজোলভ
// ══════════════════════════════
async function getActivePaths() {
  const storage = await new Promise(resolve =>
    chrome.storage.local.get(['extension_id', 'container_id', 'user_id'], resolve)
  );
  if (storage.extension_id) currentExtensionID = storage.extension_id;
  // Validate cached container_id — reject error objects stored from failed fetches
  if (typeof storage.container_id === 'string' && storage.container_id.startsWith('container_')) {
    currentContainerID = storage.container_id;
  } else if (storage.container_id) {
    await chrome.storage.local.remove('container_id'); // clear bad value
  }
  if (storage.user_id) currentUserId = storage.user_id;

  if (currentExtensionID) {
    try {
      const metaRes = await fetch(`${FIREBASE_URL}/sessions/${currentExtensionID}/meta.json?cb=${Date.now()}`);
      const meta = await metaRes.json();
      const isConnected = meta?.status === 'connected';
      console.log('🔎 getActivePaths | QR meta status:', meta?.status, '| currentGoogleUid:', currentGoogleUid, '| currentContainerID before:', currentContainerID);
      if (isConnected && !currentGoogleUid) {
        // Only let a QR session resolve/override the container when there's no Google
        // account linked. A Google-linked container must never be silently swapped out
        // for a stale/unrelated QR pairing's container just because that session's meta
        // still says "connected" (e.g. it was paired to a different account earlier).
        await resolveContainerFromMeta(meta);
      } else if (!isConnected && !currentGoogleUid) {
        // Session is disconnected — wipe container info so history shows nothing from
        // container. Skipped when a Google account is linked, since that container
        // was derived from Google Sign-In, not this QR session.
        await clearContainerState();
      }
      console.log('🔎 getActivePaths | currentContainerID after:', currentContainerID);
    } catch (e) { console.warn("⚠️ Path resolution skipped:", e); }
  }

  return {
    extensionId: currentExtensionID,
    containerId: currentContainerID,
    userId: currentUserId,
    isPermanent: !!currentContainerID,
    historyPath: currentContainerID ? `container/${currentContainerID}/records` : null,
    sessionPath: currentExtensionID ? `sessions/${currentExtensionID}/records` : null,
    metaPath: currentExtensionID ? `sessions/${currentExtensionID}/meta` : null
  };
}

async function resolveContainerFromMeta(meta = {}) {
  // Bidirectional: must be able to CLEAR currentUserId/currentContainerID too, not just
  // set them — e.g. AuthManager.signOut() PATCHes sessions/{id}/meta/user_id back to ""
  // while leaving status:"connected" (the QR pairing itself is still active, only the
  // owning account changed). Without clearing here, the extension keeps resolving to the
  // stale, already-logged-out user's container forever. Never touches Google-linked state
  // (currentGoogleUid) — that's a completely separate source of container_id, and every
  // call site already gates on `!currentGoogleUid` before calling this at all, so this is
  // safe alongside the Google-priority protections elsewhere in this file.
  const userId = meta.user_id || meta.uid || meta.userId || null;
  const containerId = meta.container_id || meta.containerId || (userId ? `container_${userId}` : null);
  const validContainerId = (typeof containerId === 'string' && containerId.startsWith('container_')) ? containerId : null;

  if (userId && validContainerId) {
    currentUserId = userId;
    currentContainerID = validContainerId;
    await chrome.storage.local.set({ user_id: currentUserId, container_id: currentContainerID });
  } else if (!currentGoogleUid) {
    await clearContainerState();
  }
}

// ══════════════════════════════
// 🔗 QR & Copy
// ══════════════════════════════
function generateQR(extension_id) {
  const container = document.getElementById('qrcode');
  if (!container) return;
  container.innerHTML = '';
  if (typeof QRCode !== 'undefined') {
    new QRCode(container, {
      text: extension_id,
      width: 150, height: 150,
      colorDark: "#000000", colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.H
    });
  }
}
function setupCopyExtensionID(extension_id) {
  const btn = document.getElementById('copy-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(extension_id).then(() => {
      const original = btn.textContent;
      btn.textContent = '✅';
      setTimeout(() => { btn.textContent = original; }, 2000);
    }).catch(() => {
      btn.textContent = '❌';
      setTimeout(() => { btn.textContent = '📋'; }, 2000);
    });
  });
}

// ══════════════════════════════
// ⏰ টাইম হেলপার
// ══════════════════════════════
function timeAgo(timestamp) {
  if (!timestamp) return 'Just now';
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  const hrs  = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  if (hrs  < 24) return `${hrs} hr ago`;
  if (days === 1) return 'Yesterday';
  if (days < 30)  return `${days} days ago`;
  return `${Math.floor(days / 30)} mo ago`;
}
function exactTime(timestamp) {
  const d = new Date(timestamp || Date.now());
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const date = d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${time} · ${date}`;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function resolveRecordBasePath(itemId) {
  const { historyPath, sessionPath } = await getActivePaths();
  const item = historyItems.find(i => i.id === itemId);
  if (!item) return historyPath || sessionPath;
  if (item.source === 'permanent') return historyPath;
  if (item._sessionId) return `sessions/${item._sessionId}/records`;
  return sessionPath || historyPath;
}

// ══════════════════════════════
// 📋 হিস্ট্রি রেন্ডার
// ══════════════════════════════
function renderHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  const q = searchQuery.trim().toLowerCase();
  let filtered = q
    ? historyItems.filter(i => i.text?.toLowerCase().includes(q))
    : [...historyItems];
  if (sortOrder === 'oldest') filtered = filtered.reverse();
  list.innerHTML = '';
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">No history yet.<br>Send something from the page!</div>';
    return;
  }
  filtered.forEach(item => {
    if (!item?.text) return;
    const isNew = (Date.now() - (item.received_at || 0)) < 3600000;
    list.appendChild(buildCard(item, isNew));
  });
}

function buildCard(item, isNew) {
  const card = document.createElement('div');
  card.className = 'history-card' + (isNew ? ' is-new' : '');
  card.dataset.id = item.id;
  const isPhone = item.type === 'phone';
  const isConsignment = item.type === 'consignment';

  // ✅ Actions parsing for new structure { "action_...": { remarks, timestamp, ... } }
  const actions = item.actions || {};
  const actionList = [];
  if (actions && typeof actions === 'object') {
    Object.entries(actions).forEach(([key, value]) => {
      if (key.startsWith('action_') && value && typeof value === 'object') {
        actionList.push({
          id: key,
          remarks: value.remarks || value.remark || '',
          timestamp: value.timestamp || 0,
          type: value.type || 'unknown',
          source: value.source || 'extension'
        });
      }
    });
  }
  actionList.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  // Header
  const header = document.createElement('div');
  header.className = 'card-header';
  header.innerHTML = `<div class="${isNew ? 'new-indicator' : 'old-indicator'}"></div>
    <div class="card-main">
      <div class="card-text">${escapeHtml(item.text || '')}</div>
      <div class="card-meta">
        <span class="card-time">${timeAgo(item.received_at)} (${exactTime(item.received_at)})</span>
        <span class="badge ${isPhone ? 'badge-phone' : (isConsignment ? 'badge-phone' : 'badge-text')}">${isPhone ? 'Phone' : (isConsignment ? 'Parcel' : 'Text')}</span>
      </div>
    </div>
    <div class="chevron" id="chev-${item.id}">▼</div>`;

  // Actions buttons
  const actionsEl = document.createElement('div');
  actionsEl.className = 'card-actions';
  actionsEl.id = `actions-${item.id}`;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'action-btn btn-copy';
  copyBtn.textContent = '⎘ Copy';
  copyBtn.addEventListener('click', (e) => { e.stopPropagation(); handleCopy(item.id, item.text); });
  actionsEl.appendChild(copyBtn);

  if (isPhone) {
    const dialBtn = document.createElement('button');
    dialBtn.className = 'action-btn btn-dial';
    dialBtn.textContent = '📞 Dial';
    dialBtn.addEventListener('click', (e) => { e.stopPropagation(); handleDial(item.id, item.text); });
    actionsEl.appendChild(dialBtn);
  }

  const remBtn = document.createElement('button');
  remBtn.className = 'action-btn btn-remark';
  remBtn.textContent = '💬';
  remBtn.addEventListener('click', (e) => { e.stopPropagation(); openRemarks(item.id); });
  actionsEl.appendChild(remBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'action-btn btn-delete';
  delBtn.textContent = '🗑';
  delBtn.addEventListener('click', (e) => { e.stopPropagation(); handleDelete(item.id); });
  actionsEl.appendChild(delBtn);

  // Action Log
  const logEl = document.createElement('div');
  logEl.className = 'action-log';
  logEl.id = `log-${item.id}`;

  const logHeader = document.createElement('div');
  logHeader.className = 'action-log-header';
  logHeader.innerHTML = `<span>Action log (${actionList.length})</span><span>▶</span>`;

  const logBody = document.createElement('div');
  logBody.className = 'action-log-body';
  logBody.id = `logbody-${item.id}`;

  if (!actionList.length) {
    logBody.innerHTML = '<div style="font-size:10px;color:#444;padding:4px 0;">No actions yet</div>';
  } else {
    actionList.forEach(a => {
      const entry = document.createElement('div');
      entry.className = 'log-item';
      const dotClass = a.type === 'dial' ? 'log-dot-dial' :
                       a.type === 'copy' ? 'log-dot-copy' :
                       a.type === 'remark' ? 'log-dot-remark' : 'log-dot-delete';
      entry.innerHTML = `<div class="log-dot ${dotClass}"></div>
        <div class="log-content">
          <div class="log-action">${capitalize(a.type)} • ${escapeHtml(a.source)}</div>
          ${a.remarks ? `<div class="log-note">"${escapeHtml(a.remarks)}"</div>` : ''}
          <div class="log-time">${exactTime(a.timestamp)}</div>
        </div>
        <div class="log-actions-row">
          <button type="button" class="log-btn-edit" title="Edit">✎</button>
          <button type="button" class="log-btn-delete" title="Delete">🗑</button>
        </div>`;
      entry.querySelector('.log-btn-edit')?.addEventListener('click', (e) => {
        e.stopPropagation();
        editAction(item.id, a);
      });
      entry.querySelector('.log-btn-delete')?.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteAction(item.id, a.id);
      });
      logBody.appendChild(entry);
    });
  }

  logHeader.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = logBody.classList.toggle('open');
    const arrow = logHeader.querySelector('span:last-child');
    if (arrow) arrow.textContent = isOpen ? '▼' : '▶';
  });

  logEl.appendChild(logHeader);
  logEl.appendChild(logBody);

  // Card toggle
  header.addEventListener('click', () => {
    const actEl = document.getElementById(`actions-${item.id}`);
    const logElId = document.getElementById(`log-${item.id}`);
    const chev = document.getElementById(`chev-${item.id}`);
    if (actEl) {
      const isOpen = actEl.classList.toggle('visible');
      if (logElId) logElId.classList.toggle('visible', isOpen);
      if (chev) chev.classList.toggle('open', isOpen);
    }
  });

  card.appendChild(header);
  card.appendChild(actionsEl);
  card.appendChild(logEl);
  return card;
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ══════════════════════════════
// ⚡ অ্যাকশন হ্যান্ডলার
// ══════════════════════════════
async function updateMetaTimestamp() {
  const { metaPath } = await getActivePaths();
  if (!metaPath) return;
  try {
    await fetch(`${FIREBASE_URL}/${metaPath}/updated_at.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Date.now())
    });
  } catch (e) { console.warn("Meta update failed:", e); }
}

async function handleCopy(itemId, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    console.warn('[DB] clipboard copy denied:', e?.message || e);
    return;
  }
  await logAction(itemId, 'copy').catch(e => console.warn('[DB] logAction failed:', e?.message || e));
}

async function handleDial(itemId, text) {
  const cleaned = text.replace(/[\s-()]/g, '');
  try {
    await chrome.tabs.create({ url: `tel:${cleaned}` });
  } catch (e) {
    console.warn('[DB] tabs.create(tel:) failed:', e?.message || e);
  }
  await logAction(itemId, 'dial').catch(e => console.warn('[DB] logAction failed:', e?.message || e));
}

async function handleDelete(itemId) {
  if (!itemId) return;
  const basePath = await resolveRecordBasePath(itemId);
  if (!basePath) return;
  const pathToDelete = `${basePath}/${itemId}`;

  try {
    await fetch(`${FIREBASE_URL}/${pathToDelete}.json`, { method: 'DELETE' });
    
    // Clean up numbers/ index for phone type
    const item = historyItems.find(i => i.id === itemId);
    if (item?.type === 'phone' && item.actions) {
      const cleanPhone = normalizePhoneKey(item.cleaned || item.text || '');
      if (cleanPhone.length >= 7) {
        Object.entries(item.actions)
          .filter(([k, v]) => k.startsWith('action_') && v?.type === 'remark')
          .forEach(([actionKey]) => {
            fetch(`${FIREBASE_URL}/numbers/${cleanPhone}/${actionKey}.json`, { method: 'DELETE' }).catch(() => {});
          });
      }
    }
    
    await updateMetaTimestamp();
    historyItems = historyItems.filter(i => i.id !== itemId);
    renderHistory();
  } catch (e) { console.error('Delete failed:', e); }
}

async function updateAction(itemId, actionId, patch) {
  const basePath = await resolveRecordBasePath(itemId);
  if (!basePath) return;
  try {
    const ts = Date.now();
    await fetch(`${FIREBASE_URL}/${basePath}/${itemId}/actions/${actionId}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...patch, timestamp: ts })
    });
    const item = historyItems.find(i => i.id === itemId);
    const existing = item?.actions?.[actionId];
    const mergedType = patch.type ?? existing?.type ?? '';
    const mergedRemarks = patch.remarks ?? existing?.remarks ?? '';
    await syncNumbersIndex(item, actionId, mergedRemarks, ts, mergedType);
    await updateMetaTimestamp();
    await loadHistory(false);
  } catch (e) { console.error('Update action failed:', e); }
}

async function deleteAction(itemId, actionId) {
  const basePath = await resolveRecordBasePath(itemId);
  if (!basePath) return;
  try {
    const item = historyItems.find(i => i.id === itemId);
    const actionType = item?.actions?.[actionId]?.type ?? '';
    await fetch(`${FIREBASE_URL}/${basePath}/${itemId}/actions/${actionId}.json`, { method: 'DELETE' });
    if (shouldIndexInNumbers(item, actionType)) {
      await removeNumbersIndex(item, actionId);
    }
    await updateMetaTimestamp();
    await loadHistory(false);
  } catch (e) { console.error('Delete action failed:', e); }
}

function editAction(itemId, action) {
  const newRemark = prompt('Edit remark:', action.remarks || '');
  if (newRemark === null) return;
  updateAction(itemId, action.id, { remarks: newRemark.trim(), type: action.type });
}

async function logAction(itemId, type, remark = null) {
  const basePath = await resolveRecordBasePath(itemId);
  const { containerId } = await getActivePaths();
  if (!basePath || !itemId) return;

  const ts = Date.now();
  const actionId = `action_${ts}`;
  
  const entry = {
    remarks: remark || '',
    timestamp: ts,
    type: type,
    source: "extension"
  };

  try {
    // Save to actions node
    await fetch(`${FIREBASE_URL}/${basePath}/${itemId}/actions/${actionId}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });

    const item = historyItems.find(i => i.id === itemId);
    await syncNumbersIndex(item, actionId, remark || '', ts, type);

    await updateMetaTimestamp();

    // Local cache update
    const localItem = historyItems.find(i => i.id === itemId);
    if (localItem) {
      if (!localItem.actions) localItem.actions = {};
      localItem.actions[actionId] = entry;
      renderHistory();
    }
  } catch (e) { console.error('Log action failed:', e); }
}

// ══════════════════════════════
// 💬 Remarks মডাল
// ══════════════════════════════
let currentRemarkItemId = null;
let selectedRemark = null;

async function openRemarks(itemId) {
  currentRemarkItemId = itemId;
  selectedRemark = null;

  let options = [];
  try {
    const res = await fetch(`${FIREBASE_URL}/remarks_options.json`);
    const data = await res.json();
    if (data) options = Object.values(data);
  } catch (e) {
    options = ['Will receive parcel', 'Requested callback', 'Not reachable', 'Wrong number'];
  }
  options.push('Others');

  const overlay = document.createElement('div');
  overlay.className = 'remarks-overlay';
  overlay.id = 'remarks-overlay';

  const sheet = document.createElement('div');
  sheet.className = 'remarks-sheet';
  const item = historyItems.find(i => i.id === itemId);
  sheet.innerHTML = `<div class="remarks-title">Add remark${item ? ' for ' + escapeHtml(item.text.substring(0, 20)) : ''}</div>`;

  options.forEach(opt => {
    const el = document.createElement('div');
    el.className = 'remark-option';
    el.innerHTML = `<div class="remark-radio"></div><span>${escapeHtml(opt)}</span>`;
    el.addEventListener('click', () => {
      document.querySelectorAll('.remark-option').forEach(o => {
        o.classList.remove('selected');
        o.querySelector('.remark-radio')?.classList.remove('selected');
      });
      el.classList.add('selected');
      el.querySelector('.remark-radio')?.classList.add('selected');
      selectedRemark = opt;
      const customInput = document.getElementById('remark-custom-input');
      if (customInput) customInput.classList.toggle('visible', opt === 'Others');
    });
    sheet.appendChild(el);
  });

  const customInput = document.createElement('input');
  customInput.type = 'text';
  customInput.id = 'remark-custom-input';
  customInput.className = 'remarks-custom-input';
  customInput.placeholder = 'Type your remark...';
  sheet.appendChild(customInput);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'remarks-save-btn';
  saveBtn.textContent = 'Save remark';
  saveBtn.addEventListener('click', async () => {
    if (!selectedRemark) return;
    const finalRemark = selectedRemark === 'Others' ? (customInput.value.trim() || 'Others') : selectedRemark;
    await logAction(currentRemarkItemId, 'remark', finalRemark);
    closeRemarks();
  });
  sheet.appendChild(saveBtn);

  overlay.appendChild(sheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeRemarks(); });
  document.body.appendChild(overlay);
}

function closeRemarks() {
  const overlay = document.getElementById('remarks-overlay');
  if (overlay) overlay.remove();
  currentRemarkItemId = null;
  selectedRemark = null;
}

// ══════════════════════════════
// 🔥 ফায়ারবেজ — লোড & লিসেন
// ══════════════════════════════
async function loadHistory(append = false) {
  // Overlap guard: 30s interval + focus reload + 3 SSE reloads can fire
  // together — second call while one is in flight returns early instead of
  // double-fetching the same paths.
  if (loadHistory.inFlight) return;
  loadHistory.inFlight = true;
  try {
  const { historyPath, extensionId, userId } = await getActivePaths();
  if (!extensionId && !historyPath) return;
  if (!append) historyItems = [];

  const allItems = [];
  const seenIds = new Set();

  function absorb(data, source, sessionId) {
    if (!data || typeof data !== 'object') return;
    Object.entries(data).forEach(([k, v]) => {
      if (v && v.text && !seenIds.has(k)) {
        seenIds.add(k);
        const actions = (v.actions && typeof v.actions === 'object') ? v.actions : {};
        const item = { id: k, ...v, actions, source };
        if (sessionId) item._sessionId = sessionId;
        allItems.push(item);
      }
    });
  }

  console.log('📦 loadHistory | historyPath:', historyPath, '| extensionId:', extensionId, '| userId:', userId);
  // container/{id}/records and users/{uid}/... are Google-account-scoped paths — Firebase
  // rules require the signed-in user's own ID token to read them (401 otherwise). This was
  // never attached here, which only started surfacing as an actual symptom once the
  // Google-linked container ID itself started resolving correctly (see the container-
  // resolution fix above this in history). getValidFirebaseIdToken() returns null when
  // there's no Google session, so QR-only users are unaffected.
  const idToken = await getValidFirebaseIdToken().catch(() => null);
  const authQuery = idToken ? `&auth=${idToken}` : '';
  try {
    // 1. Container records (permanent / logged-in)
    if (historyPath) {
      const res = await fetch(`${FIREBASE_URL}/${historyPath}.json?cb=${Date.now()}${authQuery}`);
      const containerData = await res.json();
      console.log('📦 Container fetch status:', res.status, '| data type:', typeof containerData,
        '| keys:', containerData && typeof containerData === 'object' ? Object.keys(containerData).length : containerData);
      absorb(containerData, 'permanent', null);
    }

    // 2. Collect all session IDs to fetch — and prune sibling extension connections
    // that have gone stale (>1 day since last_sync). This list is meant to hold only
    // currently-active extensions (so the Android app knows what's live right now),
    // but nothing previously re-confirmed presence after initial Google-login (see
    // touchExtensionConnection()), so entries from a browser that closed/uninstalled
    // without clicking Disconnect stayed "connected" forever — both a data-hygiene
    // problem and, since every one of these got fetched below on every popup open,
    // the main cause of slow load times once several had piled up.
    // Scoped to type === 'google_linked' only (this extension's own connection shape) —
    // never touches Android-app-originated entries (different type/lifecycle, and this
    // repo can't confirm whether the app side keeps its own presence fresh).
    const sessionIds = new Set();
    if (extensionId) sessionIds.add(extensionId);

    if (userId) {
      try {
        const extRes = await fetch(`${FIREBASE_URL}/users/${userId}/connections/extensions.json?cb=${Date.now()}${authQuery}`);
        const extMap = await extRes.json();
        if (extMap && typeof extMap === 'object') {
          const now = Date.now();
          Object.entries(extMap).forEach(([id, conn]) => {
            const lastSeen = conn?.last_sync || conn?.connected_at || 0;
            const isStale = id !== extensionId && conn?.type === 'google_linked' && (now - lastSeen) > EXTENSION_STALE_MS;
            if (isStale) {
              // Fire-and-forget — don't block this popup's own load on cleaning up
              // someone else's dead entry.
              // Standalone ?auth= here (not the shared &-prefixed authQuery above, which
              // assumes a preceding ?cb=... — this call has no other query param, so it needs
              // its own leading ?). The bare &authQuery version silently 404'd: the browser
              // sent ".json&auth=..." with no "?", so Firebase couldn't parse a query string
              // at all and looked for a literal path segment named "...json&auth=..." instead.
              fetch(`${FIREBASE_URL}/users/${userId}/connections/extensions/${id}.json${idToken ? `?auth=${idToken}` : ''}`, { method: 'DELETE' }).catch(() => {});
              console.log('🧹 Pruned stale extension connection:', id, '(last seen', lastSeen ? new Date(lastSeen).toISOString() : 'never', ')');
            } else {
              sessionIds.add(id);
            }
          });
        }
      } catch (e) { console.warn('Could not fetch user extensions list:', e); }
    }

    // 3. Fetch records from each still-active session IN PARALLEL — this loop used to
    // await one fetch at a time, so total wait time was the SUM of every session's
    // latency; with several sessions (very likely once several devices had connected
    // over time, especially before the pruning above existed) that stacked up to real,
    // user-visible delay on every popup open.
    const sessionResults = await Promise.all([...sessionIds].slice(0, 25).map(async extId => {
      try {
        // sessions/* is intentionally public per Firebase rules (extension_id is
        // an unguessable pairing secret), so no ?auth= needed here.
        const res = await fetch(`${FIREBASE_URL}/sessions/${extId}/records.json?cb=${Date.now()}`);
        if (!res.ok) {
          console.warn(`Session ${extId} fetch HTTP ${res.status} — skipped`);
          return { extId, data: null };
        }
        const data = await res.json().catch(() => null);
        return { extId, data: (data && typeof data === 'object') ? data : null };
      } catch (e) {
        console.warn(`Session ${extId} fetch failed:`, e);
        return { extId, data: null };
      }
    }));
    sessionResults.forEach(({ extId, data }) => {
      absorb(data, extId === extensionId ? 'session' : 'session_other', extId);
    });

    // Sort: Newest → Oldest
    allItems.sort((a, b) => (b.received_at || 0) - (a.received_at || 0));

    const start = append ? historyItems.length : 0;
    historyItems = append
      ? [...historyItems, ...allItems.slice(start, start + PAGINATION_LIMIT)]
      : allItems.slice(0, PAGINATION_LIMIT);

    renderHistory();
    const loadMoreWrap = document.getElementById('load-more-wrap');
    if (loadMoreWrap) loadMoreWrap.style.display = allItems.length > historyItems.length ? '' : 'none';
  } catch (e) { console.error('Load history failed:', e); }
  } finally { loadHistory.inFlight = false; }
}

function startSessionListener(id) {
  if (sseSource) { sseSource.close(); sseSource = null; }
  if (!id) return;
  sseSource = new EventSource(`${FIREBASE_URL}/sessions/${id}.json`);

  sseSource.addEventListener('put', async (event) => {
    try {
      const parsed = JSON.parse(event.data);
      const data = parsed.data;
      const path = parsed.path || '';
      if (data === null || (path === '/' && data === null)) {
        // An empty/absent sessions/{id} node only means "no QR session exists" — if a
        // Google account is linked, the container came from that login, not this QR
        // session, so it should NOT be torn down here.
        if (!currentGoogleUid) showDisconnectedState();
        return;
      }
      if (path.startsWith('/meta')) {
        // data may be full meta object (path=/meta) or just a string (path=/meta/status)
        const status = (typeof data === 'object' ? data?.status : null)
                    || (path === '/meta/status' ? data : null);
        if (status === 'disconnected') {
          if (!currentGoogleUid) showDisconnectedState();
        } else if (status === 'connected' && !currentGoogleUid) {
          showConnectedState({ meta: typeof data === 'object' ? data : {} });
          // Resolve container then load history
          if (typeof data === 'object') await resolveContainerFromMeta(data);
          else await getActivePaths();
          await loadHistory(false);
          if (currentContainerID) startContainerListener(currentContainerID);
        }
      }
      if (path.startsWith('/records')) await loadHistory(false);
    } catch (e) { console.error('SSE put parse error:', e); }
  });
  sseSource.addEventListener('patch', async (event) => {
    try {
      const parsed = JSON.parse(event.data);
      const path = parsed.path || '';
      // A patch on /meta (e.g. AuthManager PATCHing user_id+type into an already-
      // "connected" session on app login, or resetting them back to "" on app logout)
      // only carries the CHANGED subtree, not the full object — re-fetch the whole meta
      // node and run it through the SAME connected/disconnected + Google-priority logic
      // the 'put' handler above uses, instead of staying stale until the popup happens
      // to be closed and reopened.
      if (path.startsWith('/meta')) {
        try {
          const metaRes = await fetch(`${FIREBASE_URL}/sessions/${currentExtensionID}/meta.json?cb=${Date.now()}`);
          const meta = await metaRes.json();
          const status = meta?.status;
          if (status === 'connected' && !currentGoogleUid) {
            showConnectedState({ meta: meta || {} });
            await resolveContainerFromMeta(meta || {});
            if (currentContainerID) startContainerListener(currentContainerID);
          } else if (status === 'disconnected' && !currentGoogleUid) {
            showDisconnectedState();
          }
        } catch (e) { console.warn('Patch meta re-resolve failed:', e); }
      }
      await loadHistory(false);
    } catch (e) { console.error('SSE patch parse error:', e); }
  });
  sseSource.onerror = () => {
    setTimeout(() => { if (!isShuttingDown && currentExtensionID) startSessionListener(currentExtensionID); }, 5000);
  };
}

async function startContainerListener(containerId) {
  if (containerSseSource) { containerSseSource.close(); containerSseSource = null; }
  if (!containerId) return;
  // EventSource can't send custom headers, so an ID token (when the extension itself is
  // Google-signed-in) has to go in the URL as ?auth=. Without this, Firebase rules that
  // require auth on container/ reads return 401 and the SSE connection never opens —
  // this was silently failing with no visible error beyond the browser console.
  const idToken = await getValidFirebaseIdToken().catch(() => null);
  const authParam = idToken ? `?auth=${idToken}` : '';
  containerSseSource = new EventSource(`${FIREBASE_URL}/container/${containerId}.json${authParam}`);
  const reload = async () => { if (isInitialized) await loadHistory(false); };
  containerSseSource.addEventListener('put', (event) => {
    try {
      const parsed = JSON.parse(event.data);
      const path = parsed.path || '';
      if (path.startsWith('/records')) reload();
    } catch (e) { console.error('Container SSE error:', e); }
  });
  containerSseSource.addEventListener('patch', reload);
  containerSseSource.onerror = () => {
    setTimeout(() => { if (!isShuttingDown && currentContainerID) startContainerListener(currentContainerID); }, 5000);
  };
}

// scanned/barcode_scans is a flat, global node (not scoped under container/{id}) — every
// agent's scans land here regardless of device/session. loadScanHistory() does a one-shot
// full fetch of it (so new barcodes from other sessions are discovered, not just already-
// known local ones), and this listener keeps that in sync live afterwards. Requires a
// Google ID token (same as container/), so this is a no-op for QR-only sessions — there's
// no token mechanism for those, and retrying a stream that will only ever 401 would just
// spam reconnects every 5s forever.
async function startScanListener() {
  if (scanSseSource) { scanSseSource.close(); scanSseSource = null; }
  if (!currentGoogleUid) return;
  const idToken = await getValidFirebaseIdToken().catch(() => null);
  if (!idToken) return;
  scanSseSource = new EventSource(`${FIREBASE_URL}/scanned/barcode_scans.json?auth=${idToken}`);
  const reload = () => { if (isInitialized) loadScanHistory(); };
  scanSseSource.addEventListener('put', (event) => {
    try {
      const parsed = JSON.parse(event.data);
      // The very first event on connect is always a full snapshot at path "/" — skip it,
      // loadScanHistory()'s own full fetch already covers that. Only reload for actual
      // deltas afterwards (path like "/DA123..." or "/DA123.../scan_...").
      if (parsed.path === '/') return;
      reload();
    } catch (e) { console.error('Scan SSE error:', e); }
  });
  scanSseSource.addEventListener('patch', reload);
  scanSseSource.onerror = () => {
    setTimeout(() => { if (!isShuttingDown && currentGoogleUid) startScanListener(); }, 5000);
  };
}

// ══════════════════════════════
// 🔗 কানেকশন স্টেট UI
// ══════════════════════════════
/** meta object for showConnectedState() when the active session is Google-linked —
 *  prefers the real profile name/photo (from users/{uid}/profile) over the raw email. */
function googleLinkedMeta() {
  return {
    device_info: currentGoogleName || currentGoogleEmail || 'Google account',
    avatar_url: currentGooglePhotoUrl || ''
  };
}

function showConnectedState(d) {
  document.getElementById('screen-google-login')?.classList.remove('active');
  document.getElementById('screen-connect')?.classList.remove('active');
  document.getElementById('screen-connected')?.classList.add('active');
  document.getElementById('status-dot')?.classList.add('connected');
  const n = d?.meta?.device_info || d?.meta?.android_id?.substring(0, 8) || 'Connected';
  const statusNameEl = document.getElementById('status-name');
  if (statusNameEl) statusNameEl.textContent = n;
  const agentNameEl = document.getElementById('agent-name');
  if (agentNameEl) agentNameEl.textContent = n;

  const avatarEl = document.getElementById('agent-avatar');
  const avatarUrl = d?.meta?.avatar_url;
  if (avatarEl) {
    if (typeof avatarUrl === 'string' && /^https:/.test(avatarUrl)) {
      const img = document.createElement('img');
      img.src = avatarUrl;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      avatarEl.replaceChildren(img);
    } else {
      avatarEl.textContent = n.charAt(0).toUpperCase();
    }
  }

  // Extension ID
  const extEl = document.getElementById('connected-ext-id');
  if (extEl && currentExtensionID) extEl.textContent = currentExtensionID;

  // UID — container থাকলে সেটা, না হলে Google UID
  const uidEl = document.getElementById('connected-uid');
  if (uidEl) uidEl.textContent = currentContainerID || currentGoogleUid || '—';

  switchTab('history');
}
async function clearContainerState() {
  currentContainerID = null;
  currentUserId = null;
  await chrome.storage.local.remove(['container_id', 'user_id']);
}

function showDisconnectedState() {
  // If a Google account is linked, NEVER show the disconnected/Guest/QR view — Google login
  // is completely independent of the QR pairing session's status. All current call sites
  // already guard with `if (!currentGoogleUid)` or bypass this function entirely (see
  // checkConnectionWithFallback()), but checking here too means a future caller forgetting
  // that guard can't accidentally wipe a valid Google session and bounce the user back to Guest.
  if (currentGoogleUid) {
    showConnectedState({ meta: googleLinkedMeta() });
    return;
  }
  clearContainerState(); // wipe container so subsequent loadHistory won't fetch it
  const connectScreen = document.getElementById('screen-connect');
  const connectedScreen = document.getElementById('screen-connected');
  const statusDot = document.getElementById('status-dot');
  const statusName = document.getElementById('status-name');
  if (connectedScreen) connectedScreen.classList.remove('active');
  if (connectScreen) connectScreen.classList.add('active');
  if (statusDot) statusDot.classList.remove('connected');
  if (statusName) statusName.textContent = 'Guest';
}

async function checkConnectionWithFallback(extension_id, retries = 5) {
  // A Google-linked session doesn't depend on the QR/sessions/{id} node ever reaching
  // status "connected" — that's a completely separate pairing mechanism. Previously this
  // function ONLY checked the QR session and, after failing to see it "connected" here (which
  // it never will if the user only ever signed in with Google, no QR scan), unconditionally
  // fell through to showDisconnectedState() — wiping the just-established Google container
  // and showing "Guest", even though the Google login was perfectly valid. That's exactly why
  // reopening the popup after a successful Google login showed Guest + the QR screen again.
  const googleLinked = !!currentGoogleUid;
  if (googleLinked) {
    showConnectedState({ meta: googleLinkedMeta() });
  }

  for (let i = 0; i < retries; i++) {
    try {
      const url = `${FIREBASE_URL}/sessions/${extension_id}.json?cb=${Date.now()}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data && data.meta && data.meta.status === 'connected' && !googleLinked) {
        await resolveContainerFromMeta(data.meta);
        showConnectedState(data);
        return true;
      }
    } catch (e) { console.warn(`Poll attempt ${i+1} failed:`, e); }
    if (googleLinked) break; // already have a valid session — no need to keep retrying/waiting
    await new Promise(r => setTimeout(r, 1000));
  }

  if (googleLinked) return true; // still connected via Google even without a QR session
  showDisconnectedState();
  return false;
}


// ══════════════════════════════
// 🔐 Google Sign-In (cross-connect with Android app via same account)
// ══════════════════════════════
//
// Flow:
//   1. chrome.identity.launchWebAuthFlow() -> opens Google's real account-chooser page and
//      returns a Google OAuth access_token (prompt=select_account forces the chooser even
//      when only one Google account is signed into Chrome).
//   2. Exchange that access_token for a Firebase ID token + UID via the Firebase Auth REST API
//      (accounts:signInWithIdp) — this is the SAME UID the Android app gets when the user signs
//      in with Google there, since both resolve through the same Firebase project + Google account.
//   3. Store google_uid locally and link this extension's session to that UID in Firebase, so the
//      Android app (already logged in with that UID) can auto-recognize this extension without a
//      QR scan.
//   4. Once linked, hide the QR/manual-connect screen — Google login becomes the primary path.
//      (Logged-out state still falls back to showing screen-connect; wiring that toggle is a
//      follow-up step.)
//
// HISTORY — first attempt at this broke login entirely (do not repeat this mistake):
//   launchWebAuthFlow() needs a "Web application"-type OAuth client with the extension's
//   chromiumapp.org redirect URI explicitly authorized in Google Cloud Console. The FIRST
//   attempt reused the existing "Chrome Extension"-type client_id (the one in manifest.json's
//   oauth2 block, meant for chrome.identity.getAuthToken()'s browser-managed flow, which
//   doesn't validate redirect_uri at all) — Google's OAuth server rejected that outright with
//   "Error 400: redirect_uri_mismatch", breaking login completely. Fixed by creating a SEPARATE
//   "Web application"-type OAuth client (GOOGLE_OAUTH_WEB_CLIENT_ID below) with
//   https://gnchjfgedcimmpmoheolhajinihcnipb.chromiumapp.org/ authorized as a redirect URI —
//   that extension ID is deterministic from manifest.json's fixed "key" field, so it won't
//   change across reloads as long as that key stays the same. Do NOT swap this back to the
//   Chrome-Extension-type client_id — same failure will recur.


// NOTE: Google auth এখন background.js-এ চলে (db_google_login relay) — popup
// থেকে launchWebAuthFlow() চালালে auth window খুলতেই popup বন্ধ হয়ে callback
// মরতো, profile select করলেও login শেষ হতো না। Web client ID + HISTORY
// background.js-এ দেখো। Exchange (signInWithIdp) background-এই হয়; নিচের
// exchangeGoogleTokenForFirebaseUid() এখন অব্যবহৃত, শুধু রেফারেন্স হিসেবে রাখা।

async function exchangeGoogleTokenForFirebaseUid(accessToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postBody: `access_token=${accessToken}&providerId=google.com`,
        requestUri: 'http://localhost',
        returnSecureToken: true
      })
    }
  );
  const data = await res.json();
  if (!res.ok || !data.localId) {
    throw new Error(data?.error?.message || 'Firebase sign-in exchange failed');
  }
  // idToken/refreshToken were previously discarded here — without them, every subsequent
  // fetch() to an authenticated path (users/{uid}/... etc.) had no way to prove who's asking,
  // even though we already know the uid. Firebase Rules generally require auth != null for
  // anything under users/, so those writes/reads would silently fail without these.
  return {
    uid: data.localId,
    email: data.email || '',
    displayName: data.displayName || '',
    photoUrl: data.photoUrl || '',
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresIn: parseInt(data.expiresIn, 10) || 3600
  };
}

/** Mirrors AuthManager.completeGoogleSignIn() / UserRepository.createNewProfile() on the
 *  Android app side: checks users/{uid}/profile — if it already exists, leaves it completely
 *  untouched and just returns it (so this extension never clobbers a real profile the app or
 *  an admin has set up, e.g. role, branch assignments). If it doesn't exist, creates a brand
 *  new one with the exact same shape/fields the app writes, so the app and extension agree on
 *  what a "new user" profile looks like regardless of which side signs in first. */
async function ensureUserProfile(uid, idToken, displayName, email, photoUrl) {
  const authParam = idToken ? `?auth=${idToken}` : '';
  const profileUrl = `${FIREBASE_URL}/users/${uid}/profile.json${authParam}`;

  const existing = await fetch(profileUrl).then(r => r.json()).catch(() => null);
  if (existing) return existing; // ✅ existing user — profile untouched, just return it

  // ✅ new user — create fresh profile with guest role (same defaults as
  // UserRepository.createNewProfile on the Android app)
  const now = Date.now();
  const newProfile = {
    name: displayName || (email ? email.split('@')[0] : 'User'),
    email: email || '',
    containerId: `container_${uid}`,
    user_id: uid,
    photo_url: photoUrl || '',
    createdAt: now,
    lastActive: now,
    company_info: {
      role_id: 'guest',
      branch_ids: [],
      employee_id: '',
      designation: '',
      agent_type: '',
      salary_model: '',
      salary_type: '',
      fixed_amount: '',
      status: 'active'
    }
  };

  await fetch(profileUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newProfile)
  });

  return newProfile;
}

// In-memory Firebase auth token state — mirrored to chrome.storage.local so it survives
// popup close/reopen (the popup's JS context is fully torn down every time it closes).
let idTokenExpiresAt = 0; // absolute ms timestamp

/** Exchanges a Firebase refresh_token for a fresh id_token. Firebase ID tokens expire after
 *  ~1hr, so anything doing authenticated REST calls needs this to keep working without
 *  forcing the user through Google sign-in again every hour. Google may rotate the
 *  refresh_token itself on each call — always persist whatever comes back, not just idToken. */
async function refreshFirebaseIdToken(refreshToken) {
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString()
    }
  );
  const data = await res.json();
  if (!res.ok || !data.id_token) {
    throw new Error(data?.error?.message || 'Token refresh failed');
  }
  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresIn: parseInt(data.expires_in, 10) || 3600
  };
}

/** Returns a currently-valid Firebase ID token for authenticated REST calls (append as
 *  ?auth=<token> per Firebase's REST API), transparently refreshing via the stored
 *  refresh_token if the cached one has expired or is within 5 minutes of expiring. Returns
 *  null if there's no Google session at all — callers should skip auth (or skip the call
 *  entirely) in that case, same as before this existed. */
async function getValidFirebaseIdToken() {
  if (!currentRefreshToken) return null;
  const SAFETY_MARGIN_MS = 5 * 60 * 1000;
  if (currentIdToken && Date.now() < idTokenExpiresAt - SAFETY_MARGIN_MS) {
    return currentIdToken;
  }
  const { idToken, refreshToken, expiresIn } = await refreshFirebaseIdToken(currentRefreshToken);
  currentIdToken = idToken;
  currentRefreshToken = refreshToken;
  idTokenExpiresAt = Date.now() + expiresIn * 1000;
  await chrome.storage.local.set({
    google_id_token: currentIdToken,
    google_refresh_token: currentRefreshToken,
    google_token_expires_at: idTokenExpiresAt
  });
  return currentIdToken;
}

/** Links this extension's session to the signed-in Google/Firebase UID so the Android app
 *  (logged in with the same account) can recognize it without a QR scan. */
async function linkExtensionToUid(extensionId, uid, email) {
  const now = Date.now();
  await fetch(`${FIREBASE_URL}/sessions/${extensionId}/meta.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      google_uid: uid,
      google_email: email,
      linked_at: now
    })
  });
  // Mirror under the user's own node too, so the app can discover extensions the same way
  // it discovers QR-connected ones. Authenticated with ?auth=<idToken> — users/{uid}/... is
  // expected to require Firebase Auth per this project's security rules (same as every other
  // users/{uid} read/write the Android app does via the SDK, which attaches auth automatically).
  const idToken = await getValidFirebaseIdToken().catch(() => null);
  const authParam = idToken ? `?auth=${idToken}` : '';
  // Shape MUST match UserRepository.saveExtensionConnection()'s object exactly — the
  // Android app's UnifiedHistoryFetcher.listenToConnectedExtensions() discovers extensions
  // by reading connections/extensions/{id}/status === "connected". This previously wrote
  // a bare number (`now`) here instead of an object, so that .status child was always
  // null/missing and the app could never auto-discover a Google-linked extension — the
  // entire "sign in with the same Google account, no QR needed" path silently did nothing
  // on the app side even though the extension believed it had linked successfully.
  //
  // Check-then-write rather than a blind PUT: this same node can already exist from a
  // QR-based pairing, with its own android_id/type/connected_at set by the Android side.
  // A blind PUT here would silently erase those fields the moment someone also signs in
  // with Google on the same extension. Only status/last_sync change on a node that
  // already exists; a brand-new node gets the full default shape.
  const extConnPath = `users/${uid}/connections/extensions/${extensionId}`;
  const existingConn = await fetch(`${FIREBASE_URL}/${extConnPath}.json${authParam}`)
    .then(r => r.json()).catch(() => null);
  await fetch(`${FIREBASE_URL}/${extConnPath}.json${authParam}`, {
    method: existingConn && typeof existingConn === 'object' ? 'PATCH' : 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      existingConn && typeof existingConn === 'object'
        ? { status: 'connected', last_sync: now }
        : { status: 'connected', type: 'google_linked', connected_at: now, last_sync: now }
    )
  });
}

/**
 * Heartbeat: refreshes this extension's own last_sync under
 * users/{uid}/connections/extensions/{extensionId}. linkExtensionToUid() above only
 * ever runs once, at Google-login time — without something re-touching last_sync on
 * every subsequent popup open, a genuinely still-in-use extension would look just as
 * stale as an abandoned one once EXTENSION_STALE_MS has passed, and loadHistory()'s
 * pruning below would delete it. Fire-and-forget: this is presence bookkeeping, not
 * data anything on this popup-open actually waits on.
 */
async function touchExtensionConnection(extensionId, uid) {
  try {
    const idToken = await getValidFirebaseIdToken().catch(() => null);
    const authParam = idToken ? `?auth=${idToken}` : '';
    await fetch(`${FIREBASE_URL}/users/${uid}/connections/extensions/${extensionId}.json${authParam}`, {
      method : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ last_sync: Date.now() })
    });
  } catch (e) { console.warn('touchExtensionConnection failed:', e); }
}

async function handleGoogleLogin() {
  const btn = document.getElementById('google-login-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in...'; }
  try {
    // Chooser + exchange background service worker-এ হয় (db_google_login) —
    // popup খোলা থাক বা মাঝপথে বন্ধ হোক, session google_pending_login-এ জমে।
    const res = await chrome.runtime.sendMessage({ action: 'db_google_login' });
    if (!res?.ok) throw new Error(res?.error || 'Google login failed');
    const done = await finishGoogleLoginFromPending();
    if (!done && btn) { btn.textContent = 'Sign in with Google'; btn.disabled = false; }
  } catch (e) {
    console.error('Google Sign-In failed:', e);
    if (btn) { btn.textContent = 'Sign in with Google'; btn.disabled = false; }
    alert('Google Sign-In failed. Please try again.');
  }
}

// Background-এর রাখা google_pending_login থেকে login শেষ করে: conflict check,
// profile ensure, link, UI. Popup মাঝপথে বন্ধ হয়ে গেলে init থেকে auto-resume
// হয়ে এটাই চলে — তাই এখানে alert নেই, ব্যর্থ হলে শুধু false।
async function finishGoogleLoginFromPending() {
  const btn = document.getElementById('google-login-btn');
  const { google_pending_login: p } = await chrome.storage.local.get(['google_pending_login']);
  if (!p?.uid || !p?.idToken) return false;
  const { uid, email, displayName, photoUrl, idToken, refreshToken, expiresIn } = p;

  // Conflict check: currentUserId gets set by resolveContainerFromMeta() whenever a QR
  // session's meta carries a user_id (i.e., this extension is already paired to an Android
  // app that's logged in with SOME Google account). If that account is DIFFERENT from the
  // one just signed into here, silently proceeding would switch the active container away
  // from the paired device's — future data would go to THIS account's container instead,
  // which the paired device never looks at, with no indication anything changed.
  if (currentUserId && currentUserId !== uid) {
    const proceed = confirm(
      `⚠️ এই extension বর্তমানে অন্য একটি connected device-এর সাথে link করা আছে।\n\n` +
      `${email} দিয়ে sign in করলে data এখন থেকে সেই device-এর container-এ না গিয়ে এই ` +
      `Google account-এর নিজস্ব container-এ যাবে — connected device সেটা দেখতে পাবে না।\n\n` +
      `তবুও continue করবেন?`
    );
    if (!proceed) {
      await chrome.storage.local.remove(['google_pending_login']);
      if (btn) { btn.textContent = 'Sign in with Google'; btn.disabled = false; }
      return false;
    }
  }

  currentGoogleUid = uid;
  currentGoogleEmail = email;
  currentIdToken = idToken;
  currentRefreshToken = refreshToken;
  idTokenExpiresAt = Date.now() + expiresIn * 1000;

  // ✅ users/{uid}/profile — check if it already exists (existing user, e.g. already
  // signed in on the Android app) or needs to be created fresh (brand-new user). Same
  // path + shape as AuthManager.completeGoogleSignIn() on the app side.
  const profile = await ensureUserProfile(uid, idToken, displayName, email, photoUrl).catch((err) => {
    console.error('ensureUserProfile failed:', err);
    return null;
  });
  currentGoogleName = profile?.name || displayName || email;
  currentGooglePhotoUrl = profile?.photo_url || photoUrl || '';

  await chrome.storage.local.set({
    google_uid: uid,
    google_email: email,
    google_name: currentGoogleName,
    google_photo_url: currentGooglePhotoUrl,
    google_id_token: currentIdToken,
    google_refresh_token: currentRefreshToken,
    google_token_expires_at: idTokenExpiresAt
  });
  await chrome.storage.local.remove(['google_pending_login']);

  if (currentExtensionID) {
    await linkExtensionToUid(currentExtensionID, uid, email);
  }

  // A linked account counts as "connected" from the extension's side — the Android app
  // will pick up the container/session the next time it resolves paths for this UID.
  currentContainerID = `container_${uid}`;
  currentUserId = uid;
  await chrome.storage.local.set({ container_id: currentContainerID, user_id: uid });

  document.getElementById('screen-google-login')?.classList.remove('active');
  showConnectedState({ meta: googleLinkedMeta() });
  // NOTE: getActivePaths() is intentionally NOT called here — it re-derives
  // containerID from sessions/{extension_id}/meta, which only exists for the
  // QR-connect flow. Calling it here was clobbering the containerID we just
  // set above (back to null) whenever no QR session existed yet, which broke
  // loadHistory() right after Google login.
  await loadHistory(false);
  if (currentContainerID) startContainerListener(currentContainerID);
  startScanListener();
  return true;
}

async function restoreGoogleLoginState() {
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get(
      ['google_uid', 'google_email', 'google_name', 'google_photo_url', 'google_id_token', 'google_refresh_token', 'google_token_expires_at'],
      resolve
    )
  );
  if (stored.google_uid) {
    currentGoogleUid = stored.google_uid;
    currentGoogleEmail = stored.google_email || '';
    currentGoogleName = stored.google_name || '';
    currentGooglePhotoUrl = stored.google_photo_url || '';
    currentIdToken = stored.google_id_token || null;
    currentRefreshToken = stored.google_refresh_token || null;
    idTokenExpiresAt = stored.google_token_expires_at || 0;
    document.getElementById('screen-google-login')?.classList.remove('active');
    return true;
  }
  return false;
}

async function clearGoogleLoginState() {
  // No chrome.identity.removeCachedAuthToken() call needed here — that's specific to
  // chrome.identity.getAuthToken()'s internal token cache, which our background-relay
  // login flow doesn't use at all. Signing out just means dropping our own
  // stored session state below. Also drop any half-finished login.
  currentGoogleUid = null;
  currentGoogleEmail = null;
  currentGoogleName = null;
  currentGooglePhotoUrl = null;
  currentIdToken = null;
  currentRefreshToken = null;
  idTokenExpiresAt = 0;
  await chrome.storage.local.remove([
    'google_uid', 'google_email', 'google_name', 'google_photo_url',
    'google_id_token', 'google_refresh_token', 'google_token_expires_at',
    'google_pending_login'
  ]);
}

function setupGoogleLogin() {
  const btn = document.getElementById('google-login-btn');
  if (!btn) return;
  btn.addEventListener('click', handleGoogleLogin);
}


async function setupDisconnect(id) {
  const btn = document.getElementById('disconnect-btn');
  if (!btn) return;
  
  btn.addEventListener('click', async () => {
    showLoading("Disconnecting...");

    // ① Firebase-এ disconnect signal সবার আগে — keepalive নিশ্চিত করে
    //   window.close() এর পরেও request complete হবে
    try {
      await fetch(`${FIREBASE_URL}/sessions/${id}/meta/status.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify("disconnected"),
        keepalive: true
      });
      console.log("✅ meta.status → disconnected");
    } catch (e) {
      console.error('❌ Disconnect signal failed:', e);
    }

    // If this extension was Google-linked, also remove the discovery entry under
    // users/{uid}/connections/extensions — otherwise the app keeps listening to
    // sessions/{id}/records forever, believing this extension is still "connected"
    // (see linkExtensionToUid()'s PUT of status:"connected" there).
    if (currentGoogleUid) {
      try {
        const idToken = await getValidFirebaseIdToken().catch(() => null);
        const authParam = idToken ? `?auth=${idToken}` : '';
        await fetch(`${FIREBASE_URL}/users/${currentGoogleUid}/connections/extensions/${id}.json${authParam}`, {
          method: "DELETE",
          keepalive: true
        });
      } catch (e) {
        console.error('❌ Extension-connection cleanup failed:', e);
      }
    }

    // ② তারপর local cleanup
    if (sseSource) { sseSource.close(); sseSource = null; }
    if (containerSseSource) { containerSseSource.close(); containerSseSource = null; }
    if (scanSseSource) { scanSseSource.close(); scanSseSource = null; }
    await clearContainerState();
    await clearGoogleLoginState();
    // Every connection gets a fresh extension ID — old one is dropped so it
    // can't be reused to reconnect after disconnect (e.g. if it leaked via a
    // screenshot or shared screen).
    await new Promise((resolve) => chrome.storage.local.remove(['extension_id'], resolve));
    currentExtensionID = null;

    showDisconnectedState();
    document.getElementById('screen-google-login')?.classList.add('active');
    document.getElementById('screen-connect')?.classList.remove('active');
    hideLoading();
    window.close();

    // ⛔ এখানে startSessionListener(id) কল করা যাবে না। এটাই আগের কোডে কাজ করার মূল কারণ।
  });
}


function setupSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;
  input.addEventListener('input', () => {
    searchQuery = input.value.trim();
    renderHistory();
  });
}

function setupSettings() {
  const clearBtn = document.getElementById('clear-history-btn');
  if (!clearBtn) return;
  clearBtn.addEventListener('click', async () => {
    if (!confirm('সব history permanently delete হবে। নিশ্চিত?')) return;
    clearBtn.textContent = '⏳';
    clearBtn.disabled = true;
    try {
      const { historyPath, sessionPath } = await getActivePaths();
      if (historyPath) await fetch(`${FIREBASE_URL}/${historyPath}.json`, { method: 'DELETE' });
      if (sessionPath) await fetch(`${FIREBASE_URL}/${sessionPath}.json`, { method: 'DELETE' });
      historyItems = [];
      renderHistory();
      clearBtn.textContent = '✅ Cleared!';
      setTimeout(() => { clearBtn.textContent = 'Clear'; clearBtn.disabled = false; }, 2000);
    } catch (e) {
      console.error('Clear failed:', e);
      clearBtn.textContent = '❌ Failed';
      setTimeout(() => { clearBtn.textContent = 'Clear'; clearBtn.disabled = false; }, 2000);
    }
  });

  setupAutofillUrls();
  setupCcPanelUrls();
  setupAutoCopyToggle();
  setupShowNotificationsToggle();
  setupUnhideSettings();
}

// "Auto-unhide" (Settings → Auto-unhide). content.js reads these keys:
// unhide_enabled (default ON) + unhide_selectors (CSS selector list).
// Selectors are validated with querySelector before saving — invalid ones
// are rejected with a hint instead of breaking the content script later.
async function setupUnhideSettings() {
  const toggle = document.getElementById('unhide-enabled-toggle');
  const input  = document.getElementById('unhide-selector-input');
  const addBtn = document.getElementById('unhide-selector-add-btn');
  const listEl = document.getElementById('unhide-selector-list');
  if (!toggle || !input || !addBtn || !listEl) return;

  async function loadCfg() {
    const r = await chrome.storage.local.get(['unhide_enabled', 'unhide_selectors']);
    return {
      enabled: r.unhide_enabled !== false,
      selectors: Array.isArray(r.unhide_selectors) ? r.unhide_selectors : [],
    };
  }
  function validSelector(s) {
    try { document.querySelector(s); return true; }
    catch { return false; }
  }
  async function render() {
    const { enabled, selectors } = await loadCfg();
    toggle.checked = enabled;
    listEl.innerHTML = selectors.length
      ? selectors.map(s => `<div class="autofill-url-chip"><span>${escapeHtml(s)}</span><span class="url-remove" data-sel="${escapeHtml(s)}">✕</span></div>`).join('')
      : '<div class="settings-hint">No selectors yet — nothing will be auto-clicked.</div>';
    listEl.querySelectorAll('[data-sel]').forEach(el => {
      el.addEventListener('click', async () => {
        const cur = (await loadCfg()).selectors.filter(x => x !== el.dataset.sel);
        await chrome.storage.local.set({ unhide_selectors: cur });
        render();
      });
    });
  }
  toggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ unhide_enabled: toggle.checked });
  });
  addBtn.addEventListener('click', async () => {
    const v = input.value.trim();
    if (!v) return;
    if (!validSelector(v)) {
      input.value = '';
      input.placeholder = '⚠ Invalid selector — আবার চেষ্টা করো';
      setTimeout(() => { input.placeholder = 'e.g. .eye-btn, #show-phone'; }, 2000);
      return;
    }
    const cur = (await loadCfg()).selectors;
    if (!cur.includes(v)) await chrome.storage.local.set({ unhide_selectors: [...cur, v] });
    input.value = '';
    render();
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
  render();
}

// "Dark mode" (Settings → Appearance). Default is light; the choice persists
// in chrome.storage.local (db_theme) with a localStorage mirror (db_theme_ls)
// that theme-boot.js reads synchronously to avoid a first-paint flash.
function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
async function setupDarkModeToggle() {
  let dark = false;
  try {
    const { db_theme } = await chrome.storage.local.get(['db_theme']);
    dark = db_theme === 'dark';
  } catch {}
  applyTheme(dark);
  try { localStorage.setItem('db_theme_ls', dark ? 'dark' : 'light'); } catch {}
  const toggle = document.getElementById('dark-mode-toggle');
  if (!toggle) return;
  toggle.checked = dark;
  toggle.addEventListener('change', () => {
    const d = toggle.checked;
    applyTheme(d);
    try { localStorage.setItem('db_theme_ls', d ? 'dark' : 'light'); } catch {}
    chrome.storage.local.set({ db_theme: d ? 'dark' : 'light' });
  });
}

// "Show notifications" (Settings → Notifications). Read by background.js before
// every chrome.notifications.create — absent key means on (default checked).
async function setupShowNotificationsToggle() {
  const toggle = document.getElementById('show-notifications-toggle');
  if (!toggle) return;
  const { show_notifications } = await chrome.storage.local.get(['show_notifications']);
  toggle.checked = show_notifications !== false;
  toggle.addEventListener('change', () => {
    chrome.storage.local.set({ show_notifications: toggle.checked });
  });
}

// "Auto-copy incoming data" (Settings → App → Desktop). Read by background.js's
// pollIncomingCommands() as auto_copy_incoming — default is off (checkbox
// unchecked) until the user opts in, since silently overwriting someone's
// clipboard is the kind of thing that should be an explicit choice.
async function setupAutoCopyToggle() {
  const toggle = document.getElementById('auto-copy-incoming-toggle');
  if (!toggle) return;
  const { auto_copy_incoming } = await chrome.storage.local.get(['auto_copy_incoming']);
  toggle.checked = !!auto_copy_incoming;
  toggle.addEventListener('change', () => {
    chrome.storage.local.set({ auto_copy_incoming: toggle.checked });
  });
}

// Manages the "Auto-fill Pages" list (chrome.storage.local key:
// autofill_page_urls) that scan-receive-helper.js's initIfAllowed() reads to
// decide which pages it should activate on. Absent key -> DEFAULT_URLS
// (matches the original hardcoded hermes.pathaointernal.com/run-routes
// behavior); an explicitly-saved empty array is respected as-is, even
// though empty — Array.isArray is what draws that line on both sides.
async function setupAutofillUrls() {
  const input  = document.getElementById('autofill-url-input');
  const addBtn = document.getElementById('autofill-url-add-btn');
  const listEl = document.getElementById('autofill-url-list');
  if (!input || !addBtn || !listEl) return;

  const DEFAULT_URLS = ['hermes.pathaointernal.com/run-routes'];

  async function loadUrls() {
    const result = await chrome.storage.local.get(['autofill_page_urls']);
    return Array.isArray(result.autofill_page_urls) ? result.autofill_page_urls : DEFAULT_URLS;
  }
  async function saveUrls(urls) {
    await chrome.storage.local.set({ autofill_page_urls: urls });
  }
  async function render() {
    const urls = await loadUrls();
    listEl.innerHTML = urls.length
      ? urls.map(u => `<div class="autofill-url-chip"><span>${escapeHtml(u)}</span><span class="url-remove" data-url="${escapeHtml(u)}">✕</span></div>`).join('')
      : '<div class="settings-hint">No pages configured — panel won\'t auto-appear anywhere.</div>';
    listEl.querySelectorAll('[data-url]').forEach(el => {
      el.addEventListener('click', async () => {
        await saveUrls((await loadUrls()).filter(u => u !== el.dataset.url));
        render();
      });
    });
  }

  addBtn.addEventListener('click', async () => {
    const val = input.value.trim();
    if (!val) return;
    const urls = await loadUrls();
    if (urls.includes(val)) { input.value = ''; return; }
    urls.push(val);
    await saveUrls(urls);
    input.value = '';
    render();
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });

  render();
}

// Manages the "Call Center Panel Pages" list (chrome.storage.local key:
// cc_panel_urls) that the Call Center panel's own init gate reads to decide
// which pages it should appear on. Same pattern as setupAutofillUrls() above,
// but the default is an empty array, not a hardcoded URL — unlike the
// Reconcile panel (which always had a known Hermes URL), there's no known
// default page for this one, so it stays off everywhere until configured.
async function setupCcPanelUrls() {
  const input  = document.getElementById('cc-panel-url-input');
  const addBtn = document.getElementById('cc-panel-url-add-btn');
  const listEl = document.getElementById('cc-panel-url-list');
  if (!input || !addBtn || !listEl) return;

  async function loadUrls() {
    const result = await chrome.storage.local.get(['cc_panel_urls']);
    return Array.isArray(result.cc_panel_urls) ? result.cc_panel_urls : [];
  }
  async function saveUrls(urls) {
    await chrome.storage.local.set({ cc_panel_urls: urls });
  }
  async function render() {
    const urls = await loadUrls();
    listEl.innerHTML = urls.length
      ? urls.map(u => `<div class="autofill-url-chip"><span>${escapeHtml(u)}</span><span class="url-remove" data-url="${escapeHtml(u)}">✕</span></div>`).join('')
      : '<div class="settings-hint">No pages configured — panel won\'t appear anywhere.</div>';
    listEl.querySelectorAll('[data-url]').forEach(el => {
      el.addEventListener('click', async () => {
        await saveUrls((await loadUrls()).filter(u => u !== el.dataset.url));
        render();
      });
    });
  }

  addBtn.addEventListener('click', async () => {
    const val = input.value.trim();
    if (!val) return;
    const urls = await loadUrls();
    if (urls.includes(val)) { input.value = ''; return; }
    urls.push(val);
    await saveUrls(urls);
    input.value = '';
    render();
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });

  render();
}

function setupLoadMore() {
  const btn = document.getElementById('load-more-btn');
  if (!btn) return;
  btn.addEventListener('click', () => loadHistory(true));
}

function setupSortButton() {
  const btn = document.getElementById('sort-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    sortOrder = sortOrder === 'newest' ? 'oldest' : 'newest';
    btn.textContent = sortOrder === 'newest' ? 'Newest first ↓' : 'Oldest first ↑';
    renderHistory();
  });
}

function setupAutoRefresh() {
  window.addEventListener('focus', async () => {
    if (isInitialized && currentExtensionID) {
      await getActivePaths();
      await loadHistory(false);
    }
  });
  refreshInterval = setInterval(async () => {
    if (document.visibilityState === 'visible' && isInitialized) {
      await loadHistory(false);
    }
  }, 30000);
}

// ══════════════════════════════

// ✅ এক্সটেনশন আইডি জেনারেটর (DB-DDMMYY-XXXXXX ফরম্যাট)
function getOrCreateExtensionID() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['extension_id'], (result) => {
      if (result.extension_id) {
        resolve(result.extension_id); // ✅ লোকালে থাকলে রিইউজ
      } else {
        // ✅ না থাকলে নতুন জেনারেট
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yy = String(now.getFullYear()).slice(-2);
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        let suffix = '';
        for (let i = 0; i < 6; i++) suffix += chars[bytes[i] % chars.length];
        
        const newId = `DB-${dd}${mm}${yy}-${suffix}`;
        chrome.storage.local.set({ extension_id: newId }, () => resolve(newId));
      }
    });
  });
}

async function init() {
  if (isInitialized) return; // ✅ ডাবল ইনিট প্রিভেন্ট
  setupDarkModeToggle(); // theme first — before anything paints content
  showLoading("Initializing...");
  try {
    // ✅ ১. লোকাল চেক → না থাকলে জেনারেট → স্টোরেজে সেভ
    const extension_id = await getOrCreateExtensionID();
    currentExtensionID = extension_id;
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    chrome.storage.local.set({ unread_count: 0 }).catch(() => {});

    // ✅ ২. UI সেটআপ
    // Reads from manifest.json directly (not hardcoded) so this can never drift out of
    // sync with the actual installed version — bump the manifest, this updates itself.
    const versionTag = document.getElementById('version-tag');
    if (versionTag) versionTag.textContent = `v${chrome.runtime.getManifest().version}`;

    const extIdDisplay = document.getElementById('extension-id-display');
    if (extIdDisplay) extIdDisplay.textContent = extension_id;

    setupNavigation();
    generateQR(extension_id); // ✅ নতুন QR জেনারেট হবে
    setupCopyExtensionID(extension_id);
    setupDisconnect(extension_id);
    setupGoogleLogin();
    await restoreGoogleLoginState();
    // Auth window খোলার সময় popup বন্ধ হয়ে গেলে background login শেষ করে
    // google_pending_login রেখে দেয় — reopen-এ এখান থেকে auto-resume।
    if (!currentGoogleUid) {
      try { await finishGoogleLoginFromPending(); } catch (e) { console.warn('Pending Google login resume failed:', e); }
    }
    // Fire-and-forget heartbeat — not on the critical path, see touchExtensionConnection()'s
    // doc comment for why this needs to run on every open, not just at login.
    if (currentGoogleUid) touchExtensionConnection(extension_id, currentGoogleUid);
    setupSearch();
    setupSettings();
    setupLoadMore();
    setupSortButton();
    setupScanTab(); // 📷 Scanner tab
    setupDashboardTab(); // 📊 Dashboard tab
    setupConnectedInfoCopy();
    setupAutoRefresh();

    // ✅ ৩. কানেকশন চেক & হিস্ট্রি লোড
    await checkConnectionWithFallback(extension_id);
    // (getActivePaths() used to be called again here — removed: loadHistory() calls it
    // internally at its own start and uses that result directly, so this was a second,
    // fully redundant sessions/{id}/meta.json fetch every single popup open.)
    await loadHistory(false);
    startSessionListener(extension_id);
    if (currentContainerID) startContainerListener(currentContainerID);
    startScanListener();

    isInitialized = true;
    console.log("✅ Popup initialized with ID:", extension_id);
  } catch (e) {
    console.error("❌ Init failed:", e);
    showDisconnectedState();
  } finally {
    hideLoading();
  }
}

// ══════════════════════════════
// 🔗 Connected Screen — ID copy buttons
// ══════════════════════════════
function setupConnectedInfoCopy() {
  function makeCopyBtn(btnId, valueId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const val = document.getElementById(valueId)?.textContent?.trim();
      if (!val || val === '—') return;
      navigator.clipboard.writeText(val).then(() => {
        btn.textContent = '✅';
        setTimeout(() => { btn.textContent = '📋'; }, 1500);
      }).catch(() => {
        btn.textContent = '❌';
        setTimeout(() => { btn.textContent = '📋'; }, 1500);
      });
    });
  }
  makeCopyBtn('copy-connected-ext-btn', 'connected-ext-id');
  makeCopyBtn('copy-connected-uid-btn', 'connected-uid');
}


// ══════════════════════════════
// 📷 Scan Tab — Local Storage
// ══════════════════════════════
// ── Scan Tab State ─────────────────────────────────────────────────────────
// scanItems = [{ barcodeKey, barcode, entries: [{scanKey, scanned_by,
//   container_id, createdAt, url, hostname}], loading }]
// One item per unique barcode. entries sorted newest-first.
// Always fetched from Firebase; local scan_log = temp queue pre-sync.
let scanItems = [];          // the paginated default feed (recent-first, loads more on scroll)
let scanSearchQuery = '';
let scanSearchResults = [];  // separate from scanItems — search mode never overwrites the feed

// ── Pagination state (Firebase side — see fetchScanPage()) ──────────────
let scanCursor      = null;  // lastScannedAt of the oldest item in the loaded pages so far
let scanHasMore     = true;  // false once a page comes back smaller than expected
let scanLoadingMore = false; // guards against overlapping page fetches (scroll can fire fast)
let scanSearchMode  = false; // true while showing prefix-search results instead of the feed
let scanTotalCount  = null;  // from the lightweight shallow-count fetch — badge only
let scanSearchDebounce = null;
const SCAN_META_KEYS = new Set(['lastScannedAt', 'barcode']); // sibling fields on {safeKey},
                                                                // not scan_{ts} entry children
                                                                // — see scanner-module.js

function scanExactTime(timestamp) {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  const time = d.toLocaleTimeString('en-US', {
    hour  : 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
  const date = d.toLocaleDateString('en-US', {
    day  : 'numeric',
    month: 'short',
    year : 'numeric'
  });
  return `${time} · ${date}`;
}

function safeFirebaseKey(barcode) {
  return String(barcode).replace(/[.#$[\]/+\s]/g, '_');
}


// 👤 Profile name resolution — lazy + cached
// ══════════════════════════════
// uid -> resolved name string | null (not found) | Promise (in-flight).
// Session-lifetime cache: shared across every scan card, so the same scanner's
// name is only ever fetched once no matter how many barcodes they appear on.
const profileNameCache = {};

async function fetchProfileName(uid) {
  if (!uid) return null;
  if (uid in profileNameCache && !(profileNameCache[uid] instanceof Promise)) {
    return profileNameCache[uid];
  }
  if (profileNameCache[uid] instanceof Promise) return profileNameCache[uid];

  const promise = (async () => {
    try {
      const idToken = await getValidFirebaseIdToken().catch(() => null);
      const authParam = idToken ? `?auth=${idToken}` : '';
      const res = await fetch(`${FIREBASE_URL}/users/${uid}/profile/name.json${authParam}`);
      if (!res.ok) return null;
      const name = await res.json();
      return (typeof name === 'string' && name.trim()) ? name.trim() : null;
    } catch (e) {
      console.warn('[Scan] profile name fetch failed:', e);
      return null;
    }
  })();

  profileNameCache[uid] = promise;
  const resolved = await promise;
  profileNameCache[uid] = resolved; // replace in-flight promise with the final value
  return resolved;
}

// Resolves every distinct uid inside one expanded card's body, updating each
// .scan-by-name span in place once its name comes back (falls back to staying
// on the short-uid placeholder if no profile name exists).
async function resolveScanEntryNames(bodyEl) {
  const spans = [...bodyEl.querySelectorAll('.scan-by-name[data-uid]')];
  const uniqueUids = [...new Set(spans.map(s => s.dataset.uid).filter(Boolean))];

  await Promise.all(uniqueUids.map(async (uid) => {
    const name = await fetchProfileName(uid);
    if (!name) return; // keep the short-uid placeholder
    spans.forEach(s => {
      if (s.dataset.uid === uid) s.textContent = name;
    });
  }));
}

function getHostname(url) {
  try { return new URL(url || '').hostname; } catch { return '—'; }
}

function loadScanHistory() {
  scanSearchMode  = false;
  scanSearchQuery = '';
  scanCursor      = null;
  scanHasMore     = true;
  scanLoadingMore = false;
  scanTotalCount  = null;

  chrome.storage.local.get(['scan_log'], async (result) => {
    try {
      if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
      await loadScanHistoryInner(result.scan_log || {});
    } catch (e) {
      console.warn('[Scan] loadScanHistory failed:', e?.message || e);
    }
  });
}

async function loadScanHistoryInner(log) {
    const barcodeKeys = Object.keys(log);
    console.log(`[Scan] loadScanHistory: ${barcodeKeys.length} barcode(s) in local storage`);

    // Build initial items from local data (shown immediately, before Firebase responds).
    // NOTE: Firebase is always queried below regardless of whether any local scans exist —
    // this function used to return early here when scan_log was empty, which meant a
    // barcode scanned on another device/session (never touching this browser's storage)
    // could never appear, no matter how long the tab stayed open.
    scanItems = barcodeKeys.map(safeKey => {
      const localScans = log[safeKey] || {};
      const entries = Object.entries(localScans).map(([scanKey, d]) => ({
        scanKey,
        scanned_by  : d.scanned_by || '—',
        uid         : d.uid || '—',
        createdAt   : d.createdAt,
        url         : d.url,
        hostname    : getHostname(d.url),
        fromFirebase: false,
      })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      // Local entries do carry the original barcode text (scanner-module.js's
      // saveLocally()) — prefer that over safeKey so special-character barcodes display
      // correctly even before Firebase's own `barcode` field enriches this item.
      const localBarcodeText = Object.values(localScans).find(d => d.barcode)?.barcode;

      return {
        barcodeKey: safeKey,
        barcode   : localBarcodeText || safeKey,
        entries,
        loading   : true,
      };
    }).sort((a, b) => (b.entries[0]?.createdAt || 0) - (a.entries[0]?.createdAt || 0));

    renderScanList();
    updateScanBadge();

    // Firebase side is now PAGINATED (recent 20 by lastScannedAt, more on scroll — see
    // fetchScanPage()) instead of one full-tree fetch. At 1000+ barcodes and growing, a
    // full fetch was both why the tab could feel like it hangs on open (huge synchronous
    // DOM build) and an ever-growing network cost; this keeps each page's cost flat
    // regardless of total dataset size.
    try {
      const idToken = await getValidFirebaseIdToken().catch(() => null);
      if (idToken) {
        console.log('[Scan] idToken present — fetching first Firebase page');
        await fetchScanPage(idToken);
        fetchScanTotalCount(idToken); // lightweight — badge count only, doesn't block render
      } else {
        // Silent by design for guest/QR-only sessions — but logged clearly so a "no data"
        // report can distinguish this from an actual failure below.
        console.log('[Scan] no idToken — guest/local-only mode, Firebase fetch skipped');
      }
      // No idToken (QR-only session, or the token fetch itself failed): skip the Firebase
      // fetch entirely rather than sending it unauthenticated and 401ing. Only this
      // browser's own locally-stored scans (already built above) show for these sessions —
      // same limitation startScanListener()'s SSE already documents for itself; there's no
      // token mechanism for QR-only sessions, so a request here would only ever fail.
    } catch (e) {
      console.warn('[Scan] Could not fetch scan list from Firebase:', e);
    }

    scanItems.forEach(item => { item.loading = false; });
    console.log(`[Scan] loadScanHistory done — ${scanItems.length} item(s) in feed, hasMore=${scanHasMore}`);
    renderScanList();
    updateScanBadge();
}

// Fetches one page of barcodes ordered by recency (lastScannedAt) and merges them into
// scanItems (enriching local-only items, or adding ones never seen on this device).
// Called for the first page (loadScanHistory()) and again per scroll-triggered page —
// each call costs the same regardless of how large the total dataset has grown.
async function fetchScanPage(idToken) {
  if (scanLoadingMore || !scanHasMore) {
    console.log(`[Scan] fetchScanPage skipped (loadingMore=${scanLoadingMore}, hasMore=${scanHasMore})`);
    return;
  }
  scanLoadingMore = true;
  try {
    const isFirstPage = scanCursor === null;
    // +1 on later pages to cover the one-item overlap at endAt's inclusive boundary.
    // (Rare edge case: if 2+ distinct barcodes share the exact same millisecond
    // lastScannedAt at a page boundary, this single-field cursor could in theory skip
    // or repeat one of them — acceptable tradeoff vs. Firebase RTDB not supporting
    // compound-key ordering.)
    const limit = isFirstPage ? PAGINATION_LIMIT : PAGINATION_LIMIT + 1;
    let url = `${FIREBASE_URL}/scanned/barcode_scans.json?orderBy="lastScannedAt"&limitToLast=${limit}&cb=${Date.now()}&auth=${idToken}`;
    if (!isFirstPage) url += `&endAt=${scanCursor}`;
    console.log(`[Scan] fetchScanPage: ${isFirstPage ? 'first page' : 'next page, cursor=' + scanCursor}, limit=${limit}`);
    console.log('[Scan] request URL:', url.replace(/auth=[^&]+/, 'auth=***'));

    const res = await fetch(url);
    console.log('[Scan] response status:', res.status, res.statusText);
    if (!res.ok) {
      // Firebase's error body usually says exactly what's wrong (bad/missing .indexOn,
      // permission denied, malformed query, etc.) — capture it, not just the status code.
      const bodyText = await res.text().catch(() => '(could not read body)');
      console.warn('[Scan] fetchScanPage FAILED:', res.status, res.statusText, '| body:', bodyText);
      return;
    }
    const pageData = await res.json();
    if (!pageData || typeof pageData !== 'object') {
      console.log('[Scan] fetchScanPage: request OK but page is empty (no barcodes matched) — nothing more to load');
      scanHasMore = false;
      return;
    }

    const rows = Object.entries(pageData);
    scanHasMore = rows.length >= limit;
    console.log(`[Scan] fetchScanPage: received ${rows.length} row(s), hasMore=${scanHasMore}`);

    let smallest = scanCursor;
    rows.forEach(([safeKey, data]) => {
      if (!data || typeof data !== 'object') return;
      let item = scanItems.find(i => i.barcodeKey === safeKey);
      if (!item) {
        item = { barcodeKey: safeKey, barcode: data.barcode || safeKey, entries: [], loading: false };
        scanItems.push(item);
      }
      if (data.barcode) item.barcode = data.barcode;

      const fbEntries = Object.entries(data)
        .filter(([k]) => !SCAN_META_KEYS.has(k))
        .map(([scanKey, val]) => ({
          scanKey,
          scanned_by  : val.scanned_by || '—',
          uid         : val.uid        || '—',
          createdAt   : val.createdAt,
          url         : val.url,
          hostname    : getHostname(val.url),
          fromFirebase: true,
        }));

      // Merge: Firebase is truth, keep any local-only entries (not yet synced)
      const fbKeys = new Set(fbEntries.map(e => e.scanKey));
      const localOnly = (item.entries || []).filter(e => !fbKeys.has(e.scanKey));
      item.entries = [...fbEntries, ...localOnly]
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      if (typeof data.lastScannedAt === 'number' && (smallest === null || data.lastScannedAt < smallest)) {
        smallest = data.lastScannedAt;
      }
    });
    scanCursor = smallest;
    scanItems.sort((a, b) => (b.entries[0]?.createdAt || 0) - (a.entries[0]?.createdAt || 0));
    console.log(`[Scan] fetchScanPage merged — scanItems now ${scanItems.length} total, next cursor=${scanCursor}`);
  } catch (e) {
    console.warn('[Scan] fetchScanPage threw:', e);
  } finally {
    scanLoadingMore = false;
  }
}

// Lightweight — ?shallow=true returns only top-level keys (no nested scan data), so this
// stays cheap even at huge scale. Independent of pagination; drives only the header badge.
async function fetchScanTotalCount(idToken) {
  try {
    const res = await fetch(`${FIREBASE_URL}/scanned/barcode_scans.json?shallow=true&cb=${Date.now()}&auth=${idToken}`);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '(could not read body)');
      console.warn('[Scan] fetchScanTotalCount FAILED:', res.status, res.statusText, '| body:', bodyText);
      return;
    }
    const data = await res.json();
    scanTotalCount = data && typeof data === 'object' ? Object.keys(data).length : 0;
    console.log('[Scan] fetchScanTotalCount:', scanTotalCount);
    updateScanBadge();
  } catch (e) {
    console.warn('[Scan] fetchScanTotalCount threw:', e);
  }
}

// Prefix search over the Firebase key (= barcode text) — scales natively via an
// orderByKey range query, no extra search infra needed. Also filters already-loaded
// local/feed items so guest sessions (no idToken) and offline-cached entries still match.
async function runScanPrefixSearch(rawQuery) {
  const query = rawQuery.trim();
  if (!query) {
    scanSearchMode = false;
    renderScanList();
    updateScanBadge();
    return;
  }
  scanSearchMode = true;
  const upper  = query.toUpperCase();
  const prefix = safeFirebaseKey(upper);
  console.log(`[Scan] runScanPrefixSearch: query="${query}" → prefix="${prefix}"`);

  const localMatches = scanItems.filter(i =>
    i.barcodeKey.toUpperCase().startsWith(prefix) || i.barcode.toUpperCase().startsWith(upper)
  );
  console.log(`[Scan] local matches: ${localMatches.length}`);
  const results = [...localMatches];

  try {
    const idToken = await getValidFirebaseIdToken().catch(() => null);
    if (idToken) {
      const url = `${FIREBASE_URL}/scanned/barcode_scans.json?orderBy="$key"&startAt="${prefix}"&endAt="${prefix}\uf8ff"&limitToFirst=${PAGINATION_LIMIT * 2}&cb=${Date.now()}&auth=${idToken}`;
      console.log('[Scan] search request URL:', url.replace(/auth=[^&]+/, 'auth=***'));
      const res = await fetch(url);
      console.log('[Scan] search response status:', res.status, res.statusText);
      if (res.ok) {
        const data = await res.json();
        const fbCount = data && typeof data === 'object' ? Object.keys(data).length : 0;
        console.log(`[Scan] search: ${fbCount} Firebase match(es)`);
        if (data && typeof data === 'object') {
          Object.entries(data).forEach(([safeKey, d]) => {
            if (!d || typeof d !== 'object') return;
            let item = results.find(i => i.barcodeKey === safeKey);
            if (!item) {
              item = { barcodeKey: safeKey, barcode: d.barcode || safeKey, entries: [], loading: false };
              results.push(item);
            }
            if (d.barcode) item.barcode = d.barcode;

            const fbEntries = Object.entries(d)
              .filter(([k]) => !SCAN_META_KEYS.has(k))
              .map(([scanKey, val]) => ({
                scanKey,
                scanned_by  : val.scanned_by || '—',
                uid         : val.uid        || '—',
                createdAt   : val.createdAt,
                url         : val.url,
                hostname    : getHostname(val.url),
                fromFirebase: true,
              }));
            const fbKeys = new Set(fbEntries.map(e => e.scanKey));
            const localOnly = (item.entries || []).filter(e => !fbKeys.has(e.scanKey));
            item.entries = [...fbEntries, ...localOnly]
              .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          });
        }
      } else {
        const bodyText = await res.text().catch(() => '(could not read body)');
        console.warn('[Scan] runScanPrefixSearch FAILED:', res.status, res.statusText, '| body:', bodyText);
      }
    } else {
      console.log('[Scan] search: no idToken — local-only results shown');
    }
  } catch (e) {
    console.warn('[Scan] runScanPrefixSearch threw:', e);
  }

  results.sort((a, b) => (b.entries[0]?.createdAt || 0) - (a.entries[0]?.createdAt || 0));
  console.log(`[Scan] search combined total: ${results.length}`);
  scanSearchResults = results;
  renderScanList();
  updateScanBadge();
}

function updateScanBadge() {
  const badge = document.getElementById('scan-count-badge');
  if (!badge) return;
  if (scanSearchMode) {
    const n = scanSearchResults.length;
    badge.textContent = `${n} match${n !== 1 ? 'es' : ''}`;
  } else if (scanTotalCount !== null) {
    badge.textContent = `${scanTotalCount} barcode${scanTotalCount !== 1 ? 's' : ''}`;
  } else {
    // Guest mode (no idToken → fetchScanTotalCount never runs) or count still in flight:
    // falls back to however many are loaded so far rather than showing nothing.
    badge.textContent = `${scanItems.length} barcode${scanItems.length !== 1 ? 's' : ''}`;
  }
}

function renderScanList() {
  const list = document.getElementById('scan-list');
  if (!list) return;

  // Search mode shows its own result set (never overwrites the paginated feed in
  // scanItems); normal mode shows the feed as loaded so far.
  const filtered = scanSearchMode ? scanSearchResults : scanItems;

  list.innerHTML = '';

  if (filtered.length === 0) {
    list.innerHTML = scanSearchMode
      ? `<div class="empty-state">No barcode starting with "${escapeHtml(scanSearchQuery.trim())}".</div>`
      : '<div class="empty-state">No barcodes yet.<br>Scan something!</div>';
    return;
  }

  filtered.forEach(item => {
    const uid  = `bc-${item.barcodeKey}`;
    const card = document.createElement('div');
    card.className = 'history-card';

    // ── Header (always visible) ──
    const header = document.createElement('div');
    header.className = 'card-header';
    const lastScan = item.entries[0];
    const scanCount = item.entries.length;
    header.innerHTML = `
      <div class="scan-dot${item.loading ? ' scan-dot-loading' : ''}"></div>
      <div class="card-main">
        <div class="card-text" title="${escapeHtml(item.barcode)}">${escapeHtml(item.barcode)}</div>
        <div class="card-meta">
          <span class="card-time">${lastScan ? scanExactTime(lastScan.createdAt) : '—'}</span>
          <span class="scan-count-chip">${scanCount} scan${scanCount !== 1 ? 's' : ''}</span>
          ${item.loading ? '<span class="scan-loading-chip">syncing…</span>' : ''}
        </div>
      </div>
      <div class="chevron" id="chev-${uid}">▼</div>`;

    // ── Log body (hidden by default) ──
    const body = document.createElement('div');
    body.className = 'card-actions scan-log-body';
    body.id = `body-${uid}`;

    // Same user/device scanning the same barcode multiple times in a row shouldn't look
    // like different people did it — the 'by' line is only shown on the first entry of
    // each same-identity run, not repeated on every single row.
    const sameScanIdentity = (a, b) => {
      if (!a || !b) return false;
      const aUid = a.uid && a.uid !== '—' ? a.uid : null;
      const bUid = b.uid && b.uid !== '—' ? b.uid : null;
      if (aUid || bUid) return aUid === bUid;
      return (a.scanned_by || '—') === (b.scanned_by || '—') && a.scanned_by !== '—';
    };

    item.entries.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'scan-log-entry';
      const hasUid = entry.uid && entry.uid !== '—';
      const isContinuation = sameScanIdentity(entry, item.entries[i - 1]);
      // Short placeholder shown immediately; upgraded to the real profile name (if any)
      // once resolveScanEntryNames() fetches it on expand — never fetched eagerly.
      const placeholder = hasUid ? entry.uid.slice(0, 10) + '…' : (entry.scanned_by || '—');
      row.innerHTML = `
        <div class="scan-log-index">#${i + 1}</div>
        <div class="scan-log-details">
          <div class="scan-log-meta">
            <span class="scan-log-time">${scanExactTime(entry.createdAt)}</span>
            <span class="scan-url-chip" title="${escapeHtml(entry.url || entry.hostname)}">🌐 ${escapeHtml(entry.hostname)}</span>
            <button type="button" class="scan-url-copy-btn" title="Copy URL">⎘</button>
            ${!entry.fromFirebase ? '<span class="scan-local-chip">local</span>' : ''}
          </div>
          ${isContinuation ? '' : `
          <div class="scan-by-row" title="Device: ${escapeHtml(entry.scanned_by || '—')}">
            <span class="scan-by-icon">👤</span>
            <span class="scan-by-name"${hasUid ? ` data-uid="${escapeHtml(entry.uid)}"` : ''}>${escapeHtml(placeholder)}</span>
          </div>`}
        </div>`;

      // Wired here (not inline in the template) so the raw entry.url is used directly
      // from closure — safer than round-tripping it through an HTML attribute.
      const urlChip = row.querySelector('.scan-url-chip');
      if (urlChip && entry.url && /^https?:\/\//.test(entry.url)) {
        urlChip.addEventListener('click', () => {
          chrome.tabs.create({ url: entry.url }).catch(e => console.warn('[DB] tabs.create failed:', e?.message || e));
        });
      }
      const urlCopyBtn = row.querySelector('.scan-url-copy-btn');
      if (urlCopyBtn) {
        urlCopyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(entry.url || entry.hostname).then(() => {
            urlCopyBtn.textContent = '✅';
            setTimeout(() => { urlCopyBtn.textContent = '⎘'; }, 1200);
          }).catch(() => {
            urlCopyBtn.textContent = '❌';
            setTimeout(() => { urlCopyBtn.textContent = '⎘'; }, 1200);
          });
        });
      }

      if (isContinuation) row.classList.add('scan-log-entry-continuation');
      body.appendChild(row);
    });

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'action-btn btn-copy';
    copyBtn.style.cssText = 'margin: 6px 8px 8px 8px; flex: 1;';
    copyBtn.textContent = '⎘ Copy barcode';
    copyBtn.addEventListener('click', e => {
      e.stopPropagation();
      navigator.clipboard.writeText(item.barcode).then(() => {
        copyBtn.textContent = '✅ Copied!';
        setTimeout(() => { copyBtn.textContent = '⎘ Copy barcode'; }, 1500);
      }).catch(() => {
        copyBtn.textContent = '❌ Copy failed';
        setTimeout(() => { copyBtn.textContent = '⎘ Copy barcode'; }, 1500);
      });
    });

    const cardActionsRow = document.createElement('div');
    cardActionsRow.style.cssText = 'display: flex;';
    cardActionsRow.appendChild(copyBtn);
    body.appendChild(cardActionsRow);

    // Toggle on header click
    header.addEventListener('click', () => {
      const b    = document.getElementById(`body-${uid}`);
      const chev = document.getElementById(`chev-${uid}`);
      if (b) {
        const isOpen = b.classList.toggle('visible');
        if (chev) chev.classList.toggle('open', isOpen);
        // Only fetch profile names when expanding, and only once per card —
        // keeps this off the initial render entirely (no eager fetching for
        // items the user never opens).
        if (isOpen && !b.dataset.namesLoaded) {
          b.dataset.namesLoaded = '1';
          resolveScanEntryNames(b);
        }
      }
    });

    card.appendChild(header);
    card.appendChild(body);
    list.appendChild(card);
  });

  // Feed footer — only relevant in normal (non-search) mode, since search results aren't
  // paginated (single capped fetch, see runScanPrefixSearch()).
  if (!scanSearchMode) {
    const footer = document.createElement('div');
    footer.className = 'empty-state';
    footer.style.cssText = 'padding: 10px 0; font-size: 12px;';
    if (scanLoadingMore) {
      footer.textContent = 'Loading more…';
      list.appendChild(footer);
    } else if (!scanHasMore && scanItems.length > 0) {
      footer.textContent = '— end of list —';
      list.appendChild(footer);
    }
  }
}

function deleteScanRecord(barcodeKey, scanKey) {
  chrome.storage.local.get(['scan_log'], (result) => {
    try {
      if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
      const log = result.scan_log || {};
      if (log[barcodeKey]?.[scanKey]) {
        delete log[barcodeKey][scanKey];
        if (Object.keys(log[barcodeKey]).length === 0) delete log[barcodeKey];
        chrome.storage.local.set({ scan_log: log }, () => {
          if (chrome.runtime.lastError) console.warn('[Scan] delete save failed:', chrome.runtime.lastError.message);
          else loadScanHistory();
        });
      }
    } catch (e) {
      console.warn('[Scan] deleteScanRecord failed:', e?.message || e);
    }
  });
}

function setupScanTab() {
  const searchInput = document.getElementById('scan-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      scanSearchQuery = searchInput.value;
      // Debounced — search is now a network call (Firebase prefix query), not an
      // in-memory filter, so firing on every keystroke would queue up a request per
      // character typed.
      clearTimeout(scanSearchDebounce);
      scanSearchDebounce = setTimeout(() => runScanPrefixSearch(scanSearchQuery), 300);
    });
  }

  const scanList = document.getElementById('scan-list');
  if (scanList) {
    scanList.addEventListener('scroll', () => {
      if (scanSearchMode || !scanHasMore || scanLoadingMore) return;
      const nearBottom = scanList.scrollTop + scanList.clientHeight >= scanList.scrollHeight - 80;
      if (!nearBottom) return;
      getValidFirebaseIdToken().catch(() => null).then(idToken => {
        if (!idToken) return; // guest session — nothing more to page through server-side
        renderScanList(); // shows the "Loading more…" footer immediately
        fetchScanPage(idToken).then(() => {
          renderScanList();
          updateScanBadge();
        });
      });
    });
  }

  const clearBtn = document.getElementById('clear-scan-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (!confirm('সব scan records delete হবে। নিশ্চিত?')) return;
      chrome.storage.local.remove(['scan_log'], () => {
        if (chrome.runtime.lastError) {
          console.warn('[Scan] clear failed:', chrome.runtime.lastError.message);
          return;
        }
        scanItems = [];
        scanSearchResults = [];
        scanSearchMode = false;
        scanSearchQuery = '';
        scanCursor = null;
        scanHasMore = true;
        scanTotalCount = null;
        if (searchInput) searchInput.value = '';
        renderScanList();
        updateScanBadge();
      });
    });
  }
}


// ══════════════════════════════════════════════════════════════════════
// 📊 DASHBOARD TAB (demo)
// Reuses whatever's already loaded in historyItems / scanItems — no new
// Firebase reads. Export buttons download a .csv (opens fine in Excel;
// swap for a real .xlsx library later if formatting/multi-sheet is needed).
// ══════════════════════════════════════════════════════════════════════

function setupDashboardTab() {
  const generateHvBtn = document.getElementById('generate-hv-btn');
  if (generateHvBtn) generateHvBtn.addEventListener('click', () => generateHoldValidationReport());

  const syncHvBtn = document.getElementById('sync-hv-btn');
  if (syncHvBtn) syncHvBtn.addEventListener('click', () => syncHvToSheet());

  const downloadHvBtn = document.getElementById('download-hv-btn');
  if (downloadHvBtn) downloadHvBtn.addEventListener('click', async () => {
    // Direct download: fetches fresh data for whatever From/To/branch/mode is
    // currently set, WITHOUT rendering the on-screen table — "Report দেখুন" is
    // no longer a required step first. generateHoldValidationReport() already
    // resets hvReportRows to [] up front on every call (including on any
    // early-return failure path), so checking .length here after it settles
    // never downloads stale data left over from an earlier successful report.
    await generateHoldValidationReport({ skipRender: true });
    if (hvReportRows.length) downloadHvReport();
  });

  document.querySelectorAll('.dash-hv-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === hvMode) return;
      hvMode = btn.dataset.mode;
      document.querySelectorAll('.dash-hv-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      // A report already on screen was built for the OLD mode — clear it so
      // Summary/Details never look "active" while showing the other mode's
      // data. Forces a re-click of "Report দেখুন", which keeps hvReportMode
      // (used by render/download) always in sync with what's displayed.
      hvReportRows = [];
      const reportEl = document.getElementById('dash-hv-report');
      if (reportEl) reportEl.innerHTML = '';
      const statusEl = document.getElementById('dash-hv-status');
      if (statusEl) statusEl.textContent = '';
    });
  });

  const generatePerfBtn = document.getElementById('generate-perf-btn');
  if (generatePerfBtn) generatePerfBtn.addEventListener('click', () => generateTeamPerformanceReport());

  // Branch/Mode selections persist to chrome.storage.local (see loadPerfPreferences/
  // renderPerfBranchDropdown) so they come back pre-selected next time the popup
  // opens — date range intentionally does NOT persist, picked fresh each time.
  const perfBranchSel = document.getElementById('dash-perf-branch');
  if (perfBranchSel) perfBranchSel.addEventListener('change', () =>
    chrome.storage.local.set({ perf_branch_id: perfBranchSel.value }));

  const perfModeSel = document.getElementById('dash-perf-mode');
  if (perfModeSel) perfModeSel.addEventListener('change', () =>
    chrome.storage.local.set({ perf_mode: perfModeSel.value }));
}

/** Escapes a value for CSV: wraps in quotes and doubles any internal quotes
 *  whenever it contains a comma, quote, or newline (standard CSV quoting). */
function csvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadCsv(filename, rows) {
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM so Excel reads UTF-8 correctly
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ══════════════════════════════════════════════════════════════════════
// 📞 CALL CENTER EXPORT (Dashboard)
// Branch + custom From/To date range → CSV. Deliberately does NOT change
// databridge-app's Firebase schema (courier/runs_by_branchId → run_routes
// → consignments/remarks_by_consignment stays as-is) — this is a one-time
// export action, not a live-reloading list, so the extra reads a 4-hop
// chain costs are an acceptable trade for zero schema/storage impact.
// ══════════════════════════════════════════════════════════════════════

let ccBranchIds   = [];  // cached after first successful load
const ccBranchNames = {}; // branchId -> resolved display name

/** Populates the branch <select> from users/{uid}/profile/company_info/branch_ids
 *  — same path RbacManager.kt, EmployeeFragment.kt, and every other branch_ids
 *  read/write in the app uses (confirmed by grepping the whole app/src tree —
 *  FirebasePaths.kt's userCompanyInfo() helper builds the OTHER, unused
 *  users/{uid}/company_info path with no /profile/ segment; nothing in the app
 *  actually calls it). Called once, the first time the Dashboard tab is opened
 *  while Google-linked. */
/** Called every time the Dashboard nav tab is opened. Defaults the Hold
 *  Validation From/To range to TODAY (Bangladesh-local, same BD_DATE_PARTS
 *  formatter used for the report's own date display — never the machine's
 *  own timezone) and auto-runs the Summary report, so the tab always opens
 *  showing today's data with zero clicks. Branch checkboxes default to
 *  "checked" once rendered (see renderHvBranchCheckboxes), so nothing
 *  extra is needed there. Waits for loadCcBranches() on first open (branch
 *  checkboxes must exist before getSelectedHvBranchIds() finds anything);
 *  on later opens branches are already cached and this runs immediately. */
async function loadDashboardTabAndAutoGenerate() {
  if (!ccBranchIds.length) await loadCcBranches(); // cached after first successful load

  const fromInput = document.getElementById('dash-hv-from');
  const toInput    = document.getElementById('dash-hv-to');
  const todayBd = BD_DATE_PARTS.format(new Date());
  if (fromInput) fromInput.value = todayBd;
  if (toInput)   toInput.value   = todayBd;

  if (currentGoogleUid && ccBranchIds.length) generateHoldValidationReport();
}

async function loadCcBranches() {
  if (!currentGoogleUid) {
    renderHvBranchCheckboxes();
    await renderPerfBranchDropdown();
    return;
  }

  try {
    const idToken = await getValidFirebaseIdToken().catch(() => null);
    const authQuery = idToken ? `?auth=${idToken}` : '';
    const res  = await fetch(`${FIREBASE_URL}/users/${currentGoogleUid}/profile/company_info/branch_ids.json${authQuery}`);
    const data = await res.json();
    ccBranchIds = Array.isArray(data) ? data.filter(Boolean) : Object.values(data || {});

    if (!ccBranchIds.length) {
      renderHvBranchCheckboxes();
      await renderPerfBranchDropdown();
      return;
    }

    // Branch names come from Supabase (source of truth since the branch
    // cutover) — Firebase branches/{id}/name no longer exists, so that lookup
    // only ever returned the id back. One REST call, not N fetches.
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/branches?select=branch_id,name`, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${idToken}`, 'Accept': 'application/json' },
      });
      const rows = await r.json().catch(() => []);
      (Array.isArray(rows) ? rows : []).forEach(b => {
        if (b && b.branch_id) ccBranchNames[b.branch_id] = b.name || b.branch_id;
      });
    } catch { /* fall through to id fallback below */ }
    ccBranchIds.forEach(id => { if (!ccBranchNames[id]) ccBranchNames[id] = id; });

    renderHvBranchCheckboxes();
    await renderPerfBranchDropdown();
  } catch (e) {
    console.warn('[DB] loadCcBranches failed:', e);
    const listEl = document.getElementById('dash-hv-branch-list');
    if (listEl) listEl.innerHTML = '<div class="dash-hv-branch-empty">⚠ Branch list load failed</div>';
    const perfSel = document.getElementById('dash-perf-branch');
    if (perfSel) perfSel.innerHTML = '<option value="">⚠ Branch list load failed</option>';
  }
}

/** Populates #dash-perf-branch from ccBranchIds/ccBranchNames (already loaded
 *  by loadCcBranches for the Hold Validation checkboxes — no separate fetch
 *  here) and restores the last-selected branch from chrome.storage.local,
 *  falling back to the first branch if nothing stored yet or the stored id
 *  is no longer in this user's branch list. */
async function renderPerfBranchDropdown() {
  const sel = document.getElementById('dash-perf-branch');
  if (!sel) return;

  if (!ccBranchIds.length) {
    sel.innerHTML = '<option value="">কোনো branch assigned নেই</option>';
    return;
  }

  sel.innerHTML = ccBranchIds
    .map(id => `<option value="${escapeHtml(id)}">${escapeHtml(ccBranchNames[id] || id)}</option>`)
    .join('');

  const { perf_branch_id } = await chrome.storage.local.get(['perf_branch_id']);
  sel.value = ccBranchIds.includes(perf_branch_id) ? perf_branch_id : ccBranchIds[0];
}

/** Restores the last-selected Team/Agent mode from chrome.storage.local.
 *  Doesn't depend on branch data, so it runs independently of loadCcBranches
 *  — called once each time the Dashboard tab is opened (idempotent, cheap). */
async function restorePerfModePreference() {
  const modeSel = document.getElementById('dash-perf-mode');
  if (!modeSel) return;
  const { perf_mode } = await chrome.storage.local.get(['perf_mode']);
  if (perf_mode === 'team' || perf_mode === 'agent') modeSel.value = perf_mode;
}

// ══════════════════════════════════════════════════════════════════════
// 🗄️ SUPABASE — validation data lives here (Edge Function report action).
// Auth: Firebase ID token (existing getValidFirebaseIdToken()) — no
// separate Supabase login needed; the Edge Function accepts it directly.
// ══════════════════════════════════════════════════════════════════════

const SUPABASE_REPORT_PAGE_SIZE = 100; // Edge Function report action max page_size

/** Fetches ALL validation rows for one branch + date range from the
 *  validations Edge Function's `report` action, paging through
 *  all results (page_size 100, the Edge Function's maximum).
 *
 *  branchId  — e.g. "aab"
 *  startIso  — ISO 8601 start of range (inclusive), e.g. "2026-08-01T00:00:00.000Z"
 *  endIso    — ISO 8601 exclusive end,              e.g. "2026-08-22T00:00:00.000Z"
 *  idToken   — Firebase ID token from getValidFirebaseIdToken()
 *
 *  Returns flat array of row objects in the same shape as the Edge
 *  Function returns: { consignment, branch_id, assigned_to_system_id,
 *  author_system_id, source, remarks_status, remarks, note,
 *  customer_phone, created_at, ... }.
 *  Throws on a non-OK HTTP response. */
async function fetchSupabaseReportRows(branchId, startIso, endIso, idToken) {
  const rows = [];
  let page = 0;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/validations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        action:     'report',
        branch_id:  branchId,
        start_iso:  startIso,
        end_iso:    endIso,
        page,
        page_size:  SUPABASE_REPORT_PAGE_SIZE,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Supabase report fetch failed (${res.status}) for branch "${branchId}": ${body.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => []);
    const pageRows = Array.isArray(data) ? data : [];
    if (!Array.isArray(data)) {
      throw new Error(`Supabase report fetch returned non-array for branch "${branchId}" — aborting paging (would loop forever)`);
    }
    rows.push(...pageRows);
    if (pageRows.length < SUPABASE_REPORT_PAGE_SIZE) break;
    page++;
  }
  return rows;
}


// ══════════════════════════════════════════════════════════════════════
// 🔒 HOLD VALIDATION (Dashboard)
// Same branch(es) + custom From/To date range → courier/runs_by_branchId →
// run_routes → consignments / remarks_by_consignment chain as Call Center
// Export above, and — like that feature — a one-time report/export action,
// not a live-reloading list, so this makes NO change to databridge-app's
// Firebase schema either.
//
// Two differences from Call Center Export:
//   1. Branch picking is CHECKBOXES, not a <select> — lets a multi-branch
//      user pick one, several, or all; a single-branch user just sees one
//      pre-checked box and needs zero clicks on it.
//   2. Rows are filtered down to only "hold" ones before anything is shown,
//      using the SAME priority the Android app's CallCenterParcelItem uses
//      for effectiveStatus (latest remark status wins over the raw run
//      status when a remark exists) and the SAME "hold" keyword match
//      DashboardViewModel.bucketForStatus() uses (case-insensitive
//      substring, not a fixed key list, since status keys are admin-
//      configurable via config/statusMeta and a renamed one would silently
//      fall through a fixed list).
// ══════════════════════════════════════════════════════════════════════

let hvReportRows = []; // rows currently shown in the report — cached here so Download doesn't refetch
let hvMode       = 'summary'; // 'summary' | 'details' — live toggle state (see setupDashboardTab)
let hvReportMode = 'summary'; // mode hvReportRows was actually BUILT for — set once per generate,
                               // read by renderHvReport()/downloadHvReport() so a stale toggle click
                               // can never make Download not match what's on screen
let hvSummaryFilter = 'all';  // 'all' | 'validated' | 'pending' — set by clicking a Total/Validated/
                               // Pending stat cell in renderHvReportSummary(); reset on every fresh
                               // generateHoldValidationReport() call so a new report always starts
                               // fully visible. Download is unaffected — it always exports everything,
                               // this only filters what's shown on screen.

/** BD-local calendar-date key (YYYY-MM-DD) from a Supabase created_at ISO
 *  string — the unit Summary groups by. Relies on the same assumption
 *  generateHoldValidationReport() already documents for its own from/to
 *  inputs: this extension runs on a device physically in Bangladesh, so
 *  Date's LOCAL getters are already Bangladesh-local — no manual UTC+6
 *  offset needed. */
// Explicit Asia/Dhaka formatter — never the machine's own timezone. Matches
// bangladeshTodayStartMillis() on the Android side: a remark near midnight
// Bangladesh time must group/display on the same calendar day regardless of
// what OS timezone the browser running this extension happens to be set to.
const BD_DATE_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
});
const BD_TIME_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit', hour12: true,
});

function localDateKey(isoString) {
  // en-CA formats as YYYY-MM-DD directly, already the dateKey shape used everywhere else.
  return BD_DATE_PARTS.format(new Date(isoString));
}

// Date <input> value ('YYYY-MM-DD') → Asia/Dhaka midnight as ISO. The old
// `new Date(v + 'T00:00:00')` used the BROWSER's timezone, so on a
// non-BD-timezone machine the queried UTC window disagreed with the
// Asia/Dhaka grouping by up to a day. Returns null on bad input.
function bdDateInputToIso(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - 6 * 60 * 60 * 1000).toISOString();
}

function dateKeyToDdMmYyyy(dateKey) {
  const [y, m, d] = dateKey.split('-');
  return `${d}-${m}-${y}`;
}

/** CSV-only: month/day/year with slashes. Spreadsheet apps (Excel/Sheets) auto-detect
 *  this shape as a real date on paste and let it sort/filter as one; the dash-separated
 *  dd-mm-yyyy used for the on-screen dateLabel is read fine by a person but often lands
 *  as plain text once pasted into a sheet instead of becoming a date value. */
function dateKeyToMmDdYyyy(dateKey) {
  const [y, m, d] = dateKey.split('-');
  return `${m}/${d}/${y}`;
}

function formatHhMm(isoString) {
  return BD_TIME_PARTS.format(new Date(isoString)).replace(/\s?([AP]M)$/i, ' $1');
}

/** Mirrors StatusMetaCache.isVerifyRequestStatus() on the app side exactly:
 *  a remark's status field, trimmed and compared case-insensitively against
 *  "VERIFY_REQUEST" or "verify_req" — this is what a worker sets when a
 *  parcel needs call-center to validate something before it can move on. */
function isVerifyRequestStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return s === 'verify_request' || s === 'verify_req';
}

/** One consignment's FULL remarks node (every remarks_{timestamp} entry, any
 *  author — same node CallCenterFragment/WorkerSpaceFragment read in full for
 *  their "journey" history) narrowed to [rangeStart, rangeEnd) — the user's
 *  selected From/To range, not a single day, per how this report should
 *  count: once per consignment for the whole range, not once per day it was
 *  touched, unlike the app's own per-day "today" scoping.
 *
 *  hadRequest   — true if ANY entry in range is a verify-request.
 *  stillPending — same "latest entry decides" rule the app uses for
 *                 validationRequest, just generalized from a single day to
 *                 the whole range: pending only if the truly latest entry in
 *                 range is STILL a verify-request status (nothing since has
 *                 superseded it).
 *  requestEntry — the verify-request this current state relates to: the
 *                 latest entry itself when still pending, otherwise the most
 *                 recent verify-request that came before whatever resolved
 *                 it — i.e. the most recent request→resolution cycle, so a
 *                 consignment requested/resolved more than once in range
 *                 still reports its CURRENT state, not a stale earlier one. */
function analyzeRangeRemarks(remarksObj, rangeStart, rangeEnd) {
  if (!remarksObj || typeof remarksObj !== 'object') return { hadRequest: false };

  const entries = Object.values(remarksObj).filter(e => {
    const ts = e && e.createdAt;
    return typeof ts === 'number' && ts >= rangeStart && ts < rangeEnd;
  });
  if (!entries.length) return { hadRequest: false };

  const hadRequest = entries.some(e => isVerifyRequestStatus(e.status || ''));
  if (!hadRequest) return { hadRequest: false };

  const latestOverall = entries.reduce((latest, e) =>
    (!latest || (e.createdAt || 0) > (latest.createdAt || 0)) ? e : latest, null);
  const stillPending = isVerifyRequestStatus(latestOverall?.status || '');

  const verifyEntries = entries.filter(e => isVerifyRequestStatus(e.status || ''));
  const requestEntry = stillPending
    ? latestOverall
    : (verifyEntries.filter(e => (e.createdAt || 0) < (latestOverall.createdAt || 0))
         .reduce((latest, e) => (!latest || (e.createdAt || 0) > (latest.createdAt || 0)) ? e : latest, null)
       || verifyEntries.reduce((latest, e) => (!latest || (e.createdAt || 0) > (latest.createdAt || 0)) ? e : latest, null));

  return {
    hadRequest: true,
    stillPending,
    requestNote:      requestEntry?.remarks || requestEntry?.note || '',
    requestAt:        requestEntry?.createdAt || 0,
    resolutionNote:   stillPending ? '' : (latestOverall?.remarks || latestOverall?.note || ''),
    resolutionStatus: stillPending ? '' : (latestOverall?.status || ''),
    resolutionAt:     stillPending ? 0 : (latestOverall?.createdAt || 0)
  };
}

/** Renders the Hold Validation branch checkboxes from the ccBranchIds/
 *  ccBranchNames loadCcBranches() just resolved — no extra Firebase read.
 *  Called from every outcome inside loadCcBranches() so this always mirrors
 *  the Call Center Export branch dropdown's data exactly. All boxes start
 *  checked: a single-branch user gets a ready-to-run report with zero
 *  clicks, and a multi-branch user can see at a glance that every assigned
 *  branch is currently included (uncheck any to narrow it down). */
function renderHvBranchCheckboxes() {
  const listEl = document.getElementById('dash-hv-branch-list');
  if (!listEl) return;

  if (!currentGoogleUid) {
    listEl.innerHTML = '<div class="dash-hv-branch-empty">Google দিয়ে লগইন করুন প্রথমে</div>';
    return;
  }
  if (!ccBranchIds.length) {
    listEl.innerHTML = '<div class="dash-hv-branch-empty">কোনো branch assigned নেই</div>';
    return;
  }

  listEl.innerHTML = ccBranchIds.map(id => `
    <label class="dash-hv-branch-item">
      <input type="checkbox" class="dash-hv-branch-cb" value="${escapeHtml(id)}" checked>
      <span>${escapeHtml(ccBranchNames[id] || id)}</span>
    </label>
  `).join('');
}

function getSelectedHvBranchIds() {
  return [...document.querySelectorAll('.dash-hv-branch-cb:checked')].map(cb => cb.value);
}

  // ── SHEET SYNC (dashboard Hold Validation → remark sheets) ──────────────
  // Same engine as cc-panel.js bulk sync, generalized: dashboard-এর checked
  // branches × From–To range-এর প্রতিটা দিন — ওই দিনের consolidated CC
  // (latest CC remark per consignment) ওই দিনের tab/date-cell-এ, blank-only.
  const HV_SYNC_MAX_DAYS = 31;
  const HV_SHEET_DATE_RES = [
    [/^(\d{4})-(\d{2})-(\d{2})$/, (m) => [m[1], m[2], m[3]]],
    [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, (m) => [m[3], m[1].padStart(2, '0'), m[2].padStart(2, '0')]],
    [/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, (m) => ['20' + m[3], m[1].padStart(2, '0'), m[2].padStart(2, '0')]], // M/d/yy
    [/^(\d{1,2})-(\d{1,2})-(\d{4})$/, (m) => [m[3], m[2].padStart(2, '0'), m[1].padStart(2, '0')]],
    [/^(\d{4})\/(\d{2})\/(\d{2})$/, (m) => [m[1], m[2], m[3]]],
    [/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, (m) => [m[3], m[2].padStart(2, '0'), m[1].padStart(2, '0')]],
  ];
  const HV_MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  function hvSheetCellIsDate(cell, dateKey) {
    const raw = String(cell || '').trim();
    if (!raw) return false;
    for (const [re, fn] of HV_SHEET_DATE_RES) {
      const m = raw.match(re);
      if (m) { const [y, mo, d] = fn(m); if (`${y}-${mo}-${d}` === dateKey) return true; }
    }
    let m = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
    if (m) {
      const mo = HV_MONTHS[m[2].toLowerCase()];
      if (mo) {
        const y = m[3].length === 2 ? '20' + m[3] : m[3];
        if (`${y}-${mo}-${m[1].padStart(2, '0')}` === dateKey) return true;
      }
    }
    m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const cand = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      if (cand === dateKey) return true;
    }
    m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
    if (m) {
      const y = '20' + m[3];
      if (`${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` === dateKey) return true;
      if (`${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` === dateKey) return true;
    }
    return false;
  }

  async function hvSheetsGet(token, url) {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    return res.json();
  }

  function hvIndexToLetter(n) {
    let s = '', num = n;
    while (num > 0) { const rem = (num - 1) % 26; s = String.fromCharCode(65 + rem) + s; num = Math.floor((num - 1) / 26); }
    return s;
  }

  async function hvResolveLetter(token, sheetId, tab, rule, headerRow, headerCache) {
    const t = String(rule?.colRef || '').trim();
    if (!t) return null;
    if (rule?.mode !== 'text') {
      if (/^[A-Za-z]{1,3}$/.test(t)) return t.toUpperCase();
      const n = parseInt(t, 10);
      if (!isNaN(n) && n >= 1 && n <= 702) return hvIndexToLetter(n);
      return null;
    }
    const hr = (headerRow >= 1 && headerRow <= 20) ? headerRow : 1;
    const key = tab + '#' + hr;
    if (!headerCache[key]) {
      const data = await hvSheetsGet(token,
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab + '!' + hr + ':' + hr)}`);
      const rows = data.values || [];
      headerCache[key] = rows.length ? rows[0] : [];
    }
    const idx = headerCache[key].findIndex(h => String(h || '').trim() === t);
    return idx >= 0 ? hvIndexToLetter(idx + 1) : null;
  }

  async function hvSheetsWriteCell(token, sheetId, tab, letter, row1, value) {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab + '!' + letter + row1)}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: `${tab}!${letter}${row1}`, majorDimension: 'ROWS', values: [[value]] }),
      });
    if (!res.ok) throw new Error(`Sheets write ${res.status}`);
  }

  function hvEffectiveRules(conn, kind) {
    const list = kind === 'lookup' ? (conn.lookups || []) : (conn.writes || []);
    return list.filter(r => r && String(r.colRef || '').trim())
      .map(r => ({ colRef: String(r.colRef).trim(), kind: String(r.kind || (kind === 'lookup' ? 'consignment' : 'feedback')), mode: r.mode === 'text' ? 'text' : 'index' }));
  }

  function hvIsRemarkConn(conn) {
    if (!conn || conn.enabled === false) return false;
    if (conn.isLibrary) return false; // neutral libraries bind per-fragment (app 🔌); kinds carry no meaning
    if (conn.purpose === 'scanner' || conn.purpose === 'routing') return false;
    if (conn.purpose === 'remark') return true;
    return hvEffectiveRules(conn, 'lookup').length > 0 && hvEffectiveRules(conn, 'write').length > 0;
  }

  function hvScopeCovers(conn, dateKey) {
    const t = conn.scopeType || 'global';
    if (t === 'month') {
      const m = String(conn.scopeMonth || '').trim();
      return m.length >= 7 && dateKey.slice(0, 7) === m.slice(0, 7);
    }
    if (t === 'range') {
      const f = String(conn.scopeFrom || '').trim(), to = String(conn.scopeTo || '').trim();
      if (!f || !to) return false;
      return f <= dateKey && dateKey <= to;
    }
    return true;
  }

  function hvSelectForDate(conns, dateKey) {
    const cov = conns.filter(c => hvScopeCovers(c, dateKey));
    if (!cov.length) return [];
    const rank = c => (c.scopeType === 'range' ? 0 : c.scopeType === 'month' ? 1 : 2);
    const best = Math.min(...cov.map(rank));
    return cov.filter(c => rank(c) === best);
  }

  function hvDeriveValidation(feedback) {
    const f = String(feedback || '').trim();
    if (!f) return '';
    return f.toLowerCase() === 'willing to receive today' ? 'Invalid' : 'Valid';
  }

  let hvRemarkCatMap = null; // english remark -> category (per popup load)
  async function hvFetchRemarkCategories(idToken) {
    if (hvRemarkCatMap) return hvRemarkCatMap;
    const m = new Map();
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/validation_remarks` +
        `?select=remarks_en,category&source=eq.CC&is_active=eq.true`, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${idToken}`, 'Accept': 'application/json' },
      });
      const arr = await res.json().catch(() => []);
      (Array.isArray(arr) ? arr : []).forEach(x => {
        const en = (x.remarks_en || '').trim();
        if (en && x.category && !m.has(en)) m.set(en, String(x.category).trim());
      });
    } catch (e) { console.warn('[DB] HV sync: remark category fetch failed:', e); }
    hvRemarkCatMap = m;
    return m;
  }

  // ওই দিনের rows থেকে latest CC per (branch, consignment) → write values.
  function hvBuildConsolidatedCc(allRows, dateKey, catMap) {
    const byKey = new Map();
    (allRows || []).forEach(r => {
      if (!r || !r.consignment || !r.branch_id) return;
      if (localDateKey(r.created_at) !== dateKey) return;
      const k = `${r.branch_id}__${r.consignment}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    });
    const out = new Map();
    byKey.forEach((rows, k) => {
      const ccRows = rows.filter(r => r.source === 'CC')
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      if (!ccRows.length) return;
      const latest = ccRows[ccRows.length - 1];
      const engKey = (latest.remarks || '').trim();
      out.set(k, {
        feedback: catMap.get(engKey) || '',
        validation: hvDeriveValidation(catMap.get(engKey) || ''),
        validator_name: ((latest.author && latest.author.name) || latest.author_system_id || '').trim(),
        created_at: latest.created_at || '',
      });
    });
    return out;
  }

  async function hvBulkSyncOneConnection(token, branchId, conn, consolidated, dateKey) {
    const res = { scanned: 0, filled: 0, syncedRows: 0, syncedCells: 0, noCc: 0, skipped: 0 };
    const lookups = hvEffectiveRules(conn, 'lookup');
    const writes = hvEffectiveRules(conn, 'write').filter(r =>
      r.kind === 'feedback' || r.kind === 'validation' || r.kind === 'validator_name');
    if (!lookups.length || !writes.length) throw new Error('lookup/write rule নেই');
    const cidRule = lookups.find(r => r.kind === 'consignment');
    if (!cidRule) throw new Error('consignment lookup নেই — কোন column দিয়ে মিলাবো বোঝা যাচ্ছে না');
    const tab = (conn.tabPattern || 'Day {dd}').replace('{dd}', dateKey.split('-')[2]);
    const hr = (conn.headerRow >= 1 && conn.headerRow <= 20) ? conn.headerRow : 1;
    const headerCache = {};
    const cidLetter = await hvResolveLetter(token, conn.sheetId, tab, cidRule, hr, headerCache);
    if (!cidLetter) throw new Error(`consignment column '${cidRule.colRef}' পাওয়া যায়নি`);
    const dateRules = lookups.filter(r => r.kind === 'today' || r.kind === 'created_at');
    const dateLetters = new Map();
    for (const rule of dateRules) {
      const letter = await hvResolveLetter(token, conn.sheetId, tab, rule, hr, headerCache);
      if (!letter) throw new Error(`lookup column '${rule.colRef}' পাওয়া যায়নি`);
      dateLetters.set(rule, letter);
    }
    const writeLetters = [];
    for (const rule of writes) {
      const letter = await hvResolveLetter(token, conn.sheetId, tab, rule, hr, headerCache);
      if (!letter) throw new Error(`write column '${rule.colRef}' পাওয়া যায়নি`);
      writeLetters.push({ rule, letter });
    }
    async function colValues(letter) {
      const data = await hvSheetsGet(token,
        `https://sheets.googleapis.com/v4/spreadsheets/${conn.sheetId}/values/${encodeURIComponent(tab + '!' + letter + ':' + letter)}`);
      return (data.values || []).map(r => (r && r[0]) || '');
    }
    const cidCol = await colValues(cidLetter);
    const dateCols = new Map();
    for (const [, letter] of dateLetters) {
      if (![...dateCols.values()].includes(letter)) dateCols.set(letter, await colValues(letter));
    }
    const writeCols = new Map();
    for (const { letter } of writeLetters) {
      if (!writeCols.has(letter)) writeCols.set(letter, await colValues(letter));
    }
    res.scanned = cidCol.length;
    for (let i = 0; i < cidCol.length; i++) {
      const cid = String(cidCol[i] || '').trim();
      if (!cid) continue;
      let dateOk = true;
      for (const [, letter] of dateLetters) {
        const cell = (dateCols.get(letter) || [])[i] || '';
        if (!hvSheetCellIsDate(String(cell || '').trim(), dateKey)) { dateOk = false; break; }
      }
      if (!dateOk) continue;
      const blanks = writeLetters.filter(({ letter }) =>
        String((writeCols.get(letter) || [])[i] || '').trim() === '');
      if (!blanks.length) { res.filled++; continue; }
      const vals = consolidated.get(`${branchId}__${cid}`);
      if (!vals) { res.noCc++; continue; }
      try {
        for (const { rule, letter } of blanks) {
          const v = vals[rule.kind] != null ? String(vals[rule.kind]) : '';
          await hvSheetsWriteCell(token, conn.sheetId, tab, letter, i + 1, v);
          const col = writeCols.get(letter) || [];
          col[i] = v;
          res.syncedCells++;
        }
        res.syncedRows++;
      } catch (e) {
        res.skipped++;
        console.warn('[DB] HV sync: row write failed:', cid, e);
      }
    }
    return res;
  }

  function hvGetSheetsToken() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ action: 'get_sheets_token' }, res => {
          if (chrome.runtime.lastError) return resolve({ token: null, error: chrome.runtime.lastError.message });
          resolve({ token: res?.token || null, error: res?.error || null });
        });
      } catch (e) { resolve({ token: null, error: e.message }); }
    });
  }

  async function syncHvToSheet() {
    const statusEl  = document.getElementById('dash-hv-status');
    const fromInput = document.getElementById('dash-hv-from');
    const toInput   = document.getElementById('dash-hv-to');
    const btn       = document.getElementById('sync-hv-btn');
    const setStatus = msg => { if (statusEl) statusEl.textContent = msg; };
    const orig      = btn ? btn.textContent : '';

    if (!fromInput?.value || !toInput?.value) { setStatus('⚠ From এবং To — দুটো date-ই select করুন'); return; }
    const fromDate = bdDateInputToIso(fromInput.value);
    const toDate   = bdDateInputToIso(toInput.value);
    if (!fromDate || !toDate) { setStatus('⚠ Date format ঠিক নেই'); return; }
    if (fromDate > toDate) { setStatus('⚠ From date, To date-এর পরে হতে পারবে না'); return; }
    const branchesToQuery = getSelectedHvBranchIds();
    if (!branchesToQuery.length) { setStatus('⚠ অন্তত একটা branch select করো'); return; }

    // Day list (Dhaka keys), capped — per-day tab + per-day consolidated CC.
    const dayKeys = [];
    for (let t = new Date(fromDate).getTime(); t <= new Date(toDate).getTime(); t += 24 * 3600 * 1000) {
      dayKeys.push(localDateKey(new Date(t).toISOString()));
      if (dayKeys.length >= HV_SYNC_MAX_DAYS) break;
    }
    if (new Date(toDate).getTime() - new Date(fromDate).getTime() > (HV_SYNC_MAX_DAYS - 1) * 24 * 3600 * 1000) {
      setStatus(`⚠ Range বেশি বড় — সর্বোচ্চ ${HV_SYNC_MAX_DAYS} দিন একবারে sync করা যাবে`);
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = '⏳ Syncing…'; }
    try {
      const idToken = await getValidFirebaseIdToken().catch(() => null);
      if (!idToken) { setStatus('⚠ Login করুন প্রথমে'); return; }

      setStatus('⏳ Supabase থেকে validation data আনা হচ্ছে…');
      const startIso = fromDate;
      const endIso   = new Date(new Date(toDate).getTime() + 24 * 3600 * 1000).toISOString();
      const allRows = [];
      const settled = await Promise.allSettled(branchesToQuery.map(async branchId => {
        const rows = await fetchSupabaseReportRows(branchId, startIso, endIso, idToken);
        return { branchId, rows };
      }));
      settled.forEach(r => { if (r.status === 'fulfilled') allRows.push(...r.value.rows); });
      if (!allRows.length) { setStatus('এই date range/branch-এ কোনো validation data পাওয়া যায়নি'); return; }

      const catMap = await hvFetchRemarkCategories(idToken);
      const { token, error } = await hvGetSheetsToken();
      if (!token) { setStatus(`⚠ ${error || 'Sheets permission নেই — re-login করুন'}`); return; }

      // Connectors per branch (once), scope selected per day below.
      const branchConns = new Map();
      for (const branchId of branchesToQuery) {
        try {
          const connRes = await fetch(
            `${FIREBASE_URL}/config/connectors/${encodeURIComponent(branchId)}/current.json?auth=${idToken}`);
          const connObj = await connRes.json().catch(() => ({})) || {};
          branchConns.set(branchId, Object.values(connObj).filter(hvIsRemarkConn).filter(c => c.enabled !== false));
        } catch (e) {
          console.warn('[DB] HV sync: connectors unreadable for', branchId, e);
          branchConns.set(branchId, []);
        }
      }

      let totDays = 0, totConns = 0, totScanned = 0, totFilled = 0, totRows = 0, totCells = 0, totNoCc = 0;
      const errs = [];
      for (const dateKey of dayKeys) {
        const consolidated = hvBuildConsolidatedCc(allRows, dateKey, catMap);
        if (!consolidated.size) continue;
        totDays++;
        for (const branchId of branchesToQuery) {
          const conns = hvSelectForDate(branchConns.get(branchId) || [], dateKey);
          for (const conn of conns) {
            totConns++;
            const label = `${conn.sheetName || conn.sheetId || branchId} (${dateKeyToDdMmYyyy(dateKey)})`;
            setStatus(`⏳ ${label} — sheet পড়ছে…`);
            try {
              const r = await hvBulkSyncOneConnection(token, branchId, conn, consolidated, dateKey);
              totScanned += r.scanned; totFilled += r.filled;
              totRows += r.syncedRows; totCells += r.syncedCells; totNoCc += r.noCc;
            } catch (e) {
              errs.push(`${label}: ${e.message || 'sync failed'}`);
            }
          }
        }
      }
      if (!totConns) { setStatus('এই range-এ কোনো branch-এ remark connection নেই (scope দেখুন)'); return; }
      let msg = `✓ ${totDays} day(s): ${totRows} row synced (${totCells} cells) · ${totFilled} already filled · ${totNoCc} no CC yet · ${totScanned} sheet rows দেখা (${totConns} connection)`;
      if (errs.length) msg += ` · ⚠ ${errs.length} error: ${errs.slice(0, 2).join('; ')}${errs.length > 2 ? '…' : ''}`;
      setStatus(msg);
    } catch (e) {
      console.error('[DB] HV sync failed:', e);
      setStatus(`✕ ${e.message || 'sync failed'}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  }

async function generateHoldValidationReport({ skipRender = false } = {}) {
  const statusEl    = document.getElementById('dash-hv-status');
  const fromInput   = document.getElementById('dash-hv-from');
  const toInput     = document.getElementById('dash-hv-to');
  const reportEl    = document.getElementById('dash-hv-report');
  const setStatus   = msg => { if (statusEl) statusEl.textContent = msg; };

  hvReportRows = [];
  hvSummaryFilter = 'all';
  if (!skipRender && reportEl) reportEl.innerHTML = '';

  if (!fromInput?.value || !toInput?.value) {
    setStatus('⚠ From এবং To — দুটো date-ই select করুন');
    return;
  }
  const fromDate = bdDateInputToIso(fromInput.value);
  const toDate   = bdDateInputToIso(toInput.value);
  if (!fromDate || !toDate) {
    setStatus('⚠ Date format ঠিক নেই');
    return;
  }
  if (fromDate > toDate) {
    setStatus('⚠ From date, To date-এর পরে হতে পারবে না');
    return;
  }

  const branchesToQuery = getSelectedHvBranchIds();
  if (!branchesToQuery.length) {
    setStatus('⚠ অন্তত একটা branch select করো');
    return;
  }

  const idToken = await getValidFirebaseIdToken().catch(() => null);
  if (!idToken) {
    setStatus('⚠ Login করুন প্রথমে');
    return;
  }

  // Date range as ISO strings for the Edge Function (half-open: [startIso, endIso)).
  // fromDate/toDate are already Asia/Dhaka-midnight ISOs (bdDateInputToIso) —
  // endIso adds one full day to include the "To" date.
  const startIso = fromDate;
  const endIso   = new Date(new Date(toDate).getTime() + 24 * 60 * 60 * 1000).toISOString();

  try {
    // Step 1 — fetch all validation rows from Supabase per branch (parallel,
    // paginated via Edge Function report action). Replaces the old
    // runs_by_branchId → run_routes → remarks_by_consignment chain.
    // source='WORKER' = validation request; source='CC' = CC resolution.
    setStatus('⏳ Supabase থেকে validation data আনা হচ্ছে…');
    const allRows = [];
    // One branch failing (401/500) must not discard the others.
    const settled = await Promise.allSettled(branchesToQuery.map(async branchId => {
      const rows = await fetchSupabaseReportRows(branchId, startIso, endIso, idToken);
      return { branchId, rows };
    }));
    const failedBranches = [];
    settled.forEach(r => {
      if (r.status === 'fulfilled') allRows.push(...r.value.rows);
      else failedBranches.push(r.reason?.message || 'fetch failed');
    });
    if (failedBranches.length) {
      console.warn('[DB] report: branches failed:', failedBranches);
      setStatus(`⚠ ${failedBranches.length} branch-এ data আসেনি — বাকিগুলো দেখানো হচ্ছে`);
    }

    if (!allRows.length) {
      setStatus('এই date range/branch-এ কোনো validation data পাওয়া যায়নি');
      return;
    }

    // Step 2 — group by (local calendar date, consignment). A group only
    // counts as a hold-validation event if it has at least one WORKER row
    // (= an actual validation request that day) — same "must have a
    // request" rule the old whole-range grouping used, just scoped down to
    // a single day instead of the whole range, so both Summary and Details
    // stay in lockstep (a date+consignment hidden from one is hidden from
    // the other too). No Firebase fetch needed here — branch, consignment
    // and every remark field the export uses already live on the Supabase
    // row itself.
    const groups = {};
    allRows.forEach(row => {
      const dateKey = localDateKey(row.created_at);
      const key = `${dateKey}__${row.consignment}`;
      if (!groups[key]) groups[key] = { dateKey, cId: row.consignment, branchId: row.branch_id, rows: [] };
      groups[key].rows.push(row);
    });

    const validGroups = Object.values(groups).filter(g => g.rows.some(r => r.source === 'WORKER'));

    if (!validGroups.length) {
      setStatus('এই date range/branch-এ কোনো validation request পাওয়া যায়নি');
      return;
    }

    const latestMs   = row => new Date(row.created_at).getTime();
    const earliestOf = rows => rows.reduce((e, r) => (!e || latestMs(r) < latestMs(e)) ? r : e, null);
    const latestOf    = rows => rows.reduce((l, r) => (!l || latestMs(r) >= latestMs(l)) ? r : l, null);

    if (hvMode === 'summary') {
      // One row per (date, consignment): first WORKER remark that day +
      // last CC remark that day (blank if CC hasn't responded yet — still
      // shown, per how this should behave). "Pending" if the truly latest
      // entry that day (either source) is a WORKER row — same "latest
      // entry decides" rule analyzeRangeRemarks()/the app use, just scoped
      // to the day instead of the whole range.
      const summaryRows = validGroups.map(g => {
        const workerRows  = g.rows.filter(r => r.source === 'WORKER');
        const ccRows      = g.rows.filter(r => r.source === 'CC');
        const firstWorker = earliestOf(workerRows);
        const lastCc      = ccRows.length ? latestOf(ccRows) : null;
        const latestOfAll = latestOf(g.rows);
        const stillPending = latestOfAll.source === 'WORKER';
        return {
          dateKey:   g.dateKey,
          dateLabel: dateKeyToDdMmYyyy(g.dateKey),
          branchId:  g.branchId,
          cId:       g.cId,
          agentSystemId:     g.rows[0].assigned_to_system_id,
          customerPhone:     (latestOfAll.customer_phone || '').trim(),
          firstWorkerRemark: firstWorker.remarks || '',
          firstWorkerStatus: firstWorker.remarks_status || '',
          lastCcRemark:      lastCc ? (lastCc.remarks || '') : '',
          lastCcNote:        lastCc ? (lastCc.note || '') : '',
          lastCcStatus:      lastCc ? (lastCc.remarks_status || '') : '',
          validatorEmployeeId: lastCc ? (lastCc.author?.employee_id || lastCc.author_system_id || '') : '',
          stillPending,
        };
      });
      summaryRows.sort((a, b) => a.dateKey === b.dateKey ? a.cId.localeCompare(b.cId) : a.dateKey.localeCompare(b.dateKey));
      hvReportRows = summaryRows;
    } else {
      // Details: every raw remark row, unconsolidated — the breakdown
      // Summary's consolidated rows are built from. Same date+consignment
      // grouping/filter as Summary so toggling between the two always
      // describes the same underlying set of events.
      const detailRows = [];
      validGroups.forEach(g => {
        g.rows.slice().sort((a, b) => latestMs(a) - latestMs(b)).forEach(r => {
          detailRows.push({
            dateKey:   g.dateKey,
            dateLabel: dateKeyToDdMmYyyy(g.dateKey),
            timeLabel: formatHhMm(r.created_at),
            branchId:  g.branchId,
            cId:       g.cId,
            agentSystemId: r.assigned_to_system_id,
            source:  r.source,
            remark:  r.remarks || '',
            note:    r.note || '',
            status:  r.remarks_status || '',
          });
        });
      });
      detailRows.sort((a, b) => {
        if (a.dateKey !== b.dateKey) return a.dateKey.localeCompare(b.dateKey);
        if (a.cId !== b.cId) return a.cId.localeCompare(b.cId);
        return a.timeLabel.localeCompare(b.timeLabel);
      });
      hvReportRows = detailRows;
    }

    hvReportMode = hvMode;
    if (!skipRender) renderHvReport();

    if (hvReportMode === 'summary') {
      const pendingCount = hvReportRows.filter(r => r.stillPending).length;
      setStatus(`✓ Total ${hvReportRows.length} · Validated ${hvReportRows.length - pendingCount} · Pending ${pendingCount}`);
    } else {
      setStatus(`✓ ${hvReportRows.length}টা remark পাওয়া গেছে`);
    }
  } catch (e) {
    console.error('[DB] generateHoldValidationReport failed:', e);
    setStatus('⚠ Report load failed — console (F12) দেখো');
  }
}

/** Draws the on-screen report from hvReportRows. Called once generation
 *  finishes — never re-fetches, so Download reusing hvReportRows always
 *  matches exactly what's on screen. Branches on hvReportMode (the mode
 *  the CURRENT hvReportRows was built for), not the live hvMode toggle —
 *  see the toggle click handler in setupDashboardTab() for why those two
 *  can never disagree while a report is showing. */
function renderHvReport() {
  const reportEl = document.getElementById('dash-hv-report');
  if (!reportEl) return;
  if (!hvReportRows.length) { reportEl.innerHTML = ''; return; }

  if (hvReportMode === 'summary') renderHvReportSummary(reportEl);
  else renderHvReportDetails(reportEl);
}

/** One card per (date, consignment) — first Worker remark, last CC remark
 *  (blank/no card shown for that half if CC hasn't responded yet), tagged
 *  Pending/Validated. Most-actionable (pending) first, then by date. */
function renderHvReportSummary(reportEl) {
  const totalRequest   = hvReportRows.length;
  const totalPending    = hvReportRows.filter(r => r.stillPending).length;
  const totalValidated = totalRequest - totalPending;

  const filtered = hvReportRows.filter(r =>
    hvSummaryFilter === 'validated' ? !r.stillPending :
    hvSummaryFilter === 'pending'   ? r.stillPending :
    true
  );

  const sorted = filtered.slice().sort((a, b) => {
    if (a.stillPending !== b.stillPending) return a.stillPending ? -1 : 1;
    return b.dateKey.localeCompare(a.dateKey);
  });

  const rowsHtml = sorted.length ? sorted.map((r, idx) => {
    const badge = r.stillPending
      ? '<span class="dash-hv-badge dash-hv-badge-pending">⏳ Pending</span>'
      : '<span class="dash-hv-badge dash-hv-badge-validated">✓ Validated</span>';
    return `
      <div class="dash-hv-row ${r.stillPending ? 'dash-hv-row-pending' : 'dash-hv-row-validated'}">
        <div class="dash-hv-row-top">
          <span class="dash-hv-row-id">${escapeHtml(r.cId)}</span>
          <span>${r.dateLabel}</span>
        </div>
        <div class="dash-hv-row-meta">${escapeHtml(ccBranchNames[r.branchId] || r.branchId)} · ${escapeHtml(r.agentSystemId || '—')}</div>
        <div class="dash-hv-row-remark">🙋 ${escapeHtml(r.firstWorkerRemark || '(no remark)')}${r.firstWorkerStatus ? ' — ' + escapeHtml(r.firstWorkerStatus) : ''}</div>
        ${r.lastCcRemark ? `<div class="dash-hv-row-resolution">↳ ${escapeHtml(r.lastCcRemark)}${r.lastCcStatus ? ' — ' + escapeHtml(r.lastCcStatus) : ''}</div>` : ''}
        ${r.lastCcNote ? `<div class="dash-hv-row-meta">↳ 📝 ${escapeHtml(r.lastCcNote)}</div>` : ''}
        ${r.validatorEmployeeId ? `<div class="dash-hv-row-meta">↳ 👤 ${escapeHtml(r.validatorEmployeeId)}</div>` : ''}
        <div class="dash-hv-row-badge-line">
          ${badge}
          ${r.customerPhone ? `<button type="button" class="dash-hv-call-btn" data-phone="${escapeHtml(r.customerPhone)}">📞 Call</button>` : ''}
          <button type="button" class="dash-hv-remark-btn" data-idx="${idx}">📝 Remarks</button>
        </div>
        <div class="dash-hv-remark-section" data-idx="${idx}" style="display:none"></div>
      </div>`;
  }).join('') : `<div class="dash-hv-branch-empty">এই filter-এ কোনো entry নেই</div>`;

  reportEl.innerHTML = `
    <div class="dash-hv-summary-grid">
      <div class="dash-hv-summary-stat${hvSummaryFilter === 'all' ? ' active' : ''}" data-filter="all">
        <div class="dash-hv-summary-val">${totalRequest}</div>
        <div class="dash-hv-summary-label">Total</div>
      </div>
      <div class="dash-hv-summary-stat${hvSummaryFilter === 'validated' ? ' active' : ''}" data-filter="validated">
        <div class="dash-hv-summary-val validated">${totalValidated}</div>
        <div class="dash-hv-summary-label">Validated</div>
      </div>
      <div class="dash-hv-summary-stat${hvSummaryFilter === 'pending' ? ' active' : ''}" data-filter="pending">
        <div class="dash-hv-summary-val pending">${totalPending}</div>
        <div class="dash-hv-summary-label">Pending</div>
      </div>
    </div>
    <div class="dash-hv-list">${rowsHtml}</div>
  `;

  reportEl.querySelectorAll('.dash-hv-summary-stat').forEach(cell => {
    cell.addEventListener('click', () => {
      // Click the already-active filter again to clear it back to "all".
      hvSummaryFilter = (hvSummaryFilter === cell.dataset.filter) ? 'all' : cell.dataset.filter;
      renderHvReportSummary(reportEl);
    });
  });

  reportEl.querySelectorAll('.dash-hv-call-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const cleaned = btn.dataset.phone.replace(/[\s-()]/g, '');
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ …';
      chrome.runtime.sendMessage({ action: 'send_to_app', text: cleaned }, () => {
        if (chrome.runtime.lastError) {
          btn.textContent = '❌ Failed';
          setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1500);
          return;
        }
        btn.textContent = '📞 Sent!';
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1500);
      });
    });
  });

  reportEl.querySelectorAll('.dash-hv-remark-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleHvRemarkSection(reportEl, sorted, +btn.dataset.idx);
    });
  });
}

// ── Dashboard card remarks (CC) ──────────────────────────────────────────
// Same catalog + save path as the app's CallCenterFragment sheet: predefined
// CC options as chips, admin instruction auto-fills the note box, note-only
// save allowed. Writes go through the validations `write` action.
// NOTE: no sheet-verdict mirror here — that needs the agent device's Google
// account (RemarkSheetMirror, app-side); the extension only saves the remark.
let ccDashboardRemarkOpts = null; // cached per popup open

async function fetchCcDashboardRemarkOptions(idToken) {
  if (ccDashboardRemarkOpts) return ccDashboardRemarkOpts;
  let remarkLang = 'bn';
  try {
    const langRes = await fetch(`${FIREBASE_URL}/config/language/ccLang.json?auth=${idToken}`);
    if (!langRes.ok) throw new Error(`ccLang fetch failed (${langRes.status})`);
    const langJson = await langRes.json().catch(() => '');
    const langVal = (typeof langJson === 'string' ? langJson.trim() : '') || 'bn_en';
    remarkLang = langVal.split('_')[0] || 'bn';
  } catch { /* default bn */ }
  const url = `${SUPABASE_URL}/rest/v1/validation_remarks` +
    `?select=remarks_en,remarks_bn,target_status,instruction_text` +
    `&source=eq.CC&is_active=eq.true&order=priority.desc`;
  const res = await fetch(url, {
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${idToken}`, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`remark options fetch failed (${res.status})`);
  const rows = await res.json();
  ccDashboardRemarkOpts = (Array.isArray(rows) ? rows : []).map(r => {
    const en = (r.remarks_en || '').trim();
    const bn = (r.remarks_bn || '').trim();
    return {
      label: (remarkLang === 'en' ? (en || bn) : (bn || en)).trim(),
      english: en || bn,
      target: (r.target_status || '').trim(),
      instruction: (r.instruction_text || '').trim(),
    };
  }).filter(o => o.label && o.target);
  return ccDashboardRemarkOpts;
}

async function toggleHvRemarkSection(reportEl, sorted, idx) {
  const card = sorted[idx];
  const section = reportEl.querySelector(`.dash-hv-remark-section[data-idx="${idx}"]`);
  if (!section || !card) return;
  if (section.style.display !== 'none') { section.style.display = 'none'; return; }
  section.style.display = '';
  if (section.dataset.loaded) return;
  section.innerHTML = '<div class="dash-hv-status">⏳ Remarks লোড হচ্ছে…</div>';

  const idToken = await getValidFirebaseIdToken().catch(() => null);
  if (!idToken) { section.innerHTML = '<div class="dash-hv-status">⚠ Login করুন প্রথমে</div>'; return; }
  if (!card.agentSystemId) {
    section.innerHTML = '<div class="dash-hv-status">⚠ এই parcel-এ এখনো কোনো worker assign/touch করেনি, তাই remark save করা যাচ্ছে না</div>';
    return;
  }

  let options;
  try {
    options = await fetchCcDashboardRemarkOptions(idToken);
  } catch (e) {
    section.innerHTML = `<div class="dash-hv-status">⚠ Remarks load failed — ${escapeHtml(e.message || 'network error')}</div>`;
    return;
  }
  section.dataset.loaded = '1';

  const chipsHtml = options.length
    ? `<div class="dash-hv-chip-row">${options.map((o, i) =>
        `<button type="button" class="dash-hv-chip" data-opt="${i}" title="→ ${escapeHtml(o.target)}">${escapeHtml(o.label)}</button>`
      ).join('')}</div>`
    : '<div class="dash-hv-status">⚠ Config-এ কোনো remark সেট করা নেই। নোট হিসেবে লিখতে পারেন:</div>';

  section.innerHTML = `
    ${chipsHtml}
    <textarea class="dash-hv-note" rows="2" placeholder="নোট লিখুন (ঐচ্ছিক)"></textarea>
    <div class="dash-hv-remark-actions">
      <button type="button" class="dash-hv-cancel-btn">বন্ধ করুন</button>
      <button type="button" class="dash-hv-save-btn">সেভ করুন</button>
    </div>
    <div class="dash-hv-status" data-role="msg" style="display:none"></div>`;

  const msgEl  = section.querySelector('[data-role="msg"]');
  const noteEl = section.querySelector('.dash-hv-note');
  const saveBtn = section.querySelector('.dash-hv-save-btn');
  let selected = -1;
  const say = t => { msgEl.textContent = t; msgEl.style.display = t ? '' : 'none'; };

  section.querySelectorAll('.dash-hv-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const i = +chip.dataset.opt;
      selected = (selected === i) ? -1 : i;
      section.querySelectorAll('.dash-hv-chip').forEach(c =>
        c.classList.toggle('selected', +c.dataset.opt === selected));
      // CC parity: selecting fills the admin-written instruction into the
      // note box (blank clears a previous fill).
      noteEl.value = selected >= 0 ? options[selected].instruction : '';
    });
  });
  section.querySelector('.dash-hv-cancel-btn').addEventListener('click', () => {
    section.style.display = 'none';
  });
  saveBtn.addEventListener('click', async () => {
    const note = noteEl.value.trim();
    const opt = selected >= 0 ? options[selected] : null;
    if (!opt && !note) { say('একটি রিমার্কস বেছে নিন বা নোট লিখুন'); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳ …';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/validations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}`, 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({ action: 'write', row: {
          consignment: card.cId, branch_id: card.branchId,
          assigned_to_system_id: card.agentSystemId, source: 'CC',
          remarks_status: opt ? opt.target : '',
          remarks: opt ? opt.english : '',
          note,
          remarks_bn: (opt && opt.label !== opt.english) ? opt.label : '',
        }}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      say('✓ রিমার্কস সেভ হয়েছে — report refresh হচ্ছে…');
      setTimeout(() => { generateHoldValidationReport(); }, 800);
    } catch (e) {
      say(`⚠ Save failed — ${e.message || 'network error'}`);
      saveBtn.disabled = false;
      saveBtn.textContent = 'সেভ করুন';
    }
  });
}

/** One card per raw remark, chronological within each (date, consignment) —
 *  the unconsolidated breakdown Summary's rows are built from. Reuses the
 *  pending/validated colour classes to mean Worker/CC instead (orange =
 *  request, green = response) rather than adding new CSS for it. */
function renderHvReportDetails(reportEl) {
  const rowsHtml = hvReportRows.map(r => {
    const isWorker = r.source === 'WORKER';
    const badge = isWorker
      ? '<span class="dash-hv-badge dash-hv-badge-pending">🙋 Worker</span>'
      : '<span class="dash-hv-badge dash-hv-badge-validated">📞 CC</span>';
    return `
      <div class="dash-hv-row ${isWorker ? 'dash-hv-row-pending' : 'dash-hv-row-validated'}">
        <div class="dash-hv-row-top">
          <span class="dash-hv-row-id">${escapeHtml(r.cId)}</span>
          <span>${r.dateLabel} · ${r.timeLabel}</span>
        </div>
        <div class="dash-hv-row-meta">${escapeHtml(ccBranchNames[r.branchId] || r.branchId)} · ${escapeHtml(r.agentSystemId || '—')} ${badge}</div>
        <div class="dash-hv-row-remark">${escapeHtml(r.remark || '(no remark)')}${r.status ? ' — ' + escapeHtml(r.status) : ''}</div>
        ${r.note ? `<div class="dash-hv-row-meta">📝 ${escapeHtml(r.note)}</div>` : ''}
      </div>`;
  }).join('');

  reportEl.innerHTML = `<div class="dash-hv-list">${rowsHtml}</div>`;
}

/** Lowercases and dashes a branch name for use inside a filename. */
function slugifyForFilename(str) {
  return String(str || '').trim().toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'branch';
}

/** "databridge-hold-validation_<branch-part>_<date-part>.csv" — branch-part
 *  names the single branch when exactly one is selected, says how many when
 *  several (but not all) are, or "all-branches" for the full set; date-part
 *  collapses to one day when From equals To instead of repeating it. */
function buildHvFilename(fromVal, toVal, selectedIds) {
  const datePart = (fromVal === toVal) ? fromVal : `${fromVal}_to_${toVal}`;
  let branchPart;
  if (selectedIds.length === ccBranchIds.length) {
    branchPart = 'all-branches';
  } else if (selectedIds.length === 1) {
    branchPart = slugifyForFilename(ccBranchNames[selectedIds[0]] || selectedIds[0]);
  } else {
    branchPart = `${selectedIds.length}-branches`;
  }
  return `databridge-hold-validation-${hvReportMode}_${branchPart}_${datePart}.csv`;
}

function downloadHvReport() {
  if (!hvReportRows.length) {
    const statusEl = document.getElementById('dash-hv-status');
    if (statusEl) statusEl.textContent = '⚠ আগে "Report দেখুন"-এ ক্লিক করো';
    return;
  }
  const fromInput = document.getElementById('dash-hv-from');
  const toInput   = document.getElementById('dash-hv-to');

  const csvRows = hvReportMode === 'summary'
    ? [['Date', 'Branch', 'Consignment ID', 'Agent System ID', 'Validator Employee ID',
        'First Worker Remark', 'First Worker Remark Status',
        'Last CC Remark', 'Last CC Note', 'Last CC Remark Status', 'Validation Status']]
    : [['Date', 'Time', 'Branch', 'Consignment ID', 'Agent System ID', 'Source', 'Remark', 'Note', 'Remark Status']];

  hvReportRows.forEach(r => {
    if (hvReportMode === 'summary') {
      csvRows.push([
        dateKeyToMmDdYyyy(r.dateKey),
        ccBranchNames[r.branchId] || r.branchId,
        r.cId,
        r.agentSystemId || '',
        r.validatorEmployeeId || '',
        r.firstWorkerRemark || '',
        r.firstWorkerStatus || '',
        r.lastCcRemark || '',
        r.lastCcNote || '',
        r.lastCcStatus || '',
        r.stillPending ? 'Pending' : 'Validated',
      ]);
    } else {
      csvRows.push([
        dateKeyToMmDdYyyy(r.dateKey),
        r.timeLabel,
        ccBranchNames[r.branchId] || r.branchId,
        r.cId,
        r.agentSystemId || '',
        r.source === 'WORKER' ? 'Worker' : 'CC',
        r.remark || '',
        r.note || '',
        r.status || '',
      ]);
    }
  });

  downloadCsv(buildHvFilename(fromInput.value, toInput.value, getSelectedHvBranchIds()), csvRows);
}

// ══════════════════════════════════════════════════════════════════════
// 👥 TEAM PERFORMANCE (Dashboard)
// Single branch + date range → CC-sourced rows from the same Supabase
// report action Hold Validation uses. Two independent breakdowns share one
// fetch:
//   • Top summary cards — dedupe by CONSIGNMENT across the whole range;
//     each consignment's truly latest CC row decides its status bucket.
//     Answers "what happened" — one vote per consignment, no double count.
//   • Mode table — counts every CC row (no dedupe): Team groups by
//     (date, agent) for a day-by-day view, Agent groups by agent alone
//     across the whole range for a leaderboard. Answers "who did the work"
//     — an agent revisiting the same consignment twice is two acts of work,
//     so it's deliberately NOT deduped the way the summary cards are.
// ══════════════════════════════════════════════════════════════════════

const PERF_STATUS_LABELS = {
  delivery_request: '📦 Delivery',
  hold_verified:    '🔒 Hold Verified',
  return_verified:  '↩ Return Verified',
};

// users table থেকে system_id → {name, empId} (Edge join miss হলে fallback;
// branch-overlap RLS-এ same-branch actor-রা visible)। Chunked in.(...) query.
async function fetchUserNamesBySystemIds(idToken, systemIds) {
  const map = new Map();
  const ids = [...new Set((systemIds || []).filter(s => s && s !== '—'))];
  if (!ids.length) return map;
  const chunks = [];
  for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
  await Promise.all(chunks.map(async ch => {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/users?select=system_id,name,employee_id&system_id=in.(${ch.map(encodeURIComponent).join(',')})`, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${idToken}`, 'Accept': 'application/json' },
      });
      if (!res.ok) return;
      const arr = await res.json().catch(() => []);
      (Array.isArray(arr) ? arr : []).forEach(u => {
        if (u.system_id) map.set(u.system_id, { name: (u.name || '').trim(), empId: (u.employee_id || '').trim() });
      });
    } catch (e) { console.warn('[DB] perf: users lookup failed:', e); }
  }));
  return map;
}

function perfApplyUserNames(groups, nameMap) {
  Object.values(groups).forEach(g => {
    const hit = nameMap.get(g.agentId);
    if (hit && hit.name) { g.agentName = hit.name; g.agentEmpId = hit.empId; }
    if (!g.agentName) g.agentName = g.agentId;
  });
}

async function generateTeamPerformanceReport() {
  const statusEl  = document.getElementById('dash-perf-status');
  const fromInput = document.getElementById('dash-perf-from');
  const toInput   = document.getElementById('dash-perf-to');
  const branchSel = document.getElementById('dash-perf-branch');
  const modeSel   = document.getElementById('dash-perf-mode');
  const reportEl  = document.getElementById('dash-perf-report');
  const setStatus = msg => { if (statusEl) statusEl.textContent = msg; };

  if (reportEl) reportEl.innerHTML = '';

  if (!fromInput?.value || !toInput?.value) {
    setStatus('⚠ From এবং To — দুটো date-ই select করুন');
    return;
  }
  const fromDate = bdDateInputToIso(fromInput.value);
  const toDate   = bdDateInputToIso(toInput.value);
  if (!fromDate || !toDate) {
    setStatus('⚠ Date format ঠিক নেই');
    return;
  }
  if (fromDate > toDate) {
    setStatus('⚠ From date, To date-এর পরে হতে পারবে না');
    return;
  }
  const branchId = branchSel?.value;
  if (!branchId) {
    setStatus('⚠ Branch select করো');
    return;
  }
  const mode = modeSel?.value === 'agent' ? 'agent' : 'team';

  const idToken = await getValidFirebaseIdToken().catch(() => null);
  if (!idToken) {
    setStatus('⚠ Login করুন প্রথমে');
    return;
  }

  // Half-open [startIso, endIso) — same convention generateHoldValidationReport
  // uses; fromDate/toDate are Asia/Dhaka-midnight ISOs (bdDateInputToIso).
  const startIso = fromDate;
  const endIso   = new Date(new Date(toDate).getTime() + 24 * 60 * 60 * 1000).toISOString();

  try {
    setStatus('⏳ Supabase থেকে data আনা হচ্ছে…');
    const allRows = await fetchSupabaseReportRows(branchId, startIso, endIso, idToken);
    const ccRows  = allRows.filter(r => r.source === 'CC');

    if (!ccRows.length) {
      setStatus('এই date range/branch-এ কোনো CC resolution পাওয়া যায়নি');
      return;
    }

    const latestMs = row => new Date(row.created_at).getTime();
    const statusKeyOf = row => (row.remarks_status || '').trim().toLowerCase();

    // ── Summary cards: one vote per consignment (latest CC row wins) ──
    const byConsignment = {};
    ccRows.forEach(r => {
      (byConsignment[r.consignment] ||= []).push(r);
    });
    const counts = { delivery_request: 0, hold_verified: 0, return_verified: 0, other: 0 };
    Object.values(byConsignment).forEach(rows => {
      const latest = rows.reduce((a, b) => latestMs(a) >= latestMs(b) ? a : b);
      const key = statusKeyOf(latest);
      if (key in counts) counts[key]++; else counts.other++;
    });
    const totalUnique = Object.keys(byConsignment).length;

    // ── Mode table ──
    let modeRows;
    if (mode === 'team') {
      // CC agent-wise, vote-once: প্রতি consignment-এর latest CC row তার
      // author (CC agent)-কে একটা vote দেয় — কে কত hold verify করলো।
      const groups = {};
      Object.values(byConsignment).forEach(rows => {
        const latest = rows.reduce((a, b) => latestMs(a) >= latestMs(b) ? a : b);
        const agentId = latest.author_system_id || '—';
        const g = groups[agentId] ||= {
          agentId, agentName: latest.author?.name || '', agentEmpId: latest.author?.employee_id || '',
          total: 0, delivery_request: 0, hold_verified: 0, return_verified: 0, other: 0,
        };
        g.total++;
        const key = statusKeyOf(latest);
        if (key in counts) g[key]++; else g.other++;
      });
      const missing = Object.values(groups).filter(g => !g.agentName && g.agentId !== '—').map(g => g.agentId);
      perfApplyUserNames(groups, await fetchUserNamesBySystemIds(idToken, missing));
      modeRows = Object.values(groups).sort((a, b) => b.total - a.total);
    } else {
      // Delivery-agent-wise (assigned_to_system_id): distinct requested
      // consignments (WORKER row আছে) প্রতি agent — Requested vs Validated
      // (latest overall row CC = resolved)।
      const byConsAll = {};
      allRows.forEach(r => { (byConsAll[r.consignment] ||= []).push(r); });
      const groups = {};
      Object.values(byConsAll).forEach(rows => {
        if (!rows.some(r => r.source === 'WORKER')) return;
        const latest = rows.reduce((a, b) => latestMs(a) >= latestMs(b) ? a : b);
        const agentId = latest.assigned_to_system_id || rows[0].assigned_to_system_id || '—';
        const joinHit = latest.assigned?.name ? latest.assigned
          : (rows.find(r => r.assigned?.name) || {}).assigned;
        const g = groups[agentId] ||= {
          agentId, agentName: joinHit?.name || '', agentEmpId: joinHit?.employee_id || '',
          requested: 0, validated: 0,
        };
        g.requested++;
        if (latest.source === 'CC') g.validated++;
      });
      const missing = Object.values(groups).filter(g => !g.agentName && g.agentId !== '—').map(g => g.agentId);
      perfApplyUserNames(groups, await fetchUserNamesBySystemIds(idToken, missing));
      modeRows = Object.values(groups).sort((a, b) => b.requested - a.requested || b.validated - a.validated);
    }

    renderPerfReport(reportEl, mode, { totalUnique, counts }, modeRows);
    setStatus(`✓ ${totalUnique}টা unique consignment · ${ccRows.length}টা CC entry`);
  } catch (e) {
    console.error('[DB] generateTeamPerformanceReport failed:', e);
    setStatus('⚠ Report load failed — console (F12) দেখো');
  }
}

function renderPerfReport(reportEl, mode, summary, modeRows) {
  const { totalUnique, counts } = summary;

  const summaryHtml = `
    <div class="dash-hv-summary-grid dash-perf-summary-grid">
      <div class="dash-hv-summary-stat">
        <div class="dash-hv-summary-val">${totalUnique}</div>
        <div class="dash-hv-summary-label">Total Unique</div>
      </div>
      <div class="dash-hv-summary-stat">
        <div class="dash-hv-summary-val validated">${counts.delivery_request}</div>
        <div class="dash-hv-summary-label">Delivery</div>
      </div>
      <div class="dash-hv-summary-stat">
        <div class="dash-hv-summary-val pending">${counts.hold_verified}</div>
        <div class="dash-hv-summary-label">Hold Verified</div>
      </div>
      <div class="dash-hv-summary-stat">
        <div class="dash-hv-summary-val">${counts.return_verified}</div>
        <div class="dash-hv-summary-label">Return Verified</div>
      </div>
      ${counts.other ? `
      <div class="dash-hv-summary-stat">
        <div class="dash-hv-summary-val">${counts.other}</div>
        <div class="dash-hv-summary-label">Other</div>
      </div>` : ''}
    </div>`;

  const rowsHtml = mode === 'team'
    ? modeRows.map((r, i) => `
      <div class="dash-hv-row dash-perf-row">
        <div class="dash-hv-row-top">
          <span class="dash-hv-row-id">#${i + 1} ${escapeHtml(r.agentName)}${r.agentEmpId ? ' (' + escapeHtml(r.agentEmpId) + ')' : ''}</span>
          <span>Total ${r.total}</span>
        </div>
        <div class="dash-hv-row-meta">${PERF_STATUS_LABELS.hold_verified} ${r.hold_verified} · ${PERF_STATUS_LABELS.return_verified} ${r.return_verified} · ${PERF_STATUS_LABELS.delivery_request} ${r.delivery_request}${r.other ? ' · ❓ ' + r.other : ''}</div>
      </div>`).join('')
    : modeRows.map((r, i) => `
      <div class="dash-hv-row dash-perf-row">
        <div class="dash-hv-row-top">
          <span class="dash-hv-row-id">#${i + 1} ${escapeHtml(r.agentName)}${r.agentEmpId ? ' (' + escapeHtml(r.agentEmpId) + ')' : ''}</span>
          <span>Request ${r.requested}</span>
        </div>
        <div class="dash-hv-row-meta">✅ Validated ${r.validated} · ⏳ Pending ${r.requested - r.validated}</div>
      </div>`).join('');

  reportEl.innerHTML = summaryHtml + `<div class="dash-hv-list">${rowsHtml}</div>`;
}

document.addEventListener('DOMContentLoaded', init);
// ══════════════════════════════
// 🛣️ Routing Approval (sheet LIVE — Hermes step next)
// Flow: ajker tab theke sheet rows → Hermes info per consignment → render.
// Decision click → sheet-এ save (ekhon local store).
// TODO(wire-up): nijer hub — data-user hubs[0].name (hermes-api.js HermesApi.user()).
const ROUTING_OWN_HUB = 'Madanpur';
// Closed-delivered family: ei status-e parcel sesh (ar asbena).
const ROUTING_CLOSED_STATUSES = ['delivered', 'partial delivery', 'partial', 'paid return', 'exchange'];
// ⚠️ vinno hub theke closed | ✓ nij hub theke closed | '' choloman/onnanno.
function routingParcelSign(status, hub, ownHub) {
  const own = String(ownHub || ROUTING_OWN_HUB || '').trim().toLowerCase();
  const s = (status || '').trim().toLowerCase();
  if (!ROUTING_CLOSED_STATUSES.includes(s)) return '';
  return (hub || '').trim().toLowerCase() === own ? '✓' : '⚠️';
}
const ROUTING_DECISIONS_KEY = 'routing_decisions';
const ROUTING_SHEET_CFG_KEY = 'routing_sheet_cfg';
// Default decision buttons — settings theke bodlano jay. value-te {input}
// thakle press-e prompt kore bosiye K-te lekhe.
const ROUTING_DEFAULT_BUTTONS = [
  { id: 'approved', label: '✅ Approved', value: 'Approved' },
  { id: 'wrong_hub', label: '🏢 Wrong Hub', value: 'Wrong Hub' },
  { id: 'update_address', label: '📝 Update Address', value: '{input}' },
];

function routingButtons(cfg) {
  const list = cfg && Array.isArray(cfg.buttons) && cfg.buttons.length ? cfg.buttons : ROUTING_DEFAULT_BUTTONS;
  return list
    .filter(b => b && String(b.label || '').trim())
    .map((b, i) => ({
      id: String(b.id || ('btn' + (i + 1))),
      label: String(b.label).trim(),
      value: String(b.value != null ? b.value : '').trim(),
    }));
}

// Dhaka date tokens — app-er resolveTabName-er same semantics:
// {dd}=09, {d}=9, {mm}=09, {m}=9, {yyyy}=2026, {yy}=26. Token na thakle fixed.
function routingResolveTab(pattern, date) {
  const p = (pattern || '').trim() || 'Routing {dd}';
  const dt = date || new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(dt);
  const get = t => (parts.find(x => x.type === t) || {}).value || '';
  const dd = get('day'), yyyy = get('year');
  const mm = get('month');
  const d = String(parseInt(dd, 10) || 0), m = String(parseInt(mm, 10) || 0);
  return p.split('{dd}').join(dd).split('{d}').join(d)
    .split('{mm}').join(mm).split('{m}').join(m)
    .split('{yyyy}').join(yyyy).split('{yy}').join(yyyy.slice(-2));
}

function routingColToIndex(letter) {
  const t = String(letter || '').trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(t)) return -1;
  let n = 0;
  for (const ch of t) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function routingExtractSheetId(input) {
  const t = String(input || '').trim();
  if (!t) return '';
  const m = t.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : t;
}

function routingSheetRange(tab) {
  const t = String(tab || '');
  const q = /[^A-Za-z0-9_]/.test(t) ? `'${t.replace(/'/g, "''")}'` : t;
  return encodeURIComponent(q);
}

async function loadRoutingSheetCfg() {
  try {
    const r = await chrome.storage.local.get([ROUTING_SHEET_CFG_KEY]);
    return r[ROUTING_SHEET_CFG_KEY] || null;
  } catch { return null; }
}

// Ajker tab theke rows: [{id, from, to, confirm}].
async function fetchRoutingSheetRows(cfg) {
  const { token, error } = await hvGetSheetsToken();
  if (!token) throw new Error(error || 'Google sheets auth nei — Connect tab theke sign in koro');
  const sheetId = routingExtractSheetId(cfg.sheetId);
  if (!sheetId) throw new Error('Sheet ID daw settings-e');
  const tab = routingResolveTab(cfg.tabPattern);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${routingSheetRange(tab)}`,
    { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Tab "${tab}" paini`);
    throw new Error(`Sheets read failed (${res.status})`);
  }
  const data = await res.json().catch(() => ({}));
  const values = Array.isArray(data.values) ? data.values : [];
  const headerRow = Math.max(1, parseInt(cfg.headerRow, 10) || 1);
  const idIdx = routingColToIndex(cfg.idCol || 'D');
  const fromIdx = routingColToIndex(cfg.fromCol || 'C');
  const toIdx = routingColToIndex(cfg.toCol || 'E');
  const confirmIdx = routingColToIndex(cfg.confirmCol || 'K');
  if (idIdx < 0) throw new Error('ID column letter thik daw (jemon D)');
  const own = String(cfg.ownBranch || 'Madanpur').trim().toLowerCase();
  const incoming = [], outgoing = [];
  for (let i = headerRow; i < values.length; i++) {
    const r = values[i] || [];
    const id = String(r[idIdx] || '').trim();
    if (!id) continue;
    const from = fromIdx >= 0 ? String(r[fromIdx] || '').trim() : '';
    const to = toIdx >= 0 ? String(r[toIdx] || '').trim() : '';
    const confirm = confirmIdx >= 0 ? String(r[confirmIdx] || '').trim() : '';
    const row = {
      id, from, to, confirm, rowNum: i + 1,
      sheetAddress: from && to ? `${from} → ${to}` : (from || to),
      phone: '', customer: '',
      // Hermes step-e bhore jabe (ekhon blank).
      hermesAddress: '', hermesStatus: '', hub: '', lastMile: '',
      merchant: '', cod: '', history: [],
    };
    // Destination wins: To == self → incoming, else From == self → outgoing.
    if (to.toLowerCase() === own) incoming.push(row);
    else if (from.toLowerCase() === own) outgoing.push(row);
  }
  return { tab, incoming, outgoing };
}

// Decision button editor (settings): label + K value rows.
function renderRoutingDecisionEditor(buttons) {
  const box = document.getElementById('routing-decision-list');
  if (!box) return;
  box.innerHTML = '';
  (buttons && buttons.length ? buttons : ROUTING_DEFAULT_BUTTONS).forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'dash-cc-row';
    const lab = document.createElement('input');
    lab.type = 'text'; lab.className = 'dash-cc-date'; lab.style.flex = '1';
    lab.placeholder = 'Label (✅ ...)'; lab.value = b.label || '';
    lab.dataset.rlab = '1';
    const val = document.createElement('input');
    val.type = 'text'; val.className = 'dash-cc-date'; val.style.flex = '1';
    val.placeholder = 'K value ({input}?)'; val.value = b.value != null ? b.value : '';
    val.dataset.rval = '1';
    val.dataset.rid = b.id || ('btn' + (i + 1));
    const del = document.createElement('button');
    del.className = 'dash-export-btn'; del.textContent = '✕'; del.title = 'Delete';
    del.style.flex = '0 0 auto';
    del.addEventListener('click', () => { row.remove(); });
    row.appendChild(lab); row.appendChild(val); row.appendChild(del);
    box.appendChild(row);
  });
}

function collectRoutingDecisionEditor() {
  const box = document.getElementById('routing-decision-list');
  if (!box) return null;
  const out = [];
  box.querySelectorAll('.dash-cc-row').forEach(row => {
    const lab = row.querySelector('[data-rlab]');
    const val = row.querySelector('[data-rval]');
    if (!lab) return;
    const label = (lab.value || '').trim();
    if (!label) return;
    out.push({ id: (val && val.dataset.rid) || ('btn' + (out.length + 1)), label, value: ((val || {}).value || '').trim() });
  });
  return out;
}

function bindRoutingSettingsOnce(cfg) {
  if (bindRoutingSettingsOnce.done) return;
  bindRoutingSettingsOnce.done = true;
  const $ = id => document.getElementById(id);
  const toggle = $('routing-cfg-toggle'), box = $('routing-cfg');
  if (toggle && box) toggle.addEventListener('click', () => {
    const open = box.style.display === 'none';
    box.style.display = open ? '' : 'none';
    toggle.textContent = open ? '⚙️ Sheet settings ▾' : '⚙️ Sheet settings ▸';
  });
  const saveBtn = $('routing-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const btns = collectRoutingDecisionEditor();
    const next = {
      sheetId: ($('routing-sheet-id') || {}).value || '',
      tabPattern: (($('routing-tab') || {}).value || '').trim() || 'Routing {dd}',
      idCol: (($('routing-col-id') || {}).value || '').trim() || 'D',
      fromCol: (($('routing-col-from') || {}).value || '').trim() || 'C',
      toCol: (($('routing-col-to') || {}).value || '').trim() || 'E',
      confirmCol: (($('routing-col-confirm') || {}).value || '').trim() || 'K',
      ownBranch: (($('routing-own-branch') || {}).value || '').trim() || 'Madanpur',
      headerRow: (($('routing-header-row') || {}).value || '').trim() || '1',
      buttons: btns && btns.length ? btns : ROUTING_DEFAULT_BUTTONS.map(b => ({ ...b })),
    };
    try {
      await chrome.storage.local.set({ [ROUTING_SHEET_CFG_KEY]: next });
      loadRoutingTab();
    } catch (e) { console.warn('[DB] routing cfg save failed:', e); }
  });
  const addBtn = $('routing-decision-add-btn');
  if (addBtn) addBtn.addEventListener('click', () => {
    const box = document.getElementById('routing-decision-list');
    if (!box) return;
    const cur = collectRoutingDecisionEditor() || [];
    cur.push({ id: 'btn' + (cur.length + 1) + '_' + Date.now().toString(36), label: '', value: '' });
    renderRoutingDecisionEditor(cur.length ? cur : ROUTING_DEFAULT_BUTTONS);
    const rows = box.querySelectorAll('.dash-cc-row');
    const last = rows[rows.length - 1];
    if (last) { const inp = last.querySelector('input'); if (inp) inp.focus(); }
  });
}

function fillRoutingSettings(cfg) {
  const $ = id => document.getElementById(id);
  const set = (id, v) => { const el = $(id); if (el && el.value !== undefined && document.activeElement !== el) el.value = v || ''; };
  cfg = cfg || {};
  set('routing-sheet-id', cfg.sheetId);
  set('routing-tab', cfg.tabPattern || 'Routing {dd}');
  set('routing-col-id', cfg.idCol || 'D');
  set('routing-col-from', cfg.fromCol || 'C');
  set('routing-col-to', cfg.toCol || 'E');
  set('routing-col-confirm', cfg.confirmCol || 'K');
  set('routing-own-branch', cfg.ownBranch || 'Madanpur');
  set('routing-header-row', cfg.headerRow || '1');
  renderRoutingDecisionEditor(cfg.buttons && cfg.buttons.length ? cfg.buttons : ROUTING_DEFAULT_BUTTONS);
}

async function loadRoutingTab() {
  const listEl = document.getElementById('routing-list');
  const statusEl = document.getElementById('routing-status');
  const summaryEl = document.getElementById('routing-summary');
  if (!listEl) return;
  bindRoutingSettingsOnce();
  const cfg = await loadRoutingSheetCfg();
  fillRoutingSettings(cfg);
  const reloadBtn = document.getElementById('routing-refresh-btn');
  if (reloadBtn) reloadBtn.onclick = () => loadRoutingTab();
  let decisions = {};
  try {
    const r = await chrome.storage.local.get([ROUTING_DECISIONS_KEY, 'routing_decisions_demo']);
    decisions = r[ROUTING_DECISIONS_KEY] || r['routing_decisions_demo'] || {};
  } catch { /* proceeds without saved state */ }
  if (!cfg || !routingExtractSheetId(cfg.sheetId)) {
    if (statusEl) statusEl.textContent = 'Sheet settings-e Sheet ID daw (⚙️ kholo) — tarpor ajker tab theke data asbe।';
    listEl.innerHTML = '';
    if (summaryEl) summaryEl.textContent = '';
    return;
  }
  if (statusEl) statusEl.textContent = '⏳ Sheet theke ajker data ana hocche…';
  listEl.innerHTML = '';
  let tab = '', incoming = [], outgoing = [];
  try {
    const fetched = await fetchRoutingSheetRows(cfg);
    tab = fetched.tab; incoming = fetched.incoming; outgoing = fetched.outgoing;
  } catch (e) {
    if (statusEl) statusEl.textContent = `⚠ ${e.message || e}`;
    if (summaryEl) summaryEl.textContent = '';
    return;
  }
  routingState.cfg = cfg;
  routingState.tab = tab;
  routingState.incoming = incoming;
  routingState.outgoing = outgoing;
  routingState.decisions = decisions;
  renderRoutingList();
  // Hermes enrich: cached instant, bakigulo background-e fetch — seshe re-render.
  try {
    await routingEnrichHermes(cfg, [...incoming, ...outgoing], (done, total) => {
      if (statusEl) statusEl.textContent = `🔌 Hermes ${done}/${total}…`;
    });
  } catch (e) {
    console.warn('[DB] routing hermes enrich failed:', e?.message || e);
  }
  renderRoutingList();
}

let routingState = { cfg: null, tab: '', incoming: [], outgoing: [], decisions: {} };

function renderRoutingList() {
  const listEl = document.getElementById('routing-list');
  const statusEl = document.getElementById('routing-status');
  const summaryEl = document.getElementById('routing-summary');
  if (!listEl) return;
  const { cfg, tab, incoming, outgoing, decisions } = routingState;
  const ownBranch = String((cfg || {}).ownBranch || 'Madanpur').trim();
  const sheetRows = [...incoming, ...outgoing];
  if (statusEl && sheetRows.length) statusEl.textContent = `📄 ${tab} · ⬇️ ${incoming.length} incoming · ⬆️ ${outgoing.length} outgoing`;
  const addrMismatch = (row) => !!(row.hermesAddress || '').trim() && (row.sheetAddress || '').trim() !== (row.hermesAddress || '').trim();
  if (!sheetRows.length) {
    listEl.innerHTML = '<div class="card-meta">Ajker tab-e kono row nei।</div>';
    if (summaryEl) summaryEl.textContent = `📄 ${tab} · 0 rows`;
    return;
  }
  const renderRow = (row) => {
    const d = decisions[row.id];
    const stateLine = d
      ? `<div class="routing-decided">✓ ${escapeHtml(d.label)} · ${new Date(d.at).toLocaleString()}${d.extra ? ' · ' + escapeHtml(d.extra) : ''}</div>`
      : '';
    const hist = Array.isArray(row.history) ? row.history : [];
    const warnCount = hist.filter((h) => routingParcelSign(h.status, h.hub, ownBranch) === '⚠️').length;
    const histRows = hist.map((h) => {
      const sign = routingParcelSign(h.status, h.hub, ownBranch);
      return `<div class="routing-hist-row">
        <span class="routing-sign">${sign}</span>
        <span><b>${escapeHtml(h.id)}</b> · ${escapeHtml(h.address || '—')}<br>
        <span class="card-meta">${escapeHtml(h.status)} · last-mile: ${escapeHtml(h.hub)}</span></span>
      </div>`;
    }).join('');
    const histBlock = hist.length
      ? `<button class="routing-hist-toggle" data-route-hist="${escapeHtml(row.id)}">📞 Same number (${hist.length})${warnCount ? ` · ⚠️ ${warnCount}` : ''} ▸</button>
         <div class="routing-hist-list" id="rhist-${escapeHtml(row.id)}" style="display:none">${histRows || '<div class="card-meta">—</div>'}</div>`
      : `<div class="card-meta">📞 Hermes info asle history asbe</div>`;
    return `<div class="history-card routing-card">
      <div class="card-main">
        <div class="card-text">${escapeHtml(row.id)}${row.cod ? ` <span class="routing-cod">৳${escapeHtml(String(row.cod))}</span>` : ''}${row.confirm ? ` <span class="routing-diff" style="background:#dcfce7;color:#15803d">✔ ${escapeHtml(row.confirm)}</span>` : ''}</div>
        <div class="card-meta">🛣️ ${escapeHtml(row.from || '?')} → ${escapeHtml(row.to || '?')}</div>
        <div class="routing-addr">📄 Sheet: ${escapeHtml(row.sheetAddress || '—')}</div>
        <div class="routing-addr">🏢 Hermes: ${escapeHtml(row.hermesAddress || '—')}${addrMismatch(row) ? ' <span class="routing-diff">≠ mismatch</span>' : ''}</div>
        <div class="card-meta">${(row.hermesStatus || row.hub) ? `Status: <b>${escapeHtml(row.hermesStatus || '—')}</b> · Hub: ${escapeHtml(row.hub || '—')} → Last mile: ${escapeHtml(row.lastMile || '—')}` : 'Status: — (Hermes porer step-e)'}</div>
        ${histBlock}
        ${stateLine}
        <div class="card-actions">
          ${routingButtons(routingState.cfg).map(b => `<button class="action-btn" data-route-act="${escapeHtml(b.id)}" data-route-id="${escapeHtml(row.id)}">${escapeHtml(b.label)}</button>`).join('')}
        </div>
      </div>
    </div>`;
  };
  const groupHdr = (t) => `<div class="dash-sec-title" style="margin-top:10px">${t}</div>`;
  listEl.innerHTML =
    (incoming.length ? groupHdr(`⬇️ Incoming — ${ownBranch} (${incoming.length})`) + incoming.map(renderRow).join('') : '') +
    (outgoing.length ? groupHdr(`⬆️ Outgoing — ${ownBranch} theke (${outgoing.length})`) + outgoing.map(renderRow).join('') : '');
  const counts = {};
  Object.values(decisions).forEach((d) => { const k = (d && d.act) || '?'; counts[k] = (counts[k] || 0) + 1; });
  const decided = sheetRows.filter((r) => decisions[r.id]).length;
  const btnCounts = routingButtons(routingState.cfg)
    .filter(b => counts[b.id])
    .map(b => `${escapeHtml(b.label)} ${counts[b.id]}`)
    .join(' · ');
  if (summaryEl) summaryEl.textContent = `📄 ${tab} · ⬇️${incoming.length} ⬆️${outgoing.length} · Decided ${decided}${btnCounts ? ' — ' + btnCounts.replace(/<[^>]*>/g, '') : ''}`;
  listEl.querySelectorAll('[data-route-act]').forEach((btn) => {
    btn.addEventListener('click', () => decideRouting(btn.dataset.routeId, btn.dataset.routeAct, btn));
  });
  listEl.querySelectorAll('[data-route-hist]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const box = document.getElementById(`rhist-${btn.dataset.routeHist}`);
      if (!box) return;
      const open = box.style.display !== 'none';
      box.style.display = open ? 'none' : '';
      btn.innerHTML = btn.innerHTML.replace(open ? '▾' : '▸', open ? '▸' : '▾');
    });
  });
}

async function decideRouting(id, act, btn) {
  const buttons = routingButtons(routingState.cfg);
  const def = buttons.find(b => b.id === act) || { id: act, label: act, value: act };
  let kValue = def.value;
  let extra = '';
  if (kValue.includes('{input}')) {
    const val = prompt(`✏️ ${def.label} — likho:`, '');
    if (val === null) return; // cancelled
    extra = (val || '').trim();
    if (!extra) return;
    kValue = kValue.split('{input}').join(extra);
  }
  if (!kValue) return;
  const orig = btn ? btn.textContent : '';
  if (btn) btn.textContent = '⏳…';
  try {
    await saveRoutingDecision(id, def.id, def.label, extra);
    // Sheet K (confirm) column-e configured value.
    await routingWriteConfirm(id, kValue);
  } catch (e) {
    if (btn) btn.textContent = orig;
    return;
  }
  renderRoutingList();
}

// Decision → sheet confirm column (settings K, default K) at that row.
async function routingWriteConfirm(id, value) {
  const { cfg, incoming, outgoing } = routingState;
  if (!cfg) return;
  const row = [...incoming, ...outgoing].find(r => r.id === id);
  if (!row || !row.rowNum) return;
  const letter = String(cfg.confirmCol || 'K').trim().toUpperCase() || 'K';
  if (!/^[A-Z]{1,3}$/.test(letter)) return;
  const { token, error } = await hvGetSheetsToken();
  if (!token) throw new Error(error || 'Sheets auth nei');
  const tab = routingResolveTab(cfg.tabPattern);
  const sheetId = routingExtractSheetId(cfg.sheetId);
  const range = routingSheetRange(`${tab}!${letter}${row.rowNum}`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: `${tab}!${letter}${row.rowNum}`, majorDimension: 'ROWS', values: [[value]] }),
    });
  if (!res.ok) throw new Error(`Sheet write failed (${res.status})`);
  row.confirm = value;
}

// ══════════════════════════════
// 🛣️ Routing — Hermes enrich (details + history per consignment)
// Popup theke Hermes tab-e executeScript: page-er login cookie auto-jay,
// alada token lage na. Response shape defensive parse (key walk) — Hermes
// field rename korleo best-effort cholbe; na pele card-e '—' + console-e keys.
// ══════════════════════════════
function routingHermesDayKey() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());
  } catch { return new Date().toISOString().slice(0, 10); }
}

function routingHermesCacheKey() {
  return 'routing_hermes_' + routingHermesDayKey();
}

async function routingHermesTab() {
  const tabs = await chrome.tabs.query({ url: 'https://hermes.pathaointernal.com/*' });
  const active = (tabs || []).find(t => t.active) || (tabs || [])[0];
  if (active) return active;
  const created = await chrome.tabs.create({
    url: 'https://hermes.pathaointernal.com/orders/all', active: false,
  });
  await new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(finish, 15000);
    const listener = (tabId, info) => {
      if (tabId === created.id && info.status === 'complete') {
        clearTimeout(timer);
        try { chrome.tabs.onUpdated.removeListener(listener); } catch {}
        finish();
      }
    };
    try { chrome.tabs.onUpdated.addListener(listener); } catch { finish(); }
  });
  return created;
}

async function routingHermesFetch(path) {
  const tab = await routingHermesTab();
  const clean = '/' + String(path || '').replace(/^\/+/, '');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (p) => {
      try {
        const res = await fetch(p, {
          headers: { 'Accept': 'application/json' },
          credentials: 'include',
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { data = text; }
        return { ok: res.ok, status: res.status, data };
      } catch (e) {
        return { ok: false, status: 0, data: null, error: String((e && e.message) || e) };
      }
    },
    args: [clean],
  });
  const r = results && results[0] && results[0].result;
  if (!r) throw new Error('Hermes tab-e exec failed');
  if (!r.ok) throw new Error(`Hermes ${r.status || 'fetch failed'}`);
  return r.data;
}

// Case-insensitive key walk — prothom non-empty string hit.
function routingWalk(data, keys) {
  const want = keys.map(k => String(k).toLowerCase());
  let hit = '';
  try {
    (function walk(o) {
      if (hit || !o || typeof o !== 'object') return;
      if (Array.isArray(o)) { for (const v of o) { walk(v); if (hit) return; } return; }
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === 'string' && want.indexOf(k.toLowerCase()) !== -1 && v.trim()) { hit = v.trim(); return; }
      }
      for (const k of Object.keys(o)) { walk(o[k]); if (hit) return; }
    })(data);
  } catch {}
  return hit;
}

function routingLocalPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (/^8801[3-9]\d{8}$/.test(d)) return '0' + d.slice(3);
  if (/^01[3-9]\d{8}$/.test(d)) return d;
  return '';
}

function routingExtractDetails(data) {
  const root = (data && typeof data === 'object' && data.data && typeof data.data === 'object') ? data.data : data;
  return {
    status: routingWalk(root, ['status', 'order_status', 'consignment_status', 'state', 'delivery_status']),
    address: routingWalk(root, ['receiver_address', 'delivery_address', 'customer_address', 'address', 'consignee_address']),
    phone: routingLocalPhone(routingWalk(root, ['receiver_phone', 'recipient_phone', 'phone', 'customer_phone', 'consignee_phone', 'mobile'])),
    customer: routingWalk(root, ['receiver_name', 'customer_name', 'customer', 'consignee_name', 'name']),
    hub: routingWalk(root, ['hub', 'hub_name', 'current_hub', 'origin_hub']),
    lastMile: routingWalk(root, ['last_mile', 'lastmile', 'last_mile_hub', 'last_mile_hub_name', 'destination_hub']),
    cod: routingWalk(root, ['cod', 'cod_amount', 'collectable_amount', 'amount']),
    merchant: routingWalk(root, ['merchant', 'merchant_name', 'shop_name', 'shop']),
  };
}

function routingExtractList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of ['data', 'orders', 'list', 'results', 'items']) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return [];
}

async function routingEnrichOne(id) {
  const out = { id, hermesAddress: '', hermesStatus: '', hub: '', lastMile: '', phone: '', customer: '', cod: '', merchant: '', history: [] };
  const details = await routingHermesFetch('/api/v1/orders/' + encodeURIComponent(id) + '/details');
  const d = routingExtractDetails(details);
  Object.assign(out, d);
  if (d.phone) {
    try {
      const hist = await routingHermesFetch('/api/v1/orders/all?receiver_phone=' + encodeURIComponent(d.phone) + '&all_order_page=true');
      out.history = routingExtractList(hist)
        .map(o => {
          const e = routingExtractDetails(o);
          const cid = routingWalk(o, ['consignment_id', 'consignment', 'id']) || '';
          if (!cid || cid === id) return null;
          return { id: cid, address: e.address, hub: e.lastMile || e.hub, status: e.status };
        })
        .filter(Boolean)
        .slice(0, 20);
    } catch (e) {
      console.warn('[DB] routing history failed:', id, e?.message || e);
    }
  }
  return out;
}

async function routingEnrichHermes(cfg, rows, onProgress) {
  const cacheKey = routingHermesCacheKey();
  let cache = {};
  try {
    const r = await chrome.storage.local.get([cacheKey]);
    cache = r[cacheKey] || {};
  } catch {}
  // Cached age bosiye dao (instant render), bakigulo background-e ano.
  rows.forEach(row => {
    const c = cache[row.id];
    if (c) Object.assign(row, c, { history: Array.isArray(c.history) ? c.history : [] });
  });
  const pending = rows.filter(row => !cache[row.id]);
  let done = 0;
  for (const row of pending) {
    try {
      const info = await routingEnrichOne(row.id);
      Object.assign(row, info);
      cache[row.id] = info;
    } catch (e) {
      console.warn('[DB] routing enrich failed:', row.id, e?.message || e);
      row.hermesError = e?.message || 'failed';
    }
    done++;
    try { onProgress && onProgress(done, pending.length); } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  try { await chrome.storage.local.set({ [cacheKey]: cache }); } catch {}
  return rows;
}
// ══════════════════════════════
// 🚚 RUN VALIDATION REPORT TAB
// ══════════════════════════════
// Hermes run-route tab-er content script (scan-receive-helper.js) theke
// snapshot: run-এর total parcel, ajke Supabase-te pawa validation,
// validated + warning qty — table akare. Click → alada details popup
// (run-report.html), status-wise remarks soho.
const RUN_REPORT_SNAP_KEY = 'db-run-report-snapshot';
let runReportCache = null;

async function findHermesRunTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://hermes.pathaointernal.com/run-routes/*' });
    if (!tabs || !tabs.length) return null;
    return tabs.find(t => t.active) || tabs[0];
  } catch { return null; }
}

function openRunDetails(query) {
  chrome.windows.create({
    url: chrome.runtime.getURL('run-report.html') + (query || ''),
    type: 'popup', width: 560, height: 640,
  }).catch(e => console.warn('[DB] run details window failed:', e?.message || e));
}

async function loadRunReport(force) {
  const statusEl = document.getElementById('run-report-status');
  const sumEl = document.getElementById('run-report-summary');
  const byStEl = document.getElementById('run-report-bystatus');
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
  const tab = await findHermesRunTab();
  if (!tab) {
    setStatus('Kono Hermes run-route tab khola nei — run khule abar Load daw।');
    if (sumEl) sumEl.innerHTML = '';
    if (byStEl) byStEl.innerHTML = '';
    return;
  }
  const m = (tab.url || '').match(/run-routes\/(\d+)/);
  setStatus(`Run ${m ? m[1] : ''} theke report ana hocche…`);
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { action: 'db_run_report', force: !!force });
  } catch (e) {
    setStatus('Run tab-e connect holo na — extension reload kore Hermes tab refresh daw, tarpor abar try koro।');
    return;
  }
  if (!res || !res.ok || !res.report) {
    setStatus('Report pelam na (' + ((res && res.error) || 'no response') + ') — Hermes tab refresh kore abar try koro।');
    return;
  }
  runReportCache = res.report;
  try { await chrome.storage.local.set({ [RUN_REPORT_SNAP_KEY]: res.report }); } catch {}
  renderRunReport(res.report);
}

function renderRunReport(rep) {
  const statusEl = document.getElementById('run-report-status');
  const sumEl = document.getElementById('run-report-summary');
  const byStEl = document.getElementById('run-report-bystatus');
  if (!sumEl || !byStEl) return;
  const rows = Array.isArray(rep.rows) ? rep.rows : [];
  const c = rep.counts || {};
  const okN = rows.filter(r => r.verdict === 'ok').length;
  const warnN = rows.filter(r => r.verdict === 'warn').length;
  const ccN = c.todayCc || 0;
  const noN = rows.filter(r => r.verdict === 'none').length;
  const checked = rep.checkedAt
    ? new Date(rep.checkedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '—';
  if (statusEl) statusEl.textContent =
    `Run ${rep.runId} · ${rep.total} parcels · checked ${checked}` + (rep.sync ? ` · 🔄 ${rep.sync}` : '');
  const sumRow = (icon, label, n, q) =>
    `<tr class="run-sum-click" data-run-q="${q}"><td>${icon} ${label}</td><td class="num">${n}</td><td class="num">›</td></tr>`;
  sumEl.innerHTML = `<table class="run-sum-table">` +
    sumRow('📦', 'Run parcel (mot)', rep.total || 0, '?view=all') +
    sumRow('📋', 'Ajke pawa validation', ccN, '?view=today') +
    sumRow('✅', 'Validated (thik)', okN, '?verdict=ok') +
    sumRow('🚫', 'Warning / vul', warnN, '?verdict=warn') +
    sumRow('➖', 'CC request nei', noN, '?verdict=none') +
    `</table>`;
  sumEl.querySelectorAll('[data-run-q]').forEach(tr => {
    tr.addEventListener('click', () => openRunDetails(tr.dataset.runQ));
  });
  // Status-wise breakdown: protita run status-e koyta parcel, koyta
  // validated / warning — Details click-e oi status-er remarks.
  const bySt = new Map();
  rows.forEach(r => {
    const key = (r.st || '?').trim() || '?';
    let g = bySt.get(key);
    if (!g) { g = { st: key, total: 0, ok: 0, warn: 0 }; bySt.set(key, g); }
    g.total++;
    if (r.verdict === 'ok') g.ok++;
    else if (r.verdict === 'warn') g.warn++;
  });
  const groups = [...bySt.values()].sort((a, b) => b.total - a.total);
  byStEl.innerHTML = groups.length ? groups.map(g =>
    `<div class="run-st-row">
      <span class="run-st-name">${escapeHtml(g.st)}</span>
      <span class="run-st-counts">${g.total} · <b class="ok">✅${g.ok}</b> · <b class="warn">🚫${g.warn}</b></span>
      <button class="run-eye-btn" data-run-st="${escapeHtml(g.st)}">👁</button>
    </div>`).join('')
    : '<div class="dash-cc-status">Kono parcel nei।</div>';
  byStEl.querySelectorAll('[data-run-st]').forEach(btn => {
    btn.addEventListener('click', () => openRunDetails('?status=' + encodeURIComponent(btn.dataset.runSt)));
  });
  const allBtn = document.getElementById('run-report-details-btn');
  if (allBtn) allBtn.onclick = () => openRunDetails('?view=all');
  const loadBtn = document.getElementById('run-report-load-btn');
  if (loadBtn) loadBtn.onclick = () => loadRunReport(true);
}

// TODO(wire-up): sheet write goes here — connectors sheet (write column per
// consignment row, same blank-slot rule as ScannerSheetRepository) instead of
// chrome.storage.local. Hermes fetch goes into loadRoutingTab (orderSearch /
// details per ID). Button/UI code above stays unchanged.
async function saveRoutingDecision(id, act, label, extra) {
  const r = await chrome.storage.local.get([ROUTING_DECISIONS_KEY]);
  const decisions = r[ROUTING_DECISIONS_KEY] || {};
  decisions[id] = { act, label, extra: extra || '', at: Date.now() };
  await chrome.storage.local.set({ [ROUTING_DECISIONS_KEY]: decisions });
}
// Set before closing streams so the reconnect timers in each onerror handler
// don't reopen a stream the moment after it was closed.
let isShuttingDown = false;
window.addEventListener('beforeunload', () => {
  isShuttingDown = true;
  if (sseSource) sseSource.close();
  if (containerSseSource) containerSseSource.close();
  if (scanSseSource) scanSseSource.close();
  if (refreshInterval) clearInterval(refreshInterval);
});
