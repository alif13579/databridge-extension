// ═══════════════════════════════════════════════════════════
// 📷 SCANNER MODULE — Background Handler
//
// SAVE FLOW:
//   ① chrome.storage.local → scan_log           (always, for popup)
//   ② Firebase: scanned/barcode_scans/{barcode}/scan_{ts}     (always, single source of truth)
//
// PAYLOAD STRUCTURE:
//   {
//     scanned_by   : extension_id,
//     uid          : firebase uid | null,   ← null if not logged in
//     createdAt    : timestamp,
//     url          : page url
//   }
//
//   → barcode lookup:  scanned/barcode_scans/{barcode}
//   → user filter:     where uid == "{firebase_uid}"
//   → no duplication, no session/container split
//
//   Note: this path is NEVER written under container/ — it's always its own top-level
//   scanned/ tree, so a "container_id" field here was misleading. uid is the extension's
//   own chrome.storage.local user_id (stored side-by-side with container_id by
//   resolveContainerFromMeta/completeSignIn in popup.js), i.e. the raw identity rather
//   than the container-formatted string.
//
// BARCODE PARSING:
//   "DN82692872|120"  →  "DN82692872"  (strip from last pipe)
//   "  BD8269  "      →  "BD8269"      (trim whitespace)
//   empty after parse →  skip
//
// TO DISABLE: remove importScripts('scanner-module.js') from background.js
// ═══════════════════════════════════════════════════════════

(function ScannerModule() {

  // ── Barcode Parser ──────────────────────────────────────
  function parseBarcode(raw) {
    const lastPipe = raw.lastIndexOf('|');
    const code = lastPipe !== -1 ? raw.substring(0, lastPipe) : raw;
    return code.trim().toUpperCase();
  }

  // Firebase key cannot contain . # $ [ ] / + or spaces
  function safeBarcodeKey(barcode) {
    return String(barcode).replace(/[.#$[\]/+\s]/g, '_');
  }

  // ── ① Save to chrome.storage.local ──────────────────────
  function saveLocally(barcode, timestamp, url, extensionId) {
    const safeKey = safeBarcodeKey(barcode);
    const entry = {
      barcode      : barcode,
      scanned_by   : extensionId || 'unknown',
      createdAt    : timestamp,
      url          : url
    };
    chrome.storage.local.get(['scan_log'], (result) => {
      const log = result.scan_log || {};
      if (!log[safeKey]) log[safeKey] = {};
      log[safeKey][`scan_${timestamp}`] = entry;
      chrome.storage.local.set({ scan_log: log });
    });
  }

  // ── ② Push to Firebase (single path) ────────────────────
  async function pushToFirebase(barcode, timestamp, pageUrl, extensionId, uid) {
    const safeKey = safeBarcodeKey(barcode);
    const scanKey = `scan_${timestamp}`;
    const payload = {
      scanned_by   : extensionId || 'unknown',
      uid          : uid || null,
      createdAt    : timestamp,
      url          : pageUrl
    };

    try {
      const res = await fetch(
        `${CONFIG.FIREBASE_URL}/scanned/barcode_scans/${safeKey}/${scanKey}.json`,
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

    chrome.storage.local.get(['extension_id', 'user_id'], (stored) => {
      const extensionId = stored.extension_id;
      const uid = stored.user_id || null;
      const { timestamp, url } = message;

      saveLocally(barcode, timestamp, url, extensionId);
      pushToFirebase(barcode, timestamp, url, extensionId, uid);
    });
  });

})();
