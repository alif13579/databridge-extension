/* ══════════════════════════════════════════════════════════════
 * 📞 CALL CENTER desktop — data layer (fetch only, no DOM).
 * Same sources the Android CallCenterFragment uses:
 *   Firebase: courier/runs_by_branchId → courier/run_routes →
 *             courier/consignments, users_by_systemId, config/statusMeta
 *   Supabase: validations (latest + history), validation_remarks (CC),
 *             users (names), branches
 * Auth: Firebase ID token from the extension's Google login (chrome.storage).
 * ══════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const FIREBASE_URL = CONFIG.FIREBASE_URL;
  const FIREBASE_WEB_API_KEY = CONFIG.FIREBASE_WEB_API_KEY;
  const SUPABASE_URL = CONFIG.SUPABASE_URL;
  const SUPABASE_ANON_KEY = CONFIG.SUPABASE_ANON_KEY;

  /* ── small helpers ── */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  const normKey = (s) => String(s || '').trim().toLowerCase().replace(/[\s_]+/g, '');

  /* Dhaka day key yyyy-MM-dd (same as app DhakaTime.dayKey) */
  const BD_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayKey = (ms) => { try { return BD_FMT.format(new Date(ms)); } catch { return ''; } };
  const todayKey = () => BD_FMT.format(new Date());
  const fmtFull = (ms) => {
    if (!ms) return '—';
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: true,
      }).format(new Date(ms));
    } catch { return '—'; }
  };
  const fmtAge = (createdAt, attempt) => {
    if (!createdAt) return `A${attempt || 0}`;
    const days = Math.max(0, Math.floor((Date.now() - createdAt) / 86400000));
    const d = days >= 1 ? `${days}d` : `${Math.max(1, Math.floor((Date.now() - createdAt) / 3600000))}h`;
    return `${d} · A${attempt || 0}`;
  };

  /* run_runId: run_{yyyyMMdd}_{...} → that Dhaka date key */
  const runIdDateKey = (runId) => {
    const m = String(runId || '').match(/^run_(\d{4})(\d{2})(\d{2})_/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  };
  const dateKeyToYmd = (k) => String(k || '').replace(/-/g, '');

  /* ── auth (ported from popup.js token flow) ── */
  async function refreshIdToken(refreshToken) {
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_WEB_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id_token) throw new Error(data?.error?.message || 'Token refresh failed');
    return { idToken: data.id_token, refreshToken: data.refresh_token, expiresIn: parseInt(data.expires_in, 10) || 3600 };
  }

  async function getIdToken() {
    const s = await chrome.storage.local.get(['google_id_token', 'google_refresh_token', 'google_token_expires_at']);
    if (!s.google_refresh_token) return null;
    if (s.google_id_token && Date.now() < (s.google_token_expires_at || 0) - 5 * 60 * 1000) return s.google_id_token;
    const t = await refreshIdToken(s.google_refresh_token);
    await chrome.storage.local.set({
      google_id_token: t.idToken, google_refresh_token: t.refreshToken,
      google_token_expires_at: Date.now() + t.expiresIn * 1000,
    });
    return t.idToken;
  }

  async function getUid() {
    const s = await chrome.storage.local.get(['google_uid']);
    return s.google_uid || null;
  }

  /* ── profile sync (app parity — WITHOUT this, validations RLS has no
   *  UID/branch mapping for this login and correctly returns ZERO rows,
   *  while Firebase parcel reads still work fine).
   *  App flow (SupabaseRemarkValidationWriter.ensureProfileSynced):
   *    1. user-sync Edge Function `sync_profile` (sets role claim server-side)
   *    2. force fresh Firebase ID token so it carries the new claim
   *  Only then are RLS-gated Supabase reads issued. Call once per page load.
   *  Returns { idToken, usersRowMissing }. */
  async function ensureProfileSynced() {
    let idToken = null;
    try { idToken = await getIdToken(); } catch { idToken = null; }
    if (!idToken) return { idToken: null, usersRowMissing: false };
    let usersRowMissing = false;
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/user-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ action: 'sync_profile' }),
      });
      const data = await res.json().catch(() => null);
      const text = JSON.stringify(data || {});
      if (text.includes('"users_row_missing":true')) usersRowMissing = true;
    } catch { /* best-effort — reads below still attempted */ }
    // Force a fresh ID token (SecureToken refresh mints claims as of now),
    // mirroring the app's getIdToken(true) after sync_profile.
    try {
      const s = await chrome.storage.local.get(['google_refresh_token']);
      if (s.google_refresh_token) {
        const t = await refreshIdToken(s.google_refresh_token);
        await chrome.storage.local.set({
          google_id_token: t.idToken, google_refresh_token: t.refreshToken,
          google_token_expires_at: Date.now() + t.expiresIn * 1000,
        });
        idToken = t.idToken;
      }
    } catch { /* keep the previous token */ }
    return { idToken, usersRowMissing };
  }

  /* ── Firebase REST ──
   * App uses the Firebase SDK (one persistent socket, hundreds of parallel
   * gets). REST here is one HTTPS request per read, so: hard timeouts (a
   * single stalled request must never hang the whole load) + high
   * concurrency (HTTP/2 multiplexed) + progress callbacks. */
  function fetchTimeout(url, opts = {}, ms = 20000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
  }

  async function fbGet(path, idToken) {
    const res = await fetchTimeout(`${FIREBASE_URL}/${path}.json?auth=${encodeURIComponent(idToken)}`);
    if (!res.ok) throw new Error(`Firebase ${res.status} on ${path}`);
    return res.json().catch(() => null);
  }

  /* ── Supabase REST ── */
  async function sbGet(path, idToken) {
    const res = await fetchTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${idToken}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status} on ${path.split('?')[0]}`);
    const j = await res.json().catch(() => []);
    return Array.isArray(j) ? j : [];
  }

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  /* ── branches (RLS returns only allowed ones) ── */
  async function loadBranches(idToken) {
    const rows = await sbGet('branches?select=branch_id,name&order=name', idToken);
    return rows.filter((r) => r.branch_id).map((r) => ({ id: r.branch_id, name: r.name || r.branch_id }));
  }

  /* ── statusMeta (labels + colors + chip order) ── */
  let statusMetaCache = null;
  async function loadStatusMeta(idToken) {
    if (statusMetaCache) return statusMetaCache;
    const obj = await fbGet('config/statusMeta', idToken).catch(() => null) || {};
    const map = {};
    for (const [key, s] of Object.entries(obj)) {
      if (!s || typeof s !== 'object') continue;
      map[normKey(key)] = {
        key,
        label: s.bn || s.en || key,
        color: s.color || '#6B7280',
        bg: s.bg || '#F3F4F6',
        sortOrder: s.sortOrder || 0,
        ignoredWhenActual: Array.isArray(s.ignoredWhenActual) ? s.ignoredWhenActual.map((x) => normKey(x)) : [],
      };
    }
    statusMetaCache = map;
    return map;
  }

  const isVerifyRequest = (st) => ['verify_request', 'verifyreq'].includes(normKey(st));
  const isValidated = (st) => ['holdverified', 'returnverified'].includes(normKey(st));
  const isDeliveryRequest = (st) => normKey(st) === 'deliveryrequest';

  function effectiveStatus(remarkStatus, actual, meta) {
    const r = String(remarkStatus || '').trim();
    if (!r) return actual || '';
    const entry = meta[normKey(r)];
    if (entry && entry.ignoredWhenActual.includes(normKey(actual))) return actual || '';
    return r;
  }

  /* ── run index: run IDs for a branch + date ── */
  async function loadRunIds(idToken, branchId, dateKeyStr, runTypes) {
    const types = runTypes && runTypes.length ? runTypes : ['delivery_run'];
    const out = [];
    for (const t of types) {
      const node = await fbGet(`courier/runs_by_branchId/${encodeURIComponent(branchId)}/${encodeURIComponent(t)}`, idToken).catch(() => null);
      if (!node || typeof node !== 'object') continue;
      for (const runId of Object.keys(node)) {
        if (runIdDateKey(runId) === dateKeyStr) out.push({ runType: t, runId });
      }
    }
    return out;
  }

  /* ── run route: consignments + agent ── */
  async function loadRunRoute(idToken, runType, runId) {
    const snap = await fbGet(`courier/run_routes/${encodeURIComponent(runType)}/${encodeURIComponent(runId)}`, idToken).catch(() => null);
    if (!snap || typeof snap !== 'object') return null;
    let agent = String(snap.agentSystemId || '').trim();
    if (!agent) {
      const parts = String(runId).split('_');
      if (parts.length >= 3) agent = parts.slice(2).join('_');
    }
    const cons = snap.consignments && typeof snap.consignments === 'object' ? Object.keys(snap.consignments) : [];
    return { agentSystemId: agent, consignmentIds: cons, createdAt: snap.created_at || 0 };
  }

  /* ── consignment details (high concurrency + progress) ── */
  async function loadConsignments(idToken, ids, onProgress) {
    const out = {};
    const queue = [...new Set(ids)];
    const total = queue.length;
    let done = 0;
    const CONCURRENCY = 24;
    const workers = Array(Math.min(CONCURRENCY, total) || 1).fill(0).map(async () => {
      while (queue.length) {
        const id = queue.shift();
        const c = await fbGet(`courier/consignments/${encodeURIComponent(id)}`, idToken).catch(() => null);
        if (c && typeof c === 'object') out[id] = c;
        done++;
        try { onProgress && onProgress(done, total); } catch { /* ignore */ }
      }
    });
    await Promise.all(workers);
    return out;
  }

  /* ── Edge report (PROVEN path — same call the HV dashboard uses).
   *  Service-role, bypasses RLS; supports consignment/author/status eq filters;
   *  returns author + assigned embeds and Bangla labels. PostgREST direct reads
   *  need a synced role claim and can come back RLS-empty — hence Edge first. */
  async function edgeReport(idToken, { branchId, startIso, endIso, consignment }) {
    const rows = [];
    let page = 0;
    for (;;) {
      const body = {
        action: 'report', branch_id: branchId,
        start_iso: startIso, end_iso: endIso, page, page_size: 100,
      };
      if (consignment) body.consignment = consignment;
      const res = await fetch(`${SUPABASE_URL}/functions/v1/validations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`Edge report ${res.status}: ${t.slice(0, 120)}`);
      }
      const data = await res.json().catch(() => []);
      if (!Array.isArray(data)) throw new Error('Edge report non-array');
      rows.push(...data);
      if (data.length < 100) break;
      page++;
      if (page > 50) break; // safety cap (5000 rows)
    }
    return rows;
  }

  function isoDaysAgo(n) {
    return new Date(Date.now() - n * 86400000).toISOString();
  }

  /* ── branch validations window (for card latest-remarks) ── */
  async function loadBranchValidations(idToken, branchId, days = 60) {
    try {
      return await edgeReport(idToken, {
        branchId, startIso: isoDaysAgo(days), endIso: new Date().toISOString(),
      });
    } catch (e) {
      console.warn('[CC] branch validations (Edge) failed:', e && e.message);
      return [];
    }
  }

  /* ── chunked PostgREST latest (gap-fill only — RLS may return empty;
   *  Edge branch window is primary) ── */
  async function loadLatestRest(idToken, ids) {
    const uniq = [...new Set(ids)];
    const out = {};
    for (const ch of chunk(uniq, 60)) {
      const list = ch.map(encodeURIComponent).join(',');
      const rows = await sbGet(
        `validations?select=consignment,branch_id,assigned_to_system_id,author_system_id,source,remarks_status,remarks,note,created_at` +
        `&consignment=in.(${list})&order=created_at.desc`, idToken).catch((e) => {
          console.warn('[CC] latest validations (REST) failed:', e && e.message);
          return [];
        });
      for (const r of rows) {
        if (r && r.consignment && !out[r.consignment]) out[r.consignment] = r;
      }
    }
    return out;
  }

  function latestFromRows(rows) {
    const out = {};
    for (const r of rows || []) {
      if (r && r.consignment && !out[r.consignment]) out[r.consignment] = r;
    }
    return out; // rows arrive created_at desc — first wins
  }

  /* ── validation history per consignment (Edge wide-range first,
   *  PostgREST fallback; merged + deduped by id) ── */
  async function loadHistory(idToken, consignmentId, branchId) {
    let edgeRows = [];
    if (branchId) {
      try {
        edgeRows = await edgeReport(idToken, {
          branchId, startIso: '2020-01-01T00:00:00.000Z',
          endIso: new Date().toISOString(), consignment: consignmentId,
        });
      } catch (e) {
        console.warn('[CC] history (Edge) failed for', consignmentId, ':', e && e.message);
      }
    }
    let restRows = [];
    try {
      const q = `validations?select=consignment,branch_id,assigned_to_system_id,author_system_id,source,remarks_status,remarks,remarks_bn,note,created_at` +
        `&consignment=eq.${encodeURIComponent(consignmentId)}&order=created_at.desc`;
      restRows = await sbGet(q, idToken);
    } catch (e) {
      console.warn('[CC] history (REST) failed for', consignmentId, ':', e && e.message);
    }
    const seen = new Set();
    const merged = [];
    for (const r of [...edgeRows, ...restRows]) {
      if (!r || typeof r !== 'object') continue;
      const id = r.id ? String(r.id) : `noid:${r.created_at}:${r.remarks_status}:${r.remarks}:${r.note}`;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(r);
    }
    merged.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    try { console.log('[CC] history rows for', consignmentId, ':', merged.length, `(edge:${edgeRows.length} rest:${restRows.length})`); } catch { /* ignore */ }
    return merged;
  }

  /* ── users by system_id (names + phones) ── */
  async function loadUsersBySystemIds(idToken, systemIds) {
    const uniq = [...new Set(systemIds.map((s) => String(s || '').trim()).filter(Boolean))];
    const out = {};
    for (const ch of chunk(uniq, 60)) {
      const list = ch.map(encodeURIComponent).join(',');
      const rows = await sbGet(`users?select=system_id,name,employee_id,phone&system_id=in.(${list})`, idToken).catch(() => []);
      for (const r of rows) {
        if (r && r.system_id) out[r.system_id] = { name: r.name || '', employeeId: r.employee_id || '', phone: r.phone || '' };
      }
    }
    return out;
  }

  /* ── CC remark options ── */
  async function loadRemarkOptions(idToken) {
    let remarkLang = 'bn';
    try {
      const lang = await fbGet('config/language/ccLang', idToken).catch(() => '');
      const v = (typeof lang === 'string' ? lang.trim() : '') || 'bn_en';
      remarkLang = v.split('_')[0] || 'bn';
    } catch { /* default bn */ }
    const rows = await sbGet(
      'validation_remarks?select=remarks_en,remarks_bn,target_status,instruction_text,category&source=eq.CC&is_active=eq.true&order=priority.desc',
      idToken);
    return rows.map((r) => {
      const en = (r.remarks_en || '').trim();
      const bn = (r.remarks_bn || '').trim();
      return {
        label: (remarkLang === 'en' ? (en || bn) : (bn || en)).trim(),
        english: en || bn,
        target: (r.target_status || '').trim(),
        instruction: (r.instruction_text || '').trim(),
        category: (r.category || '').trim(),
      };
    }).filter((o) => o.label && o.target);
  }

  /* run_yyyyMMdd_… → that Dhaka day at noon (same fallback as the app —
   *  millis can never spill into a neighbouring day in any zone) */
  function runIdDayMillis(runId) {
    const m = String(runId || '').match(/^run_(\d{4})(\d{2})(\d{2})_/);
    if (!m) return 0;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], 6, 0, 0);
    return Number.isFinite(t) ? t : 0;
  }

  /* ── assigned-to history (run routes holding this consignment) ── */
  async function loadAssignments(idToken, consignmentId) {
    const idx = await fbGet(`courier/runs_by_consignmentId/${encodeURIComponent(consignmentId)}`, idToken).catch(() => null);
    if (!idx || typeof idx !== 'object') return [];
    const pairs = [];
    for (const [runType, runs] of Object.entries(idx)) {
      if (!runs || typeof runs !== 'object') continue;
      for (const runId of Object.keys(runs)) pairs.push({ runType, runId });
    }
    const out = [];
    for (const { runType, runId } of pairs) {
      const route = await loadRunRoute(idToken, runType, runId).catch(() => null);
      if (route && route.agentSystemId) {
        // created_at missing/0 → fall back to the runId date (app parity),
        // never 0 (which renders as 1970-01-01).
        const at = Number(route.createdAt) > 0 ? Number(route.createdAt) : runIdDayMillis(runId);
        out.push({ ...route, runType, runId, createdAt: at });
      }
    }
    // one entry per (Dhaka day, agent)
    const seen = new Map();
    for (const a of out) {
      const k = `${dayKey(a.createdAt || Date.now())}|${a.agentSystemId}`;
      if (!seen.has(k)) seen.set(k, a);
    }
    return [...seen.values()].sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  }

  /* ── save CC remark (Edge Function, same as app writeAwait) ── */
  async function saveRemark(idToken, { consignmentId, branchId, assignedAgentSystemId, status, remarksEn, remarksBn, note, feedback, validatorName }) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/validations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}`, apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({
        action: 'write',
        row: {
          consignment: consignmentId, branch_id: branchId,
          assigned_to_system_id: assignedAgentSystemId, source: 'CC',
          remarks_status: status, remarks: remarksEn, note,
          ...(remarksBn ? { remarks_bn: remarksBn } : {}),
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  window.CcData = {
    esc, normPhone, normKey, dayKey, todayKey, fmtFull, fmtAge,
    runIdDateKey, dateKeyToYmd,
    getIdToken, getUid, ensureProfileSynced,
    loadBranches, loadStatusMeta,
    isVerifyRequest, isValidated, isDeliveryRequest, effectiveStatus,
    loadRunIds, loadRunRoute, loadConsignments,
    loadBranchValidations, latestFromRows, loadLatestRest, loadHistory, loadUsersBySystemIds,
    loadRemarkOptions, loadAssignments, saveRemark,
  };
})();
