// ═══════════════════════════════════════════════════════════
// 📷 SCANNER MODULE — Content Script
// Detects Zebra Scanner (HID keyboard wedge) input on any page.
//
// HOW IT WORKS:
//   Zebra scanners send barcode chars very fast (< 40 ms apart),
//   then send Enter/Tab as a terminator.  Normal human typing is
//   slower, so we can distinguish the two by timing alone.
//
// TO DISABLE:  remove this entry from manifest.json content_scripts
// ═══════════════════════════════════════════════════════════

(function ZebraScanner() {
  const MIN_LEN  = 6;    // shortest string we treat as a barcode
  const MAX_GAP  = 40;   // ms — scanner chars arrive faster than this
  const END_KEYS = new Set(['Enter', 'Tab']);

  let _buf    = '';
  let _lastAt = 0;

  document.addEventListener('keydown', (e) => {
    const now = Date.now();

    // Gap too long → human typing, not a scanner; reset buffer
    if (_lastAt > 0 && now - _lastAt > MAX_GAP) _buf = '';
    _lastAt = now;

    // Terminator key received → evaluate buffer
    if (END_KEYS.has(e.key)) {
      const barcode = _buf.trim();
      _buf    = '';
      _lastAt = 0;

      if (barcode.length >= MIN_LEN) {
        chrome.runtime.sendMessage({
          action   : 'zebra_scan',
          barcode  : barcode,
          timestamp: now,
          url      : location.href
        }).catch(() => {}); // silently ignore if background is inactive
      }
      return;
    }

    // Accumulate printable characters only (ignore Shift, Ctrl, etc.)
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      _buf += e.key;
    }
  }, true); // capture phase — works inside <input> fields too

})();
