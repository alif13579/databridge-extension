// MV3 service workers can occasionally fail their very first importScripts()
// call with "NetworkError: ... failed to load" (a transient file-read race
// right after the extension installs/updates/reloads). Previously that
// exception was uncaught, so it aborted the rest of background.js entirely —
// no badge restore, no context menu, no message listeners. We now catch it,
// log it, and fall back to an inline copy of the same (non-secret) config so
// the service worker still starts correctly.
try {
  importScripts('config.js');
} catch (err) {
  console.error('[DataBridge] config.js failed to load via importScripts, using built-in fallback config:', err);
}
if (typeof CONFIG === 'undefined') {
  self.CONFIG = {
    FIREBASE_URL: "https://databridgebd-default-rtdb.asia-southeast1.firebasedatabase.app",
    FIREBASE_WEB_API_KEY: "AIzaSyBo6zgv8mF_0d3GjaXu7Eo4HX0e0xMXQQ4",
    PAGINATION_LIMIT: 20
  };
}

try {
  importScripts('scanner-module.js'); // 📷 Scanner Module — remove this line to disable
} catch (err) {
  console.error('[DataBridge] scanner-module.js failed to load — scan features will be unavailable this session:', err);
}

const FIREBASE_URL = CONFIG.FIREBASE_URL;

// Restore badge from stored unread count whenever the service worker wakes up
// (browser restart, extension reload, etc.) so the red badge doesn't disappear.
function restoreBadge() {
  chrome.storage.local.get(['unread_count'], (result) => {
    const count = result.unread_count || 0;
    if (count > 0) {
      chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
      chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  });
}
restoreBadge();
chrome.runtime.onStartup.addListener(restoreBadge);

// App → Extension (auto-copy to clipboard): the service worker has no way to hold
// a persistent connection (EventSource dies once Chrome suspends the worker after
// ~30s idle), so we poll on a chrome.alarms interval instead — the standard MV3
// pattern for "background needs to notice server-side changes periodically".
// This runs whether or not the popup is open; popup.js's own SSE listener
// (sessions/{id} in startSessionListener) still gives instant updates while the
// popup IS open — this alarm exists specifically for the popup-closed case.
const COMMANDS_ALARM = 'databridge-poll-commands';
chrome.alarms.create(COMMANDS_ALARM, { periodInMinutes: 0.5 }); // 30s — alarms API minimum
chrome.runtime.onStartup.addListener(() => chrome.alarms.create(COMMANDS_ALARM, { periodInMinutes: 0.5 }));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === COMMANDS_ALARM) pollIncomingCommands();
});
// A repeating alarm's first tick doesn't fire until periodInMinutes has elapsed —
// poll once immediately too, so a command sent right before the browser reopens
// isn't sitting there for up to 30s longer than it needs to be.
pollIncomingCommands();

// Context menu setup
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "sendToDataBridge",
    title: "📲 Send to DataBridge",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "sendToDataBridge") {
    if (info.selectionText) {
      sendToFirebase(info.selectionText.trim());
    } else {
      askContentScript(tab.id);
    }
  }
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "send-to-databridge") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) askContentScript(tabs[0].id);
    });
  }
});

function askContentScript(tabId) {
  chrome.tabs.sendMessage(tabId, { action: 'getBestText' }, (res) => {
    if (chrome.runtime.lastError || !res?.text) {
      console.log('[DB] askContentScript: content-script path failed/empty —',
        chrome.runtime.lastError?.message || 'res.text was empty', '— falling back to getSelection()');
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.getSelection().toString().trim()
      }, (r) => {
        if (r?.[0]?.result) sendToFirebase(r[0].result);
        else console.log('[DB] askContentScript: fallback getSelection() was also empty — nothing to send');
      });
    } else {
      console.log('[DB] askContentScript: got text from content script:', res.text);
      sendToFirebase(res.text);
    }
  });
}

// cc-panel.js (a content script) has no access to chrome.tabs.* — content
// scripts only get a limited chrome.* surface, tabs.create isn't part of
// it — so its 📞 Call button relays the phone number here to actually
// open the tel: link, same reasoning popup.js's own handleDial() sidesteps
// simply by already running in a full extension-page context.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === 'db_cc_dial' && message.phone) {
    const cleaned = String(message.phone).replace(/[\s-()]/g, '');
    chrome.tabs.create({ url: `tel:${cleaned}` });
  }
});

function isPhoneNumber(text) {
  const s = text.replace(/[\s\-().]/g, '');
  if (/^\+\d{7,15}$/.test(s)) return true;
  if (/^00\d{7,13}$/.test(s)) return true;
  if (/^\d{10,15}$/.test(s)) return true;
  if (/^0\d{9,10}$/.test(s)) return true;
  return false;
}

function normalizePhoneKey(text) {
  let s = text.replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (/^0\d{10}$/.test(s)) s = '880' + s.slice(1);
  return s.replace(/\D/g, '');
}

