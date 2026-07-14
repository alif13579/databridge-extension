// ══════════════════════════════════════════════════════════════════════════
// Scan/Receive Helper — runs ONLY on the run-close/return-receive page
// (matches entry in manifest.json — currently a PLACEHOLDER domain,
// "https://www.abc.com/scans*" — swap for the real URL once known).
//
// Problem this solves: when a run closes, an agent's returned (undelivered)
// parcels get scanned one by one into a sidebar input to "receive" them.
// Scanned parcels never got visually distinguished in the main parcel list,
// so anything the agent DIDN'T scan (meaning: claimed delivered but maybe
// wasn't) had to be found by manually diffing the scanned list against the
// full parcel list.
//
// Feature A — Duplicate-ID highlighter (no page selectors needed):
//   Scans all text on the page for exactly-N-digit tokens (consignment IDs),
//   counts how many times each value appears anywhere on the page. A value
//   appearing 2+ times (once in the scan sidebar, once in the main list) gets
//   BOTH occurrences highlighted. A value appearing only once (only in the
//   main list, never scanned) stays unhighlighted — that's the "unreceived"
//   flag staff are hunting for today by hand.
//
// Feature B — Status popup on scan (best-effort without selectors today):
//   When the agent types/scans an N-digit value into an input and presses
//   Enter, look up that same value elsewhere on the page, walk up from it to
//   find the smallest container that also holds one of the KNOWN_STATUSES
//   strings, and show a small popup with that status. Matching is by KNOWN
//   STATUS TEXT CONTENT rather than a CSS selector, specifically so this
//   keeps working even before real id/class selectors are provided — once
//   they are (tomorrow, per plan), swap the TODOs below for exact selectors
//   to make both features faster and more precise.
// ══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── CONFIG — tune these without touching the logic below ──────────────
  const ID_DIGIT_LENGTH = 12;              // consignment ID length to match
  const KNOWN_STATUSES = [                 // exact strings as they appear on the page
    'Hold', 'Delivered', 'Pending', 'Verify Req', 'Return Req',
    'Rejected', 'Confirmed', 'Delivery Req'
  ];
  const RESCAN_DEBOUNCE_MS = 250;          // wait this long after DOM stops changing
  const STATUS_POPUP_DURATION_MS = 4000;
  const MAX_WALK_UP_LEVELS = 8;            // cap ancestor search for Feature B's container

  // TODO (fill in once selectors are provided):
  // const SCAN_INPUT_SELECTOR = '#sidebar-scan-input';   // narrows Feature B's Enter-key listener
  // const PARCEL_LIST_SELECTOR = '.parcel-list-item';    // narrows Feature A's scan scope
  // Until then, Feature A scans document.body globally, and Feature B listens
  // for Enter on ANY text input on the page (filtered to N-digit values).

  const ID_PATTERN = new RegExp(`(?<!\\d)(\\d{${ID_DIGIT_LENGTH}})(?!\\d)`, 'g');

  // ══════════════════════════════
  // Feature A — Duplicate-ID highlighter
  // ══════════════════════════════

  const HIGHLIGHT_CLASS = 'db-scan-match';
  const HIGHLIGHT_TAG = 'MARK';

  function injectHighlightStyle() {
    if (document.getElementById('db-scan-helper-style')) return;
    const style = document.createElement('style');
    style.id = 'db-scan-helper-style';
    style.textContent = `
      mark.${HIGHLIGHT_CLASS} {
        background-color: #ffe066 !important;
        color: #1a1a1a !important;
        border-radius: 3px;
        padding: 0 2px;
        font-weight: 600;
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

  /** Removes all previous highlight wrapping, restoring plain text nodes —
   *  simplest way to stay correct as values dynamically appear/disappear
   *  from the scanned sidebar (rather than trying to diff incrementally). */
  function unwrapPreviousHighlights(root) {
    root.querySelectorAll(`${HIGHLIGHT_TAG}.${HIGHLIGHT_CLASS}`).forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  }

  /** Walks all text nodes under root, returns [{node, matches: [{index, value}]}] */
  function findIdMatchesInTextNodes(root) {
    const results = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // Skip script/style contents and our own popup/highlight artifacts
        const tag = node.parentElement && node.parentElement.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
        if (node.parentElement && node.parentElement.closest('.db-scan-status-popup')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      if (!text || text.length < ID_DIGIT_LENGTH) continue;
      const matches = [...text.matchAll(ID_PATTERN)];
      if (matches.length) results.push({ node, matches });
    }
    return results;
  }

  function wrapMatchInTextNode(textNode, index, length) {
    const range = document.createRange();
    range.setStart(textNode, index);
    range.setEnd(textNode, index + length);
    const mark = document.createElement(HIGHLIGHT_TAG);
    mark.className = HIGHLIGHT_CLASS;
    try {
      range.surroundContents(mark);
    } catch (e) {
      // surroundContents can throw if the range crosses element boundaries —
      // shouldn't happen for a plain text-node range, but guard anyway.
    }
  }

  function runDuplicateHighlighter() {
    unwrapPreviousHighlights(document.body);

    const found = findIdMatchesInTextNodes(document.body);

    // Count occurrences of each ID value across the whole page.
    const counts = new Map();
    found.forEach(({ matches }) => {
      matches.forEach(({ 1: value }) => {
        counts.set(value, (counts.get(value) || 0) + 1);
      });
    });

    // Wrap matches for any value seen 2+ times. Process each text node's
    // matches back-to-front so earlier offsets aren't invalidated by
    // wrapping later ones first.
    found.forEach(({ node, matches }) => {
      const toWrap = matches.filter((m) => counts.get(m[1]) >= 2);
      for (let i = toWrap.length - 1; i >= 0; i--) {
        const m = toWrap[i];
        wrapMatchInTextNode(node, m.index, m[0].length);
      }
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

  /** Given an element containing a matched ID, walks up the DOM to find the
   *  smallest ancestor whose text also contains one of KNOWN_STATUSES —
   *  matched by STATUS TEXT CONTENT, not a selector, so this keeps working
   *  without knowing the page's real card/row structure. */
  function findStatusNearElement(el) {
    let current = el;
    for (let depth = 0; depth < MAX_WALK_UP_LEVELS && current; depth++) {
      const text = current.textContent || '';
      const status = KNOWN_STATUSES.find((s) => text.includes(s));
      if (status) return status;
      current = current.parentElement;
    }
    return null;
  }

  /** Finds the element containing a plain-text occurrence of `value`
   *  elsewhere on the page (excluding the input the agent just typed into),
   *  used to look up that consignment's status in the main list. */
  function findElementContainingValue(value) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const tag = node.parentElement && node.parentElement.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'INPUT' || tag === 'TEXTAREA') {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.parentElement && node.parentElement.closest('.db-scan-status-popup')) {
          return NodeFilter.FILTER_REJECT;
        }
        return node.textContent.includes(value) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    const node = walker.nextNode();
    return node ? node.parentElement : null;
  }

  function handlePossibleScanSubmit(inputEl) {
    const raw = (inputEl.value || '').trim();
    const match = raw.match(new RegExp(`^(\\d{${ID_DIGIT_LENGTH}})$`));
    if (!match) return; // not an N-digit scan — ignore (could be a search box etc.)
    const consignmentId = match[1];

    // Small delay so the page's own JS has time to add the item to the
    // scanned-list sidebar (and Feature A's next MutationObserver pass has
    // time to run) before we look up its status in the main list.
    setTimeout(() => {
      const el = findElementContainingValue(consignmentId);
      if (!el) return;
      const status = findStatusNearElement(el);
      if (status) showStatusPopup(consignmentId, status);
    }, 300);
  }

  function setupScanInputListener() {
    // TODO: once SCAN_INPUT_SELECTOR is known, listen on that element
    // directly instead of delegating from document — narrower, faster,
    // and avoids any chance of matching an unrelated input on the page.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        handlePossibleScanSubmit(target);
      }
    }, true);
  }

  // ══════════════════════════════
  // Init — debounced re-scan on any DOM change
  // ══════════════════════════════

  let debounceTimer = null;
  function scheduleRescan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runDuplicateHighlighter, RESCAN_DEBOUNCE_MS);
  }

  function init() {
    injectHighlightStyle();
    setupScanInputListener();
    runDuplicateHighlighter();

    const observer = new MutationObserver((mutations) => {
      // Ignore mutations that are ONLY our own highlight marks / popup being
      // added-removed, to avoid an infinite observe -> rescan -> mutate loop.
      const relevant = mutations.some((m) => {
        const nodes = [...m.addedNodes, ...m.removedNodes];
        return nodes.some((n) => {
          if (n.nodeType !== Node.ELEMENT_NODE) return true; // text changes etc. are relevant
          return !(n.classList && (n.classList.contains(HIGHLIGHT_CLASS) || n.classList.contains('db-scan-status-popup')));
        });
      });
      if (relevant) scheduleRescan();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
