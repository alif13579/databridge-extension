importScripts('config.js');
const FIREBASE_URL = CONFIG.FIREBASE_URL;

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
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.getSelection().toString().trim()
      }, (r) => {
        if (r?.[0]?.result) sendToFirebase(r[0].result);
      });
    } else {
      sendToFirebase(res.text);
    }
  });
}

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
  if (!text) return;

  const { extension_id, container_id } = await new Promise(resolve =>
    chrome.storage.local.get(['extension_id', 'container_id'], resolve)
  );
  if (!extension_id) return;

  const cleaned = text.replace(/[\s\-()]/g, "");
  const isPhone = isPhoneNumber(text);
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

  } catch (error) {
    console.error("❌ DataBridge Error:", error);
  }
}