async function sendToFirebase(text) {
  if (!text) { console.warn('[DB] sendToFirebase: called with empty text — aborting'); return; }

  const { extension_id, container_id } = await new Promise(resolve =>
    chrome.storage.local.get(['extension_id', 'container_id'], resolve)
  );
  console.log('[DB] sendToFirebase: extension_id =', extension_id || '(none)', 'container_id =', container_id || '(none)');
  if (!extension_id) {
    console.warn('[DB] sendToFirebase: no extension_id in storage — aborting silently before this log existed. ' +
      'Likely cause: Disconnect (🔌) clears extension_id and a fresh one is only generated when the popup ' +
      'next opens — open the popup once to regenerate it, then retry.');
    return;
  }

  const isPhone = isPhoneNumber(text);
  // cleaned: for phone numbers, strip spaces/dashes/brackets so the app can dial directly.
  // For non-phone text (names, addresses, etc.), keep the original — stripping spaces from
  // "TANJIR RAHAMAN" produces "TANJIRRAHAMAN" which is wrong for clipboard/display use.
  const cleaned = isPhone ? text.replace(/[\s\-()]/g, "") : text;
  const timestamp = Date.now();
  const itemId = `record_${timestamp}`;

  // ✅ Initialize actions as empty object for new structure
  const payload = {
    text,
    cleaned,
    type: isPhone ? "phone" : "text",
    received_at: timestamp,
    status: "pending",
    actions: {} // ✅ Empty actions object
  };

  try {
    // ✅ 1. Always write to sessions (live sync)
    await fetch(`${FIREBASE_URL}/sessions/${extension_id}/records/${itemId}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    // ✅ 2. If logged in, also backup to container
    if (container_id) {
      await fetch(`${FIREBASE_URL}/container/${container_id}/records/${itemId}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }

    // ✅ 3. Update meta timestamp
    await fetch(`${FIREBASE_URL}/sessions/${extension_id}/meta/updated_at.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(timestamp)
    });

    // ✅ 4. Show notification
    chrome.notifications.create(`notif_${timestamp}`, {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: "DataBridge",
      message: isPhone ? `📞 ${text}` : `📝 ${text.substring(0, 50)}`
    });

    // ✅ 5. Bump unread badge count
    incrementUnreadBadge();

    console.log('[DB] sendToFirebase: done — wrote to sessions/' + extension_id + '/records/' + itemId +
      (container_id ? ' and container/' + container_id + '/records/' + itemId : ' (no container_id, skipped container write)'));

  } catch (error) {
    console.error("❌ DataBridge Error:", error);
  }
}

function incrementUnreadBadge() {
  chrome.storage.local.get(['unread_count'], (result) => {
    const next = (result.unread_count || 0) + 1;
    chrome.storage.local.set({ unread_count: next }, () => {
      chrome.action.setBadgeText({ text: next > 99 ? '99+' : String(next) });
      chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
      chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' });
    });
  });
}

// ── App → Extension: incoming commands (e.g. "send this parcel card's info
// to desktop") ─────────────────────────────────────────────────────────────
// Written by the Android app to sessions/{extension_id}/commands/{cmd_id} —
// same session node the extension already writes records/ and meta/ under,
// so no new Firebase path or security rule is needed on either side.
// Shape: { text, created_at, status: "pending" | "done" }
const PROCESSED_COMMANDS_CAP = 200; // bound the locally-stored id list so it can't grow forever

async function pollIncomingCommands() {
  const { extension_id, auto_copy_incoming, processed_command_ids } = await new Promise(resolve =>
    chrome.storage.local.get(['extension_id', 'auto_copy_incoming', 'processed_command_ids'], resolve)
  );
  if (!extension_id) return; // same "not paired yet" case sendToFirebase() already guards against

  let commands;
  try {
    const res = await fetch(`${FIREBASE_URL}/sessions/${extension_id}/commands.json?orderBy="status"&equalTo="pending"`);
    commands = await res.json();
  } catch (err) {
    console.error('[DB] pollIncomingCommands: fetch failed:', err);
    return;
  }
  if (!commands) return; // node empty/absent — nothing pending

  const processed = new Set(processed_command_ids || []);
  const entries = Object.entries(commands).filter(([id]) => !processed.has(id));
  if (entries.length === 0) return;

  // Oldest first, so if several piled up while the machine was asleep, the clipboard
  // ends up holding the most recent one after the loop (last write wins, same as
  // if they'd arrived one at a time).
  entries.sort((a, b) => (a[1]?.created_at || 0) - (b[1]?.created_at || 0));

  for (const [cmdId, cmd] of entries) {
    const text = cmd?.text;
    if (text) {
      if (auto_copy_incoming) {
        const copied = await writeToClipboardViaOffscreen(text);
        if (copied) {
          chrome.notifications.create(`notif_incoming_${cmdId}`, {
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: 'DataBridge',
            message: `📋 Copied: ${text.substring(0, 50)}`
          });
        } else {
          console.warn('[DB] pollIncomingCommands: clipboard write failed for', cmdId);
        }
      }
      incrementUnreadBadge();
    }
    processed.add(cmdId);
    // Best-effort — mirrors sendToFirebase()'s fire-and-forget-on-failure style;
    // a failed PATCH here just means this command gets re-fetched (but not
    // re-copied, since it's already in `processed`) next poll.
    fetch(`${FIREBASE_URL}/sessions/${extension_id}/commands/${cmdId}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' })
    }).catch(err => console.warn('[DB] pollIncomingCommands: mark-done PATCH failed for', cmdId, err));
  }

  // Trim from the front (oldest) once over the cap.
  const trimmed = [...processed].slice(-PROCESSED_COMMANDS_CAP);
  chrome.storage.local.set({ processed_command_ids: trimmed });
}

// Service workers have no clipboard/DOM access, so this hands the actual write off
// to a short-lived offscreen document (see offscreen.html/js) via chrome.runtime
// messaging — the only API surface offscreen documents support.
async function writeToClipboardViaOffscreen(text) {
  try {
    const offscreenUrl = chrome.runtime.getURL('offscreen.html');
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'Write incoming data from the Android app to the system clipboard'
      });
    }
    const response = await chrome.runtime.sendMessage({ target: 'offscreen-clipboard-write', text });
    return !!response?.ok;
  } catch (err) {
    console.error('[DB] writeToClipboardViaOffscreen failed:', err);
    return false;
  }
}
