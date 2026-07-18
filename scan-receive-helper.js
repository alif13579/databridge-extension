// ══════════════════════════════════════════════════════════════════════════
// Scan/Receive Helper — hermes.pathaointernal.com/run-routes/*
//
// Flow:
//   1. On page load → read parcel list → build expected ID sets (Hold / Return)
//   2. Save expected sets to localStorage (expires in 72h, keyed by run ID)
//   3. On scan (Enter) → show toast if status doesn't match the field's rules
//   4. On Save / Close Run click → commit scanned IDs as "received" in localStorage
//   5. Row borders → green (received) / red (pending)  at all times
//   6. Floating panel → Run Summary + Pending Scan list (live)
//
// Toast rules:
//   Hold field   : no toast only for "On Hold". Everything else → toast.
//   Return field : no toast only for "Return". Everything else → toast
//                  (even other allowed statuses get a toast so the user
//                   can see what status they're accepting).
//
// Save rule (CRITICAL):
//   LocalStorage is only written with "received" IDs when the SAVE /
//   Close Run button is clicked. Scanning alone never commits to storage —
//   prevents discrepancies where the drawer was closed without saving.
// ══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── SELECTORS ────────────────────────────────────────────────────────────
  const HOLD_INPUT_ID   = 'onHoldConsId';
  const RETURN_INPUT_ID = 'returnConsId';
  const PANEL_SELECTOR  = '.w-full.border.rounded.p-2.pb-4';
  const SCANNED_ROW_SEL = ':scope > div.my-2';
  const PARCEL_ROW_SEL  = '.pt-list-item';
  const DATA_COL_SEL    = '.w-1\\/6';

  // ── CONSTANTS ────────────────────────────────────────────────────────────
  // Hermes consignment IDs are 14-char uppercase alphanumeric (letter+digit mix)
  const ID_REGEX = /\b(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{14}\b/;

  const STORAGE_EXPIRY_MS = 72 * 3600 * 1000; // 3 days

  // Statuses that belong to each scan field (lowercase for comparison)
  const HOLD_VALID   = new Set(['on hold']);
  const RETURN_VALID = new Set([
    'return', 'paid return', 'return request', 'return requested',
    'exchange', 'partial delivery', 'partial', 'reattempt request', 'drto',
  ]);

  // Status → colour map (lowercase keys)
  const STATUS_COLOR = {
    'on hold':           '#3b82f6', // blue
    'return':            '#ef4444', // red
    'paid return':       '#ef4444',
    'return request':    '#f97316', // orange
    'return requested':  '#f97316',
    'exchange':          '#a855f7', // purple
    'partial delivery':  '#f59e0b', // amber
    'partial':           '#f59e0b',
    'reattempt request': '#f59e0b',
    'drto':              '#ef4444',
    'delivered':         '#22c55e', // green
    'pending':           '#6b7280', // gray
  };
  const DEFAULT_COLOR = '#6b7280';

  function statusColor(s) {
    return STATUS_COLOR[(s || '').toLowerCase()] || DEFAULT_COLOR;
  }

  // ── RUN ID / STORAGE KEY ─────────────────────────────────────────────────
  function getRunId() {
    const m = window.location.pathname.match(/\/run-routes\/(\d+)/);
    return m ? m[1] : 'unknown';
  }
  const STORAGE_KEY = `db-scan-helper-v2-${getRunId()}`;

  // ── STORAGE ──────────────────────────────────────────────────────────────
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (Date.now() > d.expiresAt) { localStorage.removeItem(STORAGE_KEY); return null; }
      return d;
    } catch { return null; }
  }

  function persistState(s) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
  }

  function initState(holdExpected, returnExpected) {
    const existing = loadState();
    if (existing) return existing;
    const s = {
      runId: getRunId(),
      createdAt: Date.now(),
      expiresAt: Date.now() + STORAGE_EXPIRY_MS,
      holdExpected,
      returnExpected,
      holdReceived: [],
      returnReceived: [],
    };
    persistState(s);
    return s;
  }

  // ── DOM HELPERS ──────────────────────────────────────────────────────────
  function parcelRows() {
    return [...document.querySelectorAll(PARCEL_ROW_SEL)].filter(r =>
      r.querySelector(DATA_COL_SEL)
    );
  }

  function rowIdEl(row) {
    const col = row.querySelector(DATA_COL_SEL);
    return col ? col.querySelector('.flex-1') : null;
  }

  function rowId(row) {
    const el = rowIdEl(row);
    return el ? el.textContent.trim() : '';
  }

  function rowStatus(row) {
    const b = row.querySelector('.pt-label-btn');
    return b ? b.textContent.trim() : null;
  }

  function rowAmount(row) {
    const col = row.querySelector(DATA_COL_SEL);
    if (!col) return 0;
    for (const el of col.querySelectorAll('.flex-1')) {
      const m = el.textContent.trim().match(/^(\d+)\s*Tk/i);
      if (m) return parseInt(m[1]);
    }
    return 0;
  }

  function rowCollected(row) {
    const m = row.textContent.match(/Collected Amount[:\s]+(\d+)/i);
    return m ? parseInt(m[1]) : 0;
  }

  // Build expected ID lists by reading the current parcel list DOM
  function buildExpected() {
    const holdExpected = [], returnExpected = [];
    parcelRows().forEach(row => {
      const id  = rowId(row);
      const st  = (rowStatus(row) || '').toLowerCase();
      if (!ID_REGEX.test(id)) return;
      if (HOLD_VALID.has(st))   holdExpected.push(id);
      else if (RETURN_VALID.has(st)) returnExpected.push(id);
    });
    return { holdExpected, returnExpected };
  }

  // Run summary: unique statuses with qty, total amount, collected amount
  function buildSummary() {
    const map = {};
    parcelRows().forEach(row => {
      const st = rowStatus(row);
      if (!st) return;
      if (!map[st]) map[st] = { qty: 0, total: 0, collected: 0 };
      map[st].qty++;
      map[st].total     += rowAmount(row);
      map[st].collected += rowCollected(row);
    });
    return map;
  }

  // IDs currently visible in a scan panel (not yet saved — just in DOM)
  function panelScannedIds(inputId) {
    const input = document.getElementById(inputId);
    const panel = input && input.closest(PANEL_SELECTOR);
    if (!panel) return [];
    const ids = [];
    panel.querySelectorAll(SCANNED_ROW_SELECTOR).forEach(row => {
      const d = row.querySelector('div');
      const t = d && d.textContent.trim();
      if (t && ID_REGEX.test(t)) ids.push(t);
    });
    return ids;
  }

  function findRowById(id) {
    return parcelRows().find(r => rowId(r) === id);
  }

  // ── STYLES ──────────────────────────────────────────────────────────────
  function injectStyle() {
    if (document.getElementById('db-scan-style')) return;
    const s = document.createElement('style');
    s.id = 'db-scan-style';
    s.textContent = `
      /* Row borders */
      .db-row-received { border-left: 4px solid #22c55e !important; background: #f0fdf4 !important; }
      .db-row-pending  { border-left: 4px solid #ef4444 !important; background: #fff5f5 !important; }

      /* Tick mark */
      .db-tick {
        display: inline-flex; align-items: center; justify-content: center;
        background: #22c55e; color: #fff; border-radius: 4px;
        font-size: 10px; font-weight: 700; line-height: 1;
        padding: 2px 5px; margin-left: 6px; vertical-align: middle;
        white-space: nowrap; letter-spacing: .2px;
      }

      /* Toast */
      .db-toast {
        position: fixed; top: 20px; right: 20px; z-index: 2147483647;
        background: #1e1e2e; color: #fff; border-radius: 10px; padding: 12px 16px;
        box-shadow: 0 4px 20px rgba(0,0,0,.35); min-width: 210px;
        font: 13px/1.5 -apple-system, Segoe UI, sans-serif;
        opacity: 0; transform: translateY(-10px);
        transition: opacity .2s, transform .2s;
      }
      .db-toast.db-show { opacity: 1; transform: translateY(0); }
      .db-toast-label  { font-size: 11px; opacity: .55; margin-bottom: 3px; }
      .db-toast-id     { font: 700 15px/1 monospace; color: #ffe066; }
      .db-toast-status { font-size: 13px; font-weight: 600; margin-top: 5px; }

      /* Floating panel */
      #db-panel {
        position: fixed; top: 80px; right: 100px; z-index: 2147483646;
        background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
        box-shadow: 0 4px 24px rgba(0,0,0,.13); width: 290px;
        font: 13px/1.5 -apple-system, Segoe UI, sans-serif; overflow: hidden;
      }
      .db-hdr {
        background: #1e293b; color: #fff; padding: 10px 14px;
        display: flex; justify-content: space-between; align-items: center;
        cursor: move; user-select: none; font-weight: 600; font-size: 13px;
      }
      .db-hdr button {
        background: none; border: none; color: #fff; font-size: 18px;
        cursor: pointer; line-height: 1; padding: 0 2px;
      }
      .db-body { padding: 10px; max-height: 72vh; overflow-y: auto; }
      .db-sec  { margin-bottom: 14px; }
      .db-sec-title {
        font-weight: 700; font-size: 11px; text-transform: uppercase;
        letter-spacing: .5px; color: #64748b; margin-bottom: 8px;
      }
      .db-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .db-table th {
        text-align: left; color: #94a3b8; padding: 3px 4px; font-weight: 600;
        border-bottom: 1px solid #f1f5f9;
      }
      .db-table td   { padding: 4px; vertical-align: middle; }
      .db-table .num { text-align: right; font-variant-numeric: tabular-nums; }
      .db-dot {
        display: inline-block; width: 8px; height: 8px;
        border-radius: 50%; margin-right: 6px; vertical-align: middle;
      }
      .db-tfoot td {
        padding-top: 8px; border-top: 1px solid #e5e7eb;
        font-size: 12px; color: #1e293b;
      }
      .db-pending-grp { margin-bottom: 10px; }
      .db-pending-hdr {
        font-weight: 600; font-size: 12px; display: flex; align-items: center;
        gap: 6px; margin-bottom: 4px;
      }
      .db-cnt {
        background: #f1f5f9; color: #475569; border-radius: 10px;
        padding: 0 7px; font-size: 11px; font-weight: 700;
      }
      .db-ids { display: flex; flex-wrap: wrap; gap: 4px; }
      .db-id {
        background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px;
        padding: 2px 6px; font: 11px/1.4 monospace; color: #334155;
      }
      .db-more { font-size: 11px; color: #94a3b8; padding: 2px 4px; align-self: center; }
      .db-id {
        cursor: pointer;
        transition: background .15s, border-color .15s;
      }
      .db-id:hover { background: #e0f2fe !important; border-color: #7dd3fc !important; color: #0369a1 !important; }
      @keyframes db-flash {
        0%   { background: #fef08a; box-shadow: 0 0 0 3px #fde047; }
        60%  { background: #fef08a; box-shadow: 0 0 0 3px #fde047; }
        100% { background: transparent; box-shadow: none; }
      }
      .db-row-flash { animation: db-flash 1.8s ease forwards !important; }
      .db-done { color: #22c55e; font-weight: 600; font-size: 13px; padding: 6px 4px; }
      .db-divider { border: none; border-top: 1px solid #f1f5f9; margin: 10px 0; }
    `;
    document.head.appendChild(s);
  }

  // ── TOAST ────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(id, status, isInvalid) {
    document.querySelectorAll('.db-toast').forEach(e => e.remove());
    clearTimeout(toastTimer);
    const color = statusColor(status);
    const label = isInvalid ? '⚠️ Wrong Field' : 'ℹ️ Status Info';
    const el = document.createElement('div');
    el.className = 'db-toast';
    el.innerHTML = `
      <div class="db-toast-label">${label}</div>
      <div class="db-toast-id">${id}</div>
      <div class="db-toast-status" style="color:${color}">● ${status || 'Unknown'}</div>
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('db-show'));
    toastTimer = setTimeout(() => {
      el.classList.remove('db-show');
      setTimeout(() => el.remove(), 250);
    }, 4000);
  }

  // ── FLOATING PANEL ───────────────────────────────────────────────────────
  let panel = null;
  let minimized = false;

  function createPanel() {
    panel = document.createElement('div');
    panel.id = 'db-panel';
    panel.innerHTML = `
      <div class="db-hdr">
        <span>📦 DataBridge Reconcile</span>
        <button id="db-min">−</button>
      </div>
      <div class="db-body" id="db-body">
        <div class="db-sec" id="db-summary"></div>
        <hr class="db-divider">
        <div class="db-sec" id="db-pending"></div>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('db-min').addEventListener('click', () => {
      minimized = !minimized;
      document.getElementById('db-body').style.display = minimized ? 'none' : '';
      document.getElementById('db-min').textContent = minimized ? '+' : '−';
    });

    // Draggable
    const hdr = panel.querySelector('.db-hdr');
    let ox, oy, ol, ot;
    hdr.addEventListener('mousedown', e => {
      ox = e.clientX; oy = e.clientY; ol = panel.offsetLeft; ot = panel.offsetTop;
      const move = ev => {
        panel.style.left  = (ol + ev.clientX - ox) + 'px';
        panel.style.top   = (ot + ev.clientY - oy) + 'px';
        panel.style.right = 'auto';
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', () => document.removeEventListener('mousemove', move), { once: true });
    });
  }

  function refreshPanel(st) {
    if (!panel) createPanel();

    // ── Summary section ──
    const summary = buildSummary();
    let totalCollected = 0;
    let rows = '';
    Object.entries(summary).forEach(([status, d]) => {
      const c = statusColor(status);
      totalCollected += d.collected;
      rows += `<tr>
        <td><span class="db-dot" style="background:${c}"></span>${status}</td>
        <td class="num">${d.qty}</td>
        <td class="num">${d.total ? d.total.toLocaleString() + ' ৳' : '—'}</td>
      </tr>`;
    });
    document.getElementById('db-summary').innerHTML = `
      <div class="db-sec-title">📊 Run Summary</div>
      <table class="db-table">
        <thead><tr><th>Status</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3" class="db-tfoot">
          💰 Collected: <b>${totalCollected ? totalCollected.toLocaleString() + ' ৳' : '—'}</b>
        </td></tr></tfoot>
      </table>
    `;

    // ── Pending section ──
    const holdPending   = (st.holdExpected   || []).filter(id => !st.holdReceived.includes(id));
    const returnPending = (st.returnExpected || []).filter(id => !st.returnReceived.includes(id));

    let pendHTML = '<div class="db-sec-title">⏳ Pending Scan</div>';

    function pendingGroup(label, color, ids) {
      if (!ids.length) return '';
      const shown = ids.slice(0, 4);
      const extra = ids.length - shown.length;
      return `
        <div class="db-pending-grp">
          <div class="db-pending-hdr" style="color:${color}">
            <span>● ${label}</span><span class="db-cnt">${ids.length}</span>
          </div>
          <div class="db-ids">
            ${shown.map(id => `<span class="db-id" data-scroll-id="${id}">${id}</span>`).join('')}
            ${extra > 0 ? `<span class="db-more">+${extra} more</span>` : ''}
          </div>
        </div>`;
    }

    pendHTML += pendingGroup('On Hold', '#3b82f6', holdPending);
    pendHTML += pendingGroup('Return', '#ef4444', returnPending);

    if (!holdPending.length && !returnPending.length) {
      pendHTML += '<div class="db-done">✅ All parcels received!</div>';
    }

    document.getElementById('db-pending').innerHTML = pendHTML;

    // Attach scroll-on-click to every ID badge
    document.getElementById('db-pending').querySelectorAll('[data-scroll-id]').forEach(el => {
      el.addEventListener('click', () => scrollToRow(el.dataset.scrollId));
    });
  }

  // ── SCROLL TO ROW ───────────────────────────────────────────────────────────
  function scrollToRow(id) {
    const row = findRowById(id);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('db-row-flash');
    // Force reflow so re-adding the class re-triggers the animation
    void row.offsetWidth;
    row.classList.add('db-row-flash');
    setTimeout(() => row.classList.remove('db-row-flash'), 1900);
  }

  // ── ROW BORDERS ──────────────────────────────────────────────────────────
  function refreshBorders(st) {
    const received = new Set([...st.holdReceived, ...st.returnReceived]);
    const expected = new Set([...st.holdExpected, ...st.returnExpected]);
    parcelRows().forEach(row => {
      const id   = rowId(row);
      const idEl = rowIdEl(row);
      row.classList.remove('db-row-received', 'db-row-pending');

      // Remove any previously injected tick
      if (idEl) idEl.querySelectorAll('.db-tick').forEach(e => e.remove());

      if (!expected.has(id)) return;

      if (received.has(id)) {
        row.classList.add('db-row-received');
        if (idEl) {
          const tick = document.createElement('span');
          tick.className = 'db-tick';
          tick.textContent = '\u2713 Received';
          idEl.appendChild(tick);
        }
      } else {
        row.classList.add('db-row-pending');
      }
    });
  }

  // ── RECONCILE RECEIVED LIST WITH CURRENT PAGE STATUS ─────────────────────
  // If a previously-received parcel gets reassigned and its status changes,
  // it should no longer count as received — remove it from the list and
  // persist, so borders + pending panel stay accurate.
  function reconcileWithPageState(st) {
    // Build a quick id→status map from the current DOM
    const pageStatus = {};
    parcelRows().forEach(row => {
      const id = rowId(row);
      const s  = (rowStatus(row) || '').toLowerCase();
      if (id) pageStatus[id] = s;
    });

    const holdBefore   = st.holdReceived.length;
    const returnBefore = st.returnReceived.length;

    // Keep only IDs that still exist on the page with the correct status
    st.holdReceived   = st.holdReceived.filter(id =>
      pageStatus[id] !== undefined && HOLD_VALID.has(pageStatus[id])
    );
    st.returnReceived = st.returnReceived.filter(id =>
      pageStatus[id] !== undefined && RETURN_VALID.has(pageStatus[id])
    );

    const changed =
      st.holdReceived.length   !== holdBefore ||
      st.returnReceived.length !== returnBefore;

    if (changed) persistState(st);
    return changed;
  }

  // ── SCAN INPUT HANDLER ───────────────────────────────────────────────────
  const listenedInputs = new Set();
  function attachScanListeners(st) {
    [
      { inputId: HOLD_INPUT_ID,   validSet: HOLD_VALID,   noToastStatus: 'on hold'  },
      { inputId: RETURN_INPUT_ID, validSet: RETURN_VALID, noToastStatus: 'return'   },
    ].forEach(({ inputId, validSet, noToastStatus }) => {
      const input = document.getElementById(inputId);
      if (!input || listenedInputs.has(inputId)) return;
      listenedInputs.add(inputId);

      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        const id = (input.value || '').trim().toUpperCase();
        if (!ID_REGEX.test(id)) return;

        setTimeout(() => {
          const row    = findRowById(id);
          const status = row ? rowStatus(row) : 'Not Found';
          const stLow  = (status || '').toLowerCase();

          // Show toast unless this is the "silent" match for this field
          if (stLow !== noToastStatus) {
            const isInvalid = !validSet.has(stLow);
            showToast(id, status || 'Not Found', isInvalid);
          }

          refreshPanel(st);
        }, 300);
      });
    });
  }

  // ── SAVE / CLOSE RUN HANDLER ─────────────────────────────────────────────
  function onSaveClick(st) {
    // Read whatever is currently in each panel's DOM list
    const holdScanned   = panelScannedIds(HOLD_INPUT_ID);
    const returnScanned = panelScannedIds(RETURN_INPUT_ID);

    holdScanned.forEach(id => {
      if (!st.holdReceived.includes(id)) st.holdReceived.push(id);
    });
    returnScanned.forEach(id => {
      if (!st.returnReceived.includes(id)) st.returnReceived.push(id);
    });

    persistState(st);      // ← only write to localStorage here
    refreshBorders(st);
    refreshPanel(st);
  }

  function isSaveBtn(el) {
    const btn = el.closest('button');
    if (!btn) return false;
    // Matches "Close Run" (pt-btn-danger) or any button whose text is "SAVE"
    const text = btn.textContent.trim().toLowerCase();
    return (btn.classList.contains('pt-btn-danger') && text.includes('close'))
        || text === 'save';
  }

  // ── INIT ─────────────────────────────────────────────────────────────────
  let appState = null;

  function init() {
    injectStyle();

    const { holdExpected, returnExpected } = buildExpected();
    appState = initState(holdExpected, returnExpected);

    reconcileWithPageState(appState); // clean stale received IDs on load
    createPanel();
    refreshPanel(appState);
    refreshBorders(appState);
    attachScanListeners(appState);

    // Save / Close Run click
    document.addEventListener('click', e => {
      if (isSaveBtn(e.target)) {
        setTimeout(() => onSaveClick(appState), 150);
      }
    });

    // Retry attaching listeners after async drawer open
    [1500, 4000].forEach(ms => setTimeout(() => attachScanListeners(appState), ms));

    // Observe DOM changes → refresh panel + borders
    let debounce = null;
    new MutationObserver(mutations => {
      const skip = mutations.every(m =>
        [...m.addedNodes, ...m.removedNodes].every(n =>
          n.nodeType === Node.ELEMENT_NODE && (n.id === 'db-panel' || n.classList?.contains('db-toast'))
        )
      );
      if (skip) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        reconcileWithPageState(appState);
        refreshPanel(appState);
        refreshBorders(appState);
      }, 300);
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
