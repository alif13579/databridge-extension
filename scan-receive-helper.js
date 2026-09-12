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
//   7. CC crosscheck strip → today's Supabase CC requests (delivery_request /
//      hold_verified / return_verified) vs live run status: warnings + validated
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
  // Consignment IDs / statuses come from sheets + Firebase (shared, attacker-
  // reachable via a crafted barcode) and render into this page's DOM — escape.
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
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

  // Maps every raw Hermes status to exactly one of 3 buckets for the
  // "Copy for Sheet" export (see buildSheetBuckets() below). Deliberately
  // separate from HOLD_VALID/RETURN_VALID above — those decide which
  // physical scan field an id auto-fills into, a different concern with a
  // different grouping (e.g. exchange/partial delivery/paid return route to
  // the Return scan field there, but count as Delivered here).
  const SHEET_STATUS_BUCKET = {
    'delivered':          'delivered',
    'partial delivery':   'delivered',
    'partial':            'delivered',
    'exchange':           'delivered',
    'paid return':        'delivered',
    'return':              'return',
    'return request':      'return',
    'return requested':    'return',
    'reattempt request':   'return',
    'reattempt requested': 'return',
    'on hold':              'hold',
  };

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

  function initState(holdExpected, returnExpected, totalRowsFound) {
    const existing = loadState();
    if (existing) {
      // A fresh read that actually found parcel rows is always authoritative —
      // sync the cached expected sets to it on EVERY visit, not just when the
      // old cache happened to be empty. Otherwise hold/return IDs that changed
      // since the last visit (resolved, newly placed on hold, reassigned, etc.)
      // stay stuck on the first-visit snapshot for up to 72h — the run's actual
      // current hold/return list silently drifts from what the panel/borders
      // show. holdReceived/returnReceived (real scan/save progress) are left
      // untouched here; reconcileWithPageState() prunes those independently
      // based on each ID's live status.
      //
      // Only skip the sync when the fresh read found ZERO parcel rows at all —
      // that means Hermes' Vue SPA hadn't rendered the list yet when init() ran,
      // so the read itself isn't trustworthy (the [1500ms/3500ms] retries and
      // the MutationObserver rebuild the sets once rows do appear).
      if (totalRowsFound > 0) {
        console.log('[DataBridge] Syncing expected sets from live page:',
          holdExpected.length, 'hold /', returnExpected.length, 'return',
          '(was', existing.holdExpected.length, '/', existing.returnExpected.length, ')');
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

  function cleanConsignment(text) {
    // Hermes ID column can carry extra labels ("Consign ID:", Age/Attempt
    // badges) depending on page/markup — always extract the pure 14-char
    // ID so Supabase `consignment=in.(...)` matches the column exactly.
    // A dirty string passes ID_REGEX.test but never matches the DB.
    const m = String(text || '').toUpperCase().match(ID_REGEX);
    return m ? m[0] : '';
  }

  function rowId(row) {
    const el = rowIdEl(row);
    if (!el) return '';
    // Strip our own injected nodes (e.g. the "✓ SCANNED" .db-tick appended
    // into this same div on receive) — otherwise textContent comes back as
    // "ABC123✓ SCANNED" and leaks into Copy-for-Sheet TSV, expected-set
    // builds, and findRowById() matching. Clone first so the live DOM
    // (tick visibility) is untouched.
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.db-tick').forEach(n => n.remove());
    return cleanConsignment(clone.textContent);
  }

  // Hermes parcel statuses seen on run-routes (lowercase). Used to pick the
  // real status badge out of Age/Attempt/COD chips that share .pt-label-btn.
  // (XCHECK_RESOLVED values are already covered by the maps/sets below.)
  const KNOWN_RUN_STATUSES = new Set([
    ...Object.keys(STATUS_COLOR),
    ...Object.keys(SHEET_STATUS_BUCKET),
    ...HOLD_VALID, ...RETURN_VALID,
    'assigned', 'assigned for delivery', 'in transit', 'intransit',
    'on the way to last mile hub', 'received at last mile hub',
    'pending', 'on hold',
    'return', 'return requested', 'reattempt request',
    'delivered', 'partial delivery', 'paid return', 'exchange',
    'cancelled', 'canceled', 'lost',
  ]);

  function rowStatus(row) {
    // Status is in a .pt-label-btn inside the FIRST .w-1/6 column
    const flexContainer = row.querySelector('.flex.flex-1');
    if (!flexContainer) return null;
    const cols = flexContainer.querySelectorAll(DATA_COL_SEL);
    const idCol = cols[0];
    if (!idCol) return null;

    // Get all .pt-label-btn elements in the ID column
    const allBtns = [...idCol.querySelectorAll('.pt-label-btn')];
    const candidates = [];
    for (const btn of allBtns) {
      const text = btn.textContent.trim();
      if (!text) continue;
      // Skip if it's just a number (attempt count) or just "COD"
      if (/^\d+$/.test(text)) continue;  // Skip pure numbers
      if (text.toLowerCase() === 'cod') continue;  // Skip COD
      // Skip Age:/Attempt: meta chips ("Age: 3 day", "Attempt: 2") — these
      // share .pt-label-btn but are never the parcel status.
      if (text.includes(':')) continue;
      const low = text.toLowerCase();
      if (/^(age|attempt)\b/.test(low)) continue;
      candidates.push(text);
    }
    if (!candidates.length) return null;
    // Prefer a known parcel status; fall back to the first surviving chip
    // so unknown future statuses still sync instead of vanishing.
    return candidates.find(t => KNOWN_RUN_STATUSES.has(t.toLowerCase())) || candidates[0];
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

  // Groups every row's ID into the 3 SHEET_STATUS_BUCKET buckets for the
  // "Copy for Sheet" export. Rows whose status doesn't match any bucket are
  // counted in `unmatched` rather than silently dropped, so the caller can
  // tell the user something was skipped instead of losing IDs quietly.
  function buildSheetBuckets() {
    const buckets = { delivered: [], hold: [], return: [] };
    let unmatched = 0;
    parcelRows().forEach(row => {
      const id = rowId(row);
      if (!id) return;
      const bucket = SHEET_STATUS_BUCKET[(rowStatus(row) || '').trim().toLowerCase()];
      if (bucket) buckets[bucket].push(id);
      else unmatched++;
    });
    return { buckets, unmatched };
  }

  // Tab-separated, column order Delivered / Hold / Return (matches the A/B/C
  // sheet layout) — shorter columns pad with empty cells so every row has
  // exactly 3 fields and pastes as a clean rectangular block.
  function buildSheetTsv({ delivered, hold, return: ret }) {
    const maxLen = Math.max(delivered.length, hold.length, ret.length);
    const rows = [];
    for (let i = 0; i < maxLen; i++) {
      rows.push([delivered[i] || '', hold[i] || '', ret[i] || ''].join('\t'));
    }
    return rows.join('\n');
  }

  // navigator.clipboard.writeText() can silently reject from an injected
  // content-script panel (document focus / Permissions Policy quirks) — the
  // execCommand fallback works via direct DOM selection instead, which
  // doesn't depend on the async Clipboard API's stricter user-activation
  // checks. Shared by the Run Summary amount-copy button and the Copy for
  // Sheet header button.
  function copyToClipboard(text) {
    function legacyCopy() {
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
      return navigator.clipboard.writeText(text)
        .then(() => true)
        .catch((err) => {
          console.error('[DataBridge] clipboard.writeText failed, falling back:', err);
          return legacyCopy();
        });
    }
    return Promise.resolve(legacyCopy());
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
      /* CC validation sign (sits next to the SCANNED tick) */
      .db-xbadge { margin-left: 4px; cursor: help; }
      .db-xbadge-warn { background: #dc2626; }

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
        min-width: 320px; min-height: 160px; max-width: 700px;
        font: 13px/1.5 -apple-system, Segoe UI, sans-serif; overflow: hidden;
        display: flex; flex-direction: column;
      }
      /* Bottom-right drag-to-resize grip. max-height stays at the CSS default
         (300px, shrink-to-content) until the user actually drags this —
         createPanel()'s resize handler lifts it to 85vh at that point, so a
         panel nobody resizes keeps today's look unchanged. */
      .db-resize-handle {
        position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
        cursor: nwse-resize; border-bottom-right-radius: 12px;
        background: repeating-linear-gradient(135deg, #cbd5e1 0, #cbd5e1 1.5px, transparent 1.5px, transparent 4px);
      }
      .db-resize-handle:hover { background-color: rgba(59,130,246,.08); }
      .db-hdr {
        background: #1e293b; color: #fff; padding: 7px 10px;
        display: flex; justify-content: space-between; align-items: center;
        cursor: move; user-select: none; font-weight: 600; font-size: 11px;
        flex-shrink: 0;
      }
      .db-hdr-actions { display: flex; gap: 2px; align-items: center; }
      .db-hdr button {
        background: none; border: none; color: #fff; font-size: 18px;
        cursor: pointer; line-height: 1; padding: 0 2px;
      }
      /* Save-to-Memory popover — toggled by the 🧠 button in .db-hdr. Sits between
         the header and .db-body as a normal (not absolutely-positioned) flow
         element so it can't get clipped by #db-panel's overflow:hidden. */
      .db-memory-popover {
        padding: 8px 10px; background: #f8fafc; border-bottom: 1px solid #e2e8f0;
        display: flex; flex-direction: column; gap: 6px; flex-shrink: 0;
      }
      .db-memory-popover.hidden { display: none; }
      .db-memory-popover input {
        padding: 5px 7px; font-size: 11px; border-radius: 5px;
        border: 1px solid #cbd5e1; background: #fff; color: #1e293b;
      }
      .db-memory-popover input:focus { outline: none; border-color: #3b82f6; }
      .db-memory-popover button {
        padding: 6px 8px; background: #3b82f6; border: none; border-radius: 5px;
        color: #fff; font-size: 11px; font-weight: 700; cursor: pointer;
      }
      .db-memory-popover button:hover { background: #2563eb; }
      .db-memory-list {
        display: flex; flex-direction: column; gap: 3px; max-height: 220px; overflow-y: auto;
      }
      .db-memory-list .db-id {
        cursor: default; display: flex; align-items: center; justify-content: space-between; gap: 4px;
      }
      .db-memory-list .db-id:hover {
        background: #f8fafc !important; border-color: #e2e8f0 !important; color: #334155 !important;
      }
      .db-mem-del {
        cursor: pointer; opacity: 0.5; font-size: 10px; line-height: 1; color: #ef4444;
      }
      .db-mem-del:hover { opacity: 1; }
      .db-mem-clear-all { cursor: pointer; opacity: 0.6; color: #ef4444; }
      .db-mem-clear-all:hover { opacity: 1; }
      .db-mem-clear-all.hidden { display: none; }
      .db-memory-cols { display: flex; gap: 8px; }
      .db-memory-col { flex: 1; min-width: 0; }
      .db-memory-col-hdr {
        display: flex; justify-content: space-between; align-items: center;
        font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase;
        letter-spacing: .5px; margin-bottom: 5px;
      }
      .db-field-rescan { cursor: pointer; opacity: 0.6; }
      .db-field-rescan:hover { opacity: 1; }
      .db-field-list { display: flex; flex-direction: column; gap: 3px; max-height: 220px; overflow-y: auto; }
      .db-field-row {
        padding: 4px 6px; font-size: 10px; background: #fff; border: 1px solid #e2e8f0;
        border-radius: 4px; cursor: pointer; color: #334155;
      }
      .db-field-row:hover { border-color: #93c5fd; }
      .db-field-row.selected { background: #dbeafe; border-color: #3b82f6; color: #1e40af; font-weight: 600; }
      .db-field-empty { font-size: 10px; color: #94a3b8; padding: 4px; }
      /* Applied directly to the real page <input> the user picks as auto-fill
         target (not scoped under #db-panel — the target lives on the host page). */
      .db-field-glow {
        outline: 3px solid #f59e0b !important;
        outline-offset: 1px !important;
        box-shadow: 0 0 0 4px rgba(245, 158, 11, .3) !important;
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
      .db-xc-sumrow { cursor: pointer; }
      .db-xc-sumrow:hover td { background: #f1f5f9; }
      .db-xc-sumrow.on td { background: #e0f2fe; font-weight: 700; }
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
      .db-more {
        font-size: 11px; color: #94a3b8; padding: 2px 4px; align-self: center;
        cursor: pointer; text-decoration: underline; text-decoration-style: dotted;
      }
      .db-more:hover { color: #64748b; }
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

      /* CC crosscheck strip (full-width, under header) */
      #db-xcheck-strip { padding: 0 10px; }
      #db-xcheck-strip:empty { padding: 0; }
      .db-xc-bar {
        display: flex; align-items: center; gap: 6px; margin: 6px 0 0;
        padding: 5px 8px; border-radius: 6px; font-size: 11px; font-weight: 700;
        cursor: pointer; user-select: none;
      }
      .db-xc-bar-warn { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; }
      .db-xc-bar-ok   { background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d; }
      .db-xc-bar-idle { background: #f8fafc; border: 1px solid #e2e8f0; color: #94a3b8; font-weight: 400; cursor: default; }
      .db-xc-refresh { margin-left: auto; cursor: pointer; opacity: .7; }
      .db-xc-refresh:hover { opacity: 1; }
      .db-xc-list { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 2px 2px; max-height: 110px; overflow-y: auto; }
      .db-xc-item {
        display: inline-flex; align-items: center; gap: 4px;
        background: #fff; border: 1px solid #e2e8f0; border-radius: 4px;
        padding: 1px 4px; font: 10px/1.5 monospace; color: #334155; cursor: pointer;
      }
      .db-xc-item:hover { background: #e0f2fe !important; border-color: #7dd3fc !important; }
      .db-xc-item .db-xc-st { font-family: -apple-system, Segoe UI, sans-serif; color: #64748b; }
      .db-xc-item-warn { border-color: #fecaca; }
      .db-xc-item-ok { border-color: #bbf7d0; }

      /* Confirmed one-time-copy list */
      #db-confirmed-strip { padding: 0 10px; }
      #db-confirmed-strip:empty { padding: 0; }
      .db-cf-item {
        display: inline-flex; align-items: center; gap: 6px;
        background: #fff; border: 1px solid #bbf7d0; border-radius: 4px;
        padding: 1px 4px; font: 10px/1.5 monospace; color: #334155;
      }
      .db-cf-agent { font-family: -apple-system, Segoe UI, sans-serif; color: #15803d; font-weight: 700; }
      .db-cf-copy {
        background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 4px;
        cursor: pointer; font-size: 11px; padding: 0 5px; line-height: 1.5;
      }
      .db-cf-copy:hover { background: #dcfce7; }

      /* CC report modal (lives inside #db-panel so the observer skips it) */
      #db-report-backdrop {
        position: fixed; inset: 0; z-index: 2147483646;
        background: rgba(15,23,42,.45); display: flex;
        align-items: center; justify-content: center;
      }
      #db-report-modal {
        background: #fff; border-radius: 10px; width: min(560px, 92vw);
        max-height: 84vh; display: flex; flex-direction: column;
        box-shadow: 0 10px 40px rgba(0,0,0,.35); font-size: 12px; color: #1e293b;
      }
      .db-rp-hdr {
        display: flex; align-items: center; padding: 10px 12px;
        font-weight: 800; font-size: 13px; border-bottom: 1px solid #e2e8f0;
      }
      .db-rp-close { margin-left: auto; cursor: pointer; opacity: .6; padding: 2px 6px; }
      .db-rp-close:hover { opacity: 1; }
      .db-rp-sub { padding: 6px 12px; color: #64748b; font-size: 11px; display: flex; gap: 8px; align-items: center; }
      .db-rp-chips { display: flex; gap: 6px; padding: 4px 12px 8px; flex-wrap: wrap; }
      .db-rp-chip {
        border: 1px solid #e2e8f0; background: #f8fafc; border-radius: 12px;
        padding: 2px 10px; font-size: 11px; font-weight: 700; cursor: pointer; color: #475569;
      }
      .db-rp-chip.on { background: #1e293b; color: #fff; border-color: #1e293b; }
      .db-rp-table { overflow-y: auto; padding: 0 12px; flex: 1; min-height: 60px; }
      .db-rp-row {
        display: flex; gap: 8px; align-items: baseline; padding: 6px 0;
        border-top: 1px solid #f1f5f9; cursor: pointer;
      }
      .db-rp-row:hover { background: #f8fafc; }
      .db-rp-id { font-family: monospace; font-size: 11px; white-space: nowrap; }
      .db-rp-st { color: #64748b; font-size: 11px; white-space: nowrap; margin-left: auto; text-align: right; }
      .db-rp-remark { color: #334155; font-size: 11px; }
      .db-rp-note { color: #94a3b8; font-size: 10px; }
      .db-rp-badge {
        font-size: 10px; font-weight: 800; border-radius: 4px; padding: 1px 6px; white-space: nowrap;
      }
      .db-rp-badge-warn { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
      .db-rp-badge-ok { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
      .db-rp-badge-mute { background: #f8fafc; color: #94a3b8; border: 1px solid #e2e8f0; }
      .db-rp-day { font-size: 10px; color: #94a3b8; white-space: nowrap; }
      .db-rp-ftr { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #e2e8f0; flex-wrap: wrap; }
      .db-rp-btn {
        border: 1px solid #cbd5e1; background: #f8fafc; border-radius: 6px;
        padding: 5px 10px; font-size: 11px; font-weight: 700; cursor: pointer; color: #334155;
      }
      .db-rp-btn:hover { background: #e2e8f0; }
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
      <div class="db-toast-id">${escapeHtml(id)}</div>
      <div class="db-toast-status" style="color:${color}">● ${escapeHtml(status) || 'Unknown'}</div>
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
  // CC report strips (xcheck + confirmed) live behind a header toggle button,
  // Memory-popover style — click to show/hide. Default HIDDEN so the tall
  // report bars don't push Run Summary / Pending out of the panel; the
  // toggle itself shows the count (🚫N / ✅ / 📋). Choice persists across runs.
  let xcheckOpen = false;
  try { xcheckOpen = localStorage.getItem('db-xcheck-open') === '1'; } catch (_) {}
  let selectedFieldEl = null; // manually-picked auto-fill target (see detectPageInputs/selectField)

  /** Reads the saved panel position for the current run URL from localStorage
   *  and applies it to the panel element, clamping to the visible viewport so
   *  the panel can't end up off-screen if the window was resized since last use.
   *  Falls back to the CSS default (top:0 / right:375px) when nothing is saved. */
  function applyPanelPosition(panelEl) {
    try {
      const raw = localStorage.getItem(`db-panel-pos-${getRunId()}`);
      if (!raw) return;
      const { left, top } = JSON.parse(raw);
      if (!left || !top) return;

      // Clamp so the panel stays inside the viewport
      const panelW = panelEl.offsetWidth  || 340;
      const panelH = panelEl.offsetHeight || 200;
      const maxLeft = Math.max(0, window.innerWidth  - panelW);
      const maxTop  = Math.max(0, window.innerHeight - panelH);

      const clampedLeft = Math.min(Math.max(0, parseInt(left, 10)),  maxLeft);
      const clampedTop  = Math.min(Math.max(0, parseInt(top,  10)),  maxTop);

      panelEl.style.left  = clampedLeft + 'px';
      panelEl.style.top   = clampedTop  + 'px';
      panelEl.style.right = 'auto'; // override the CSS default right:375px
    } catch (_) {}
  }

  // CC report visibility — header toggle (Memory-style). Both strips hide
  // together; memory popover open → also hidden (it needs the space).
  function applyXcheckVisibility() {
    let memOpen = false;
    try {
      const p = document.getElementById('db-memory-popover');
      memOpen = !!(p && !p.classList.contains('hidden'));
    } catch (_) {}
    const show = xcheckOpen && !memOpen;
    ['db-xcheck-strip', 'db-confirmed-strip'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? '' : 'none';
    });
    // Exclusive views: validation strip open → whole Run Summary + Pending
    // body hides, so validation and run summary never show together.
    // (Memory popover controls #db-summary itself; minimized wins overall.)
    try {
      const body = document.getElementById('db-body');
      if (body && typeof minimized !== 'undefined') body.style.display = (!minimized && !show) ? '' : 'none';
    } catch (_) {}
  }

  // Header toggle badge — sobsomoy graph-chart icon (📈/📉): undelivered
  // thakle 📉+count (down trend = attention), nahole 📈. Exact count
  // title tooltip + expanded strip-e thake.
  function paintXcheckToggle() {
    const b = document.getElementById('db-xcheck-toggle');
    if (!b) return;
    const dr = (xcheck.drUndelivered || []).length;
    const v = (xcheck.validated || []).length;
    if (xcheck.status !== 'done' || (!dr && !v)) b.textContent = '📈';
    else if (dr > 0) b.textContent = `📉${dr > 9 ? '9+' : dr}`;
    else b.textContent = '📈';
    b.title = `Validation (${dr ? dr + ' undelivered' : v ? v + ' validated' : 'no activity'}) — click to switch views`;
  }

  function createPanel() {
    panel = document.createElement('div');
    panel.id = 'db-panel';
    panel.innerHTML = `
      <div class="db-hdr">
        <span>📦 DataBridge Reconcile</span>
        <div class="db-hdr-actions">
          <button id="db-sheet-copy-btn" title="Copy Delivered/Hold/Return IDs for the sheet">📋</button>
          <button id="db-xcheck-toggle" title="Validation / Run Summary — click to switch views">📈</button>
          <button id="db-report-btn" title="CC Validation Report">📊</button>
          <button id="db-memory-toggle" title="Save to memory">🧠</button>
          <button id="db-min">−</button>
        </div>
      </div>
      <div class="db-memory-popover hidden" id="db-memory-popover">
        <input id="db-memory-save-input" type="text" placeholder="Scan, type or paste (1 per line) + Enter">
        <div class="db-memory-cols">
          <div class="db-memory-col">
            <div class="db-memory-col-hdr">Saved IDs <span class="db-mem-clear-all hidden" id="db-mem-clear-all" title="Clear all IDs">Clear all</span></div>
            <div class="db-memory-list" id="db-memory-list"></div>
          </div>
          <div class="db-memory-col">
            <div class="db-memory-col-hdr">🎯 Which field it goes to <span class="db-field-rescan" id="db-field-rescan" title="Scan the page again">🔄</span></div>
            <div class="db-field-list" id="db-field-list"></div>
          </div>
        </div>
        <button id="db-memory-fill-btn" style="
          width:100%;padding:6px 0;background:#1e3a5f;border:1px solid #3b82f6;
          border-radius:5px;color:#7ab3e0;font-size:11px;font-weight:700;cursor:pointer;display:none">
          🧠 Auto-fill from Memory
        </button>
      </div>
      <div id="db-xcheck-strip"></div>
      <div id="db-confirmed-strip"></div>
      <div class="db-body" id="db-body">
        <div class="db-sec" id="db-summary"></div>
        <div class="db-vdivider"></div>
        <div class="db-sec" id="db-pending"></div>
      </div>
      <div class="db-resize-handle" title="Drag to resize"></div>
    `;
    document.body.appendChild(panel);
    applyPanelPosition(panel);

    document.getElementById('db-min').addEventListener('click', () => {
      minimized = !minimized;
      // Exclusive views: expanding restores the body only when the
      // validation strip is not open (else both would show together).
      let memOpenNow = false;
      try {
        const p = document.getElementById('db-memory-popover');
        memOpenNow = !!(p && !p.classList.contains('hidden'));
      } catch (_) {}
      document.getElementById('db-body').style.display =
        (!minimized && !(xcheckOpen && !memOpenNow)) ? '' : 'none';
      document.getElementById('db-min').textContent = minimized ? '+' : '−';

      // Bug: the memory popover is a sibling of #db-body, not inside it, so
      // hiding #db-body alone left it fully visible (input + both columns +
      // Auto-fill button) when minimizing while it was open — the panel
      // never actually collapsed to just the header. Force it closed here,
      // the same way the 🧠 toggle's closing branch does (restore Run
      // Summary + divider too, since opening the popover hides those).
      // It stays closed on restore — reopen via 🧠 if wanted.
      if (minimized) {
        const memPop = document.getElementById('db-memory-popover');
        if (memPop && !memPop.classList.contains('hidden')) {
          memPop.classList.add('hidden');
          document.getElementById('db-summary').style.display = '';
          applyXcheckVisibility();
          const vdiv = document.querySelector('.db-vdivider');
          if (vdiv) vdiv.style.display = '';
        }
      }

      // A manually-resized height (and/or width, from the resize grip) would
      // otherwise leave the collapsed header at an enlarged size — db-body is
      // hidden but the panel's own dimensions aren't — so this wasn't a true
      // "minimize" if the panel had ever been dragged wider/taller. Stash
      // both and collapse to content/default, then restore both on expand.
      // min-height is separate from height and needed its own override: the
      // base CSS's unconditional min-height:160px (line 425) still clamps
      // height:auto up to 160px regardless, leaving blank panel background
      // below the collapsed header — the "white layer" that stayed visible.
      const resizeHandle = panel.querySelector('.db-resize-handle');
      if (minimized) {
        panel.dataset.expandedHeight = panel.style.height || '';
        panel.dataset.expandedWidth  = panel.style.width  || '';
        panel.style.height = 'auto';
        panel.style.width  = '';
        panel.style.minHeight = '0';
        if (resizeHandle) resizeHandle.style.display = 'none';
      } else {
        panel.style.height = panel.dataset.expandedHeight || '';
        panel.style.width  = panel.dataset.expandedWidth  || '';
        panel.style.minHeight = '';
        if (resizeHandle) resizeHandle.style.display = '';
      }
    });

    // Save-to-Memory — 🧠 icon in the header toggles a popover (scan/type/paste
    // input, saved-IDs column, target-field column, Auto-fill button) so an
    // agent can manage memory and pick a fill target straight from this page
    // instead of needing the extension popup. Same chrome.storage.local
    // key/shape applyMemoryToState()/fillFromMemory() below already use, so
    // whatever gets saved here is immediately visible/usable in Auto-fill too.
    // Opening the popover hides Run Summary (frees up vertical space for the
    // two columns); closing it restores Run Summary.
    const memToggle = document.getElementById('db-memory-toggle');
    const memPopover = document.getElementById('db-memory-popover');
    const memInput   = document.getElementById('db-memory-save-input');
    if (memToggle) memToggle.addEventListener('click', e => {
      e.stopPropagation(); // don't let the header's drag handler below see this click
      const opening = memPopover.classList.contains('hidden');
      memPopover.classList.toggle('hidden');
      document.getElementById('db-summary').style.display = opening ? 'none' : '';
      applyXcheckVisibility();
      const vdiv = document.querySelector('.db-vdivider');
      if (vdiv) vdiv.style.display = opening ? 'none' : '';
      if (opening) { memInput.focus(); renderFieldList(); }
    });
    const trySave = () => { saveIdToMemory(memInput.value); memInput.value = ''; memInput.focus(); };
    if (memInput) memInput.addEventListener('keydown', e => { if (e.key === 'Enter') trySave(); });

    // Multi-ID paste — if the clipboard has 2+ non-empty lines, treat each line as
    // its own ID (same trim/pipe-strip/ID_REGEX cleanup as a single scan, via
    // saveIdToMemory) instead of dumping the whole blob into the single-line input.
    // A single-line paste falls through to normal input behavior (still needs Enter/Save).
    if (memInput) memInput.addEventListener('paste', async e => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      const lines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) return;
      e.preventDefault();
      let saved = 0, skipped = 0;
      for (const line of lines) {
        const status = await saveIdToMemory(line, { silent: true });
        if (status === 'saved') saved++;
        else if (status !== 'empty') skipped++;
      }
      memInput.value = '';
      memInput.focus();
      showToast('Memory', `${saved} saved${skipped ? `, ${skipped} skipped` : ''}`, skipped > 0 && saved === 0);
      refreshPanel(appState);
    });

    // Auto-fill + target-field rescan — static now (live inside the memory
    // popover instead of being recreated in #db-pending every refreshPanel
    // call), so listeners are attached once here rather than re-attached
    // on every render.
    const fillBtn = document.getElementById('db-memory-fill-btn');
    if (fillBtn) fillBtn.addEventListener('click', () => fillFromMemory());
    const rescanBtn = document.getElementById('db-field-rescan');
    if (rescanBtn) rescanBtn.addEventListener('click', e => { e.stopPropagation(); renderFieldList(); });
    const clearAllBtn = document.getElementById('db-mem-clear-all');
    if (clearAllBtn) clearAllBtn.addEventListener('click', e => { e.stopPropagation(); clearAllMemory(); });

    // Copy for Sheet — header icon, left of 🧠. Builds the 3 status buckets
    // fresh from the current DOM on click (not cached), so it always
    // reflects whatever's on the page right now.
    const sheetCopyBtn = document.getElementById('db-sheet-copy-btn');
    if (sheetCopyBtn) sheetCopyBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const { buckets, unmatched } = buildSheetBuckets();
      const tsv = buildSheetTsv(buckets);
      const ok = await copyToClipboard(tsv);
      const orig = sheetCopyBtn.textContent;
      sheetCopyBtn.textContent = ok ? '✓' : '✗';
      setTimeout(() => { sheetCopyBtn.textContent = orig; }, 1200);
      if (ok && unmatched > 0) {
        showToast('Copy for Sheet', `Copied — ${unmatched} ID(s) had an unrecognized status and were skipped`, true);
      }
    });

    // CC Validation Report — header 📊 button opens the report modal.
    const reportBtn = document.getElementById('db-report-btn');
    if (reportBtn) reportBtn.addEventListener('click', e => { e.stopPropagation(); openReport(); });

    // CC report strips toggle — exclusive views: strip open hides the
    // Run Summary + Pending body so validation and summary never show
    // together; closing the strip brings the body back.
    const xcToggle = document.getElementById('db-xcheck-toggle');
    if (xcToggle) xcToggle.addEventListener('click', e => {
      e.stopPropagation();
      xcheckOpen = !xcheckOpen;
      try { localStorage.setItem('db-xcheck-open', xcheckOpen ? '1' : '0'); } catch (_) {}
      applyXcheckVisibility();
    });
    applyXcheckVisibility();
    paintXcheckToggle();

    // Draggable — position is saved to localStorage per run URL on mouseup
    // so the panel remembers where it was left the next time the same run
    // is opened. Key: db-panel-pos-{runId}. Restored in applyPanelPosition()
    // (called just above). Viewport-clamped on restore to handle window resizes.
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
      document.addEventListener('mouseup', () => {
        document.removeEventListener('mousemove', move);
        // Save final position for this run URL
        try {
          localStorage.setItem(
            `db-panel-pos-${getRunId()}`,
            JSON.stringify({ left: panel.style.left, top: panel.style.top })
          );
        } catch (_) {}
      }, { once: true });
    });

    // Resizable — bottom-right grip drag adjusts width + height together.
    // Lifts the CSS max-height cap (300px, meant for the default
    // shrink-to-content look) to 85vh the first time it's used, so a
    // deliberately-enlarged panel isn't silently clamped back down.
    const resizeHandle = panel.querySelector('.db-resize-handle');
    const MIN_W = 320, MIN_H = 160, MAX_W = 700;
    resizeHandle.addEventListener('mousedown', e => {
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const startW = panel.offsetWidth, startH = panel.offsetHeight;
      panel.style.maxHeight = '85vh';
      const resize = ev => {
        panel.style.width  = Math.min(MAX_W, Math.max(MIN_W, startW + ev.clientX - startX)) + 'px';
        panel.style.height = Math.max(MIN_H, startH + ev.clientY - startY) + 'px';
      };
      document.addEventListener('mousemove', resize);
      document.addEventListener('mouseup', () => document.removeEventListener('mousemove', resize), { once: true });
    });
  }

  /** Parses/validates raw scanner or typed input (same cleanup as the Hermes
   *  scan-input listener below: strip pipe suffix, uppercase, ID_REGEX check),
   *  then adds it to this run's memory in chrome.storage.local.
   *  opts.silent suppresses the per-call toast + refreshPanel (used for bulk
   *  paste, where the caller shows one summary toast and refreshes once after
   *  the whole batch). Returns 'saved' | 'duplicate' | 'invalid' | 'empty' | 'error'. */
  async function saveIdToMemory(raw, opts = {}) {
    const silent = !!opts.silent;
    const trimmed = (raw || '').trim().toUpperCase();
    if (!trimmed) return 'empty';
    const pipeIdx = trimmed.lastIndexOf('|');
    const id = pipeIdx !== -1 ? trimmed.substring(0, pipeIdx) : trimmed;
    if (!ID_REGEX.test(id)) {
      if (!silent) showToast('Memory', `Invalid ID: ${id}`, true);
      return 'invalid';
    }

    const memKey = `db-memory-${getRunId()}`;
    try {
      const result = await chrome.storage.local.get([memKey]);
      const mem = result[memKey] || { runId: getRunId(), ids: [], savedAt: null };
      if (mem.ids.includes(id)) {
        if (!silent) showToast('Memory', `${id} already saved`, false);
        return 'duplicate';
      }
      mem.ids.push(id);
      mem.savedAt = Date.now();
      await chrome.storage.local.set({ [memKey]: mem });
      if (!silent) {
        showToast('Memory', `Saved ${id} (${mem.ids.length} total)`, false);
        refreshPanel(appState); // updates the Auto-fill button's count immediately
      }
      return 'saved';
    } catch (e) {
      console.warn('[DB] saveIdToMemory failed:', e);
      if (!silent) showToast('Memory', 'Save failed — see console', true);
      return 'error';
    }
  }

  /** Renders the list of IDs saved to this run's memory inside the popover,
   *  most-recently-added first. mem.ids is stored oldest→newest (push-only);
   *  reversed only for display, so storage order stays untouched for
   *  fillFromMemory() etc. */
  function renderMemoryList(ids) {
    const listEl = document.getElementById('db-memory-list');
    if (!listEl) return;
    listEl.innerHTML = (ids || []).length
      ? [...ids].reverse().map(id =>
          `<span class="db-id">${escapeHtml(id)}<span class="db-mem-del" data-remove-id="${escapeHtml(id)}" title="Remove from memory">🗑</span></span>`
        ).join('')
      : '';
    listEl.querySelectorAll('[data-remove-id]').forEach(el => {
      el.addEventListener('click', () => removeIdFromMemory(el.dataset.removeId));
    });
  }

  /** Removes a single ID from this run's memory (chrome.storage.local), then
   *  refreshes the panel so the chip disappears and the count updates. */
  async function removeIdFromMemory(id) {
    const memKey = `db-memory-${getRunId()}`;
    try {
      const result = await chrome.storage.local.get([memKey]);
      const mem = result[memKey];
      if (!mem) return;
      mem.ids = mem.ids.filter(x => x !== id);
      await chrome.storage.local.set({ [memKey]: mem });
      refreshPanel(appState);
    } catch (e) {
      console.warn('[DB] removeIdFromMemory failed:', e);
      showToast('Memory', 'Remove failed — see console', true);
    }
  }

  /** Wipes every ID from this run's memory in one go (chrome.storage.local),
   *  confirming first since — unlike the per-row 🗑, which only ever loses one
   *  scan — this can erase a run's worth of saved IDs in a single click. */
  async function clearAllMemory() {
    const memKey = `db-memory-${getRunId()}`;
    try {
      const result = await chrome.storage.local.get([memKey]);
      const mem = result[memKey];
      if (!mem || !mem.ids.length) return;
      if (!confirm('All saved IDs will be deleted. Continue?')) return;
      mem.ids = [];
      await chrome.storage.local.set({ [memKey]: mem });
      refreshPanel(appState);
    } catch (e) {
      console.warn('[DB] clearAllMemory failed:', e);
      showToast('Memory', 'Clear failed — see console', true);
    }
  }

  // Tracks which pending-scan groups (by label) the user has expanded to show
  // every ID instead of the default +N-more truncation. Declared outside
  // refreshPanel() because that function rebuilds #db-pending's innerHTML
  // wholesale on every scan/state change — without this living here, an
  // expanded group would silently re-collapse on the very next refresh.
  const expandedPendingGroups = new Set();

  async function refreshPanel(st) {
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
        <td><span class="db-dot" style="background:${c}"></span>${escapeHtml(status)}</td>
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

    // Attach copy listeners on amount buttons
    document.getElementById('db-summary').querySelectorAll('.db-copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = btn.dataset.copy;
        if (!val) return;
        copyToClipboard(val).then(ok => {
          const orig = btn.textContent;
          btn.textContent = ok ? '✓' : '✗';
          setTimeout(() => { btn.textContent = orig; }, 1200);
        });
      });
    });

    // ── Pending section ──
    const holdPending   = (st.holdExpected   || []).filter(id => !st.holdReceived.includes(id));
    const returnPending = (st.returnExpected || []).filter(id => !st.returnReceived.includes(id));

    let pendHTML = '<div class="db-sec-title">⏳ Pending Scans</div>';

    function pendingGroup(label, color, ids) {
      if (!ids.length) return '';
      const isExpanded = expandedPendingGroups.has(label);
      const shown = isExpanded ? ids : ids.slice(0, 4);
      const extra = ids.length - shown.length;
      return `
        <div class="db-pending-grp">
          <div class="db-pending-hdr" style="color:${color}">
            <span>● ${label}</span><span class="db-cnt">${ids.length}</span>
          </div>
          <div class="db-ids">
            ${shown.map(id => `<span class="db-id" data-scroll-id="${escapeHtml(id)}">${escapeHtml(id)}</span>`).join('')}
            ${extra > 0 ? `<span class="db-more" data-toggle-group="${label}">+${extra} more</span>` : ''}
            ${isExpanded && ids.length > 4 ? `<span class="db-more" data-toggle-group="${label}">Show less</span>` : ''}
          </div>
        </div>`;
    }

    pendHTML += pendingGroup('On Hold', '#3b82f6', holdPending);
    pendHTML += pendingGroup('Return', '#ef4444', returnPending);

    // "Fill from Memory" button — shown when memory has IDs for this run.
    // chrome.storage.local (not localStorage) — shared with popup.js, which is
    // where IDs actually get saved. See doc comment on applyMemoryToState() below.
    const memKey   = `db-memory-${getRunId()}`;
    let   memCount = 0;
    try {
      const result = await chrome.storage.local.get([memKey]);
      const memIds = result[memKey]?.ids || [];
      memCount = memIds.length;
      renderMemoryList(memIds);
    } catch {}
    renderFieldList();
    const fillBtn = document.getElementById('db-memory-fill-btn');
    if (fillBtn) {
      fillBtn.textContent = `🧠 Auto-fill from Memory (${memCount})`;
      fillBtn.style.display = memCount > 0 ? '' : 'none';
    }
    const clearAllBtn = document.getElementById('db-mem-clear-all');
    if (clearAllBtn) clearAllBtn.classList.toggle('hidden', memCount === 0);

    if (!holdPending.length && !returnPending.length) {
      pendHTML += '<div class="db-done">✅ All parcels received!</div>';
    }

    document.getElementById('db-pending').innerHTML = pendHTML;

    // Attach scroll-on-click to every ID badge
    document.getElementById('db-pending').querySelectorAll('[data-scroll-id]').forEach(el => {
      el.addEventListener('click', () => scrollToRow(el.dataset.scrollId));
    });

    // Attach expand/collapse toggle for "+N more" / "Show less"
    document.getElementById('db-pending').querySelectorAll('[data-toggle-group]').forEach(el => {
      el.addEventListener('click', () => {
        const label = el.dataset.toggleGroup;
        if (expandedPendingGroups.has(label)) expandedPendingGroups.delete(label);
        else expandedPendingGroups.add(label);
        refreshPanel(st);
      });
    });

    // CC crosscheck: cached paint first, then signature-guarded fetch.
    renderXcheck();
    maybeRefreshXcheck(false);
    // Run → validations status sync: same signature guard, status-inclusive.
    maybeSyncRunStatus();
    // Confirmed one-time-copy list: same signature guard.
    renderConfirmed();
    maybeRefreshConfirmed(false);
  }

  // ── CC VALIDATION REPORT MODAL ───────────────────────────────────────────
  function reportEntries() {
    const f = xcheck.reportFilter;
    if (f === 'dr') return [...(xcheck.drUndelivered || [])];
    if (f === 'co') return [...(xcheck.carried || [])];
    if (f === 'cc') {
      return (xcheck.todayCc || []).map(c => ({
        id: c.id, verdict: 'cc', tag: c.remarksStatus || 'CC remark',
        st: c.st, remarkEn: c.remarkEn, remarkBn: c.remarkBn,
        note: c.note, dateKey: c.dateKey, carried: false,
      }));
    }
    const all = [...xcheck.warnings, ...xcheck.validated];
    if (f === 'warn') return all.filter(e => e.verdict === 'warn');
    if (f === 'ok')   return all.filter(e => e.verdict === 'ok');
    if (f === 'none') {
      const seen = new Set(all.map(e => e.id));
      const rows = parcelRows();
      const ids = [...new Set(rows.map(rowId).filter(id => id && ID_REGEX.test(id) && !seen.has(id)))].sort();
      const stMap = new Map();
      rows.forEach(r => { const id = rowId(r); if (id && !stMap.has(id)) stMap.set(id, rowStatus(r) || ''); });
      return ids.map(id => ({ id, verdict: 'mute', tag: 'No CC request', st: stMap.get(id) || '?', remarkEn: '', remarkBn: '', note: '', dateKey: '', carried: false }));
    }
    return all;
  }

  function openReport() {
    if (!panel) return;
    if (xcheck.status !== 'done') maybeRefreshXcheck(true);
    let bd = document.getElementById('db-report-backdrop');
    if (!bd) {
      bd = document.createElement('div');
      bd.id = 'db-report-backdrop';
      panel.appendChild(bd);
      bd.addEventListener('click', e => { if (e.target === bd) closeReport(); });
      if (!xcheck.escBound) {
        xcheck.escBound = true;
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeReport(); });
      }
    }
    bd.style.display = '';
    renderReport();
  }

  function closeReport() {
    const bd = document.getElementById('db-report-backdrop');
    if (bd) bd.style.display = 'none';
  }

  function renderReport() {
    const bd = document.getElementById('db-report-backdrop');
    if (!bd || bd.style.display === 'none') return;
    const w = xcheck.warnings.length, v = xcheck.validated.length;
    const ccN = (xcheck.todayCc || []).length;
    const drN = (xcheck.drUndelivered || []).length;
    const coN = (xcheck.carried || []).length;
    const vrN = xcheck.verifyRequestCount || 0;
    const hvN = (xcheck.holdVerified || 0) + (xcheck.returnVerified || 0);
    const drqN = xcheck.deliveryRequest || 0;
    const achN = xcheck.achievement || 0;
    const all = [...xcheck.warnings, ...xcheck.validated];
    const noneCount = (() => {
      try {
        const seen = new Set(all.map(e => e.id));
        return [...new Set(parcelRows().map(rowId).filter(id => id && ID_REGEX.test(id) && !seen.has(id)))].length;
      } catch { return 0; }
    })();
    const f = xcheck.reportFilter;
    const chip = (key, label) =>
      `<span class="db-rp-chip${f === key ? ' on' : ''}" data-rp-filter="${key}">${label}</span>`;
    const entries = reportEntries();
    const badgeCls = e => e.verdict === 'warn' ? 'db-rp-badge-warn' : e.verdict === 'ok' ? 'db-rp-badge-ok' : e.verdict === 'cc' ? 'db-rp-badge-ok' : e.verdict === 'co' ? 'db-rp-badge-warn' : 'db-rp-badge-mute';
    const dayBadge = e => !e.dateKey ? '' : e.carried
      ? `<span class="db-rp-day">📅 ${escapeHtml(e.dateKey)}</span>`
      : `<span class="db-rp-day">Today</span>`;
    const dot = e => `<span class="db-dot" style="background:${statusColor(e.st === '?' ? '' : e.st)}"></span>`;
    bd.innerHTML = `
      <div id="db-report-modal">
        <div class="db-rp-hdr"><span>📊 CC Validation — Run ${escapeHtml(getRunId())}</span><span class="db-rp-close" id="db-rp-close">✕</span></div>
        <div class="db-rp-sub">
          <span>Verify Requested: ${vrN}</span><span>Validated: ${v}</span><span>Verified: ${hvN}</span><span>Delivery_Request: ${drqN}</span><span>Achievement: ${achN}</span><span>warning: ${drN} (not delivered)</span><span>previous_days: ${coN}</span><span>today_cc: ${ccN}</span><span>no_request: ${noneCount}</span>
          ${xcheck.checkedAt ? `<span style="margin-left:auto">Checked ${escapeHtml(xcheckCheckedTime())}</span>` : ''}
          ${runSync.at ? `<span title="Run status → Supabase validations">🔄 ${escapeHtml(runSync.last)}</span>` : ''}
        </div>
        <div class="db-rp-chips">
          ${chip('all', `All (${all.length})`)}
          ${chip('dr', `Warning (${drN})`)}
          ${chip('co', `Previous Days (${coN})`)}
          ${chip('ok', `Validated (${v})`)}
          ${chip('cc', `Today CC (${ccN})`)}
          ${chip('none', `No Request (${noneCount})`)}
          <span class="db-rp-chip" id="db-rp-refresh" title="Check again now">🔄</span>
        </div>
        <div class="db-rp-table">${
          xcheck.status === 'loading' ? '<div class="db-rp-note" style="padding:8px 0">🔍 Checking…</div>'
          : !entries.length ? '<div class="db-rp-note" style="padding:8px 0">Nothing here</div>'
          : entries.map(e => `
            <div class="db-rp-row" data-scroll-id="${escapeHtml(e.id)}">
              <span class="db-rp-badge ${badgeCls(e)}">${escapeHtml(e.tag)}</span>
              <span>
                <div class="db-rp-id">${escapeHtml(e.id)}</div>
                <div class="db-rp-remark">${escapeHtml(xcheckRemark(e))}</div>
                ${e.note ? `<div class="db-rp-note">📝 ${escapeHtml(e.note)}</div>` : ''}
              </span>
              <span class="db-rp-st">${dot(e)}${escapeHtml(e.st)}<br>${dayBadge(e)}</span>
            </div>`).join('')
        }</div>
        <div class="db-rp-ftr">
          <button class="db-rp-btn" id="db-rp-copy-tsv">📋 TSV</button>
          <button class="db-rp-btn" id="db-rp-share">💬 Share</button>
          <button class="db-rp-btn" id="db-rp-csv">⬇️ CSV</button>
        </div>
      </div>`;
    document.getElementById('db-rp-close').addEventListener('click', closeReport);
    bd.querySelectorAll('[data-rp-filter]').forEach(c => {
      c.addEventListener('click', () => { xcheck.reportFilter = c.dataset.rpFilter; renderReport(); });
    });
    document.getElementById('db-rp-refresh').addEventListener('click', () => maybeRefreshXcheck(true));
    bd.querySelectorAll('[data-scroll-id]').forEach(n => {
      n.addEventListener('click', () => scrollToRow(n.dataset.scrollId));
    });
    const flashBtn = async (id, fn) => {
      const b = document.getElementById(id);
      if (!b) return;
      const ok = await fn().catch(() => false);
      const orig = b.textContent;
      b.textContent = ok ? '✓ Copied' : '✗ Failed';
      setTimeout(() => { b.textContent = orig; }, 1500);
    };
    document.getElementById('db-rp-copy-tsv').addEventListener('click', () =>
      flashBtn('db-rp-copy-tsv', () => copyToClipboard(xcheckReportTsv(entries))));
    document.getElementById('db-rp-share').addEventListener('click', () =>
      flashBtn('db-rp-share', () => copyToClipboard(
        xcheckShareText(getRunId(), XCHECK_DAY.format(new Date()), xcheck.warnings, xcheck.validated, xcheck.carried))));
    document.getElementById('db-rp-csv').addEventListener('click', () => {
      const csv = xcheckReportTsv(entries).split('\n')
        .map(l => l.split('\t').map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
      a.download = `cc-report-run-${getRunId()}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    });
  }

  // ── CONFIRMED ONE-TIME-COPY LIST ─────────────────────────────────────────
  // Supabase-এ status CONFIRMED হওয়া consignments (worker confirm করেছে) —
  // ID + agent name, per-ID copy button। Copy সফল হলেই list থেকে delete
  // (one-time)। chrome.storage.local-এ per-run persist করে, তাই reload-এ
  // uncopied গুলো থাকে; fresh fetch-এ আর confirmed নেই এমন auto-drop হয়।
  const cfd = { sig: null, status: 'idle', items: [], inflight: false }; // items: [{id, agent}]

  function cfdKey() { return `db-confirmed-${getRunId()}`; }

  async function cfdLoadStored() {
    try {
      const todayKey = XCHECK_DAY.format(new Date());
      const res = await chrome.storage.local.get([cfdKey()]);
      const saved = res[cfdKey()];
      if (saved && saved.dateKey === todayKey && Array.isArray(saved.items)) return saved.items;
    } catch {}
    return [];
  }

  async function cfdSave(items) {
    try {
      await chrome.storage.local.set({ [cfdKey()]: { dateKey: XCHECK_DAY.format(new Date()), items } });
    } catch {}
  }

  async function cfdFetchToday(ids) {
    const token = await xcheckIdToken();
    const gte = dhakaMidnightIso(0); // শুধু আজ — confirmed fresh action
    const base = `${XCHECK_URL}/rest/v1/validations` +
      `?select=consignment,source,remarks_status,created_at,assigned_to_system_id,assigned:users!validations_assigned_to_system_id_fkey(name,employee_id)` +
      `&remarks_status=in.(CONFIRMED,confirmed,Confirmed)` +
      `&created_at=gte.${encodeURIComponent(gte)}` +
      `&order=created_at.desc`;
    const headers = { 'apikey': XCHECK_ANON, 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
    const out = [];
    const chunks = [];
    for (let i = 0; i < ids.length; i += XCHECK_CHUNK) chunks.push(ids.slice(i, i + XCHECK_CHUNK));
    await Promise.all(chunks.map(async ch => {
      const res = await fetch(`${base}&consignment=in.(${ch.map(encodeURIComponent).join(',')})`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.json().catch(() => []);
      if (Array.isArray(arr)) out.push(...arr);
    }));
    return out;
  }

  function renderConfirmed() {
    const el = document.getElementById('db-confirmed-strip');
    if (!el) return;
    if (cfd.status === 'loading' && !cfd.items.length) {
      el.innerHTML = `<div class="db-xc-bar db-xc-bar-idle"><span>🔍 Checking confirmed…</span></div>`;
      applyXcheckVisibility();
      return;
    }
    if (!cfd.items.length) { el.innerHTML = ''; return; }
    el.innerHTML =
      `<div class="db-xc-bar db-xc-bar-ok"><span>✅ Confirmed (${cfd.items.length}) — leaves the list once copied</span>` +
      `<span class="db-xc-refresh" id="db-cfd-refresh" title="Check again now">🔄</span></div>` +
      `<div class="db-xc-list">${cfd.items.map(e => `
        <span class="db-cf-item">
          <span data-scroll-id="${escapeHtml(e.id)}" style="cursor:pointer" title="Go to row">${escapeHtml(e.id)}</span>
          <span class="db-cf-agent">${escapeHtml(e.agent || '')}</span>
          <button class="db-cf-copy" data-copy-id="${escapeHtml(e.id)}" title="Copy ID (once)">📋</button>
        </span>`).join('')}</div>`;
    el.querySelectorAll('[data-scroll-id]').forEach(n => {
      n.addEventListener('click', () => scrollToRow(n.dataset.scrollId));
    });
    const rb = document.getElementById('db-cfd-refresh');
    if (rb) rb.addEventListener('click', e => { e.stopPropagation(); maybeRefreshConfirmed(true); });
    el.querySelectorAll('[data-copy-id]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const id = btn.dataset.copyId;
        const ok = await copyToClipboard(id).catch(() => false);
        if (ok) {
          cfd.items = cfd.items.filter(x => x.id !== id);
          await cfdSave(cfd.items);
          renderConfirmed();
          showToast('Confirmed', `📋 ${id} copied — removed from list`, false);
        } else {
          const orig = btn.textContent;
          btn.textContent = '✗';
          setTimeout(() => { btn.textContent = orig; }, 1200);
        }
      });
    });
    applyXcheckVisibility();
  }

  async function maybeRefreshConfirmed(force) {
    const sig = xcheckSig();
    if (sig === null) {
      if (cfd.sig !== null || cfd.status !== 'idle') {
        cfd.sig = null; cfd.status = 'idle'; cfd.items = [];
        renderConfirmed();
      }
      return;
    }
    if (!force && (sig === cfd.sig || cfd.inflight)) return;
    cfd.sig = sig;
    cfd.inflight = true;
    if (!cfd.items.length) { cfd.status = 'loading'; renderConfirmed(); }
    try {
      const rows = parcelRows();
      const ids = [...new Set(rows.map(rowId).filter(id => id && ID_REGEX.test(id)))];
      const todayRows = await cfdFetchToday(ids);
      // Latest row per consignment decides — এখনো CONFIRMED হলেই list-এ।
      const latest = new Map();
      todayRows.forEach(r => {
        const id = r && r.consignment;
        if (!id) return;
        const prev = latest.get(id);
        if (!prev || (r.created_at || '') > (prev.created_at || '')) latest.set(id, r);
      });
      const fresh = new Map();
      latest.forEach((r, id) => {
        if ((r.remarks_status || '').trim().toLowerCase() !== 'confirmed') return;
        const agent = (r.assigned && r.assigned.name ? r.assigned.name : '') ||
          (r.assigned_to_system_id || '');
        fresh.set(id, agent);
      });
      // Merge with stored one-time queue: stored-copy-হওয়াগুলো আগেই গেছে;
      // fresh-এ নেই এমন stored auto-drop (status বদলে গেছে), নতুন fresh add।
      const stored = await cfdLoadStored();
      const storedMap = new Map(stored.map(x => [x.id, x.agent]));
      const merged = [];
      fresh.forEach((agent, id) => merged.push({ id, agent: agent || storedMap.get(id) || '' }));
      cfd.items = merged;
      await cfdSave(merged);
      cfd.status = 'done';
    } catch (err) {
      console.warn('[DB Confirmed] fetch failed:', err);
      // Fetch fail → stored queue-টাই দেখাও (হারাবে না)।
      if (!cfd.items.length) {
        const stored = await cfdLoadStored();
        if (stored.length) { cfd.items = stored; cfd.status = 'done'; }
        else cfd.status = 'idle';
      }
    } finally {
      cfd.inflight = false;
      renderConfirmed();
      if (xcheckSig() !== null && xcheckSig() !== cfd.sig) maybeRefreshConfirmed(true);
    }
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

      // 0. CC validation sign — scan state থেকে independent:
      //    ajker mismatch → ⚠ DEKHO (লাল), ajker thik → ✓ THIK (সবুজ),
      //    ager din-er delivery request (ekhono deya hoyni) → 📅 BAKI (কমলা)।
      //    .db-tick class থাকায় cleanup + observer-skip auto-cover করে।
      if (idEl) {
        const vx = xcheck.details.get(id);
        if (vx) {
          const b = document.createElement('span');
          const isWarn = vx.verdict === 'warn';
          b.className = 'db-tick db-xbadge' + (isWarn ? ' db-xbadge-warn' : '');
          b.textContent = isWarn ? '⚠ CHECK' : '✓ OK';
          b.title = `${vx.tag} — run: ${vx.st}` +
            (vx.remarkEn ? ` — ${vx.remarkBn || vx.remarkEn}` : '') +
            (vx.carried ? ` (${vx.dateKey})` : '');
          idEl.appendChild(b);
        } else {
          // Ager din-er delivery request, ekhono deya hoyni → 📅 BAKI।
          const co = xcheck.carriedById && xcheck.carriedById.get(id);
          if (co) {
            const b = document.createElement('span');
            b.className = 'db-tick db-xbadge';
            b.style.background = '#d97706';
            b.textContent = '📅 PENDING';
            b.title = `Previous day (${co.dateKey || ''}) delivery request — still undelivered` +
              (co.remarkEn ? ` — ${co.remarkBn || co.remarkEn}` : '') +
              ` — run: ${co.st}`;
            idEl.appendChild(b);
          } else {
            // Verify-status না হলেও আজকের যেকোনো CC remark থাকলে 📋 CC mark —
            // যাতে "validation mark korche na" না লাগে।
            const cc = xcheck.todayCcById && xcheck.todayCcById.get(id);
            if (cc) {
              const b = document.createElement('span');
              b.className = 'db-tick db-xbadge';
              b.style.background = '#2563eb';
              b.textContent = '📋 CC';
              const lbl = cc.remarksStatus || cc.remarkEn || 'CC remark';
              b.title = `Today\u2019s CC — ${lbl}${cc.remarkEn && cc.remarkEn !== lbl ? ` — ${cc.remarkBn || cc.remarkEn}` : ''} — run: ${cc.st}`;
              idEl.appendChild(b);
            }
          }
        }
      }

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

  // ── RECONCILE EXPECTED SETS WITH CURRENT PAGE STATUS ─────────────────────
  // initState() syncs the cached expected sets from the live DOM only when
  // rows already exist at init() time — but Hermes' Vue list usually renders
  // AFTER our content script runs, and the retry/observer rebuild paths only
  // fire when BOTH expected sets are empty. So a non-empty stale cache (e.g.
  // 5 hold IDs first visit, of which the agent since delivered/returned 3)
  // survived reloads untouched until the 72h cache expired.
  // This closes that gap with the same conservative rule as
  // reconcileWithPageState(): an ID is touched ONLY when the page explicitly
  // shows it — absent rows (pagination, mid re-render) are left alone, so a
  // partial render can never shrink the sets. Unreadable status ('') also
  // leaves the ID untouched.
  function reconcileExpectedWithPage(st) {
    const rows = parcelRows();
    if (!rows.length) return false;

    const holdSet   = new Set(st.holdExpected   || []);
    const returnSet = new Set(st.returnExpected || []);
    let changed = false;

    rows.forEach(row => {
      const id = rowId(row);
      if (!id || !ID_REGEX.test(id)) return;
      const s = (rowStatus(row) || '').trim().toLowerCase();
      if (!s) return; // status unreadable → keep as-is

      if (HOLD_VALID.has(s)) {
        if (!holdSet.has(id))    { holdSet.add(id);      changed = true; }
        if (returnSet.has(id))   { returnSet.delete(id); changed = true; }
      } else if (RETURN_VALID.has(s)) {
        if (!returnSet.has(id))  { returnSet.add(id);    changed = true; }
        if (holdSet.has(id))     { holdSet.delete(id);   changed = true; }
      } else {
        // Explicitly shown with a non-hold/return status (delivered etc.)
        // → no longer pending, drop from both expected sets.
        if (holdSet.has(id))     { holdSet.delete(id);   changed = true; }
        if (returnSet.has(id))   { returnSet.delete(id); changed = true; }
      }
    });

    if (changed) {
      st.holdExpected   = [...holdSet];
      st.returnExpected = [...returnSet];
      persistState(st);
    }
    return changed;
  }

  // ── CC CROSSCHECK (Supabase validations × run status) ────────────────────
  // Run-এর সব consignment ID দিয়ে CC remarks আনে, তারপর run status-এর
  // সাথে FAMILY দিয়ে মিলায় (Hermes run statuses):
  //   DELIVERY family: Delivered, Partial Delivery, Paid Return, Exchange
  //   RETURN family:   Return, Return Requested, Reattempt Request (+aliases)
  //   OPEN family:     On Hold, Assigned for Delivery, On the way to last
  //                    mile hub, Received at last mile hub (+aliases)
  //   hold_verified (HOLD_VERIFIED) + যেকোনো family (open/delivery/return) → ✅
  //   return_verified (RETURN_VERIFIED) + যেকোনো family              → ✅
  //   delivery_request (DELIVERY_REQUEST) + delivery                → ✅ fulfilled
  //   delivery_request + open/return                                → ⚠️ THE ONLY warning
  //   (agent delivery na kore chole asche — koyta emon ache setai count হয়)
  // Supabase remarks_status (validation_remarks, source=CC): HOLD_VERIFIED,
  // RETURN_VERIFIED, DELIVERY_REQUEST — "Latest row decides".
  const XCHECK_DELIVERY = new Set(['delivered', 'partial delivery', 'partial', 'paid return', 'exchange']);
  const XCHECK_RETURN = new Set(['return', 'return requested', 'return request', 'reattempt request', 'reattempt requested']);
  const XCHECK_OPEN = new Set(['on hold', 'assigned for delivery', 'assigned', 'on the way to last mile hub', 'received at last mile hub', 'pending', 'in transit', 'intransit']);
  const XCHECK_RESOLVED = XCHECK_DELIVERY; // alias: delivery_request fulfilled only by delivery family
  const XCHECK_CHUNK = 200; // PostgREST in.(...) safety chunk (app-এর pattern)
  const XCHECK_DAYS = 7; // carryover window: গতকালের unanswered request আজও দেখাবে
  // CONFIG comes from config.js (same content-script entry, manifest order) —
  // guarded so a missing CONFIG can never kill the whole helper again.
  const XCHECK_CFG = (typeof CONFIG !== 'undefined' && CONFIG) ? CONFIG : {};
  const XCHECK_URL = XCHECK_CFG.SUPABASE_URL || '';
  const XCHECK_ANON = XCHECK_CFG.SUPABASE_ANON_KEY || '';
  const XCHECK_FB_URL = XCHECK_CFG.FIREBASE_URL || '';
  const XCHECK_FB_KEY = XCHECK_CFG.FIREBASE_WEB_API_KEY || '';
  const XCHECK_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' });

  const xcheck = {
    sig: null, status: 'idle', // idle|loading|done|no-token|error
    warnings: [], validated: [], details: new Map(), note: '',
    todayCc: [], todayCcById: new Map(), ccOpen: true,
    drUndelivered: [], drOpen: true,
    carried: [], carriedById: new Map(), coOpen: true,
    verifyRequestIds: [], verifyRequestCount: 0,
    holdVerified: 0, returnVerified: 0, deliveryRequest: 0, achievement: 0,
    sumOpen: null,
    bnMap: null, checkedAt: 0,
    inflight: false, warnOpen: true, okOpen: false,
    reportFilter: 'all', escBound: false,
  };

  // Firebase ID token — cc-panel.js-এর port (content-script নিজে refresh
  // করে, popup-এর সাথে chrome.storage.local key share করে)।
  async function xcheckRefreshToken(refreshToken) {
    const res = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${XCHECK_FB_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString()
      }
    );
    const data = await res.json();
    if (!res.ok || !data.id_token) throw new Error(data?.error?.message || 'Token refresh failed');
    return {
      idToken: data.id_token,
      refreshToken: data.refresh_token,
      expiresIn: parseInt(data.expires_in, 10) || 3600
    };
  }

  async function xcheckIdToken() {
    const stored = await chrome.storage.local.get(['google_id_token', 'google_refresh_token', 'google_token_expires_at']);
    if (!stored.google_refresh_token) { const e = new Error('no-token'); e.code = 'no-token'; throw e; }
    if (stored.google_id_token && Date.now() < (stored.google_token_expires_at || 0) - 5 * 60 * 1000) {
      return stored.google_id_token;
    }
    try {
      const t = await xcheckRefreshToken(stored.google_refresh_token);
      await chrome.storage.local.set({
        google_id_token: t.idToken,
        google_refresh_token: t.refreshToken,
        google_token_expires_at: Date.now() + t.expiresIn * 1000
      });
      return t.idToken;
    } catch (err) {
      console.warn('[DB XCheck] token refresh failed:', err);
      const e = new Error('no-token'); e.code = 'no-token'; throw e;
    }
  }

  // Dhaka midnight N days ago as UTC ISO (Dhaka = +06:00, no DST).
  function dhakaMidnightIso(daysAgo) {
    const now = new Date();
    const dhaka = new Date(now.getTime() + (360 + now.getTimezoneOffset()) * 60000);
    dhaka.setHours(0, 0, 0, 0);
    dhaka.setDate(dhaka.getDate() - daysAgo);
    return dhaka.toISOString();
  }
  function xcheckDayKey(iso) { try { return XCHECK_DAY.format(new Date(iso)); } catch { return ''; } }

  async function xcheckFetchToday(ids) {
    // Run-এর সব consignment ID দিয়ে Supabase থেকে CC remarks আনে:
    // 7-day window (carryover warnings-এর জন্য) + আজকের সব CC row
    // (যেকোনো remarks_status — delivery_request/hold_verified/
    // return_verified শুধু নয়)। Status filter তুলে দেওয়ার কারণ: CC-এর
    // আজকের remark যেকোনো target_status হতে পারে (Delivered/On Hold/…),
    // শুধু 3 verify-status filter করলে "No pending" দেখাতো যদিও row আছে।
    const token = await xcheckIdToken();
    const gte = dhakaMidnightIso(XCHECK_DAYS);
    const base = `${XCHECK_URL}/rest/v1/validations` +
      `?select=consignment,source,remarks_status,remarks,note,created_at` +
      `&source=eq.CC` +
      `&created_at=gte.${encodeURIComponent(gte)}` +
      `&order=created_at.desc`;
    const headers = { 'apikey': XCHECK_ANON, 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
    const out = [];
    const chunks = [];
    for (let i = 0; i < ids.length; i += XCHECK_CHUNK) chunks.push(ids.slice(i, i + XCHECK_CHUNK));
    await Promise.all(chunks.map(async ch => {
      const res = await fetch(`${base}&consignment=in.(${ch.map(encodeURIComponent).join(',')})`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.json().catch(() => []);
      if (Array.isArray(arr)) out.push(...arr);
    }));
    return out;
  }

  async function xcheckFetchVerifyRequests(ids) {
    // Delivery agent verify requests: WORKER + VERIFY_REQUEST, today (Dhaka)
    // only, distinct consignment IDs within this run.
    if (!ids.length) return [];
    const token = await xcheckIdToken();
    const gte = dhakaMidnightIso(0);
    const base = `${XCHECK_URL}/rest/v1/validations` +
      `?select=consignment,created_at` +
      `&source=eq.WORKER` +
      `&remarks_status=eq.VERIFY_REQUEST` +
      `&created_at=gte.${encodeURIComponent(gte)}` +
      `&order=created_at.desc`;
    const headers = { 'apikey': XCHECK_ANON, 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
    const out = [];
    const chunks = [];
    for (let i = 0; i < ids.length; i += XCHECK_CHUNK) chunks.push(ids.slice(i, i + XCHECK_CHUNK));
    await Promise.all(chunks.map(async ch => {
      const res = await fetch(`${base}&consignment=in.(${ch.map(encodeURIComponent).join(',')})`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.json().catch(() => []);
      if (Array.isArray(arr)) out.push(...arr);
    }));
    const runSet = new Set(ids);
    const distinct = [...new Set(out.map(r => r && r.consignment).filter(id => id && runSet.has(id)))].sort();
    return distinct;
  }

  function xcheckClassify(todayRows, pageStatus) {
    // Latest row per consignment decides (server desc per chunk, cross-chunk
    // order not guaranteed → compare created_at client-side).
    const latest = new Map();
    todayRows.forEach(r => {
      const id = r && r.consignment;
      if (!id) return;
      const prev = latest.get(id);
      if (!prev || (r.created_at || '') > (prev.created_at || '')) latest.set(id, r);
    });
    const todayKey = XCHECK_DAY.format(new Date());
    const warnings = [], validated = [], details = new Map();
    const todayCc = [], todayCcById = new Map();
    const drUndelivered = [];
    // Ager din-er delivery_request, ekhono deya hoyni — alada "baki" list.
    // Sudhu delivery_request carry hoy; purono hold/return-verified lagbe na.
    const carried = [], carriedById = new Map();
    const entry = (id, row, verdict, tag, runRaw) => {
      const dateKey = xcheckDayKey(row.created_at);
      const e = {
        id, verdict, tag, st: runRaw || '?',
        remarkEn: (row.remarks || '').trim(),
        remarkBn: '',
        remarksStatus: (row.remarks_status || '').trim(),
        note: (row.note || '').trim(),
        dateKey, carried: !!dateKey && dateKey !== todayKey,
      };
      (verdict === 'warn' ? warnings : validated).push(e);
      details.set(id, e);
      return e;
    };
    const carryEntry = (id, row, runRaw) => {
      const e = {
        id, verdict: 'co', tag: 'Previous day — undelivered', st: runRaw || '?',
        remarkEn: (row.remarks || '').trim(),
        remarkBn: '',
        remarksStatus: (row.remarks_status || '').trim(),
        note: (row.note || '').trim(),
        dateKey: xcheckDayKey(row.created_at), carried: true,
      };
      carried.push(e);
      carriedById.set(id, e);
      return e;
    };
    latest.forEach((row, id) => {
      const rs = (row.remarks_status || '').trim().toLowerCase();
      const runRaw = (pageStatus.get(id) || '').trim();
      const run = runRaw.toLowerCase();
      // Ajker sob CC remark (jekono status) — run page-er list-er jonno.
      const dateKey = xcheckDayKey(row.created_at);
      const isToday = !!dateKey && dateKey === todayKey;
      if (isToday) {
        const c = {
          id, st: runRaw || '?',
          remarksStatus: (row.remarks_status || '').trim(),
          remarkEn: (row.remarks || '').trim(),
          remarkBn: '',
          note: (row.note || '').trim(),
          dateKey,
        };
        todayCc.push(c);
        todayCcById.set(id, c);
      }
      if (rs === 'delivery_request') {
        if (XCHECK_DELIVERY.has(run)) {
          if (isToday) entry(id, row, 'ok', 'Delivered', runRaw);
        } else if (isToday) {
          drUndelivered.push(entry(id, row, 'warn', 'Delivery Request — Not Delivered', runRaw));
        } else {
          carryEntry(id, row, runRaw);
        }
      } else if (rs === 'hold_verified') {
        if (isToday) entry(id, row, 'ok', 'Hold Verified', runRaw);
      } else if (rs === 'return_verified') {
        if (isToday) entry(id, row, 'ok', 'Return Verified', runRaw);
      }
    });
    todayCc.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    drUndelivered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    carried.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const holdVerified = validated.filter(e => (e.remarksStatus || '').toLowerCase() === 'hold_verified').length;
    const returnVerified = validated.filter(e => (e.remarksStatus || '').toLowerCase() === 'return_verified').length;
    const achievement = validated.filter(e => (e.remarksStatus || '').toLowerCase() === 'delivery_request').length;
    const deliveryRequest = achievement + drUndelivered.length;
    return { warnings, validated, details, todayCc, todayCcById, drUndelivered, carried, carriedById, holdVerified, returnVerified, deliveryRequest, achievement };
  }

  // Bangla remark labels (validation_remarks catalog, CC) — cached per load.
  async function xcheckBnMap() {
    if (xcheck.bnMap) return xcheck.bnMap;
    const m = new Map();
    try {
      const token = await xcheckIdToken();
      const res = await fetch(
        `${XCHECK_URL}/rest/v1/validation_remarks?select=remarks_en,remarks_bn&source=eq.CC`,
        { headers: { 'apikey': XCHECK_ANON, 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
      );
      const arr = await res.json().catch(() => []);
      (Array.isArray(arr) ? arr : []).forEach(x => {
        const en = (x.remarks_en || '').trim().toLowerCase();
        const bn = (x.remarks_bn || '').trim();
        if (en && bn && !m.has(en)) m.set(en, bn);
      });
    } catch (err) {
      console.warn('[DB XCheck] remark catalog fetch failed:', err);
    }
    xcheck.bnMap = m;
    return m;
  }

  function xcheckRemark(e) {
    return (e.remarkBn || e.remarkEn || '—');
  }

  function xcheckCheckedTime() {
    if (!xcheck.checkedAt) return '';
    try {
      return new Date(xcheck.checkedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  // ── REPORT BUILDERS (pure — unit-tested below via node) ──────────────────
  function xcheckReportTsv(entries) {
    const esc = v => String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' / ');
    const lines = ['Consignment\tRun status\tVerdict\tCC remark\tDate'];
    entries.forEach(e => {
      lines.push([e.id, e.st, e.tag, xcheckRemark(e), e.dateKey || ''].map(esc).join('\t'));
    });
    return lines.join('\n');
  }

  function xcheckShareText(runId, dateKey, warnings, validated, carried) {
    const [y, m, d] = (dateKey || '').split('-');
    const L = [];
    const co = Array.isArray(carried) ? carried : [];
    L.push(`📦 Run ${runId} — CC Validation (${d && m && y ? `${d}-${m}-${y}` : dateKey || ''})`);
    L.push(`✅ Validated: ${validated.length} | 🚫 Not Delivered: ${warnings.length} | 📅 Previous Days Pending: ${co.length}`);
    if (warnings.length) {
      L.push('🚫 Not Delivered:');
      warnings.forEach(e => L.push(`• ${e.id} — ${e.tag}, run: ${e.st}`));
    }
    if (co.length) {
      L.push('📅 Requested on a previous day, undelivered:');
      co.forEach(e => L.push(`• ${e.id} — ${e.dateKey || ''}, run: ${e.st}`));
    }
    if (validated.length) {
      L.push('✅ Validated:');
      validated.forEach(e => L.push(`• ${e.id} — ${e.tag}`));
    }
    return L.join('\n');
  }

  function xcheckSig() {
    const rows = parcelRows();
    if (!rows.length) return null;
    const ids = [...new Set(rows.map(rowId).filter(id => id && ID_REGEX.test(id)))].sort();
    return `${getRunId()}|${ids.join(',')}`;
  }

  // ── POPUP RUN REPORT (snapshot for popup Run tab + details window) ───────
  // All run parcels (ID + live run status) + per-parcel CC verdict/remark —
  // verdict: ok (validated) / warn (delivery_request undelivered) /
  // cc (other CC remark today) / none (no CC request).
  function buildRunReport() {
    const seen = new Set();
    const rows = [];
    parcelRows().forEach(r => {
      const id = rowId(r);
      if (!id || seen.has(id)) return;
      seen.add(id);
      const st = rowStatus(r) || '';
      const vx = xcheck.details.get(id);
      const cc = xcheck.todayCcById && xcheck.todayCcById.get(id);
      rows.push({
        id, st,
        verdict: vx ? vx.verdict : (cc ? 'cc' : 'none'),
        tag: vx ? vx.tag : (cc ? (cc.remarksStatus || 'CC remark') : 'No CC request'),
        remarksStatus: vx ? (vx.remarksStatus || '') : (cc ? (cc.remarksStatus || '') : ''),
        remarkEn: vx ? (vx.remarkEn || '') : (cc ? (cc.remarkEn || '') : ''),
        remarkBn: vx ? (vx.remarkBn || '') : (cc ? (cc.remarkBn || '') : ''),
        note: vx ? (vx.note || '') : (cc ? (cc.note || '') : ''),
        dateKey: vx ? (vx.dateKey || '') : (cc ? (cc.dateKey || '') : ''),
        carried: !!(vx && vx.carried),
      });
    });
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      runId: getRunId(),
      checkedAt: xcheck.checkedAt || 0,
      xstatus: xcheck.status,
      total: rows.length,
      rows,
      counts: {
        validated: xcheck.validated.length,
        warnings: xcheck.warnings.length,
        undelivered: (xcheck.drUndelivered || []).length,
        todayCc: (xcheck.todayCc || []).length,
        verifyRequest: xcheck.verifyRequestCount || 0,
        holdVerified: xcheck.holdVerified || 0,
        returnVerified: xcheck.returnVerified || 0,
        verified: (xcheck.holdVerified || 0) + (xcheck.returnVerified || 0),
        deliveryRequest: xcheck.deliveryRequest || 0,
        achievement: xcheck.achievement || 0,
      },
      sync: runSync.at ? runSync.last : '',
    };
  }

  // ── FIREBASE RUN STATUS SYNC (run → courier/consignments + delivery_run) ──
  // Supabase sync-er moto run khullei chole, 2 step-e:
  // 1. courier/consignments/{id}/status ← live page status (known only).
  // 2. delivery_run node-er consignments map ← source status (app-er backfill
  //    pattern, WorkerSpaceFragment). Sudhu diff-te PATCH; node na thakle skip.
  const fbRunSync = { sig: null, inflight: false };

  async function maybeSyncFirebaseRunStatus() {
    const rows = parcelRows();
    const ids = [...new Set(rows.map(rowId).filter(id => id && ID_REGEX.test(id)))];
    if (!ids.length) return;
    const sig = `${getRunId()}|${ids.slice().sort().join(',')}`;
    if (sig === fbRunSync.sig || fbRunSync.inflight) return;
    fbRunSync.sig = sig;
    fbRunSync.inflight = true;
    try {
      const token = await xcheckIdToken();
      const runId = getRunId();
      const base = `${XCHECK_FB_URL}/courier/run_routes/delivery_run/${encodeURIComponent(runId)}/consignments`;
      const curRes = await fetch(`${base}.json?auth=${token}`);
      if (curRes.status === 401 || curRes.status === 403) { fbRunSync.sig = null; return; }
      const cur = curRes.ok ? await curRes.json().catch(() => null) : null;
      const norm = v => {
        if (typeof v === 'string') return v.trim();
        if (v && typeof v === 'object') return String(v.status || '').trim();
        return '';
      };
      const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
      const isKnown = s => !!s && KNOWN_RUN_STATUSES.has(String(s).toLowerCase());
      const pageStatus = new Map();
      parcelRows().forEach(r => {
        const id = rowId(r);
        if (id) pageStatus.set(id, (rowStatus(r) || '').trim());
      });
      // 1. courier/consignments/{id}/status ← live page status (known only).
      const consSrc = {}; // id -> effective source status
      const consDiffs = {};
      await Promise.all(ids.map(async id => {
        try {
          const r = await fetch(`${XCHECK_FB_URL}/courier/consignments/${encodeURIComponent(id)}/status.json?auth=${token}`);
          if (!r.ok) return;
          const body = await r.json().catch(() => null);
          if (body === null || body === undefined) return; // node nei — app-er moto skip
          const curSt = String(body).trim();
          if (!curSt) return;
          consSrc[id] = curSt;
          const pageSt = pageStatus.get(id) || '';
          if (isKnown(pageSt) && !same(pageSt, curSt)) {
            consDiffs[id] = { status: pageSt };
            consSrc[id] = pageSt;
          }
        } catch (_) {}
      }));
      const consKeys = Object.keys(consDiffs);
      if (consKeys.length) {
        const w1 = await fetch(`${XCHECK_FB_URL}/courier/consignments.json?auth=${token}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(consDiffs)
        });
        if (!w1.ok) throw new Error(`HTTP ${w1.status}`);
        console.log(`[DB FbRunSync] run ${runId}: updated ${consKeys.length} courier/consignments statuses from live page`);
      }
      // 2. run_routes backfill (app pattern) — node na thakle skip, banano hoy na.
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return;
      const diffs = {};
      ids.forEach(id => {
        if (!consSrc[id] || same(norm(cur[id]), consSrc[id])) return;
        diffs[id] = consSrc[id];
      });
      const keys = Object.keys(diffs);
      if (!keys.length) {
        console.log(`[DB FbRunSync] run ${runId}: all ${ids.length} run_routes statuses already in sync`);
        return;
      }
      const w = await fetch(`${base}.json?auth=${token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(diffs)
      });
      if (!w.ok) throw new Error(`HTTP ${w.status}`);
      console.log(`[DB FbRunSync] run ${runId}: updated ${keys.length}/${ids.length} consignment statuses in delivery_run`);
    } catch (err) {
      if (err && err.code === 'no-token') fbRunSync.sig = null;
      else console.warn('[DB FbRunSync] sync failed:', err);
    } finally {
      fbRunSync.inflight = false;
    }
  }

  // ── RUN STATUS SYNC (run → Supabase validations.consignment_status) ──
  // Run page-এর live status দিয়ে OI DIN-er (run kholar din, Dhaka bounds)
  // same consignment-এর SOB validation row-এর consignment_status update হয়
  // (Edge `sync_run_status` action — service_role দিয়ে লেখে, কারণ RLS-এ
  // UPDATE policy নেই)।
  // Status-inclusive signature guard: ID set same থাকলেও status বদলালে sync
  // হয়; unchanged run-এ network call-ই হয় না (server-ও zero-write)।
  const runSync = { sig: null, inflight: false, at: 0, last: '' };

  function runSyncDay() {
    return { start: dhakaMidnightIso(0), end: dhakaMidnightIso(-1) };
  }

  function runSyncSig() {
    const rows = parcelRows();
    if (!rows.length) return null;
    const pairs = [];
    rows.forEach(r => {
      const id = rowId(r);
      if (id && ID_REGEX.test(id)) pairs.push(`${id}:${rowStatus(r) || ''}`);
    });
    if (!pairs.length) return null;
    return `${getRunId()}|${runSyncDay().start}|${pairs.sort().join(',')}`;
  }

  async function maybeSyncRunStatus() {
    const sig = runSyncSig();
    if (sig === null || sig === runSync.sig || runSync.inflight) return;
    runSync.sig = sig;
    runSync.inflight = true;
    try {
      const token = await xcheckIdToken();
      const items = [];
      const seen = new Set();
      parcelRows().forEach(r => {
        const id = rowId(r);
        const st = (rowStatus(r) || '').trim();
        if (!id || !ID_REGEX.test(id) || !st || seen.has(id)) return;
        seen.add(id);
        items.push({ consignment: id, status: st });
      });
      if (!items.length) return;
      const day = runSyncDay();
      const res = await fetch(`${XCHECK_URL}/functions/v1/validations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': XCHECK_ANON,
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ action: 'sync_run_status', items, day_start: day.start, day_end: day.end })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      runSync.at = Date.now();
      runSync.last = `+${data.updated || 0} ~${data.unchanged || 0} ?${data.missing || 0}`;
      runSync.err = '';
      console.log(`[DB RunSync] run ${getRunId()}:`, runSync.last);
      try { renderReport(); } catch {}
      try { renderXcheck(); } catch {}
    } catch (err) {
      // Not signed in via popup yet → retry on a later refresh (cheap local
      // storage read each time, no network until the token exists).
      if (err && err.code === 'no-token') runSync.sig = null;
      else {
        console.warn('[DB RunSync] sync failed:', err);
        runSync.err = (err && err.message) ? String(err.message).slice(0, 120) : 'sync failed';
        try { renderXcheck(); } catch {}
      }
    } finally {
      runSync.inflight = false;
      // Status changed mid-flight → sync again for the new set.
      if (runSyncSig() !== null && runSyncSig() !== runSync.sig) maybeSyncRunStatus();
    }
  }

  function runSyncBar() {
    // Display removed — the run-status sync still runs silently in the
    // background (maybeSyncRunStatus), only the visible bar is gone.
    return '';
  }

  function renderXcheck() {
    const el = document.getElementById('db-xcheck-strip');
    if (!el) return;
    const refreshBtn = `<span class="db-xc-refresh" id="db-xcheck-refresh" title="Check again now">🔄</span>`;
    if (xcheck.status === 'idle') { el.innerHTML = ''; return; }
    if (xcheck.status === 'loading') {
      el.innerHTML = `<div class="db-xc-bar db-xc-bar-idle"><span>🔍 Checking CC requests…</span>${refreshBtn}</div>`;
    } else if (xcheck.status === 'no-token') {
      el.innerHTML = `<div class="db-xc-bar db-xc-bar-idle"><span>⚪ CC check off — sign in from the extension popup</span>${refreshBtn}</div>`;
    } else if (xcheck.status === 'error') {
      el.innerHTML = `<div class="db-xc-bar db-xc-bar-idle"><span>⚪ CC check failed (network/RLS) — press 🔄 to retry</span>${refreshBtn}</div>`;
    } else {
      const w = xcheck.warnings, v = xcheck.validated;
      const dr = xcheck.drUndelivered || [];
      const co = xcheck.carried || [];
      const vrN = xcheck.verifyRequestCount || 0;
      const hvN = (xcheck.holdVerified || 0) + (xcheck.returnVerified || 0);
      const drqN = xcheck.deliveryRequest || 0;
      const achN = xcheck.achievement || 0;
      const runTotal = (() => {
        try { return new Set(parcelRows().map(rowId).filter(id => id && ID_REGEX.test(id))).size; }
        catch { return 0; }
      })();
      const pctOf = (n, base) => base > 0 ? `${Math.round((n / base) * 100)}%` : '—';
      const sumTableRow = (key, label, n, p) =>
        `<tr class="db-xc-sumrow${xcheck.sumOpen === key ? ' on' : ''}" data-sum="${key}"><td>${label}</td><td class="num">${n}</td><td class="num">${p}</td></tr>`;
      const sumIdsFor = key => {
        const isDelivery = e => (e.remarksStatus || '').toLowerCase() === 'delivery_request';
        const isVerified = e => ['hold_verified', 'return_verified'].includes((e.remarksStatus || '').toLowerCase());
        if (key === 'vr') return (xcheck.verifyRequestIds || []).map(id => ({ id, st: '', tag: 'Verify requested today' }));
        if (key === 'ok') return (xcheck.validated || []).slice();
        if (key === 'verified') return (xcheck.validated || []).filter(isVerified);
        if (key === 'drq') return (xcheck.validated || []).filter(isDelivery).concat(xcheck.drUndelivered || []);
        if (key === 'ach') return (xcheck.validated || []).filter(isDelivery);
        return [];
      };
      const sumList = (() => {
        if (!xcheck.sumOpen) return '';
        const ids = sumIdsFor(xcheck.sumOpen);
        if (!ids.length) return `<div class="db-xc-list"><span style="opacity:.65">No IDs</span></div>`;
        return `<div class="db-xc-list">${ids.map(e =>
          `<span class="db-xc-item" data-scroll-id="${escapeHtml(e.id)}" title="${escapeHtml(e.tag || '')}">${escapeHtml(e.id)}${e.st ? ` <span class="db-xc-st">${escapeHtml(e.st)}</span>` : ''}</span>`
        ).join('')}</div>`;
      })();
      const summaryBar = `<div class="db-xc-bar db-xc-bar-idle" id="db-xc-sumbar">` +
        `<table class="db-table">` +
        `<thead><tr><th>Run Status</th><th class="num">Count</th><th class="num">%</th></tr></thead><tbody>` +
        sumTableRow('vr', 'Verify Requested', vrN, pctOf(vrN, runTotal)) +
        sumTableRow('ok', 'Validated', v.length, pctOf(v.length, vrN)) +
        sumTableRow('verified', 'Verified', hvN, pctOf(hvN, v.length)) +
        sumTableRow('drq', 'Delivery_Request', drqN, pctOf(drqN, v.length)) +
        sumTableRow('ach', 'Achievement', achN, pctOf(achN, drqN)) +
        `</tbody></table>` +
        sumList +
        `${refreshBtn}</div>`;
      // warnings are delivery_request mismatches only —
      // generic warn bar shows only for non-delivery warnings.
      const otherWarn = w.filter(e => dr.indexOf(e) === -1);
      const drItem = (e) =>
        `<span class="db-xc-item db-xc-item-warn" data-scroll-id="${escapeHtml(e.id)}" title="Delivery request — run: ${escapeHtml(e.st)}${e.remarkEn ? ` — ${escapeHtml(e.remarkBn || e.remarkEn)}` : ''}">` +
        `${escapeHtml(e.id)} <span class="db-xc-st">${escapeHtml(e.st)}</span></span>`;
      // Delivery request today, still not delivered — most important bar, on top.
      const drBar = dr.length
        ? `<div class="db-xc-bar db-xc-bar-warn" id="db-xc-drbar"><span>🚫 ${dr.length} delivery requests not delivered — agent returned without delivery</span></div>` +
          (xcheck.drOpen ? `<div class="db-xc-list">${dr.map(drItem).join('')}</div>` : '')
        : '';
      // Ager din delivery request chilo, ekhono deya hoyni — alada kore, jeno clearly bojha jay.
      const coItem = (e) =>
        `<span class="db-xc-item db-xc-item-warn" data-scroll-id="${escapeHtml(e.id)}" title="Previous day (${escapeHtml(e.dateKey || '')}) delivery request — still undelivered — run: ${escapeHtml(e.st)}${e.remarkEn ? ` — ${escapeHtml(e.remarkBn || e.remarkEn)}` : ''}">` +
        `${escapeHtml(e.id)} <span class="db-xc-st">${escapeHtml(e.st)}</span></span>`;
      const coBar = co.length
        ? `<div class="db-xc-bar db-xc-bar-warn" id="db-xc-cobar" style="border-color:#d97706"><span>📅 ${co.length} previous-day delivery requests still undelivered</span></div>` +
          (xcheck.coOpen ? `<div class="db-xc-list">${co.map(coItem).join('')}</div>` : '')
        : '';
      const hasActivity = dr.length || co.length || otherWarn.length || v.length;
      if (!hasActivity) {
        el.innerHTML = summaryBar + drBar + coBar + runSyncBar();
        const db = document.getElementById('db-xc-drbar');
        if (db) db.addEventListener('click', e => {
          if (e.target.id === 'db-xcheck-refresh') return;
          xcheck.drOpen = !xcheck.drOpen; renderXcheck();
        });
        const cob0 = document.getElementById('db-xc-cobar');
        if (cob0) cob0.addEventListener('click', e => {
          if (e.target.id === 'db-xcheck-refresh') return;
          xcheck.coOpen = !xcheck.coOpen; renderXcheck();
        });
      } else {
        const item = (e, cls) =>
          `<span class="db-xc-item ${cls}" data-scroll-id="${escapeHtml(e.id)}" title="${escapeHtml(e.tag)} — run: ${escapeHtml(e.st)}">` +
          `${escapeHtml(e.id)} <span class="db-xc-st">${escapeHtml(e.st)}</span></span>`;
        el.innerHTML =
          summaryBar +
          drBar +
          coBar +
          (otherWarn.length
            ? `<div class="db-xc-bar db-xc-bar-warn" id="db-xc-warnbar"><span>⚠️ ${otherWarn.length} need review — delivery/verify mismatch</span></div>` +
              (xcheck.warnOpen ? `<div class="db-xc-list">${otherWarn.map(e => item(e, 'db-xc-item-warn')).join('')}</div>` : '')
            : '') +
          runSyncBar();
        const db = document.getElementById('db-xc-drbar');
        if (db) db.addEventListener('click', e => {
          if (e.target.id === 'db-xcheck-refresh') return;
          xcheck.drOpen = !xcheck.drOpen; renderXcheck();
        });
        const cob = document.getElementById('db-xc-cobar');
        if (cob) cob.addEventListener('click', e => {
          if (e.target.id === 'db-xcheck-refresh') return;
          xcheck.coOpen = !xcheck.coOpen; renderXcheck();
        });
        const wb = document.getElementById('db-xc-warnbar');
        if (wb) wb.addEventListener('click', e => {
          if (e.target.id === 'db-xcheck-refresh') return;
          xcheck.warnOpen = !xcheck.warnOpen; renderXcheck();
        });
      }
    }
    el.querySelectorAll('[data-sum]').forEach(tr => {
      tr.addEventListener('click', () => {
        xcheck.sumOpen = xcheck.sumOpen === tr.dataset.sum ? null : tr.dataset.sum;
        renderXcheck();
      });
    });
    el.querySelectorAll('[data-scroll-id]').forEach(n => {
      n.addEventListener('click', () => scrollToRow(n.dataset.scrollId));
    });
    const rb = document.getElementById('db-xcheck-refresh');
    if (rb) rb.addEventListener('click', e => { e.stopPropagation(); maybeRefreshXcheck(true); });
    applyXcheckVisibility();
    paintXcheckToggle();
  }

  // Signature-guarded auto-check: runs on every refreshPanel but hits the
  // network only when the run's ID set actually changed (or forced).
  async function maybeRefreshXcheck(force) {
    const sig = xcheckSig();
    if (sig === null) {
      if (xcheck.sig !== null || xcheck.status !== 'idle') {
        xcheck.sig = null; xcheck.status = 'idle';
        xcheck.warnings = []; xcheck.validated = []; xcheck.details = new Map();
        xcheck.todayCc = []; xcheck.todayCcById = new Map();
        xcheck.drUndelivered = [];
        xcheck.carried = []; xcheck.carriedById = new Map();
        xcheck.verifyRequestIds = []; xcheck.verifyRequestCount = 0;
        xcheck.holdVerified = 0; xcheck.returnVerified = 0;
        xcheck.deliveryRequest = 0; xcheck.achievement = 0;
        xcheck.sumOpen = null;
        fbRunSync.sig = null;
        xcheck.checkedAt = 0;
        closeReport();
        renderXcheck();
      }
      return;
    }
    if (!force && (sig === xcheck.sig || xcheck.inflight)) return;
    xcheck.sig = sig;
    xcheck.inflight = true;
    if (xcheck.status !== 'done') { xcheck.status = 'loading'; renderXcheck(); }
    try {
      const rows = parcelRows();
      const ids = [...new Set(rows.map(rowId).filter(id => id && ID_REGEX.test(id)))];
      const [todayRows, verifyIds] = await Promise.all([
        xcheckFetchToday(ids),
        xcheckFetchVerifyRequests(ids).catch(() => []),
      ]);
      const pageStatus = new Map();
      parcelRows().forEach(r => {
        const id = rowId(r);
        if (id) pageStatus.set(id, rowStatus(r) || '');
      });
      const { warnings, validated, details, todayCc, todayCcById, drUndelivered, carried, carriedById, holdVerified, returnVerified, deliveryRequest, achievement } = xcheckClassify(todayRows, pageStatus);
      try {
        const bn = await xcheckBnMap();
        details.forEach(e => {
          const hit = bn.get((e.remarkEn || '').toLowerCase());
          if (hit) e.remarkBn = hit;
        });
        (todayCc || []).forEach(c => {
          const hit = bn.get((c.remarkEn || '').toLowerCase());
          if (hit) c.remarkBn = hit;
        });
        (carried || []).forEach(c => {
          const hit = bn.get((c.remarkEn || '').toLowerCase());
          if (hit) c.remarkBn = hit;
        });
      } catch {}
      xcheck.warnings = warnings;
      xcheck.validated = validated;
      xcheck.details = details;
      xcheck.todayCc = todayCc || [];
      xcheck.todayCcById = todayCcById || new Map();
      xcheck.drUndelivered = drUndelivered || [];
      xcheck.carried = carried || [];
      xcheck.carriedById = carriedById || new Map();
      xcheck.verifyRequestIds = Array.isArray(verifyIds) ? verifyIds : [];
      xcheck.verifyRequestCount = xcheck.verifyRequestIds.length;
      xcheck.holdVerified = holdVerified || 0;
      xcheck.returnVerified = returnVerified || 0;
      xcheck.deliveryRequest = deliveryRequest || 0;
      xcheck.achievement = achievement || 0;
      console.log(`[DB XCheck] run ${getRunId()}: ${ids.length} IDs → ${todayRows.length} CC rows (7d), today CC ${xcheck.todayCc.length}, verify requests ${xcheck.verifyRequestCount}, validated ${validated.length} (verified ${xcheck.holdVerified + xcheck.returnVerified}, delivery req ${xcheck.deliveryRequest}, achievement ${xcheck.achievement}), undelivered ${xcheck.drUndelivered.length}, previous days ${xcheck.carried.length}, warn ${warnings.length}, ok ${validated.length}`);
      xcheck.checkedAt = Date.now();
      xcheck.status = 'done';
    } catch (err) {
      console.warn('[DB XCheck] fetch failed:', err);
      xcheck.status = (err && err.code === 'no-token') ? 'no-token' : 'error';
    } finally {
      xcheck.inflight = false;
      renderXcheck();
      renderReport(); // no-op unless the modal is open
      try { maybeSyncRunStatus(); } catch {}
      try { maybeSyncFirebaseRunStatus(); } catch {}
      // Paint the per-row VALIDATED / error signs with the fresh data.
      // refreshBorders' own injections (.db-tick/.db-row-badge) are observer-
      // skipped, so this can't loop.
      try { if (appState) refreshBorders(appState); } catch {}
      // IDs changed mid-flight → check again for the new set.
      if (xcheckSig() !== null && xcheckSig() !== xcheck.sig) maybeRefreshXcheck(true);
    }
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
        const raw = (input.value || '').trim().toUpperCase();
        // Extract pure 14-char ID (handles pipe suffix "ID|120" + pasted
        // "Consign ID: ..." labels) — never send a dirty string to Supabase.
        const id = cleanConsignment(raw);
        console.log('[DB] SCAN in', inputId, '→ raw:', raw, '→ parsed ID:', id);
        if (!id) {
          console.warn('[DB] ID rejected by regex:', raw);
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
  // Uses chrome.storage.local (not localStorage) — localStorage here would be
  // this PAGE's own storage bucket, completely separate from the extension
  // popup's storage even though popup.js used to write to a same-named key;
  // IDs saved via the Memory tab never actually reached this page that way.
  // chrome.storage.local is shared across both contexts, which is the point.
  // async + not awaited by init() below, so re-renders the panel itself once
  // the storage read resolves rather than making init() wait on it.
  async function applyMemoryToState(st) {
    const memKey = `db-memory-${getRunId()}`;
    try {
      const result = await chrome.storage.local.get([memKey]);
      const mem = result[memKey];
      if (!mem) return;
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
        refreshPanel(st);
        refreshBorders(st);
      }
    } catch (e) {
      console.warn('[DB] Memory load failed:', e);
    }
  }


  // ── TARGET FIELD PICKER ──────────────────────────────────────────────────
  /** Finds visible text-type <input> elements on the page (excluding the
   *  extension's own panel) so the user can pick a manual auto-fill target
   *  instead of relying on the automatic hold/return status routing. */
  function detectPageInputs() {
    return Array.from(document.querySelectorAll('input'))
      .filter(el => el.type === 'text' && el.offsetParent !== null && !el.closest('#db-panel'))
      .map((el, i) => ({
        el,
        label: el.labels?.[0]?.textContent?.trim()
            || el.getAttribute('aria-label')
            || el.placeholder
            || el.name
            || el.id
            || `Field ${i + 1}`
      }));
  }

  function renderFieldList() {
    const listEl = document.getElementById('db-field-list');
    if (!listEl) return;
    const fields = detectPageInputs();
    listEl.innerHTML = fields.length
      ? fields.map((f, i) =>
          `<div class="db-field-row${f.el === selectedFieldEl ? ' selected' : ''}" data-field-idx="${i}">${escapeHtml(f.label)}</div>`
        ).join('')
      : '<div class="db-field-empty">No input field found</div>';
    listEl.querySelectorAll('[data-field-idx]').forEach((el, i) => {
      el.addEventListener('click', () => selectField(fields[i].el));
    });
  }

  /** Sets the manual auto-fill target: clears any previous glow, glows the
   *  newly-picked field on the real page, and re-renders the list so its
   *  highlight matches. fillFromMemory() checks selectedFieldEl first and
   *  falls back to automatic hold/return routing when nothing is selected
   *  (or the selected element was removed by a page re-render). */
  function selectField(el) {
    if (selectedFieldEl) selectedFieldEl.classList.remove('db-field-glow');
    selectedFieldEl = el;
    el.classList.add('db-field-glow');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    renderFieldList();
  }

  // ── FILL FROM MEMORY ─────────────────────────────────────────────────────
  // Iterates saved memory IDs into correct Hermes scan fields.
  // Manual target (selectedFieldEl, via the field picker) wins if set and
  // still attached to the page; otherwise falls back to the automatic
  // routing: On Hold status → #onHoldConsId, everything else → #returnConsId.
  // Each ID is removed from memory after being input.
  // Called from popup via chrome.runtime.onMessage.
  async function fillFromMemory() {
    const memKey = `db-memory-${getRunId()}`;
    let mem;
    try {
      const result = await chrome.storage.local.get([memKey]);
      mem = result[memKey];
      if (!mem) { showToast('Memory', 'No saved IDs for this run', false); return; }
    } catch { return; }

    const ids = [...(mem.ids || [])];
    if (!ids.length) { showToast('Memory', 'Memory khali', false); return; }

    showToast('Memory', `Pasting ${ids.length} IDs…`, false);

    for (const id of ids) {
      let input;
      if (selectedFieldEl && document.body.contains(selectedFieldEl)) {
        input = selectedFieldEl;
      } else {
        const row    = findRowById(id);
        const status = (row ? rowStatus(row) || '' : '').toLowerCase();
        const inputId = HOLD_VALID.has(status) ? HOLD_INPUT_ID : RETURN_INPUT_ID;
        input = document.getElementById(inputId);
      }

      if (input) {
        input.focus();
        // Set value via native input setter so Vue/React reactivity fires
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSet.call(input, id);
        input.dispatchEvent(new Event('input',   { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
      }

      // Remove used ID from memory
      mem.ids = mem.ids.filter(x => x !== id);
      try { await chrome.storage.local.set({ [memKey]: mem }); } catch {}

      await new Promise(r => setTimeout(r, 600)); // Hermes needs time per scan
    }

    showToast('Memory', 'Auto-fill sesh ✓', false);
    refreshPanel(appState);
  }

  // Listen for message from popup — moved inside init() (see below); this
  // used to sit here at top level, which was harmless when the script was
  // scoped to hermes.pathaointernal.com/run-routes/* but started firing on
  // every page once manifest.json broadened matches to <all_urls>, competing
  // with content.js's own onMessage listener on pages like Google Sheets.

  // ── INIT ─────────────────────────────────────────────────────────────────
  let appState = null;

  function init() {
    injectStyle();

    // Listen for message from popup — only registered here (inside init(),
    // i.e. only on pages that passed the initIfAllowed() URL gate) so it
    // doesn't exist on every <all_urls> page and compete with other
    // extension content scripts' own onMessage listeners elsewhere.
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.action === 'db_memory_fill' && message.runId === getRunId()) {
        fillFromMemory();
        sendResponse({ ok: true });
      }
      if (message.action === 'db_run_report') {
        // Popup Run tab-এর জন্য snapshot: run-এর sob parcel + protitar
        // run status ও CC verdict/remark. Table + status-wise grouping
        // popup-e hoy; content script sudhu data pathay.
        (async () => {
          try {
            if (message.force) await maybeRefreshXcheck(true);
            sendResponse({ ok: true, report: buildRunReport() });
          } catch (err) {
            sendResponse({ ok: false, error: (err && err.message) || 'report failed' });
          }
        })();
        return true;
      }
      return false;
    });

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
    appState = initState(holdExpected, returnExpected, allRows.length);
    console.log('[DB] State loaded from storage?', !!(loadState()));
    console.log('[DB] appState.holdExpected:', appState.holdExpected);
    console.log('[DB] appState.returnExpected:', appState.returnExpected);
    console.log('[DB] appState.holdReceived:', appState.holdReceived);
    console.log('[DB] appState.returnReceived:', appState.returnReceived);

    applyMemoryToState(appState); // auto-apply IDs saved in popup Memory tab
    reconcileWithPageState(appState); // clean stale received IDs on load
    reconcileExpectedWithPage(appState); // heal stale expected IDs on load
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

    // Retry: re-build expected sets + re-attach listeners if Hermes
    // rendered the parcel list after init() (SPA async render).
    [1500, 3500].forEach(ms => setTimeout(() => {
      // Late-render heal for the stale-cache case (non-empty but outdated
      // expected sets) — the empty-only rebuild below can't cover it.
      const expChanged = reconcileExpectedWithPage(appState);
      if (expChanged &&
          (appState.holdExpected.length || appState.returnExpected.length)) {
        console.log(`[DB] Retry @${ms}ms: reconciled expected sets with live DOM`,
          appState.holdExpected.length, 'hold /', appState.returnExpected.length, 'return');
        refreshBorders(appState);
        refreshPanel(appState);
      }
      if (!appState.holdExpected.length && !appState.returnExpected.length) {
        const { holdExpected, returnExpected } = buildExpected();
        if (holdExpected.length || returnExpected.length) {
          appState.holdExpected   = holdExpected;
          appState.returnExpected = returnExpected;
          persistState(appState);
          console.log(`[DB] Retry @${ms}ms: rebuilt expected sets`,
            holdExpected.length, 'hold /', returnExpected.length, 'return');
          refreshBorders(appState);
          refreshPanel(appState);
        }
      }
      listenedInputs.clear();
      attachScanListeners(appState);
    }, ms));

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
                reconcileExpectedWithPage(appState);
                refreshBorders(appState);
                refreshPanel(appState);
              }, 100);
            }
          });
        }
      });

      clearTimeout(debounce);
      debounce = setTimeout(() => {
        // Hermes is a Vue SPA — parcel rows may not have been in the DOM
        // when init() ran. If expected sets are still empty but rows exist
        // now, rebuild them before refreshing borders.
        if (!appState.holdExpected.length && !appState.returnExpected.length) {
          const { holdExpected, returnExpected } = buildExpected();
          if (holdExpected.length || returnExpected.length) {
            appState.holdExpected   = holdExpected;
            appState.returnExpected = returnExpected;
            persistState(appState);
            console.log('[DB] MutationObserver: rebuilt expected sets from live DOM',
              holdExpected.length, 'hold /', returnExpected.length, 'return');
          }
        }
        reconcileWithPageState(appState);
        reconcileExpectedWithPage(appState);
        refreshPanel(appState);
        refreshBorders(appState);
      }, 300);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // Now that manifest.json matches <all_urls> (was previously scoped to
  // hermes.pathaointernal.com/run-routes/*), this script runs on every page
  // and self-gates here using a URL allowlist set from the extension popup's
  // Settings tab (chrome.storage.local key: autofill_page_urls — see
  // popup.js). Falls back to the original hardcoded page when nothing has
  // been configured yet, so existing behavior is unchanged by default.
  const DEFAULT_AUTOFILL_URLS = ['hermes.pathaointernal.com/run-routes'];
  async function initIfAllowed() {
    let urls = DEFAULT_AUTOFILL_URLS;
    try {
      const result = await chrome.storage.local.get(['autofill_page_urls']);
      if (Array.isArray(result.autofill_page_urls)) urls = result.autofill_page_urls;
    } catch (e) {
      console.warn('[DB] Could not read autofill_page_urls, using default:', e);
    }
    if (urls.some(u => u && window.location.href.includes(u))) init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initIfAllowed);
  } else {
    initIfAllowed();
  }
})();
