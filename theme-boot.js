// Zero-flash theme boot — runs synchronously from <head>, before first paint.
// Reads only the localStorage mirror (sync); popup.js reconciles with the
// chrome.storage.local source of truth on init. Default: light.
try {
  document.documentElement.dataset.theme =
    localStorage.getItem('db_theme_ls') === 'dark' ? 'dark' : 'light';
} catch (e) {
  document.documentElement.dataset.theme = 'light';
}
