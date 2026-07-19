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
  const PARCEL_ROW_SEL  = '.flex.pt-list-item';  // Data rows only (header lacks 'flex')
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
    if (existing) {
      // If the cached expected sets are empty but a fresh page read finds real
      // candidates, the cache was almost certainly written while the DOM selectors
      // didn't match yet (or before the parcel list had finished loading) — rebuild
      // the expected sets from the current, correctly-parsed page instead of staying
      // stuck on a stale empty cache for up to 72h. holdReceived/returnReceived (any
      // real save progress) are left untouched either way.
      const cacheLooksStale =
        !existing.holdExpected.length && !existing.returnExpected.length &&
        (holdExpected.length || returnExpected.length);
      if (cacheLooksStale) {
        console.log('[DataBridge] Cached expected sets were empty, rebuilding from live page:',
          holdExpected.length, 'hold /', returnExpected.length, 'return');
        existing.holdExpected = holdExpected;
        existing.returnExpected = returnExpected;
        persistState(existing);
      }
      return existing;
    }
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
    // The ID is in the FIRST .w-1/6 column inside the row's .flex.flex-1 container
    const flexContainer = row.querySelector('.flex.flex-1');
    if (!flexContainer) return null;
    const cols = flexContainer.querySelectorAll(DATA_COL_SEL);
    // First column (index 0) is the ID column
    const idCol = cols[0];
    if (!idCol) return null;
    // The ID is the FIRST direct .flex-1 child of the column
    const idDiv = idCol.querySelector(':scope > .flex-1');
    return idDiv;
  }

  function rowId(row) {
    const el = rowIdEl(row);
    return el ? el.textContent.trim() : '';
  }

  function rowStatus(row) {
    // Status is in a .pt-label-btn inside the FIRST .w-1/6 column
    const flexContainer = row.querySelector('.flex.flex-1');
    if (!flexContainer) return null;
    const cols = flexContainer.querySelectorAll(DATA_COL_SEL);
    const idCol = cols[0];
    if (!idCol) return null;

    // Get all .pt-label-btn elements in the ID column
    const allBtns = idCol.querySelectorAll('.pt-label-btn');

    // Find the one that contains a status-like text (has letters, not just numbers)
    for (const btn of allBtns) {
      const text = btn.textContent.trim();
      // Skip if it's just a number (attempt count) or just "COD"
      if (/^\d+$/.test(text)) continue;  // Skip pure numbers
      if (text.toLowerCase() === 'cod') continue;  // Skip COD
      // This should be the status
      return text;
    }
    return null;
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
    const holdExpected = [], returnExpected = [], skipped = [];
    const rows = parcelRows();
    console.log('[DB] buildExpected → total rows found by parcelRows():', rows.length);

    rows.forEach((row, i) => {
      const id  = rowId(row);
      const st  = rowStatus(row) || '';
      const stL = st.toLowerCase();

      if (!ID_REGEX.test(id)) {
        skipped.push({ i, id: id || '(empty)', st, reason: 'ID_REGEX fail' });
        return;
      }
      if (HOLD_VALID.has(stL))        holdExpected.push(id);
      else if (RETURN_VALID.has(stL)) returnExpected.push(id);
      else                            skipped.push({ i, id, st, reason: 'status not in hold/return' });
    });

    console.group('[DB] buildExpected result');
    console.log('Hold expected   (%d):', holdExpected.length, holdExpected);
    console.log('Return expected (%d):', returnExpected.length, returnExpected);
    if (skipped.length)
      console.table(skipped);
    console.groupEnd();
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
    panel.querySelectorAll(SCANNED_ROW_SEL).forEach(row => {
      const d = row.querySelector('div');
      const t = d && d.textContent.trim();
      if (t && ID_REGEX.test(t)) ids.push(t);
    });
    return ids;
  }

  function findRowById(id) {
    const rows = parcelRows();
    // (findRowById logs suppressed to reduce noise)
    const found = rows.find(r => {
      const rid = rowId(r);
      const match = rid === id;

      return match;
    });

    return found;
  }

  // ── STYLES ──────────────────────────────────────────────────────────────
  function injectStyle() {
    if (document.getElementById('db-scan-style')) return;
    const s = document.createElement('style');
    s.id = 'db-scan-style';
    s.textContent = `
      /* Row borders - applied to the row's inner .p-4 container */
      .db-row-received, .db-row-pending {
        position: relative;
      }
      .db-row-received {
        border-left: 5px solid #22c55e !important;
        background: rgba(34,197,94,0.07) !important;
      }
      .db-row-pending {
        border-left: 5px solid #ef4444 !important;
        background: rgba(239,68,68,0.07) !important;
      }

      /* Tick mark */
      .db-tick {
        display: inline-flex; align-items: center; justify-content: center;
        background: #22c55e; color: #fff; border-radius: 4px;
        font-size: 10px; font-weight: 700; line-height: 1;
        padding: 2px 5px; margin-left: 6px; vertical-align: middle;
        white-space: nowrap; letter-spacing: .2px;
      }

      /* Row number badge - prominent identifier */
      .db-row-badge {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: #22c55e;
        color: #fff;
        border-radius: 8px;
        padding: 4px 8px;
        font-size: 12px;
        font-weight: 800;
        line-height: 1;
        white-space: nowrap;
        box-shadow: 0 2px 8px rgba(34,197,94,0.5);
        z-index: 100;
        border: 2px solid #fff;
      }
      .db-row-badge-pending {
        background: #ef4444;
        box-shadow: 0 2px 8px rgba(239,68,68,0.5);
      }
      .db-scan-num {
        font-size: 11px;
        opacity: 0.95;
      }
      .db-scan-icon {
        font-size: 14px;
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
        position: fixed; top: 0px; right: 375px; z-index: 2147483646;
        background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
        box-shadow: 0 4px 24px rgba(0,0,0,.13); width: 415px; max-height: 300px;
        font: 13px/1.5 -apple-system, Segoe UI, sans-serif; overflow: hidden;
        display: flex; flex-direction: column;
      }
      .db-hdr {
        background: #1e293b; color: #fff; padding: 7px 10px;
        display: flex; justify-content: space-between; align-items: center;
        cursor: move; user-select: none; font-weight: 600; font-size: 11px;
        flex-shrink: 0;
      }
      .db-hdr button {
        background: none; border: none; color: #fff; font-size: 18px;
        cursor: pointer; line-height: 1; padding: 0 2px;
      }
      /* Row layout: Run Summary (left) + Pending Scan (right) side-by-side instead
         of stacked. .db-body itself no longer scrolls — each .db-sec column scrolls
         independently, since the summary table (fixed row count) and the pending-ID
         list (can grow long) rarely need the same amount of vertical space. */
      .db-body {
        padding: 8px; flex: 1; min-height: 0; overflow: hidden;
        display: flex; flex-direction: row; gap: 10px;
      }
      .db-sec { flex: 1; min-width: 0; overflow-y: auto; }
      .db-vdivider { flex-shrink: 0; width: 1px; background: #e5e7eb; align-self: stretch; }
      .db-sec-title {
        font-weight: 700; font-size: 10px; text-transform: uppercase;
        letter-spacing: .5px; color: #64748b; margin-bottom: 8px;
      }
      .db-table { width: 100%; border-collapse: collapse; font-size: 10px; }
      .db-table th {
        text-align: left; color: #94a3b8; padding: 2px 3px; font-weight: 600;
        border-bottom: 1px solid #f1f5f9;
      }
      .db-table td   { padding: 3px 2px; vertical-align: middle; }
      .db-table .num { text-align: right; font-variant-numeric: tabular-nums; }
      .db-copy-btn {
        background: none; border: none; cursor: pointer; padding: 2px 4px;
        color: #94a3b8; font-size: 16px; line-height: 1; vertical-align: middle;
        opacity: 0.6; transition: opacity .15s;
      }
      .db-copy-btn:hover { opacity: 1; }
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
        font-weight: 600; font-size: 11px; display: flex; align-items: center;
        gap: 6px; margin-bottom: 4px;
      }
      .db-cnt {
        background: #f1f5f9; color: #475569; border-radius: 10px;
        padding: 0 7px; font-size: 11px; font-weight: 700;
      }
      .db-ids { display: flex; flex-wrap: wrap; gap: 4px; }
      .db-id {
        background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px;
        padding: 1px 4px; font: 10px/1.4 monospace; color: #334155;
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
        <div class="db-vdivider"></div>
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
      const amtStr = d.total ? d.total.toLocaleString() + ' ৳' : '—';
      rows += `<tr>
        <td><span class="db-dot" style="background:${c}"></span>${status}</td>
        <td class="num">${d.qty}</td>
        <td class="num">${amtStr}</td>
      </tr>`;
    });
    document.getElementById('db-summary').innerHTML = `
      <div class="db-sec-title">📊 Run Summary</div>
      <table class="db-table">
        <thead><tr><th>Status</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="2" class="db-tfoot">💰 Collected</td>
          <td class="db-tfoot num" style="white-space:nowrap">
            <b>${totalCollected ? totalCollected.toLocaleString() + ' ৳' : '—'}</b>
            ${totalCollected ? `<button class="db-copy-btn" data-copy="${totalCollected}" title="Copy amount">⎘</button>` : ''}
          </td>
        </tr></tfoot>
      </table>
    `;

    console.groupEnd(); // refreshBorders
    // Attach copy listeners on amount buttons
    document.getElementById('db-summary').querySelectorAll('.db-copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = btn.dataset.copy;
        if (!val) return;

        const showResult = (ok) => {
          const orig = btn.textContent;
          btn.textContent = ok ? '✓' : '✗';
          setTimeout(() => { btn.textContent = orig; }, 1200);
        };

        // navigator.clipboard.writeText() can silently reject from an injected
        // content-script panel (document focus / Permissions Policy quirks) — this
        // execCommand fallback works via direct DOM selection instead, which doesn't
        // depend on the async Clipboard API's stricter user-activation checks.
        function legacyCopy(text) {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          let ok = false;
          try { ok = document.execCommand('copy'); }
          catch (err) { console.error('[DataBridge] legacy copy failed:', err); }
          document.body.removeChild(ta);
          return ok;
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(val)
            .then(() => showResult(true))
            .catch((err) => {
              console.error('[DataBridge] clipboard.writeText failed, falling back:', err);
              showResult(legacyCopy(val));
            });
        } else {
          showResult(legacyCopy(val));
        }
      });
    });

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
    console.group('[DB] refreshBorders — expected:%d  received:%d', expected.size, received.size);
    console.log('holdReceived   :', st.holdReceived);
    console.log('returnReceived :', st.returnReceived);
    parcelRows().forEach((row, index) => {
      const id   = rowId(row);
      const idEl = rowIdEl(row);
      console.log('[DB] row', index, '|', id || '(no id)', '| expected:', expected.has(id), '| received:', received.has(id));

      // Apply to the inner .p-4 container — this is always present and
      // lets border + background render without fighting the outer row's CSS.
      // Fall back to the row itself if the inner container isn't found.
      const innerContainer = row.querySelector('[class*="p-4"][class*="flex-row"]')
                          || row.querySelector('.p-4');
      const targetEl = innerContainer || row;

      targetEl.classList.remove('db-row-received', 'db-row-pending');

      // Remove any previously injected identifiers
      if (idEl) idEl.querySelectorAll('.db-tick').forEach(e => e.remove());
      row.querySelectorAll('.db-row-badge').forEach(e => e.remove());

      if (!expected.has(id)) return;

      if (received.has(id)) {
        targetEl.classList.add('db-row-received');

        // 1. Tick in ID column
        if (idEl) {
          const tick = document.createElement('span');
          tick.className = 'db-tick';
          tick.textContent = '\u2713 SCANNED';
          idEl.appendChild(tick);
        }

        // 2. Prominent row index badge in first column (w-24 checkbox area)
        const checkboxCol = row.querySelector('.w-24');
        if (checkboxCol) {
          const badge = document.createElement('div');
          badge.className = 'db-row-badge';
          badge.innerHTML = `<span class="db-scan-num">#${index + 1}</span><span class="db-scan-icon">\u2713</span>`;
          checkboxCol.style.position = 'relative';
          checkboxCol.appendChild(badge);
        }
      } else {
        targetEl.classList.add('db-row-pending');

        // Show row number for pending items too
        const checkboxCol = row.querySelector('.w-24');
        if (checkboxCol) {
          const badge = document.createElement('div');
          badge.className = 'db-row-badge db-row-badge-pending';
          badge.innerHTML = `<span class="db-scan-num">#${index + 1}</span><span class="db-scan-icon">\u25cb</span>`;
          checkboxCol.style.position = 'relative';
          checkboxCol.appendChild(badge);
        }
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

    // Remove an ID ONLY when the page explicitly shows it with a WRONG status.
    // If the row is absent (undefined) — e.g. mid Hermes re-render — keep the
    // ID: removing it here would kill the green border every time Hermes
    // refreshes the DOM after processing a scan.
    st.holdReceived   = st.holdReceived.filter(id => {
      if (pageStatus[id] === undefined) return true; // row absent → keep
      return HOLD_VALID.has(pageStatus[id]);          // wrong status → remove
    });
    st.returnReceived = st.returnReceived.filter(id => {
      if (pageStatus[id] === undefined) return true;
      return RETURN_VALID.has(pageStatus[id]);
    });

    const changed =
      st.holdReceived.length   !== holdBefore ||
      st.returnReceived.length !== returnBefore;

    if (changed) persistState(st);
    return changed;
  }

  // ── SCAN INPUT HANDLER ───────────────────────────────────────────────────
  // Use capture-phase listener so we always fire before Hermes' own handlers
  // that might call stopPropagation(). Also survives React/Vue re-renders.
  const listenedInputs = new Set();
  function attachScanListeners(st) {
    [
      { inputId: HOLD_INPUT_ID,   validSet: HOLD_VALID,   noToastStatus: 'on hold'  },
      { inputId: RETURN_INPUT_ID, validSet: RETURN_VALID, noToastStatus: 'return'   },
    ].forEach(({ inputId, validSet, noToastStatus }) => {
      const input = document.getElementById(inputId);
      if (!input || listenedInputs.has(inputId)) return;
      listenedInputs.add(inputId);

      // Mark this input as monitored
      input.setAttribute('data-db-monitored', 'true');

      // Capture-phase listener — fires before Hermes bubble-phase handlers
      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        let raw = (input.value || '').trim().toUpperCase();
        // Strip pipe suffix (e.g. DB160726JFWRVN|120 → DB160726JFWRVN)
        const pipeIdx = raw.lastIndexOf('|');
        const id = pipeIdx !== -1 ? raw.substring(0, pipeIdx) : raw;
        console.log('[DB] SCAN in', inputId, '→ raw:', raw, '→ parsed ID:', id);
        if (!ID_REGEX.test(id)) {
          console.warn('[DB] ID rejected by regex:', id);
          return;
        }
        // Replace input value with clean ID so Hermes also receives the parsed ID
        input.value = id;

        setTimeout(() => {
          try {
            console.log('[DB] Looking for row ID:', id, '— rows available:', parcelRows().length);
            const row    = findRowById(id);
            const status = row ? rowStatus(row) : 'Not Found';
            const stLow  = (status || '').toLowerCase();
            console.log('[DB] Row found:', !!row, '| status:', status, '| noToastStatus:', noToastStatus);

            // Show toast unless this is the "silent" match for this field
            if (stLow !== noToastStatus) {
              const isInvalid = !validSet.has(stLow);
              console.log('[DB] → toast (invalid:', isInvalid, ')');
              showToast(id, status || 'Not Found', isInvalid);
            } else {
              console.log('[DB] → silent match, no toast');
            }

            // IMPORTANT: Add ID to received list immediately for visual feedback
            if (inputId === HOLD_INPUT_ID && !st.holdReceived.includes(id)) {
              st.holdReceived.push(id);
            } else if (inputId === RETURN_INPUT_ID && !st.returnReceived.includes(id)) {
              st.returnReceived.push(id);
            }

            refreshBorders(st);
            refreshPanel(st);
          } catch (err) {
            console.error('[DataBridge] Scan handler error:', err);
          }
        }, 300);
      }, true); // ← capture phase
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


  // ── MEMORY INTEGRATION ───────────────────────────────────────────────────
  // Reads IDs saved via the popup Memory tab for this run and auto-applies
  // them as received (hold or return) based on current page status.
  // This means parcels scanned in the save stage don't need re-scanning
  // when the agent reaches the close stage on the same run.
  function applyMemoryToState(st) {
    const memKey = `db-memory-${getRunId()}`;
    try {
      const raw = localStorage.getItem(memKey);
      if (!raw) return;
      const mem = JSON.parse(raw);
      const ids = mem.ids || [];
      if (!ids.length) return;

      let applied = 0;
      ids.forEach(id => {
        const row    = findRowById(id);
        const status = (row ? rowStatus(row) : '').toLowerCase();
        if (HOLD_VALID.has(status) && !st.holdReceived.includes(id)) {
          st.holdReceived.push(id);
          applied++;
        } else if (RETURN_VALID.has(status) && !st.returnReceived.includes(id)) {
          st.returnReceived.push(id);
          applied++;
        }
      });

      if (applied > 0) {
        console.log(`[DB] Memory: applied ${applied} ID(s) from memory for run ${getRunId()}`);
        persistState(st);
      }
    } catch (e) {
      console.warn('[DB] Memory load failed:', e);
    }
  }

  // ── INIT ─────────────────────────────────────────────────────────────────
  let appState = null;

  function init() {
    injectStyle();

    // ── PARCEL LIST SNAPSHOT (for debugging) ──
    const allRows = parcelRows();
    console.group('[DB] INIT — parcel list snapshot (%d rows)', allRows.length);
    const snapshot = allRows.map((row, i) => ({
      '#': i + 1,
      id:      rowId(row)     || '(none)',
      status:  rowStatus(row) || '(none)',
    }));
    console.table(snapshot);
    console.log('[DB] Run ID:', getRunId());
    console.log('[DB] Storage key:', STORAGE_KEY);
    console.groupEnd();
    // ────────────────────────────────────────────

    const { holdExpected, returnExpected } = buildExpected();
    appState = initState(holdExpected, returnExpected);
    console.log('[DB] State loaded from storage?', !!(loadState()));
    console.log('[DB] appState.holdExpected:', appState.holdExpected);
    console.log('[DB] appState.returnExpected:', appState.returnExpected);
    console.log('[DB] appState.holdReceived:', appState.holdReceived);
    console.log('[DB] appState.returnReceived:', appState.returnReceived);

    applyMemoryToState(appState); // auto-apply IDs saved in popup Memory tab
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
    [1500, 4000].forEach(ms => setTimeout(() => { listenedInputs.clear(); attachScanListeners(appState); }, ms));

    // Observe DOM changes → refresh panel + borders
    let debounce = null;
    new MutationObserver(mutations => {
      const skip = mutations.every(m => {
        // Any mutation whose target lives inside our own panel. This was the missing
        // case: refreshPanel() replaces #db-summary/#db-pending's innerHTML on every
        // scan/save/reconcile, and every one of those mutations has a TARGET inside
        // #db-panel even though the individual added/removed nodes below (a fresh
        // .db-sec-title, .db-table, .db-copy-btn, etc.) don't carry id="db-panel"
        // themselves. Without this check, each refresh re-triggered this same observer
        // ~100-300ms later, which refreshed again, forever — tearing down and rebuilding
        // every button/listener in the panel on a loop. That's why the copy button (and
        // pending-ID click-to-scroll) needed several clicks: some fraction of clicks
        // landed in the instant the button was mid-rebuild and had no listener yet.
        if (m.target && m.target.closest && m.target.closest('#db-panel')) return true;

        return [...m.addedNodes, ...m.removedNodes].every(n =>
          // Skip mutations caused by our own injections so we don't
          // trigger a reconcile loop every time refreshBorders runs.
          n.nodeType !== Node.ELEMENT_NODE ||
          n.id === 'db-panel' ||
          n.classList?.contains('db-toast') ||
          n.classList?.contains('db-row-badge') ||
          n.classList?.contains('db-tick')
        );
      });
      if (skip) return;

      // Check if any monitored input changed value (Hermes processed scan)
      mutations.forEach(m => {
        if (m.type === 'childList') {
          [...m.addedNodes].forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE && node.closest?.('[data-db-monitored]')) {
              // Input value changed - trigger border refresh
              clearTimeout(debounce);
              debounce = setTimeout(() => {
                reconcileWithPageState(appState);
                refreshBorders(appState);
                refreshPanel(appState);
              }, 100);
            }
          });
        }
      });

      clearTimeout(debounce);
      debounce = setTimeout(() => {
        reconcileWithPageState(appState);
        refreshPanel(appState);
        refreshBorders(appState);
      }, 300);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
