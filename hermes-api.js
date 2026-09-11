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
  // NOTE: this file runs at document_start (see manifest) so the hook is
  // installed BEFORE the Hermes SPA bundle executes — at document_idle
  // the initial page-load calls would already be missed.
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
      // Reachable-from-DOM flag so the content script can verify the hook
      // actually installed (inline page scripts may be blocked by CSP).
      try { document.documentElement.setAttribute('data-db-hook', 'pending'); } catch (e) {}
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
      try { document.documentElement.setAttribute('data-db-hook', 'active'); } catch (e) {}
    } + ')();';

    try {
      var s = document.createElement('script');
      s.textContent = hookSrc;
      (document.documentElement || document.head).appendChild(s);
      s.remove();
      // Verify one tick later whether the page-world script ran at all.
      setTimeout(function () {
        try {
          var st = document.documentElement.getAttribute('data-db-hook');
          window.__dbHookStatus = (st === 'active') ? 'active' : 'blocked-csp';
        } catch (e) { window.__dbHookStatus = 'unknown'; }
      }, 1000);
    } catch (e) { window.__dbHookStatus = 'blocked-csp'; /* CSP may block inline page scripts — sniffer stays off */ }
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
        + 'Capture: browser-level (CSP-proof) — use the site normally '
        + '(orders search, run-route); calls land here live.</div>';
      html += '<div style="display:flex;gap:6px;margin:8px 0">'
        + '<input data-role="probe-id" placeholder="Consignment ID (jemon DR070926TXSTGS)" '
        + 'style="flex:1;border:1px solid #cbd5e1;border-radius:6px;padding:4px 6px;font-size:12px"/>'
        + '<button data-act="probe">Details ano</button></div>'
        + '<div data-role="probe-out" style="display:none;max-height:160px;overflow:auto;'
        + 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:6px;'
        + 'white-space:pre-wrap;word-break:break-all;font-size:11px"></div>';
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
            : '✕ Session failed (' + r.status + ') — check whether you are logged into Hermes.';
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
      // Probe: consignment details via captured endpoint, using the live
      // login session. Shows top-level keys + truncated JSON for verify.
      panelEl.querySelector('[data-act="probe"]').addEventListener('click', function () {
        var id = panelEl.querySelector('[data-role="probe-id"]').value.trim();
        var out = panelEl.querySelector('[data-role="probe-out"]');
        if (!id) { out.style.display = ''; out.textContent = 'Age Consignment ID likho.'; return; }
        out.style.display = '';
        out.textContent = 'Fetching details…';
        window.HermesApi.orderDetails(id).then(function (r) {
          var keys = (r.data && typeof r.data === 'object') ? Object.keys(r.data).join(', ') : typeof r.data;
          var dump = '';
          try { dump = JSON.stringify(r.data).slice(0, 1500); } catch (e) { dump = String(r.data).slice(0, 1500); }
          out.textContent = 'status: ' + r.status + '\nkeys: ' + keys + '\n\n' + dump;
        }).catch(function (e) {
          out.textContent = '✕ Failed: ' + (e && e.message);
        });
      });
    });
  }

  // ── Orders/all auto-history (consignment → phone → full history) ───
  // orders/all-এ Consignment Id দিলে single parcel আসে। Agent-এর আসল দরকার
  // oi customer-এর সব parcel (previous address + last-mile hub দেখে routing
  // error ধরা)। Hermes-এর receiver_phone param full history দেয় — তাই single
  // result এলে phone auto-fill + re-search করে দিই। Guard: phone box ভরা
  // থাকলে বা same ID-তে একবার চালালে আর fire হয় না (loop-proof)।
  var histLastAutoFor = '';

  function toLocalPhone(digits) {
    var d = String(digits || '').replace(/\D/g, '');
    if (/^8801[3-9]\d{8}$/.test(d)) return '0' + d.slice(3);
    if (/^01[3-9]\d{8}$/.test(d)) return d;
    return '';
  }

  function firstPhoneIn(data) {
    var KEYS = ['receiver_phone', 'recipient_phone', 'phone', 'customer_phone', 'consignee_phone', 'mobile'];
    var found = [];
    (function walk(o) {
      if (!o || found.length >= 5) return;
      if (Array.isArray(o)) { for (var i = 0; i < o.length && found.length < 5; i++) walk(o[i]); return; }
      if (typeof o !== 'object') return;
      var keys = Object.keys(o);
      for (var k = 0; k < keys.length; k++) {
        var v = o[keys[k]];
        if (typeof v === 'string' && KEYS.indexOf(keys[k].toLowerCase()) !== -1) {
          var local = toLocalPhone(v);
          if (local) { found.push(local); return; }
        }
      }
      for (var j = 0; j < keys.length && found.length < 5; j++) walk(o[keys[j]]);
    })(data);
    if (found.length) return found[0];
    try {
      var m = JSON.stringify(data).match(/0?1[3-9]\d{8}/);
      if (m) return toLocalPhone(m[0]);
    } catch (e) {}
    return '';
  }

  function consignmentInput() {
    return document.querySelector('input[placeholder="Consignment Id"]');
  }

  function receiverPhoneInput() {
    return document.querySelector('input[placeholder="Receiver Phone"]');
  }

  function resultRows() {
    try {
      return document.querySelectorAll('.pt-list .pt-list-item:not(.pt-list-item-header)');
    } catch (e) { return []; }
  }

  function setVueInput(el, val) {
    try {
      var proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
      var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, val);
      else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    } catch (e) {
      try { el.value = val; } catch (_) {}
    }
  }

  function clickSearchButton() {
    try {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').trim().toLowerCase();
        if (t === 'search' || t.indexOf('search') === 0) { btns[i].click(); return true; }
      }
    } catch (e) {}
    return false;
  }

  function toast(msg) {
    try {
      var el = document.getElementById('db-hermes-hist-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'db-hermes-hist-toast';
        el.setAttribute('style', [
          'position:fixed', 'left:50%', 'bottom:16px', 'transform:translateX(-50%)',
          'z-index:2147483647', 'background:#0f172a', 'color:#fff',
          'font:12px/1.4 system-ui,sans-serif', 'padding:8px 14px',
          'border-radius:16px', 'box-shadow:0 2px 8px rgba(0,0,0,.35)'
        ].join(';'));
        document.documentElement.appendChild(el);
      }
      el.textContent = msg;
      el.style.display = '';
      clearTimeout(el.__t);
      el.__t = setTimeout(function () { el.style.display = 'none'; }, 3500);
    } catch (e) {}
  }

  function maybeAutoHistory() {
    try {
      if (location.pathname.indexOf('/orders/all') !== 0) return;
      var cEl = consignmentInput(), pEl = receiverPhoneInput();
      if (!cEl || !pEl) return;
      if (!cEl.__dbHistBound) {
        cEl.__dbHistBound = true;
        cEl.addEventListener('input', function () { histLastAutoFor = ''; });
      }
      var cid = (cEl.value || '').trim();
      var phoneVal = (pEl.value || '').trim();
      if (cid.length < 10 || phoneVal) {
        if (!cid) histLastAutoFor = '';
        return;
      }
      if (histLastAutoFor === cid) return;
      if (resultRows().length !== 1) return;
      histLastAutoFor = cid; // set BEFORE fetch — double-fire proof
      toast('📞 ' + cid + ' → customer history anchi…');
      window.HermesApi.orderSearch(cid).then(function (r) {
        var phone = (r && r.ok) ? firstPhoneIn(r.data) : '';
        if (!phone) { toast('⚠ No number found — enter it in the phone box manually'); return; }
        setVueInput(pEl, phone);
        clickSearchButton();
        toast('📞 ' + phone + ' — loading all parcels');
      }).catch(function () {
        toast('⚠ Could not load history — enter it in the phone box manually');
      });
    } catch (e) { /* never break host page */ }
  }

  var histDebounce = null;
  function scheduleAutoHistory() {
    clearTimeout(histDebounce);
    histDebounce = setTimeout(maybeAutoHistory, 800);
  }

  // ── Ticket popup (kobiraj my-feed — amar pending tickets) ──────────
  // my-feed = amar jonno pending tickets. 60s poll-e notun ticket ele
  // laptop-e sound + ticket-info toast + badge. Click → ticket khule.
  // First load-e ja ache segulo silent-known (sound storm hobena) —
  // tarpor theke sudhu genuinely-notun gulo alert hoy.
  var TICKET_FEED = '/api/internal/v1/kobiraj/issue/my-feed' +
    '?sla_breached=0&is_reappeared=0&page=1&per_page=20&need_follow_up=1';
  var TICKET_KNOWN_KEY = 'hermes_ticket_known';
  var TICKET_POLL_MS = 60000;
  var ticketKnown = null; // Set<string> — null until first load
  var ticketList = [];
  var ticketTimer = null;
  var ticketChipEl = null, ticketPanelEl = null;

  function ticketListFrom(data) {
    try {
      var d = data && data.data !== undefined ? data.data : data;
      if (Array.isArray(d)) return d;
      if (d && Array.isArray(d.data)) return d.data;
      if (d && Array.isArray(d.items)) return d.items;
      if (d && Array.isArray(d.issues)) return d.issues;
    } catch (e) {}
    return [];
  }

  function normTicket(o) {
    o = o || {};
    var id = o.id || o.issue_id || o.ticket_id || o.uuid || '';
    var team = '';
    try { team = (o.team && o.team.name) || o.team_name || ''; } catch (e) {}
    return {
      id: String(id),
      title: o.subject || o.title || o.issue_title || o.category_name || o.sub_category || String(id),
      cat: o.category || o.category_name || o.sub_category || '',
      team: team,
      sla: o.sla_breached ? 'SLA breached' : (o.sla_status || o.sla || '')
    };
  }

  function beep(times) {
    try {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      var i = 0;
      (function one() {
        try {
          var ctx = new C();
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.type = 'sine'; o.frequency.value = 880;
          g.gain.setValueAtTime(0.001, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.05);
          g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
          o.start(); o.stop(ctx.currentTime + 0.55);
          setTimeout(function () { try { ctx.close(); } catch (e) {} }, 700);
        } catch (e) {}
        if (++i < (times || 1)) setTimeout(one, 350);
      })();
    } catch (e) {}
  }

  function ensureTicketUi() {
    if (ticketChipEl) return;
    ticketChipEl = document.createElement('div');
    ticketChipEl.textContent = '🎫 Tickets';
    ticketChipEl.title = 'DataBridge — amar pending tickets';
    ticketChipEl.setAttribute('style', [
      'position:fixed', 'right:12px', 'bottom:48px', 'z-index:2147483647',
      'background:#7c3aed', 'color:#fff', 'font:12px/1.4 system-ui,sans-serif',
      'padding:6px 10px', 'border-radius:16px', 'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,.35)', 'user-select:none'
    ].join(';'));
    ticketChipEl.addEventListener('click', toggleTicketPanel);
    document.documentElement.appendChild(ticketChipEl);

    ticketPanelEl = document.createElement('div');
    ticketPanelEl.setAttribute('style', [
      'position:fixed', 'right:12px', 'bottom:84px', 'z-index:2147483647',
      'width:360px', 'max-height:340px', 'overflow:auto',
      'background:#fff', 'color:#111', 'font:12px/1.5 system-ui,sans-serif',
      'border:1px solid #cbd5e1', 'border-radius:10px',
      'box-shadow:0 8px 28px rgba(0,0,0,.25)', 'padding:10px', 'display:none'
    ].join(';'));
    document.documentElement.appendChild(ticketPanelEl);
  }

  function renderTicketChip() {
    ensureTicketUi();
    ticketChipEl.textContent = '🎫 Tickets' + (ticketList.length ? ' (' + ticketList.length + ')' : '');
  }

  function toggleTicketPanel() {
    ensureTicketUi();
    if (ticketPanelEl.style.display !== 'none') { ticketPanelEl.style.display = 'none'; return; }
    ticketPanelEl.style.display = '';
    renderTicketList();
  }

  function renderTicketList() {
    var html = '<div style="font-weight:700;margin-bottom:6px">🎫 Amar pending tickets</div>';
    if (!ticketList.length) {
      html += '<div style="color:#94a3b8">No pending tickets. 🎉</div>';
    } else {
      html += ticketList.map(function (t) {
        var meta = [t.cat, t.team, t.sla].filter(Boolean).join(' • ');
        return '<div data-tid="' + String(t.id).replace(/"/g, '') + '" '
          + 'style="padding:6px 4px;border-top:1px solid #f1f5f9;cursor:pointer">'
          + '<div style="font-weight:600">' + String(t.title).replace(/</g, '&lt;') + '</div>'
          + '<div style="color:#64748b;font-size:11px">#' + String(t.id).replace(/</g, '&lt;')
          + (meta ? ' • ' + meta.replace(/</g, '&lt;') : '') + '</div></div>';
      }).join('');
    }
    ticketPanelEl.innerHTML = html;
    ticketPanelEl.querySelectorAll('[data-tid]').forEach(function (n) {
      n.addEventListener('click', function () {
        try { window.open('/issues/' + encodeURIComponent(n.dataset.tid), '_blank'); } catch (e) {}
      });
    });
  }

  function ticketToast(t) {
    try {
      var el = document.getElementById('db-hermes-ticket-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'db-hermes-ticket-toast';
        el.setAttribute('style', [
          'position:fixed', 'left:12px', 'bottom:16px', 'z-index:2147483647',
          'max-width:340px', 'background:#1e1b4b', 'color:#fff',
          'font:12px/1.5 system-ui,sans-serif', 'padding:10px 14px',
          'border-radius:10px', 'box-shadow:0 4px 16px rgba(0,0,0,.4)',
          'cursor:pointer'
        ].join(';'));
        el.addEventListener('click', function () {
          el.style.display = 'none';
          toggleTicketPanel();
          if (ticketPanelEl.style.display === 'none') toggleTicketPanel();
        });
        document.documentElement.appendChild(el);
      }
      el.innerHTML = '<b>🎫 New ticket</b><br>' + String(t.title).replace(/</g, '&lt;')
        + '<br><span style="color:#c4b5fd;font-size:11px">#' + String(t.id).replace(/</g, '&lt;')
        + (t.cat ? ' • ' + String(t.cat).replace(/</g, '&lt;') : '') + '</span>';
      el.style.display = '';
      clearTimeout(el.__t);
      el.__t = setTimeout(function () { el.style.display = 'none'; }, 12000);
    } catch (e) {}
  }

  function loadTicketKnown(done) {
    try {
      chrome.storage.local.get(TICKET_KNOWN_KEY, function (store) {
        try {
          var arr = (store && store[TICKET_KNOWN_KEY]) || [];
          ticketKnown = new Set(arr);
        } catch (e) { ticketKnown = new Set(); }
        done();
      });
    } catch (e) { ticketKnown = new Set(); done(); }
  }

  function saveTicketKnown() {
    try {
      var put = {}; put[TICKET_KNOWN_KEY] = Array.from(ticketKnown).slice(-200);
      chrome.storage.local.set(put);
    } catch (e) {}
  }

  function pollTickets(first) {
    try {
      apiFetch(TICKET_FEED).then(function (r) {
        if (!r || !r.ok) return;
        var fresh = ticketListFrom(r.data).map(normTicket).filter(function (t) { return t.id; });
        ticketList = fresh;
        renderTicketChip();
        if (ticketPanelEl && ticketPanelEl.style.display !== 'none') renderTicketList();
        if (ticketKnown === null) return;
        var isFirst = first && ticketKnown.size === 0;
        var news = fresh.filter(function (t) { return !ticketKnown.has(t.id); });
        fresh.forEach(function (t) { ticketKnown.add(t.id); });
        saveTicketKnown();
        if (isFirst || !news.length) return; // first sighting = silent baseline
        beep(2);
        news.slice(0, 3).forEach(ticketToast);
        if (news.length > 3) toast('🎫 ' + news.length + ' new tickets!');
      }).catch(function () { /* next tick retries */ });
    } catch (e) { /* never break host page */ }
  }

  function startTicketPoll() {
    if (ticketTimer) return;
    renderTicketChip();
    loadTicketKnown(function () { pollTickets(true); });
    try {
      ticketTimer = setInterval(function () { pollTickets(false); }, TICKET_POLL_MS);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) pollTickets(false);
      });
    } catch (e) {}
  }

  // ── Boot (Hermes pages only) ─────────────────────────────────────────
  // First: one automatic session check (cookie-auth proof). Chip shows
  // ✓ when Hermes data calls work, ✕ when login is missing — no click
  // needed, the answer is visible immediately after reload.
  function autoSessionCheck() {
    try {
      apiFetch(PING_PATH).then(function (r) {
        window.__dbHermesSession = !!(r && r.ok);
        ensureUi();
        var base = chipEl ? chipEl.textContent.replace(/ • [✓✕] session$/, '') : '🔌 Hermes API';
        if (chipEl) chipEl.textContent = base + (r && r.ok ? ' • ✓ session' : ' • ✕ login');
        console.log('[DB HermesApi] session check:', r && r.status, r && r.ok ? 'OK — data access kaj korche' : 'FAIL — login lagbe');
      }).catch(function (e) {
        window.__dbHermesSession = false;
        ensureUi();
        if (chipEl && chipEl.textContent.indexOf('✕') === -1) chipEl.textContent += ' • ✕ login';
        console.log('[DB HermesApi] session check failed:', e && e.message);
      });
    } catch (e) {}
  }
  try {
    if (location.hostname === 'hermes.pathaointernal.com') {
      startSniff();
      ensureUi();
      chrome.storage.local.get(SNIFF_KEY, function (store) {
        renderChip(((store && store[SNIFF_KEY]) || []).length);
      });
      // Browser-level capture (background webRequest) lands in the same
      // key — refresh the chip live so the count moves without reopening.
      try {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area === 'local' && changes[SNIFF_KEY]) {
            renderChip((changes[SNIFF_KEY].newValue || []).length);
          }
        });
      } catch (e) {}
  // orders/all auto-history: consignment → phone → full history.
      // (Boot runs at document_start, so bind lazily — inputs may not
      // exist on the very first pass.)
      try {
        var cEl0 = consignmentInput();
        if (cEl0 && !cEl0.__dbHistBound) {
          cEl0.__dbHistBound = true;
          cEl0.addEventListener('input', function () { histLastAutoFor = ''; });
        }
      } catch (e) {}
      try {
        new MutationObserver(scheduleAutoHistory).observe(
          document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
      scheduleAutoHistory();
      // Ticket popup + new-ticket sound/toast.
      try { startTicketPoll(); } catch (e) {}
      // Session proof first — everything else depends on it.
      try { autoSessionCheck(); } catch (e) {}
    }
  } catch (e) { /* never break the host page */ }

  window.HermesApi = {
    get: apiFetch,
    user: readUser,
    permissions: readPermissions,
    ping: function () { return apiFetch(PING_PATH); },
    // ── Captured endpoint helpers (from live sniffing, Sep 2026) ──────
    orderDetails: function (consignmentId) {
      return apiFetch(API_PREFIX + 'v1/orders/' + encodeURIComponent(consignmentId) + '/details');
    },
    orderSearch: function (consignmentId) {
      return apiFetch(API_PREFIX + 'v1/orders/all?consignment_id='
        + encodeURIComponent(consignmentId) + '&all_order_page=true');
    },
    relatedConsIds: function (consignmentId) {
      return apiFetch(API_PREFIX + 'v1/orders/' + encodeURIComponent(consignmentId) + '/related-cons-ids');
    },
    runRoute: function (runId) {
      return apiFetch(API_PREFIX + 'v1/run-routes/' + encodeURIComponent(runId));
    }
  };
})();
