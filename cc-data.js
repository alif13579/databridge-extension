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

  /* ── Firebase REST ── */
  async function fbGet(path, idToken) {
    const res = await fetch(`${FIREBASE_URL}/${path}.json?auth=${encodeURIComponent(idToken)}`);
    if (!res.ok) throw new Error(`Firebase ${res.status} on ${path}`);
    return res.json().catch(() => null);
  }

  /* ── Supabase REST ── */
  async function sbGet(path, idToken) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
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

  /* ── consignment details ── */
  async function loadConsignments(idToken, ids) {
    const out = {};
    const queue = [...new Set(ids)];
    const workers = Array(6).fill(0).map(async () => {
      while (queue.length) {
        const id = queue.shift();
        const c = await fbGet(`courier/consignments/${encodeURIComponent(id)}`, idToken).catch(() => null);
        if (c && typeof c === 'object') out[id] = c;
      }
    });
    await Promise.all(workers);
    return out;
  }

  /* ── latest validation per consignment (chunked `in` query) ── */
  async function loadLatestValidations(idToken, ids) {
    const uniq = [...new Set(ids)];
    const out = {};
    for (const ch of chunk(uniq, 60)) {
      const list = ch.map(encodeURIComponent).join(',');
      const rows = await sbGet(
        `validations?select=consignment,branch_id,assigned_to_system_id,author_system_id,source,remarks_status,remarks,note,created_at,author:users!validations_author_system_id_fkey(name,employee_id)` +
        `&consignment=in.(${list})&order=created_at.desc`, idToken).catch(() => []);
      for (const r of rows) {
        if (r && r.consignment && !out[r.consignment]) out[r.consignment] = r;
      }
    }
    return out;
  }

  /* ── validation history per consignment ── */
  async function loadHistory(idToken, consignmentId, branchId) {
    let q = `validations?select=consignment,branch_id,assigned_to_system_id,author_system_id,source,remarks_status,remarks,remarks_bn,note,created_at,author:users!validations_author_system_id_fkey(name,employee_id)` +
      `&consignment=eq.${encodeURIComponent(consignmentId)}&order=created_at.desc`;
    if (branchId) q += `&branch_id=eq.${encodeURIComponent(branchId)}`;
    return sbGet(q, idToken).catch(() => []);
  }

  /* ── users by system_id (names) ── */
  async function loadUsersBySystemIds(idToken, systemIds) {
    const uniq = [...new Set(systemIds.map((s) => String(s || '').trim()).filter(Boolean))];
    const out = {};
    for (const ch of chunk(uniq, 60)) {
      const list = ch.map(encodeURIComponent).join(',');
      const rows = await sbGet(`users?select=system_id,name,employee_id&system_id=in.(${list})`, idToken).catch(() => []);
      for (const r of rows) {
        if (r && r.system_id) out[r.system_id] = { name: r.name || '', employeeId: r.employee_id || '' };
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
      if (route && route.agentSystemId) out.push({ ...route, runType, runId });
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
    getIdToken, getUid,
    loadBranches, loadStatusMeta,
    isVerifyRequest, isValidated, isDeliveryRequest, effectiveStatus,
    loadRunIds, loadRunRoute, loadConsignments,
    loadLatestValidations, loadHistory, loadUsersBySystemIds,
    loadRemarkOptions, loadAssignments, saveRemark,
  };
})();
