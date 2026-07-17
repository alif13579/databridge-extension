// ═══════════════════════════════════════════════════════════
// 📷 SCANNER MODULE — Background Handler
// Receives zebra_scan messages from scanner-content.js,
// parses the barcode, then saves to:
//   ① chrome.storage.local  (key: scan_log)
//   ② Firebase Realtime DB  (scanned/{barcode}/scan_{ts})
//
// BARCODE PARSING RULES:
//   • If barcode contains '|', take everything BEFORE the last '|'
//       "DN82692872|120"   →  "DN82692872"
//       "BKDHSKSJ|230"    →  "BKDHSKSJ"
//       "A|B|C"           →  "A|B"
//   • Always trim leading/trailing whitespace
//   • Empty result after parsing → skip (don't save)
//
// TO DISABLE: remove importScripts('scanner-module.js') from background.js
// ═══════════════════════════════════════════════════════════

(function ScannerModule() {

  // ── Barcode Parser ──────────────────────────────────────
  function parseBarcode(raw) {
    const lastPipe = raw.lastIndexOf('|');
    const code = lastPipe !== -1 ? raw.substring(0, lastPipe) : raw;
    return code.trim();
  }

  // Firebase key cannot contain . # $ [ ] / + or spaces → replace with _
  function safeBarcodeKey(barcode) {
    return String(barcode).replace(/[.#$[\]/+\s]/g, '_');
  }

  // ── ① Save to chrome.storage.local ──────────────────────
  function saveLocally(barcode, timestamp, url, extensionId) {
    const safeKey = safeBarcodeKey(barcode);
    const scanKey = `scan_${timestamp}`;
    const entry = {
      barcode    : barcode,
      scanned_by : extensionId || 'unknown',
      createdAt  : timestamp,
      url        : url
    };
    chrome.storage.local.get(['scan_log'], (result) => {
      const log = result.scan_log || {};
      if (!log[safeKey]) log[safeKey] = {};
      log[safeKey][scanKey] = entry;
      chrome.storage.local.set({ scan_log: log });
    });
  }

  // ── ② Push to Firebase ──────────────────────────────────
  // Path: scanned / {safeBarcode} / scan_{timestamp}
  async function pushToFirebase(barcode, timestamp, url, extensionId) {
    const safeKey = safeBarcodeKey(barcode);
    const scanKey = `scan_${timestamp}`;
    const payload = {
      scanned_by : extensionId || 'unknown',
      createdAt  : timestamp,
      url        : url
    };
    try {
      const res = await fetch(
        `${CONFIG.FIREBASE_URL}/scanned/${safeKey}/${scanKey}.json`,
        {
          method : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body   : JSON.stringify(payload)
        }
      );
      if (!res.ok) console.error('[Scanner] Firebase error:', res.status);
    } catch (err) {
      console.error('[Scanner] Firebase push failed:', err);
    }
  }

  // ── Message Listener ────────────────────────────────────
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action !== 'zebra_scan') return;

    const barcode = parseBarcode(message.barcode);
    if (!barcode) return; // empty after parsing → skip

    chrome.storage.local.get(['extension_id'], (stored) => {
      const extensionId = stored.extension_id;
      const { timestamp, url } = message;

      saveLocally(barcode, timestamp, url, extensionId);
      pushToFirebase(barcode, timestamp, url, extensionId);
    });
  });

})();
