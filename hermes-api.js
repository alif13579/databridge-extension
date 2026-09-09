// Hermes API client + endpoint sniffer — hermes.pathaointernal.com
//
// Auth: the `access_token` inside #app[data-user] is a bcrypt hash, NOT a
// bearer token — it can't authorize anything. The real session is the
// login cookie, so every call below is a same-origin fetch from inside the
// page context: cookies ride along automatically while the user is logged
// in. No token storage, nothing to refresh.
//
// v1 scope: read-only helpers + an opt-out sniffer that records which
// /api/* endpoints the Hermes SPA itself calls (method + URL only, never
// bodies), so the next automation step can reuse proven endpoints instead
// of guessing them. A tiny floating chip shows what's captured + a
// one-click session test.
(function () {
  'use strict';
  if (window.__dbHermesApiLoaded) return;
  window.__dbHermesApiLoaded = true;

  var API_PREFIX = '/api/';
  var SNIFF_KEY = 'hermes_api_sniffed';
  var SNIFF_CAP = 200;
  var PING_PATH = '/api/internal/v1/postal/notifications/count';

  function csrfToken() {
    try {
      var m = document.querySelector('meta[name="csrf-token"]');
      return (m && m.getAttribute('content')) || '';
    } catch (e) { return ''; }
  }

  // Same-origin: page cookies (Laravel session) are sent automatically.
  function apiFetch(path, opts) {
    opts = opts || {};
    var headers = {
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    };
    var csrf = csrfToken();
    if (csrf) headers['X-CSRF-TOKEN'] = csrf;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      credentials: 'include'
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function readUser() {
    try {
      var app = document.getElementById('app');
      if (!app || !app.dataset || !app.dataset.user) return null;
      return JSON.parse(app.dataset.user);
    } catch (e) { return null; }
  }

  function readPermissions() {
    try {
      var app = document.getElementById('app');
      if (!app || !app.dataset || !app.dataset.userPermissions) return null;
      return JSON.parse(app.dataset.userPermissions);
    } catch (e) { return null; }
  }

  // ── Sniffer (page-world hook, URL-only) ──────────────────────────────
  // Content scripts live in an isolated JS world, so the page's own
  // fetch/XHR must be observed from a script injected into page context.
  function startSniff() {
    if (window.__dbHermesSniffing) return;
    window.__dbHermesSniffing = true;

    document.addEventListener('db-hermes-api', function (ev) {
      try {
        var d = (ev && ev.detail) || {};
        if (!d.url || d.url.indexOf('/api/') === -1) return;
        var url = String(d.url);
        // Store origin-relative path only — host never varies here.
        var path = url.replace(/^https?:\/\/[^/]+/i, '');
        chrome.storage.local.get(SNIFF_KEY, function (store) {
          var list = (store && store[SNIFF_KEY]) || [];
          if (!list.some(function (e) { return e.m === d.method && e.u === path; })) {
            list.unshift({ m: d.method || 'GET', u: path, t: Date.now() });
            if (list.length > SNIFF_CAP) list.length = SNIFF_CAP;
            var put = {}; put[SNIFF_KEY] = list;
            chrome.storage.local.set(put, function () { renderChip(list.length); });
          }
        });
      } catch (e) { /* never break the host page */ }
    });

    var hookSrc = '(' + function () {
      function emit(method, url) {
        try {
          if (url && String(url).indexOf('/api/') !== -1) {
            document.dispatchEvent(new CustomEvent('db-hermes-api', {
              detail: { method: method, url: String(url) }
            }));
          }
        } catch (e) {}
      }
      try {
        var origFetch = window.fetch;
        window.fetch = function (input, init) {
          try {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            emit(method, url);
          } catch (e) {}
          return origFetch.apply(this, arguments);
        };
      } catch (e) {}
      try {
        var origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
          try { emit(String(method || 'GET').toUpperCase(), url); } catch (e) {}
          return origOpen.apply(this, arguments);
        };
      } catch (e) {}
    } + ')();';

    try {
      var s = document.createElement('script');
      s.textContent = hookSrc;
      (document.documentElement || document.head).appendChild(s);
      s.remove();
    } catch (e) { /* CSP may block inline page scripts — sniffer stays off */ }
  }

  // ── Floating chip (capture list + session test) ──────────────────────
  var chipEl = null, panelEl = null, countEl = null;

  function ensureUi() {
    if (chipEl) return;
    chipEl = document.createElement('div');
    chipEl.id = 'db-hermes-api-chip';
    chipEl.textContent = '🔌 Hermes API (0)';
    chipEl.title = 'DataBridge — captured Hermes API endpoints';
    chipEl.setAttribute('style', [
      'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483647',
      'background:#0f172a', 'color:#fff', 'font:12px/1.4 system-ui,sans-serif',
      'padding:6px 10px', 'border-radius:16px', 'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,.35)', 'user-select:none'
    ].join(';'));
    chipEl.addEventListener('click', togglePanel);
    document.documentElement.appendChild(chipEl);

    panelEl = document.createElement('div');
    panelEl.setAttribute('style', [
      'position:fixed', 'right:12px', 'bottom:48px', 'z-index:2147483647',
      'width:360px', 'max-height:320px', 'overflow:auto',
      'background:#fff', 'color:#111', 'font:12px/1.5 system-ui,sans-serif',
      'border:1px solid #cbd5e1', 'border-radius:10px',
      'box-shadow:0 8px 28px rgba(0,0,0,.25)', 'padding:10px', 'display:none'
    ].join(';'));
    document.documentElement.appendChild(panelEl);
  }

  function renderChip(n) {
    ensureUi();
    if (countEl === null) { /* first paint */ }
    chipEl.textContent = '🔌 Hermes API (' + n + ')';
  }

  function copyText(t, done) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(function () { done(true); }, function () { done(false); });
      } else {
        var ta = document.createElement('textarea');
        ta.value = t;
        document.documentElement.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) {}
        ta.remove();
        done(ok);
      }
    } catch (e) { done(false); }
  }

  function togglePanel() {
    ensureUi();
    if (panelEl.style.display !== 'none') { panelEl.style.display = 'none'; return; }
    panelEl.style.display = '';
    panelEl.innerHTML = '<div style="color:#64748b">Loading…</div>';
    chrome.storage.local.get(SNIFF_KEY, function (store) {
      var list = (store && store[SNIFF_KEY]) || [];
      var html = '<div style="font-weight:700;margin-bottom:6px">Hermes API — captured endpoints</div>';
      html += '<div style="display:flex;gap:6px;margin-bottom:8px">'
        + '<button data-act="test" style="flex:1">Test session</button>'
        + '<button data-act="copy" style="flex:1">Copy all</button>'
        + '<button data-act="clear">Clear</button></div>';
      html += '<div data-role="msg" style="color:#64748b;margin-bottom:6px">'
        + 'Site-ti normal use koro (orders, run-route) — call gulo ekhane jombe.</div>';
      if (!list.length) {
        html += '<div style="color:#94a3b8">Ekhono kichu capture hoyni.</div>';
      } else {
        html += '<div>' + list.map(function (e) {
          return '<div style="padding:3px 0;border-top:1px solid #f1f5f9">'
            + '<b>' + e.m + '</b> <span>' + e.u.replace(/</g, '&lt;') + '</span></div>';
        }).join('') + '</div>';
      }
      panelEl.innerHTML = html;

      panelEl.querySelector('[data-act="test"]').addEventListener('click', function () {
        var msg = panelEl.querySelector('[data-role="msg"]');
        msg.textContent = 'Testing session…';
        apiFetch(PING_PATH).then(function (r) {
          msg.textContent = r.ok
            ? '✓ Session OK (' + r.status + ') — cookie-auth kaj korche.'
            : '✕ Session fail (' + r.status + ') — Hermes-e login ache kina dekho.';
        }).catch(function (e) {
          msg.textContent = '✕ Request failed: ' + (e && e.message);
        });
      });
      panelEl.querySelector('[data-act="copy"]').addEventListener('click', function (ev) {
        var t = list.map(function (e) { return e.m + ' ' + e.u; }).join('\n');
        var btn = ev.target;
        copyText(t, function (ok) {
          btn.textContent = ok ? '✓ Copied' : '✗ Failed';
          setTimeout(function () { btn.textContent = 'Copy all'; }, 1500);
        });
      });
      panelEl.querySelector('[data-act="clear"]').addEventListener('click', function () {
        var put = {}; put[SNIFF_KEY] = [];
        chrome.storage.local.set(put, function () { renderChip(0); togglePanel(); togglePanel(); });
      });
    });
  }

  // ── Boot (Hermes pages only) ─────────────────────────────────────────
  try {
    if (location.hostname === 'hermes.pathaointernal.com') {
      startSniff();
      ensureUi();
      chrome.storage.local.get(SNIFF_KEY, function (store) {
        renderChip(((store && store[SNIFF_KEY]) || []).length);
      });
    }
  } catch (e) { /* never break the host page */ }

  window.HermesApi = {
    get: apiFetch,
    user: readUser,
    permissions: readPermissions,
    ping: function () { return apiFetch(PING_PATH); }
  };
})();
