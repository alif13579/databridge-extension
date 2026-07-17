// ═══════════════════════════════════════════════════════════
// 📷 SCANNER MODULE — Background Handler
// Receives zebra_scan messages from scanner-content.js and
// saves to chrome.storage.local under the key 'scan_log':
//
//   scan_log: {
//     "{safeBarcode}": {
//       "scan_{timestamp}": {
//         barcode    : original barcode string
//         scanned_by : extension_id of the scanner
//         createdAt  : unix ms timestamp
//         url        : page url where scan happened
//       }
//     }
//   }
//
// Same barcode scanned again → new scan_{ts} node (never overwrites).
// Firebase sync will be added in a future step.
//
// TO DISABLE: remove importScripts('scanner-module.js') from background.js
// ═══════════════════════════════════════════════════════════

(function ScannerModule() {

  // Firebase key chars that are invalid: . # $ [ ] / + and spaces
  // Replace with underscore so the barcode is a safe key.
  function safeBarcodeKey(barcode) {
    return String(barcode).replace(/[.#$[\]/+\s]/g, '_');
  }

  function saveLocally(message, extensionId) {
    const safeKey = safeBarcodeKey(message.barcode);
    const scanKey = `scan_${message.timestamp}`;

    const entry = {
      barcode    : message.barcode,        // original value preserved here
      scanned_by : extensionId || 'unknown',
      createdAt  : message.timestamp,
      url        : message.url
    };

    chrome.storage.local.get(['scan_log'], (result) => {
      const log = result.scan_log || {};
      if (!log[safeKey]) log[safeKey] = {};
      log[safeKey][scanKey] = entry;
      chrome.storage.local.set({ scan_log: log });
    });
  }

  // Listen for messages from scanner-content.js
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action !== 'zebra_scan') return;
    chrome.storage.local.get(['extension_id'], (stored) => {
      saveLocally(message, stored.extension_id);
    });
  });

})();
