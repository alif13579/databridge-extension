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

/** Reads the current formula-bar value. Tries known internal class names
 *  first (fast path, kept for whichever Sheets version still uses them),
 *  then falls back to accessibility attributes (aria-label/role) — Google
 *  changes internal obfuscated class names across releases far more often
 *  than it changes accessibility labels (those need to stay stable for
 *  screen readers), so this fallback is meant to survive that churn without
 *  needing a code update every time Google restructures the DOM. */
function readSheetsFormulaBarValue() {
  const knownSelectors = ['.cell-input', '#t-formula-bar-input', '.waffle-formula-bar-input'];
  for (const sel of knownSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const val = el.value ?? el.textContent;
      if (val && val.trim()) return val.trim();
    }
  }

  const ariaCandidates = document.querySelectorAll(
    '[aria-label*="Formula bar" i], [aria-label*="formula" i], [role="textbox"]'
  );
  for (const el of ariaCandidates) {
    const val = el.value ?? el.textContent;
    if (val && val.trim()) return val.trim();
  }

  return null;
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

      // Excel Online — formula bar
      const excelFormulaBar = document.querySelector('[data-automation-id="formulaBarInput"], .formulaBarInput');
      if (excelFormulaBar) {
        const val = excelFormulaBar.value || excelFormulaBar.textContent;
        if (val && val.trim()) {
          lastCellValue = val.trim();
          return;
        }
      }

      // Generic table cell click
      if (target.tagName === 'TD' || target.tagName === 'TH') {
        const val = target.textContent.trim();
        if (val) lastCellValue = val;
      }
    }, 100); // slight delay — Sheets needs time to update formula bar
  });
}

// ══════════════════════════════
// Get best text to send
// priority: selected text > cell value > word under cursor
// ══════════════════════════════
function getBestText() {
  // ১. Selected text আছে?
  const selected = window.getSelection().toString().trim();
  if (selected) return selected;

  // ২. Cell value আছে?
  if (lastCellValue) {
    const val = lastCellValue;
    lastCellValue = null; // use once
    return val;
  }

  // ৩. Word under cursor
  const word = getWordUnderCursor(lastMouseX, lastMouseY);
  if (word) return word;

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