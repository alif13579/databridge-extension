// ══════════════════════════════
// 🔧 কনফিগ
// ══════════════════════════════
const FIREBASE_URL = CONFIG.FIREBASE_URL;
const FIREBASE_WEB_API_KEY = CONFIG.FIREBASE_WEB_API_KEY;
const PAGINATION_LIMIT = CONFIG.PAGINATION_LIMIT || 20;

// ══════════════════════════════
// 🌐 গ্লোবাল স্টেট
// ══════════════════════════════
let currentExtensionID = null;
let currentContainerID = null;
let currentUserId = null;
let historyItems = [];
let sseSource = null;
let containerSseSource = null;
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
  ['history', 'scan', 'connect', 'settings'].forEach(tab => {
    const el = document.getElementById(`nav-${tab}`);
    if (el) el.addEventListener('click', () => {
      switchTab(tab);
      if (tab === 'history' && isInitialized) loadHistory(false);
      if (tab === 'scan') loadScanHistory();
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

    // 2. Collect all session IDs to fetch
    const sessionIds = new Set();
    if (extensionId) sessionIds.add(extensionId);

    // If logged in, also pull every connected extension's session for this user
    if (userId) {
      try {
        const extRes = await fetch(`${FIREBASE_URL}/users/${userId}/connections/extensions.json?cb=${Date.now()}${authQuery}`);
        const extMap = await extRes.json();
        if (extMap && typeof extMap === 'object') {
          Object.keys(extMap).forEach(id => sessionIds.add(id));
        }
      } catch (e) { console.warn('Could not fetch user extensions list:', e); }
    }

    // 3. Fetch records from each session
    for (const extId of sessionIds) {
      try {
        const res = await fetch(`${FIREBASE_URL}/sessions/${extId}/records.json?cb=${Date.now()}`);
        absorb(await res.json(), extId === extensionId ? 'session' : 'session_other', extId);
      } catch (e) { console.warn(`Session ${extId} fetch failed:`, e); }
    }

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

function startContainerListener(containerId) {
  if (containerSseSource) { containerSseSource.close(); containerSseSource = null; }
  if (!containerId) return;
  containerSseSource = new EventSource(`${FIREBASE_URL}/container/${containerId}.json`);
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
  await fetch(`${FIREBASE_URL}/users/${uid}/connections/extensions/${extensionId}.json${authParam}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'connected',
      type: 'google_linked',
      connected_at: now,
      last_sync: now
    })
  });
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
    const extIdDisplay = document.getElementById('extension-id-display');
    if (extIdDisplay) extIdDisplay.textContent = extension_id;

    setupNavigation();
    generateQR(extension_id); // ✅ নতুন QR জেনারেট হবে
    setupCopyExtensionID(extension_id);
    setupDisconnect(extension_id);
    setupGoogleLogin();
    await restoreGoogleLoginState();
    setupSearch();
    setupSettings();
    setupLoadMore();
    setupSortButton();
    setupScanTab(); // 📷 Scanner tab
    setupConnectedInfoCopy();
    setupAutoRefresh();

    // ✅ ৩. কানেকশন চেক & হিস্ট্রি লোড
    await checkConnectionWithFallback(extension_id);
    await getActivePaths();
    await loadHistory(false);
    startSessionListener(extension_id);
    if (currentContainerID) startContainerListener(currentContainerID);

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
let scanItems = [];
let scanSearchQuery = '';
let scanFirebaseResult = null; // null = show local log; object = show Firebase details

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

function loadScanHistory() {
  chrome.storage.local.get(['scan_log'], (result) => {
    const log = result.scan_log || {};
    const flat = [];
    Object.entries(log).forEach(([barcodeKey, scans]) => {
      Object.entries(scans).forEach(([scanKey, data]) => {
        let hostname = '—';
        try { hostname = new URL(data.url).hostname; } catch (e) {}
        flat.push({
          barcodeKey,
          scanKey,
          barcode   : data.barcode || barcodeKey,
          scanned_by: data.scanned_by,
          createdAt : data.createdAt,
          url       : data.url,
          hostname
        });
      });
    });
    flat.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    scanItems = flat;
    renderScanList();
    const badge = document.getElementById('scan-count-badge');
    if (badge) badge.textContent = `${flat.length} record${flat.length !== 1 ? 's' : ''}`;
  });
}

function renderScanList() {
  const list = document.getElementById('scan-list');
  if (!list) return;

  const q = scanSearchQuery.trim().toLowerCase();
  const filtered = q
    ? scanItems.filter(s => (s.barcode || '').toLowerCase().includes(q))
    : [...scanItems];

  list.innerHTML = '';

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">No scans yet.<br>Scan a barcode in any tab!</div>';
    return;
  }

  filtered.forEach(scan => {
    const uid = `scan-${scan.barcodeKey}-${scan.scanKey}`;
    const card = document.createElement('div');
    card.className = 'history-card';

    // Header (always visible, compact — same pattern as history cards)
    const header = document.createElement('div');
    header.className = 'card-header';
    header.innerHTML = `
      <div class="scan-dot"></div>
      <div class="card-main">
        <div class="card-text">${escapeHtml(scan.barcode)}</div>
        <div class="card-meta">
          <span class="card-time">${scanExactTime(scan.createdAt)}</span>
          <span class="scan-url-chip">🌐 ${escapeHtml(scan.hostname)}</span>
        </div>
      </div>
      <div class="chevron" id="chev-${uid}">▼</div>`;

    // Actions (hidden by default, toggle on header click)
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.id = `actions-${uid}`;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'action-btn btn-copy';
    copyBtn.textContent = '⎘ Copy';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(scan.barcode);
      copyBtn.textContent = '✅';
      setTimeout(() => { copyBtn.textContent = '⎘ Copy'; }, 1500);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'action-btn btn-delete';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteScanRecord(scan.barcodeKey, scan.scanKey);
    });

    actions.appendChild(copyBtn);
    actions.appendChild(delBtn);

    // Toggle on header click
    header.addEventListener('click', () => {
      const act = document.getElementById(`actions-${uid}`);
      const chev = document.getElementById(`chev-${uid}`);
      if (act) {
        const isOpen = act.classList.toggle('visible');
        if (chev) chev.classList.toggle('open', isOpen);
      }
    });

    card.appendChild(header);
    card.appendChild(actions);
    list.appendChild(card);
  });
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

async function fetchBarcodeFromFirebase(barcode) {
  const list = document.getElementById('scan-list');
  if (!list) return;
  list.innerHTML = '<div class="empty-state">🔍 Fetching from Firebase...</div>';

  // Sanitize barcode key (same logic as scanner-module.js)
  const safeKey = barcode.replace(/[.#$/\[\]]/g, '_');
  try {
    const res = await fetch(
      `${FIREBASE_URL}/scanned/barcode_scans/${safeKey}.json?cb=${Date.now()}`
    );
    const data = await res.json();

    if (!data || typeof data !== 'object') {
      list.innerHTML = `<div class="empty-state">No records found for <b>${escapeHtml(barcode)}</b></div>`;
      return;
    }

    // data = { scan_ts1: {...}, scan_ts2: {...} }
    const entries = Object.entries(data)
      .map(([key, val]) => ({ key, ...val }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    scanFirebaseResult = { barcode, entries };
    renderFirebaseDetails(barcode, entries);
  } catch (err) {
    list.innerHTML = `<div class="empty-state">⚠️ Firebase fetch failed: ${escapeHtml(String(err))}</div>`;
  }
}

function renderFirebaseDetails(barcode, entries) {
  const list = document.getElementById('scan-list');
  if (!list) return;
  list.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'scan-firebase-header';
  header.innerHTML = `
    <div class="scan-firebase-barcode">📦 ${escapeHtml(barcode)}</div>
    <div class="scan-firebase-count">${entries.length} scan record${entries.length !== 1 ? 's' : ''} in Firebase</div>`;
  list.appendChild(header);

  entries.forEach((entry, i) => {
    let hostname = '—';
    try { hostname = new URL(entry.url || '').hostname; } catch {}

    const card = document.createElement('div');
    card.className = 'scan-card scan-firebase-card';
    card.innerHTML = `
      <div class="scan-card-header">
        <div class="scan-firebase-index">#${i + 1}</div>
        <div class="scan-detail-row"><span class="scan-detail-label">Scan Key</span><span class="scan-detail-value mono">${escapeHtml(entry.key)}</span></div>
        <div class="scan-detail-row"><span class="scan-detail-label">Time</span><span class="scan-detail-value">${scanExactTime(entry.createdAt)}</span></div>
        <div class="scan-detail-row"><span class="scan-detail-label">Scanned By</span><span class="scan-detail-value mono">${escapeHtml(entry.scanned_by || '—')}</span></div>
        <div class="scan-detail-row"><span class="scan-detail-label">Container</span><span class="scan-detail-value mono">${escapeHtml(entry.container_id || '—')}</span></div>
        <div class="scan-detail-row"><span class="scan-detail-label">Page</span><span class="scan-url-chip">🌐 ${escapeHtml(hostname)}</span></div>
      </div>`;
    list.appendChild(card);
  });
}

function setupScanTab() {
  const searchInput = document.getElementById('scan-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim();
      scanSearchQuery = q;
      // Clear Firebase results when user clears the search box
      if (!q) {
        scanFirebaseResult = null;
        renderScanList();
      } else {
        // Just filter local list while typing
        renderScanList();
      }
    });

    // Enter → fetch full details from Firebase
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const q = searchInput.value.trim();
      if (!q) return;
      fetchBarcodeFromFirebase(q);
    });
  }

  const clearBtn = document.getElementById('clear-scan-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (!confirm('সব scan records delete হবে। নিশ্চিত?')) return;
      chrome.storage.local.remove(['scan_log'], () => {
        scanItems = [];
        renderScanList();
        const badge = document.getElementById('scan-count-badge');
        if (badge) badge.textContent = '0 records';
      });
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', () => {
  if (sseSource) sseSource.close();
  if (containerSseSource) containerSseSource.close();
  if (refreshInterval) clearInterval(refreshInterval);
});
