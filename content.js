// ── Current mouse position track ──
let lastMouseX = 0;
let lastMouseY = 0;

document.addEventListener('mousemove', (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
});

// ══════════════════════════════
// Word under mouse cursor
// ══════════════════════════════
function getWordUnderCursor(x, y) {
  let range = null;

  // caretRangeFromPoint (Chrome)
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.setEnd(pos.offsetNode, pos.offset);
    }
  }

  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null;

  const textNode = range.startContainer;
  const text     = textNode.textContent;
  const offset   = range.startOffset;

  // সামনে scan — space/punctuation পর্যন্ত
  let start = offset;
  while (start > 0 && /\S/.test(text[start - 1])) start--;

  // পেছনে scan — space/punctuation পর্যন্ত
  let end = offset;
  while (end < text.length && /\S/.test(text[end])) end++;

  const word = text.slice(start, end).trim();
  return word.length > 0 ? word : null;
}

// ══════════════════════════════
// Cell value (Google Sheets / Excel Online)
// ══════════════════════════════
let lastCellValue = null;

/**
 * ⚠️ FRAGILE — READ BEFORE TOUCHING THIS FUNCTION ⚠️
 *
 * Reads the Google Sheets formula bar's current value (what the shortcut
 * sends when a cell is selected). Confirmed WORKING as of 2026-07-21 with
 * the exact selectors below.
 *
 * This function has regressed 4 times already — twice from Google actually
 * changing Sheets' DOM, twice from well-intentioned refactors that
 * introduced a NEW bug while "fixing" something else. Specific mistakes
 * already made here before (do not repeat):
 *
 *   1. (commit 6a27eb7) Rewriting the combined, comma-separated
 *      `querySelector('.a, .b, .c')` as a sequential per-selector loop
 *      (`for (sel of list) querySelector(sel)`) seems equivalent but ISN'T:
 *      the combined form returns whichever matches FIRST IN DOCUMENT ORDER
 *      across all three; a sequential loop always tries the first selector
 *      in the LIST first regardless of position, and can pick a stale/
 *      hidden element over the real live formula bar.
 *   2. (commit da80521) `[role="textbox"]` and `[aria-label*="formula" i]`
 *      look like reasonable broader fallbacks but both ALSO match the
 *      Sheets Name Box (the "A1"/"B2" cell-reference indicator) — causing
 *      the shortcut to silently send the wrong thing instead of failing
 *      loudly. Only the EXACT `[aria-label="Formula bar"]` is safe.
 *
 * If a person reports this broken again: do NOT guess at a new selector.
 * Check the console logging already in place below first (page console,
 * F12, on the actual Sheets tab) — it shows exactly which candidate
 * element was found (if any) and its raw value, which tells you whether
 * this is a real Google DOM change (both candidates null) or something
 * else (element found, value empty/wrong).
 */
function readSheetsFormulaBarValue() {
  // Selector priority (most stable → least stable):
  //   1. aria-label="Formula bar" — Google keeps this for screen-reader
  //      compat so it survives DOM restructures that rename internal classes.
  //   2. Known internal class names as fallback.
  const ariaEl  = document.querySelector('[aria-label="Formula bar"]');
  const classEl = document.querySelector('.cell-input, #t-formula-bar-input, .waffle-formula-bar-input');
  console.log('[DB] readSheetsFormulaBarValue:', {
    ariaEl:  ariaEl  ? { tag: ariaEl.tagName,  cls: ariaEl.className,  val: ariaEl.value,  text: ariaEl.textContent?.slice(0, 50) }  : null,
    classEl: classEl ? { tag: classEl.tagName, cls: classEl.className, val: classEl.value, text: classEl.textContent?.slice(0, 50) } : null,
  });

  const candidates = [ariaEl, classEl];
  for (const el of candidates) {
    if (!el) continue;
    const val = (el.value != null ? el.value : el.textContent || '').trim();
    if (val) return val;
  }
  console.log('[DB] readSheetsFormulaBarValue: no candidate had a usable value');
  return null;
}

/** Same idea as readSheetsFormulaBarValue() but for Excel Online — extracted
 *  so getBestText() can live-read it too, not just the click listener. */
function readExcelFormulaBarValue() {
  const el = document.querySelector('[data-automation-id="formulaBarInput"], .formulaBarInput');
  if (!el) return null;
  const val = el.value || el.textContent;
  return val && val.trim() ? val.trim() : null;
}

function detectCellClick() {
  document.addEventListener('click', (e) => {
    const target = e.target;

    // Google Sheets — active cell এর formula bar থেকে value নাও
    // Sheets এ cell click হলে formula bar update হয়
    setTimeout(() => {
      const sheetsVal = readSheetsFormulaBarValue();
      if (sheetsVal) {
        lastCellValue = sheetsVal;
        return;
      }

      const excelVal = readExcelFormulaBarValue();
      if (excelVal) {
        lastCellValue = excelVal;
        return;
      }

      // Generic table cell click
      if (target.tagName === 'TD' || target.tagName === 'TH') {
        const val = target.textContent.trim();
        if (val) lastCellValue = val;
      }
    }, 300); // delay — Sheets needs time to update the formula bar after a click
  });
}

// ══════════════════════════════
// Get best text to send
// priority: selected text > cell value (live) > cell value (cached from
// click) > word under cursor
// ══════════════════════════════
function getBestText() {
  // ১. Selected text আছে?
  const selected = window.getSelection().toString().trim();
  if (selected) { console.log('[DB] getBestText: tier=selected-text', selected); return selected; }

  // ২. Cell value — LIVE read at the moment the shortcut fires, before
  // falling back to whatever detectCellClick's click listener cached.
  // Matters because a cell can be selected via keyboard navigation (arrow
  // keys / Tab) without ever firing a click event — detectCellClick() only
  // listens for clicks, so lastCellValue would stay stale (or empty) for a
  // keyboard-selected cell. Reading the formula bar directly, right now,
  // reflects whatever's CURRENTLY selected regardless of how it got
  // selected, so this is correct for both click and keyboard navigation.
  const liveSheetsVal = readSheetsFormulaBarValue();
  if (liveSheetsVal) { console.log('[DB] getBestText: tier=live-sheets', liveSheetsVal); return liveSheetsVal; }

  const liveExcelVal = readExcelFormulaBarValue();
  if (liveExcelVal) { console.log('[DB] getBestText: tier=live-excel', liveExcelVal); return liveExcelVal; }

  // Fallback: cached value from a previous click (e.g. a generic table's
  // TD/TH, which has no formula bar to live-read from at all).
  if (lastCellValue) {
    const val = lastCellValue;
    lastCellValue = null; // use once
    console.log('[DB] getBestText: tier=cached-click', val);
    return val;
  }

  // ৩. Word under cursor
  const word = getWordUnderCursor(lastMouseX, lastMouseY);
  if (word) { console.log('[DB] getBestText: tier=word-under-cursor', word); return word; }

  console.log('[DB] getBestText: no tier matched anything — url:', window.location.hostname);

  return null;
}

// ══════════════════════════════
// Listen for message from background.js
// background.js shortcut/right-click এ এই message পাঠাবে
// ══════════════════════════════
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getBestText') {
    const text = getBestText();
    sendResponse({ text });
  }
});

// ── Init ──
detectCellClick();