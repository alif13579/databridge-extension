// ══════════════════════════════════════════════════════════════════════════
// Scan/Receive Helper — runs on the Hermes run-close / return-receive page
// (https://hermes.pathaointernal.com/run-routes/*)
//
// Problem this solves: when a run closes, an agent's returned (undelivered)
// parcels get scanned one by one into a sidebar input to "receive" them.
// Scanned parcels never got visually distinguished in the main parcel list,
// so anything the agent DIDN'T scan (claimed delivered/handled but maybe
// wasn't) had to be found by manually diffing the scanned list against the
// full parcel list.
//
// Feature A — Reconciliation highlighter:
//   For every parcel row in the main list whose status is On Hold / Return /
//   DRTO / Partial / Exchange, check whether its consignment ID has been
//   scanned into either sidebar panel (#onHoldConsId or #returnConsId).
//     - Scanned  -> ID highlighted GREEN in the main list (reconciled).
//     - Not yet scanned -> ID highlighted RED in the main list (still
//       needs to be handed over / scanned before Close Run).
//
// Feature B — Status popup on scan:
//   When the agent scans/types a consignment ID into either sidebar input
//   and presses Enter, look up that same row in the main parcel list and
//   show a small popup confirming its status badge (e.g. "On Hold",
//   "Return Requested"). Quick sanity check that the scanned parcel matches
//   what the system expects.
//
// Selectors below were taken directly from the live page's DOM (2026-07).
// If Hermes changes its markup/CSS framework, these will need updating —
// they are the single source of truth for "where things live" and are
// kept at the top so future fixes only touch this block.
// ══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── CONFIG ──────────────────────────────────────────────────────────────
  const HOLD_INPUT_ID = 'onHoldConsId';
  const RETURN_INPUT_ID = 'returnConsId';

  // Panel container that wraps each scan input + its growing list of
  // scanned rows. Works for both panels even though onHoldConsId sits one
  // level shallower in the DOM than returnConsId (closest() handles both).
  const PANEL_SELECTOR = '.w-full.border.rounded.p-2.pb-4';

  // A scanned-row that has landed in a panel, e.g.:
  //   <div class="w-full flex flex-row items-center justify-between my-2">
  //     <div>DO140726NMLFBM</div><div>780</div>
  //   </div>
  const SCANNED_ROW_SELECTOR = ':scope > div.my-2';

  // Each parcel in the main list is a `.pt-list-item`. NOTE: the Summary
  // table at the bottom of the same sidebar also uses `.pt-list-item` for
  // its rows, so we disambiguate by requiring a `.w-1/6` child column,
  // which only the real parcel rows have (summary rows use `.w-1/3`).
  const PARCEL_ROW_SELECTOR = '.pt-list-item';
  const PARCEL_ROW_DATA_COLUMN = '.w-1\\/6'; // first w-1/6 column = ID/status/amount

  // Consignment IDs seen on this page are 14-char uppercase alphanumeric
  // tokens (e.g. DM140726KBM449, DS1407269VVA3A) — letter/digit mix varies
  // internally, so we match on length + "has both a letter and a digit"
  // rather than a fixed letter/digit position count.
  const ID_REGEX = /\b(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{14}\b/;

  // Only these statuses are part of the hold/return reconciliation flow —
  // other rows (Delivered, Pending, etc.) are left alone.
  const RECONCILE_STATUS_PATTERN = /HOLD|RETURN|DRTO|PARTIAL|EXCHANGE/i;

  const RESCAN_DEBOUNCE_MS = 250;
  const STATUS_POPUP_DURATION_MS = 4000;

  // ══════════════════════════════
  // Styles
  // ══════════════════════════════

  function injectStyle() {
    if (document.getElementById('db-scan-helper-style')) return;
    const style = document.createElement('style');
    style.id = 'db-scan-helper-style';
    style.textContent = `
      .db-scan-matched, .db-scan-missing {
        border-radius: 3px;
        padding: 0 4px;
        font-weight: 700;
      }
      .db-scan-matched {
        background-color: #d3f9d8 !important;
        color: #1a7a2e !important;
      }
      .db-scan-missing {
        background-color: #ffe3e3 !important;
        color: #c92a2a !important;
      }
      .db-scan-status-popup {
        position: fixed;
        top: 24px;
        right: 24px;
        z-index: 2147483647;
        background: #1a1a1a;
        color: #fff;
        padding: 12px 18px;
        border-radius: 10px;
        font: 14px/1.4 -apple-system, Segoe UI, Roboto, sans-serif;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        max-width: 320px;
        opacity: 0;
        transform: translateY(-8px);
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .db-scan-status-popup.db-visible {
        opacity: 1;
        transform: translateY(0);
      }
      .db-scan-status-popup .db-scan-id {
        font-weight: 700;
        color: #ffe066;
      }
    `;
    document.head.appendChild(style);
  }

  // ══════════════════════════════
  // DOM readers
  // ══════════════════════════════

  /** All real parcel rows in the main list (summary-table rows excluded). */
  function getParcelRows() {
    return [...document.querySelectorAll(PARCEL_ROW_SELECTOR)].filter((row) =>
      row.querySelector(PARCEL_ROW_DATA_COLUMN)
    );
  }

  /** The element holding the plain-text consignment ID inside a parcel row. */
  function getRowIdElement(row) {
    const col = row.querySelector(PARCEL_ROW_DATA_COLUMN);
    return col ? col.querySelector('.flex-1') : null;
  }

  /** The row's status badge text, e.g. "On Hold", "Return Requested". */
  function getRowStatus(row) {
    const badge = row.querySelector('.pt-label-btn');
    return badge ? badge.textContent.trim() : null;
  }

  /** Set of consignment IDs currently scanned into a given panel. */
  function getScannedIds(inputId) {
    const input = document.getElementById(inputId);
    const panel = input && input.closest(PANEL_SELECTOR);
    const ids = new Set();
    if (!panel) return ids;
    panel.querySelectorAll(SCANNED_ROW_SELECTOR).forEach((row) => {
      const idDiv = row.querySelector('div');
      const text = idDiv && idDiv.textContent.trim();
      if (text) ids.add(text);
    });
    return ids;
  }

  // ══════════════════════════════
  // Feature A — Reconciliation highlighter
  // ══════════════════════════════

  function clearHighlights() {
    document.querySelectorAll('.db-scan-matched, .db-scan-missing').forEach((el) => {
      el.classList.remove('db-scan-matched', 'db-scan-missing');
    });
  }

  function runReconciliation() {
    clearHighlights();

    const scannedIds = new Set([
      ...getScannedIds(HOLD_INPUT_ID),
      ...getScannedIds(RETURN_INPUT_ID),
    ]);

    getParcelRows().forEach((row) => {
      const status = getRowStatus(row) || '';
      if (!RECONCILE_STATUS_PATTERN.test(status)) return; // not part of this flow

      const idEl = getRowIdElement(row);
      if (!idEl) return;
      const id = idEl.textContent.trim();
      if (!ID_REGEX.test(id)) return;

      idEl.classList.add(scannedIds.has(id) ? 'db-scan-matched' : 'db-scan-missing');
    });
  }

  // ══════════════════════════════
  // Feature B — Status popup on scan
  // ══════════════════════════════

  function showStatusPopup(consignmentId, status) {
    document.querySelectorAll('.db-scan-status-popup').forEach((el) => el.remove());
    const popup = document.createElement('div');
    popup.className = 'db-scan-status-popup';
    popup.innerHTML = `Consignment <span class="db-scan-id">${consignmentId}</span> — Status: <b>${status}</b>`;
    document.body.appendChild(popup);
    requestAnimationFrame(() => popup.classList.add('db-visible'));
    setTimeout(() => {
      popup.classList.remove('db-visible');
      setTimeout(() => popup.remove(), 250);
    }, STATUS_POPUP_DURATION_MS);
  }

  function findRowById(id) {
    return getParcelRows().find((row) => {
      const idEl = getRowIdElement(row);
      return idEl && idEl.textContent.trim() === id;
    });
  }

  function handleScanSubmit(inputEl) {
    const raw = (inputEl.value || '').trim().toUpperCase();
    if (!ID_REGEX.test(raw)) return; // not a recognizable consignment ID

    // Small delay so the page's own JS has time to add the item to the
    // panel's scanned list (and our next debounced rescan can pick it up)
    // before we look up its status in the main list.
    setTimeout(() => {
      const row = findRowById(raw);
      const status = row && getRowStatus(row);
      if (status) showStatusPopup(raw, status);
      runReconciliation();
    }, 300);
  }

  function setupScanInputListeners() {
    [HOLD_INPUT_ID, RETURN_INPUT_ID].forEach((id) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleScanSubmit(input);
      });
    });
  }

  // ══════════════════════════════
  // Init — debounced re-scan on any DOM change
  // ══════════════════════════════

  let debounceTimer = null;
  function scheduleRescan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runReconciliation, RESCAN_DEBOUNCE_MS);
  }

  function init() {
    injectStyle();
    setupScanInputListeners();
    runReconciliation();

    const observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((m) => {
        const nodes = [...m.addedNodes, ...m.removedNodes];
        return nodes.some((n) => {
          if (n.nodeType !== Node.ELEMENT_NODE) return true;
          return !(n.classList && n.classList.contains('db-scan-status-popup'));
        });
      });
      if (relevant) scheduleRescan();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Scan inputs may not exist yet on first paint if the drawer opens
    // after an async load — retry listener setup a couple of times.
    setTimeout(setupScanInputListeners, 1000);
    setTimeout(setupScanInputListeners, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
