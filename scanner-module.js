// ═══════════════════════════════════════════════════════════
// 📷 SCANNER MODULE — Background Handler
//
// SAVE FLOW:
//   ① chrome.storage.local → scan_log           (always, for popup)
//   ② sessions/{ext_id}/scanned/{barcode}/scan_{ts}  (always, temp)
//   ③ If container_id exists (user connected/logged in):
//        → container/{id}/scanned/{barcode}/scan_{ts}  (permanent write)
//        → sessions/{ext_id}/scanned/{barcode}/scan_{ts}  DELETE (cleanup)
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
    return code.trim();
  }

  // Firebase key cannot contain . # $ [ ] / + or spaces
  function safeBarcodeKey(barcode) {
    return String(barcode).replace(/[.#$[\]/+\s]/g, '_');
  }

  function firebasePut(url, payload) {
    return fetch(url, {
      method : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(payload)
    }).then(res => {
      if (!res.ok) console.error('[Scanner] PUT error:', res.status, url);
    }).catch(err => console.error('[Scanner] PUT failed:', err, url));
  }

  function firebaseDelete(url) {
    return fetch(url, { method: 'DELETE' })
      .catch(err => console.error('[Scanner] DELETE failed:', err, url));
  }

  // ── ① Save to chrome.storage.local ──────────────────────
  function saveLocally(barcode, timestamp, url, extensionId) {
    const safeKey = safeBarcodeKey(barcode);
    const entry = {
      barcode    : barcode,
      scanned_by : extensionId || 'unknown',
      createdAt  : timestamp,
      url        : url
    };
    chrome.storage.local.get(['scan_log'], (result) => {
      const log = result.scan_log || {};
      if (!log[safeKey]) log[safeKey] = {};
      log[safeKey][`scan_${timestamp}`] = entry;
      chrome.storage.local.set({ scan_log: log });
    });
  }

  // ── ② + ③ Push to Firebase ──────────────────────────────
  async function pushToFirebase(barcode, timestamp, pageUrl, extensionId, containerId) {
    const safeKey    = safeBarcodeKey(barcode);
    const scanKey    = `scan_${timestamp}`;
    const sessionPath =
      `${CONFIG.FIREBASE_URL}/sessions/${extensionId}/scanned/${safeKey}/${scanKey}.json`;
    const payload = {
      scanned_by : extensionId || 'unknown',
      createdAt  : timestamp,
      url        : pageUrl
    };

    // ② Always write to session first (temp)
    await firebasePut(sessionPath, payload);

    if (containerId) {
      const containerPath =
        `${CONFIG.FIREBASE_URL}/container/${containerId}/scanned/${safeKey}/${scanKey}.json`;

      // ③a Permanent write to container
      await firebasePut(containerPath, payload);

      // ③b Cleanup session copy (now redundant)
      await firebaseDelete(sessionPath);
    }
  }

  // ── Message Listener ────────────────────────────────────
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action !== 'zebra_scan') return;

    const barcode = parseBarcode(message.barcode);
    if (!barcode) return; // empty after parsing → skip

    chrome.storage.local.get(['extension_id', 'container_id'], (stored) => {
      const extensionId = stored.extension_id;
      const containerId = stored.container_id || null;
      const { timestamp, url } = message;

      saveLocally(barcode, timestamp, url, extensionId);
      pushToFirebase(barcode, timestamp, url, extensionId, containerId);
    });
  });

})();
