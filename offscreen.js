// Runs inside the offscreen document. Only chrome.runtime messaging is
// available here (see manifest "offscreen" permission) — background.js
// (a service worker, no DOM) sends the text to copy via sendMessage, and
// this script writes it to the OS clipboard.
//
// Offscreen documents do NOT support navigator.clipboard.writeText()
// (as of this writing) — only the legacy execCommand('copy') path works,
// which needs a focused, selected DOM node to copy from.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen-clipboard-write') return false;

  const ta = document.getElementById('clipboard-relay');
  ta.value = msg.text || '';
  ta.focus();
  ta.select();

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (err) {
    console.error('[DataBridge offscreen] execCommand copy failed:', err);
  }
  sendResponse({ ok });
  return true; // keep the message channel open for the async sendResponse above
});
