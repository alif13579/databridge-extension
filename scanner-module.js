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
//     container_id : container_id | null,   ← null if not logged in
//     createdAt    : timestamp,
//     url          : page url
//   }
//
//   → barcode lookup:  scanned/barcode_scans/{barcode}
//   → user filter:     where container_id == "{id}"
//   → no duplication, no session/container split
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
  // Zebra scanners often append a pipe-separated suffix, e.g.:
  //   "DA140726BDFMZ2|980"  → amount 980 (3+ digits) → strip → "DA140726BDFMZ2"
  //   "DA140726BDFMZ200|00" → suffix "00" (≤2 digits) → KEEP → "DA140726BDFMZ200"
  //   "DN82692872"          → no pipe → keep as-is
  // Rule: only strip if suffix after last | is purely numeric AND 3+ digits.
  function parseBarcode(raw) {
    console.log('[Scanner] raw barcode received:', JSON.stringify(raw));
    const lastPipe = raw.lastIndexOf('|');
    if (lastPipe !== -1) {
      const suffix = raw.substring(lastPipe + 1).trim();
      if (/^\d{3,}$/.test(suffix)) {
        // 3+ digit numeric suffix → likely scanner amount/weight → strip it
        const code = raw.substring(0, lastPipe).trim();
        console.log('[Scanner] stripped numeric suffix:', JSON.stringify(suffix), '→', JSON.stringify(code));
        return code;
      }
      // suffix is ≤2 digits or non-numeric → part of the barcode, keep all
      console.log('[Scanner] suffix kept (≤2 digits or non-numeric):', JSON.stringify(suffix));
    }
    const code = raw.trim();
    console.log('[Scanner] parsed barcode:', JSON.stringify(code));
    return code;
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
  async function pushToFirebase(barcode, timestamp, pageUrl, extensionId, containerId) {
    const safeKey = safeBarcodeKey(barcode);
    const scanKey = `scan_${timestamp}`;
    const payload = {
      scanned_by   : extensionId || 'unknown',
      container_id : containerId || null,
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

    chrome.storage.local.get(['extension_id', 'container_id'], (stored) => {
      const extensionId = stored.extension_id;
      const containerId = stored.container_id || null;
      const { timestamp, url } = message;

      saveLocally(barcode, timestamp, url, extensionId);
      pushToFirebase(barcode, timestamp, url, extensionId, containerId);
    });
  });

})();
