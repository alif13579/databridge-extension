// ═══════════════════════════════════════════════════════════
// 📷 SCANNER MODULE — Background Handler
// Receives zebra_scan messages and saves to Firebase under:
//
//   scanned/
//     {barcode}/
//       scan_{timestamp}/
//         scanned_by  : extension_id of the scanner
//         createdAt   : unix ms timestamp
//         url         : page url where scan happened
//
// Same barcode scanned multiple times → multiple scan_{ts} nodes.
//
// TO DISABLE:  remove importScripts('scanner-module.js') from background.js
// ═══════════════════════════════════════════════════════════

(function ScannerModule() {

  // Firebase key cannot contain  . # $ [ ] / +
  // Replace any of these with underscore so the barcode is a safe key.
  function safeBarcodeKey(barcode) {
    return barcode.replace(/[.#$[\]/+]/g, '_');
  }

  async function saveScan(message) {
    // Read the extension's own ID — used as "scanned_by" identifier
    const { extension_id } = await new Promise(resolve =>
      chrome.storage.local.get(['extension_id'], resolve)
    );

    const safeBarcode = safeBarcodeKey(message.barcode);
    const ts          = message.timestamp;

    const payload = {
      scanned_by: extension_id || 'unknown',
      createdAt : ts,
      url       : message.url
    };

    // PUT creates the node; using timestamp as key means same barcode
    // scanned again simply adds a sibling node — never overwrites.
    const firebaseUrl =
      `${CONFIG.FIREBASE_URL}/scanned/${safeBarcode}/scan_${ts}.json`;

    try {
      const res = await fetch(firebaseUrl, {
        method : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify(payload)
      });
      if (!res.ok) console.error('[Scanner] Firebase error:', res.status);
    } catch (err) {
      console.error('[Scanner] Network error:', err);
    }
  }

  // Listen for messages from scanner-content.js
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'zebra_scan') {
      saveScan(message);
    }
  });

})();
