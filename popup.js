// ══════════════════════════════
// 🔧 কনফিগ
// ══════════════════════════════
const FIREBASE_URL = CONFIG.FIREBASE_URL;
const FIREBASE_WEB_API_KEY = CONFIG.FIREBASE_WEB_API_KEY;
const PAGINATION_LIMIT = CONFIG.PAGINATION_LIMIT || 20;
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
  ['history', 'scan', 'dashboard', 'connect', 'settings'].forEach(tab => {
    const el = document.getElementById(`nav-${tab}`);
    if (el) el.addEventListener('click', () => {
      switchTab(tab);
      if (tab === 'history' && isInitialized) loadHistory(false);
      if (tab === 'scan') loadScanHistory();
      if (tab === 'dashboard') {
        renderDashboard();
        if (!ccBranchIds.length) loadCcBranches(); // cached after first successful load
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
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
        <span class="badge ${isPhone ? 'badge-phone' : 'badge-text'}">${isPhone ? 'Phone' : 'Text'}</span>
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
  await navigator.clipboard.writeText(text);
  await logAction(itemId, 'copy');
}

async function handleDial(itemId, text) {
  const cleaned = text.replace(/[\s-()]/g, '');
  chrome.tabs.create({ url: `tel:${cleaned}` });
  await logAction(itemId, 'dial');
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
  sheet.innerHTML = `<div class="remarks-title">Add remark${item ? ' for ' + item.text.substring(0, 20) : ''}</div>`;

  options.forEach(opt => {
    const el = document.createElement('div');
    el.className = 'remark-option';
    el.innerHTML = `<div class="remark-radio"></div><span>${opt}</span>`;
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
    const sessionResults = await Promise.all([...sessionIds].map(async extId => {
      try {
        const res = await fetch(`${FIREBASE_URL}/sessions/${extId}/records.json?cb=${Date.now()}`);
        return { extId, data: await res.json() };
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
    setTimeout(() => { if (currentExtensionID) startSessionListener(currentExtensionID); }, 5000);
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
    setTimeout(() => { if (currentContainerID) startContainerListener(currentContainerID); }, 5000);
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
    setTimeout(() => { if (currentGoogleUid) startScanListener(); }, 5000);
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
  document.getElementById('status-name').textContent = n;
  document.getElementById('agent-name').textContent = n;

  const avatarEl = document.getElementById('agent-avatar');
  const avatarUrl = d?.meta?.avatar_url;
  if (avatarEl) {
    if (avatarUrl) {
      avatarEl.innerHTML = `<img src="${avatarUrl}" alt="" referrerpolicy="no-referrer">`;
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


// "Web application"-type OAuth client, created specifically for launchWebAuthFlow() — separate
// from the "Chrome Extension"-type client_id in manifest.json's oauth2 block (which is used by
// chrome.identity.getAuthToken() elsewhere and must NOT be reused here — see HISTORY above).
const GOOGLE_OAUTH_WEB_CLIENT_ID = '757742303355-qulp4gr95shmh36kj6ugtit15nfss46c.apps.googleusercontent.com';
const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

function getGoogleAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    const redirectUri = chrome.identity.getRedirectURL();
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth` +
      `?client_id=${encodeURIComponent(GOOGLE_OAUTH_WEB_CLIENT_ID)}` +
      `&response_type=token` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(GOOGLE_OAUTH_SCOPES.join(' '))}` +
      `&prompt=select_account`;

    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        reject(chrome.runtime.lastError || new Error('No redirect URL returned'));
        return;
      }
      // launchWebAuthFlow returns the access_token in the redirect URL's fragment, e.g.
      // "https://<ext-id>.chromiumapp.org/#access_token=...&token_type=Bearer&expires_in=..."
      const fragment = redirectUrl.split('#')[1] || '';
      const token = new URLSearchParams(fragment).get('access_token');
      if (!token) {
        reject(new Error('No access_token in redirect URL'));
        return;
      }
      resolve(token);
    });
  });
}

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
    const accessToken = await getGoogleAuthToken(true);
    const { uid, email, displayName, photoUrl, idToken, refreshToken, expiresIn } = await exchangeGoogleTokenForFirebaseUid(accessToken);

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
        if (btn) { btn.textContent = 'Sign in with Google'; btn.disabled = false; }
        return;
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
  } catch (e) {
    console.error('Google Sign-In failed:', e);
    if (btn) { btn.textContent = 'Sign in with Google'; btn.disabled = false; }
    alert('Google Sign-In failed. Please try again.');
  }
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
  // chrome.identity.getAuthToken()'s internal token cache, which launchWebAuthFlow() (see
  // getGoogleAuthToken() above) doesn't use at all. Signing out just means dropping our own
  // stored session state below.
  currentGoogleUid = null;
  currentGoogleEmail = null;
  currentGoogleName = null;
  currentGooglePhotoUrl = null;
  currentIdToken = null;
  currentRefreshToken = null;
  idTokenExpiresAt = 0;
  await chrome.storage.local.remove([
    'google_uid', 'google_email', 'google_name', 'google_photo_url',
    'google_id_token', 'google_refresh_token', 'google_token_expires_at'
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
  showLoading("Initializing...");
  try {
    // ✅ ১. লোকাল চেক → না থাকলে জেনারেট → স্টোরেজে সেভ
    const extension_id = await getOrCreateExtensionID();
    currentExtensionID = extension_id;
    chrome.action.setBadgeText({ text: '' });
    chrome.storage.local.set({ unread_count: 0 });

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
      navigator.clipboard.writeText(val);
      btn.textContent = '✅';
      setTimeout(() => { btn.textContent = '📋'; }, 1500);
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

// ══════════════════════════════
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
    const log = result.scan_log || {};
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
  });
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
      if (urlChip && entry.url) {
        urlChip.addEventListener('click', () => chrome.tabs.create({ url: entry.url }));
      }
      const urlCopyBtn = row.querySelector('.scan-url-copy-btn');
      if (urlCopyBtn) {
        urlCopyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(entry.url || entry.hostname);
          urlCopyBtn.textContent = '✅';
          setTimeout(() => { urlCopyBtn.textContent = '⎘'; }, 1200);
        });
      }

      if (isContinuation) row.classList.add('scan-log-entry-continuation');
      body.appendChild(row);
    });

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'action-btn btn-copy';
    copyBtn.style.cssText = 'margin: 6px 8px 8px; width: calc(100% - 16px);';
    copyBtn.textContent = '⎘ Copy barcode';
    copyBtn.addEventListener('click', e => {
      e.stopPropagation();
      navigator.clipboard.writeText(item.barcode);
      copyBtn.textContent = '✅ Copied!';
      setTimeout(() => { copyBtn.textContent = '⎘ Copy barcode'; }, 1500);
    });
    body.appendChild(copyBtn);

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
    const log = result.scan_log || {};
    if (log[barcodeKey]?.[scanKey]) {
      delete log[barcodeKey][scanKey];
      if (Object.keys(log[barcodeKey]).length === 0) delete log[barcodeKey];
      chrome.storage.local.set({ scan_log: log }, () => loadScanHistory());
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
  const exportHistoryBtn = document.getElementById('export-history-btn');
  if (exportHistoryBtn) exportHistoryBtn.addEventListener('click', () => exportHistoryToCsv());

  const exportScansBtn = document.getElementById('export-scans-btn');
  if (exportScansBtn) exportScansBtn.addEventListener('click', () => exportScansToCsv());

  const exportCcBtn = document.getElementById('export-cc-btn');
  if (exportCcBtn) exportCcBtn.addEventListener('click', () => exportCallCenterData());

  const generateHvBtn = document.getElementById('generate-hv-btn');
  if (generateHvBtn) generateHvBtn.addEventListener('click', () => generateHoldValidationReport());

  const downloadHvBtn = document.getElementById('download-hv-btn');
  if (downloadHvBtn) downloadHvBtn.addEventListener('click', () => downloadHvReport());
}

function renderDashboard() {
  const historyEl  = document.getElementById('dash-stat-history');
  const barcodesEl = document.getElementById('dash-stat-barcodes');
  const todayEl    = document.getElementById('dash-stat-today');
  if (!historyEl || !barcodesEl || !todayEl) return;

  historyEl.textContent = historyItems.length;

  const totalScans = scanItems.reduce((sum, item) => sum + (item.entries?.length || 0), 0);
  barcodesEl.textContent = totalScans;

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayCount = scanItems.reduce((sum, item) => {
    return sum + (item.entries || []).filter(e => (e.createdAt || 0) >= todayStart.getTime()).length;
  }, 0);
  todayEl.textContent = todayCount;
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

function exportHistoryToCsv() {
  const rows = [['ID', 'Text', 'Source', 'Received At']];
  historyItems.forEach(item => {
    rows.push([
      item.id || '',
      item.text || '',
      item.source || '',
      item.received_at ? new Date(item.received_at).toISOString() : ''
    ]);
  });
  downloadCsv(`databridge-history-${Date.now()}.csv`, rows);
}

function exportScansToCsv() {
  const rows = [['Barcode', 'Scanned By', 'Container ID', 'URL', 'Scanned At']];
  scanItems.forEach(item => {
    (item.entries || []).forEach(e => {
      rows.push([
        item.barcode || item.barcodeKey || '',
        e.scanned_by || '',
        e.container_id || '',
        e.url || '',
        e.createdAt ? new Date(e.createdAt).toISOString() : ''
      ]);
    });
  });
  downloadCsv(`databridge-scans-${Date.now()}.csv`, rows);
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
async function loadCcBranches() {
  const branchSelect = document.getElementById('dash-cc-branch');
  if (!branchSelect) return;
  if (!currentGoogleUid) {
    branchSelect.innerHTML = '<option value="">Google দিয়ে লগইন করুন প্রথমে</option>';
    renderHvBranchCheckboxes();
    return;
  }

  try {
    const idToken = await getValidFirebaseIdToken().catch(() => null);
    const authQuery = idToken ? `?auth=${idToken}` : '';
    const res  = await fetch(`${FIREBASE_URL}/users/${currentGoogleUid}/profile/company_info/branch_ids.json${authQuery}`);
    const data = await res.json();
    ccBranchIds = Array.isArray(data) ? data.filter(Boolean) : Object.values(data || {});

    if (!ccBranchIds.length) {
      branchSelect.innerHTML = '<option value="">কোনো branch assigned নেই</option>';
      renderHvBranchCheckboxes();
      return;
    }

    await Promise.all(ccBranchIds.map(async id => {
      try {
        const r = await fetch(`${FIREBASE_URL}/branches/${id}/name.json${authQuery}`);
        ccBranchNames[id] = (await r.json()) || id;
      } catch { ccBranchNames[id] = id; }
    }));

    branchSelect.innerHTML = '<option value="">All My Branches</option>' +
      ccBranchIds.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(ccBranchNames[id])}</option>`).join('');
    renderHvBranchCheckboxes();
  } catch (e) {
    console.warn('[DB] loadCcBranches failed:', e);
    branchSelect.innerHTML = '<option value="">⚠ Branch list load failed</option>';
    renderHvBranchCheckboxes();
  }
}

/** Parses the yyyyMMdd date embedded in a run key (e.g. "20260722" from
 *  "run_20260722_EMP001") into a real Date at local midnight. Returns null
 *  if the run id doesn't match the expected shape (defensive — a malformed
 *  key shouldn't crash the export). */
function parseRunKeyDate(yyyyMMdd) {
  const m = yyyyMMdd.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const yyyy = parseInt(m[1], 10), MM = parseInt(m[2], 10), dd = parseInt(m[3], 10);
  return new Date(yyyy, MM - 1, dd);
}

async function exportCallCenterData() {
  const statusEl  = document.getElementById('dash-cc-status');
  const branchSel = document.getElementById('dash-cc-branch');
  const fromInput = document.getElementById('dash-cc-from');
  const toInput   = document.getElementById('dash-cc-to');
  const setStatus = msg => { if (statusEl) statusEl.textContent = msg; };

  if (!fromInput.value || !toInput.value) {
    setStatus('⚠ From এবং To — দুটো date-ই select করুন');
    return;
  }
  const fromDate = new Date(fromInput.value + 'T00:00:00');
  const toDate   = new Date(toInput.value   + 'T00:00:00');
  if (fromDate > toDate) {
    setStatus('⚠ From date, To date-এর পরে হতে পারবে না');
    return;
  }

  const selectedBranch  = branchSel.value;
  const branchesToQuery = selectedBranch ? [selectedBranch] : ccBranchIds;
  if (!branchesToQuery.length) {
    setStatus('⚠ কোনো branch পাওয়া যায়নি — Connect tab-এ Google login check করো');
    return;
  }

  const idToken   = await getValidFirebaseIdToken().catch(() => null);
  const authQuery = idToken ? `?auth=${idToken}` : '';

  try {
    // Step 1 — one full runs_by_branchId fetch per branch (parallel), then
    // filter run keys by date range CLIENT-SIDE. Run keys now use a yyyyMMdd
    // STRING, which does sort chronologically, so a server-side range query
    // per branch would also work — kept as a client-side filter here for
    // simplicity (one fetch per branch either way, avoids adding per-run-type
    // range queries on top of the per-branch fetch).
    setStatus('⏳ Branch data আনা হচ্ছে…');
    const branchResults = await Promise.all(branchesToQuery.map(async branchId => {
      const res  = await fetch(`${FIREBASE_URL}/courier/runs_by_branchId/${branchId}.json${authQuery}`);
      return { branchId, data: await res.json() };
    }));

    const runTuples = [];
    branchResults.forEach(({ branchId, data }) => {
      if (!data || typeof data !== 'object') return;
      Object.entries(data).forEach(([runType, runsOfType]) => {
        if (!runsOfType || typeof runsOfType !== 'object') return;
        Object.keys(runsOfType).forEach(runId => {
          const m = runId.match(/^run_(\d{8})_(.+)$/);
          if (!m) return;
          const runDate = parseRunKeyDate(m[1]);
          if (!runDate || runDate < fromDate || runDate > toDate) return;
          runTuples.push({ branchId, runType, runId, runDate, agentSystemId: m[2] });
        });
      });
    });

    if (!runTuples.length) {
      setStatus('এই date range-এ কোনো run পাওয়া যায়নি');
      return;
    }

    // Step 2 — each surviving run's consignments map, in parallel
    setStatus(`⏳ ${runTuples.length}টা run থেকে consignment বের করা হচ্ছে…`);
    const runNodeResults = await Promise.all(runTuples.map(async t => {
      const res  = await fetch(`${FIREBASE_URL}/courier/run_routes/${t.runType}/${t.runId}.json${authQuery}`);
      const data = await res.json();
      return { ...t, consignments: (data && data.consignments) || {} };
    }));

    // One row per (runType, runId, consignmentId) — intentionally NOT
    // deduped by consignment id alone, since the same id can legitimately
    // appear in separate runs across different days in the range (a
    // re-attempt), and each such occurrence is its own row.
    const rows = [];
    runNodeResults.forEach(t => {
      Object.entries(t.consignments).forEach(([cId, status]) => {
        rows.push({ ...t, cId, runStatus: status });
      });
    });

    if (!rows.length) {
      setStatus('Run পাওয়া গেছে কিন্তু কোনো consignment নেই');
      return;
    }

    // Step 3 — each UNIQUE consignment's details + latest remark, in parallel
    setStatus(`⏳ ${rows.length}টা consignment-এর detail আনা হচ্ছে…`);
    const uniqueCids = [...new Set(rows.map(r => r.cId))];
    const detailMap  = {};
    await Promise.all(uniqueCids.map(async cId => {
      const [cons, remarks] = await Promise.all([
        fetch(`${FIREBASE_URL}/courier/consignments/${cId}.json${authQuery}`).then(r => r.json()),
        fetch(`${FIREBASE_URL}/courier/remarks_by_consignment/${cId}.json${authQuery}`).then(r => r.json()),
      ]);
      let latestRemark = null;
      if (remarks && typeof remarks === 'object') {
        latestRemark = Object.values(remarks).reduce((latest, r) =>
          (!latest || (r.createdAt || 0) > (latest.createdAt || 0)) ? r : latest, null);
      }
      detailMap[cId] = { cons: cons || {}, remark: latestRemark };
    }));

    // Step 4 — assemble + download
    const csvRows = [[
      'Date', 'Branch', 'Agent System ID', 'Consignment ID', 'Customer Name',
      'Phone', 'Address', 'COD', 'Status', 'Latest Remark', 'Remark Status'
    ]];
    rows.forEach(r => {
      const d    = detailMap[r.cId] || {};
      const cons = d.cons || {};
      const dd   = String(r.runDate.getDate()).padStart(2, '0');
      const mm   = String(r.runDate.getMonth() + 1).padStart(2, '0');
      csvRows.push([
        `${dd}-${mm}-${r.runDate.getFullYear()}`,
        ccBranchNames[r.branchId] || r.branchId,
        r.agentSystemId,
        r.cId,
        cons.recipientName    || '',
        cons.recipientPhone   || '',
        cons.recipientAddress || '',
        cons.collectableAmount ?? '',
        r.runStatus || cons.status || '',
        d.remark?.remarks || '',
        d.remark?.status  || ''
      ]);
    });

    downloadCsv(`databridge-callcenter-${fromInput.value}_to_${toInput.value}.csv`, csvRows);
    setStatus(`✓ ${rows.length}টা row export হয়েছে`);
  } catch (e) {
    console.error('[DB] exportCallCenterData failed:', e);
    setStatus('⚠ Export failed — console (F12) দেখো');
  }
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

async function generateHoldValidationReport() {
  const statusEl    = document.getElementById('dash-hv-status');
  const fromInput   = document.getElementById('dash-hv-from');
  const toInput     = document.getElementById('dash-hv-to');
  const reportEl    = document.getElementById('dash-hv-report');
  const downloadBtn = document.getElementById('download-hv-btn');
  const setStatus   = msg => { if (statusEl) statusEl.textContent = msg; };

  downloadBtn?.classList.remove('visible');
  hvReportRows = [];
  if (reportEl) reportEl.innerHTML = '';

  if (!fromInput.value || !toInput.value) {
    setStatus('⚠ From এবং To — দুটো date-ই select করুন');
    return;
  }
  const fromDate = new Date(fromInput.value + 'T00:00:00');
  const toDate   = new Date(toInput.value   + 'T00:00:00');
  if (fromDate > toDate) {
    setStatus('⚠ From date, To date-এর পরে হতে পারবে না');
    return;
  }

  const branchesToQuery = getSelectedHvBranchIds();
  if (!branchesToQuery.length) {
    setStatus('⚠ অন্তত একটা branch select করো');
    return;
  }

  const idToken   = await getValidFirebaseIdToken().catch(() => null);
  const authQuery = idToken ? `?auth=${idToken}` : '';

  try {
    // Step 1 — one full runs_by_branchId fetch per branch (parallel), then
    // filter run keys by date range client-side (same approach and same
    // caveat as exportCallCenterData() above: run keys sort chronologically
    // as yyyyMMdd strings, so a server-side range query per branch would
    // also work — kept client-side here to avoid adding per-run-type range
    // queries on top of the per-branch fetch).
    setStatus('⏳ Branch data আনা হচ্ছে…');
    const branchResults = await Promise.all(branchesToQuery.map(async branchId => {
      const res  = await fetch(`${FIREBASE_URL}/courier/runs_by_branchId/${branchId}.json${authQuery}`);
      return { branchId, data: await res.json() };
    }));

    const runTuples = [];
    branchResults.forEach(({ branchId, data }) => {
      if (!data || typeof data !== 'object') return;
      Object.entries(data).forEach(([runType, runsOfType]) => {
        if (!runsOfType || typeof runsOfType !== 'object') return;
        Object.keys(runsOfType).forEach(runId => {
          const m = runId.match(/^run_(\d{8})_(.+)$/);
          if (!m) return;
          const runDate = parseRunKeyDate(m[1]);
          if (!runDate || runDate < fromDate || runDate > toDate) return;
          runTuples.push({ branchId, runType, runId, runDate, agentSystemId: m[2] });
        });
      });
    });

    if (!runTuples.length) {
      setStatus('এই date range-এ কোনো run পাওয়া যায়নি');
      return;
    }

    // Step 2 — each surviving run's consignments map, in parallel
    setStatus(`⏳ ${runTuples.length}টা run থেকে consignment বের করা হচ্ছে…`);
    const runNodeResults = await Promise.all(runTuples.map(async t => {
      const res  = await fetch(`${FIREBASE_URL}/courier/run_routes/${t.runType}/${t.runId}.json${authQuery}`);
      const data = await res.json();
      return { ...t, consignments: (data && data.consignments) || {} };
    }));

    const rows = [];
    runNodeResults.forEach(t => {
      Object.entries(t.consignments).forEach(([cId, status]) => {
        rows.push({ ...t, cId, runStatus: status });
      });
    });

    if (!rows.length) {
      setStatus('Run পাওয়া গেছে কিন্তু কোনো consignment নেই');
      return;
    }

    // Step 3 — each UNIQUE consignment's details + FULL remarks history (not
    // just the latest one), in parallel. The whole node is needed now since
    // Step 4 below looks at every remark across the range, not one entry.
    setStatus(`⏳ ${rows.length}টা consignment-এর detail আনা হচ্ছে…`);
    const uniqueCids = [...new Set(rows.map(r => r.cId))];
    const detailMap  = {};
    await Promise.all(uniqueCids.map(async cId => {
      const [cons, remarks] = await Promise.all([
        fetch(`${FIREBASE_URL}/courier/consignments/${cId}.json${authQuery}`).then(r => r.json()),
        fetch(`${FIREBASE_URL}/courier/remarks_by_consignment/${cId}.json${authQuery}`).then(r => r.json()),
      ]);
      detailMap[cId] = {
        cons: cons || {},
        remarksRaw: (remarks && typeof remarks === 'object') ? remarks : {}
      };
    }));

    // Step 4 — one entry per CONSIGNMENT for the whole range (a re-attempted
    // consignment can show up in `rows` more than once, once per run/day it
    // was touched; per the user's own scoping call, Total Request/Validation
    // count each consignment once for the whole range, not once per day) —
    // keep whichever touching run is most recent, for the branch/agent/date
    // shown on its row — then keep only consignments that ever had a verify-
    // request in range (analyzeRangeRemarks() above decides pending vs
    // validated using the SAME "latest entry decides" rule the app uses
    // per-day, generalized to the whole range).
    const latestRowByC = {};
    rows.forEach(r => {
      const existing = latestRowByC[r.cId];
      if (!existing || r.runDate > existing.runDate) latestRowByC[r.cId] = r;
    });

    const rangeStart = fromDate.getTime();
    const rangeEnd   = toDate.getTime() + 24 * 60 * 60 * 1000; // end of the "To" day, inclusive
    const requestRows = [];
    Object.entries(latestRowByC).forEach(([cId, r]) => {
      const d = detailMap[cId] || {};
      const info = analyzeRangeRemarks(d.remarksRaw, rangeStart, rangeEnd);
      if (!info.hadRequest) return;
      requestRows.push({ ...r, cons: d.cons || {}, ...info });
    });

    // Most actionable first: still-pending ones on top, most recently
    // requested within each group first.
    requestRows.sort((a, b) => {
      if (a.stillPending !== b.stillPending) return a.stillPending ? -1 : 1;
      return (b.requestAt || 0) - (a.requestAt || 0);
    });

    hvReportRows = requestRows;
    renderHvReport();

    if (!requestRows.length) {
      setStatus('এই date range/branch-এ কোনো validation request পাওয়া যায়নি');
      return;
    }
    const pendingCount = requestRows.filter(r => r.stillPending).length;
    setStatus(`✓ Total Request ${requestRows.length} · Validated ${requestRows.length - pendingCount} · Pending ${pendingCount}`);
    downloadBtn?.classList.add('visible');
  } catch (e) {
    console.error('[DB] generateHoldValidationReport failed:', e);
    setStatus('⚠ Report load failed — console (F12) দেখো');
  }
}

/** Draws the on-screen report from hvReportRows. Called once generation
 *  finishes — never re-fetches, so Download reusing hvReportRows always
 *  matches exactly what's on screen. Shows both pending and validated
 *  parcels together, most-actionable (pending) first — see the sort in
 *  generateHoldValidationReport() — each tagged with a badge. */
function renderHvReport() {
  const reportEl = document.getElementById('dash-hv-report');
  if (!reportEl) return;
  if (!hvReportRows.length) { reportEl.innerHTML = ''; return; }

  const totalRequest   = hvReportRows.length;
  const totalPending   = hvReportRows.filter(r => r.stillPending).length;
  const totalValidated = totalRequest - totalPending;

  const rowsHtml = hvReportRows.map(r => {
    const cons = r.cons || {};
    const dd = String(r.runDate.getDate()).padStart(2, '0');
    const mm = String(r.runDate.getMonth() + 1).padStart(2, '0');
    const badge = r.stillPending
      ? '<span class="dash-hv-badge dash-hv-badge-pending">⏳ Pending</span>'
      : '<span class="dash-hv-badge dash-hv-badge-validated">✓ Validated</span>';
    return `
      <div class="dash-hv-row ${r.stillPending ? 'dash-hv-row-pending' : 'dash-hv-row-validated'}">
        <div class="dash-hv-row-top">
          <span class="dash-hv-row-id">${escapeHtml(r.cId)}</span>
          <span>${dd}-${mm}-${r.runDate.getFullYear()}</span>
        </div>
        <div>${escapeHtml(cons.recipientName || '—')} · ${escapeHtml(cons.recipientPhone || '—')}</div>
        <div class="dash-hv-row-meta">${escapeHtml(ccBranchNames[r.branchId] || r.branchId)} · ${escapeHtml(r.agentSystemId)} · COD ${escapeHtml(String(cons.collectableAmount ?? '—'))}</div>
        <div class="dash-hv-row-remark">🙋 ${escapeHtml(r.requestNote || '(no note)')}</div>
        ${r.resolutionNote ? `<div class="dash-hv-row-resolution">↳ ${escapeHtml(r.resolutionNote)}</div>` : ''}
        <div class="dash-hv-row-badge-line">${badge}</div>
      </div>`;
  }).join('');

  reportEl.innerHTML = `
    <div class="dash-hv-summary-grid">
      <div class="dash-hv-summary-stat">
        <div class="dash-hv-summary-val">${totalRequest}</div>
        <div class="dash-hv-summary-label">Total Request</div>
      </div>
      <div class="dash-hv-summary-stat">
        <div class="dash-hv-summary-val validated">${totalValidated}</div>
        <div class="dash-hv-summary-label">Total Validation</div>
      </div>
      <div class="dash-hv-summary-stat">
        <div class="dash-hv-summary-val pending">${totalPending}</div>
        <div class="dash-hv-summary-label">Pending</div>
      </div>
    </div>
    <div class="dash-hv-list">${rowsHtml}</div>
  `;
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
  return `databridge-hold-validation_${branchPart}_${datePart}.csv`;
}

function downloadHvReport() {
  if (!hvReportRows.length) return;
  const fromInput = document.getElementById('dash-hv-from');
  const toInput   = document.getElementById('dash-hv-to');

  const csvRows = [[
    'Consignment ID', 'Branch', 'Agent System ID', 'Last Touched', 'Customer Name',
    'Phone', 'Address', 'COD', 'Validation Status', 'Request Note', 'Resolution Note'
  ]];
  hvReportRows.forEach(r => {
    const cons = r.cons || {};
    const dd = String(r.runDate.getDate()).padStart(2, '0');
    const mm = String(r.runDate.getMonth() + 1).padStart(2, '0');
    csvRows.push([
      r.cId,
      ccBranchNames[r.branchId] || r.branchId,
      r.agentSystemId,
      `${dd}-${mm}-${r.runDate.getFullYear()}`,
      cons.recipientName    || '',
      cons.recipientPhone   || '',
      cons.recipientAddress || '',
      cons.collectableAmount ?? '',
      r.stillPending ? 'Pending' : 'Validated',
      r.requestNote    || '',
      r.resolutionNote || ''
    ]);
  });

  downloadCsv(buildHvFilename(fromInput.value, toInput.value, getSelectedHvBranchIds()), csvRows);
}

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', () => {
  if (sseSource) sseSource.close();
  if (containerSseSource) containerSseSource.close();
  if (refreshInterval) clearInterval(refreshInterval);
});
