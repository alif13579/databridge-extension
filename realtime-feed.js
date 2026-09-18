// ══════════════════════════════════════════════════════════════════════
// DbRealtimeFeed — tiny dependency-free Supabase Realtime (postgres_changes)
// client shared by the dashboard (popup.js) and the CC panel (cc-panel.js).
//
// Why a hand-rolled Phoenix client instead of @supabase/supabase-js: the
// extension ships no bundler and MV3 content scripts can't import ESM from
// the package — this is ~150 lines covering exactly one use case:
//   INSERT/UPDATE on public.validations, filtered per branch_id.
//
// Auth: Firebase third-party JWT (same token the REST paths already use —
// getValidFirebaseIdToken). RLS on validations (own branch OR assigned
// worker) is enforced server-side on the socket too, so a device only ever
// receives rows it may see.
//
// Quota safety (free tier: 2M msgs/mo, 200 peak conns):
//   • ONE socket per page, one channel, one binding per branch.
//   • Payloads are single rows; callers debounce refetches (burst → 1 fetch).
//   • Callers PAUSE their 30s Edge polling while status is 'live' and resume
//     it on any drop — so normal operation costs ~zero Edge invocations, and
//     a Realtime outage/limit degrades to polling instead of going dark.
//   • Every action (save / Generate / ⟳) works with the socket dead.
//
// Statuses: 'off' (stopped) | 'connecting' | 'live' | 'retry' (backing off).
// onStatus(status) fires on every transition; onRecord(record, type) fires
// for each INSERT/UPDATE/DELETE that passes RLS ('DELETE' never happens on
// validations today — forwarded anyway for forward-compat).
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  if (window.DbRealtimeFeed) return;

  const VSN = '1.0.0';
  const TOPIC = 'realtime:validations-feed';
  const HEARTBEAT_MS = 25_000;
  const HEARTBEAT_GRACE_MS = 12_000;
  const REJOIN_MS = 50 * 60 * 1000; // fresh Firebase JWT before the ~1h expiry
  const BACKOFFS_MS = [2000, 5000, 10_000, 20_000, 30_000, 60_000];

  let ws = null;
  let ref = 0;
  let joinRef = null;
  let hbRef = null;
  let lastHbAck = 0;
  let status = 'off';
  let branchKey = '';
  let opts = null;
  let backoffIdx = 0;
  let timers = { hb: null, rejoin: null, retry: null };

  function setStatus(next, detail) {
    if (status === next) return;
    status = next;
    try { opts && opts.onStatus && opts.onStatus(next, detail); } catch (_) {}
  }

  function clearTimeoutBy(k) {
    try { if (timers[k]) clearTimeout(timers[k]); } catch (_) {}
    timers[k] = null;
  }

  function clearAllTimers() {
    ['hb', 'rejoin', 'retry'].forEach(clearTimeoutBy);
    try { if (timers.hbInt) clearInterval(timers.hbInt); } catch (_) {}
    timers.hbInt = null;
  }

  function send(msg) {
    try {
      if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
    } catch (_) {}
    return false;
  }

  function bindingsFor(branches) {
    return branches.map(b => ({
      event: '*', schema: 'public', table: 'validations',
      filter: 'branch_id=eq.' + b,
    }));
  }

  function scheduleRetry() {
    if (!opts) return;
    setStatus('retry');
    const wait = BACKOFFS_MS[Math.min(backoffIdx, BACKOFFS_MS.length - 1)];
    backoffIdx++;
    clearTimeoutBy('retry');
    timers.retry = setTimeout(() => { connect(); }, wait);
  }

  function heartbeat() {
    if (!ws || ws.readyState !== 1) return;
    if (lastHbAck && (Date.now() - lastHbAck) > HEARTBEAT_MS + HEARTBEAT_GRACE_MS) {
      try { ws.close(); } catch (_) {}
      scheduleRetry();
      return;
    }
    hbRef = String(++ref);
    send([hbRef, hbRef, 'phoenix', 'heartbeat', {}]);
  }

  async function connect() {
    if (!opts) return;
    cleanupSocket();
    setStatus('connecting');
    let token = null;
    try { token = await opts.getToken(); } catch (_) { token = null; }
    if (!token) { scheduleRetry(); return; } // logged-out → retry later, never spin
    let url;
    try {
      const host = opts.supabaseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
      url = 'wss://' + host + '/realtime/v1/websocket?apikey=' +
        encodeURIComponent(opts.anonKey) + '&vsn=' + VSN;
    } catch (_) { scheduleRetry(); return; }
    let sock;
    try { sock = new WebSocket(url); } catch (_) { scheduleRetry(); return; }
    ws = sock;

    sock.onopen = () => {
      joinRef = String(++ref);
      send([joinRef, joinRef, TOPIC, 'phx_join', {
        config: {
          broadcast: { ack: false, self: false },
          presence: { key: '' },
          postgres_changes: bindingsFor(opts.branches),
        },
        access_token: token,
      }]);
    };

    sock.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (!Array.isArray(msg) || msg.length < 4) return;
      const mRef = msg[0], mTopic = msg[2], mEvent = msg[3], payload = msg[4] || {};
      if (mTopic !== TOPIC && mTopic !== 'phoenix') return;
      if (mEvent === 'phx_reply') {
        if (mRef === hbRef) { lastHbAck = Date.now(); return; }
        if (mRef === joinRef) {
          if (payload.status === 'ok') {
            backoffIdx = 0;
            lastHbAck = Date.now();
            setStatus('live');
            clearTimeoutBy('rejoin');
            timers.rejoin = setTimeout(() => { connect(); }, REJOIN_MS); // fresh JWT
          } else {
            scheduleRetry();
          }
        }
        return;
      }
      if (mEvent === 'phx_error' || mEvent === 'phx_close') { scheduleRetry(); return; }
      if (mEvent === 'postgres_changes') {
        try {
          const data = payload.data || {};
          if (data.table === 'validations' && data.record) {
            opts.onRecord && opts.onRecord(data.record, data.type || 'INSERT');
          }
        } catch (_) {}
      }
    };

    sock.onerror = () => { /* onclose follows — reconnect there */ };
    sock.onclose = () => {
      if (ws === sock && opts) scheduleRetry();
    };
  }

  function cleanupSocket() {
    // Close only — heartbeat/retry/rejoin timers survive reconnects; stop()
    // is the only path that clears everything.
    const s = ws;
    ws = null;
    joinRef = null;
    try { if (s) s.close(); } catch (_) {}
  }

  function branchKeyOf(branches) {
    return (branches || []).slice().sort().join('|');
  }

  window.DbRealtimeFeed = {
    /**
     * opts: { supabaseUrl, anonKey, branches[], getToken()->Promise<string|null>,
     *         onRecord(record, type), onStatus(status) }
     * Same branch set + live socket → callbacks swapped, no rejoin.
     */
    ensure(nextOpts) {
      const key = branchKeyOf(nextOpts.branches);
      if (opts && key === branchKey && ws && ws.readyState === 1 && status === 'live') {
        opts.onRecord = nextOpts.onRecord;
        opts.onStatus = nextOpts.onStatus;
        return;
      }
      this.stop();
      if (!nextOpts.branches || !nextOpts.branches.length) return;
      opts = {
        supabaseUrl: nextOpts.supabaseUrl,
        anonKey: nextOpts.anonKey,
        branches: nextOpts.branches.slice(),
        getToken: nextOpts.getToken,
        onRecord: nextOpts.onRecord,
        onStatus: nextOpts.onStatus,
      };
      branchKey = key;
      backoffIdx = 0;
      timers.hbInt = setInterval(heartbeat, HEARTBEAT_MS);
      connect();
    },
    stop() {
      clearAllTimers();
      cleanupSocket();
      opts = null;
      branchKey = '';
      backoffIdx = 0;
      setStatus('off');
    },
    isLive() { return status === 'live'; },
    getStatus() { return status; },
  };

  // Sleeping laptop / dropped Wi-Fi → retry promptly instead of waiting out
  // the backoff ladder.
  try {
    window.addEventListener('online', () => {
      if (opts && status !== 'live' && status !== 'off') {
        clearTimeout(timers.retry);
        backoffIdx = 0;
        connect();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && opts && status !== 'live' && status !== 'off') {
        clearTimeout(timers.retry);
        backoffIdx = 0;
        connect();
      }
    });
  } catch (_) {}
})();
