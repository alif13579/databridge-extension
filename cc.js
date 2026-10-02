/* ══════════════════════════════════════════════════════════════
 * 📞 CALL CENTER desktop — UI layer (renders CcData into cc.html).
 * App CallCenterFragment parity: stats + click-filter, search, agent
 * filter, sort (Agents/Attempt/Aging/Smart), status chips, parcel cards
 * (call / remarks / WhatsApp / journey), remark + journey dialogs.
 * Desktop differences: tel:/wa.me links instead of auto-dial, no swipes.
 * ══════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const D = window.CcData;
  const $ = (id) => document.getElementById(id);

  const state = {
    idToken: null,
    parcels: [],          // enriched parcel objects
    meta: {},             // statusMeta
    users: {},            // systemId -> {name, employeeId}
    source: 'request',    // request | live | mix (app ccDataSource parity)
    missingIds: [],       // sheet IDs absent in Firebase (ID-only chips)
    sheetNote: '',        // sheet read note (binding/scope hints)
    lastSheetSig: '',     // silent-tick change detection
    tickTimer: null,
    statFilter: 'all',    // all | request | served | rejected
    statusFilter: 'all',
    search: '',
    agentFilter: '',
    sortMode: 'auto',
    remarkOpts: null,
  };

  /* ── helpers ── */
  function toast(msg, ok = true) {
    const el = $('cc-toast');
    el.textContent = msg;
    el.style.background = ok ? '#15803d' : '#b91c1c';
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      if (!btn) return toast('📋 Copied');
      const o = btn.textContent;
      btn.textContent = '✅';
      setTimeout(() => { btn.textContent = o; }, 1200);
    }).catch(() => toast('Copy failed', false));
  }

  const waLink = (phone, text) =>
    `https://wa.me/${String(phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(text || '')}`;

  function parcelShareText(p) {
    return `📦 ${p.id}\n👤 ${p.customer}\n📞 ${p.phone}\n📍 ${p.address}\n💰 COD: ৳${p.cod}\n🏢 ${p.branchName || ''}`.trim();
  }

  function statusCfg(statusKey) {
    const e = state.meta[D.normKey(statusKey)];
    if (e) return { label: e.label, color: e.color, bg: e.bg, sortOrder: e.sortOrder };
    return { label: String(statusKey || '').trim() || '—', color: '#6B7280', bg: '#F3F4F6', sortOrder: 0 };
  }

  /* ── effective remark fields ── */
  function enrichParcel(p, latest) {
    const r = latest || {};
    const remarkStatus = String(r.remarks_status || '').trim();
    const remarks = String(r.remarks_bn || r.remarks || '').trim();
    const note = String(r.note || '').trim();
    const eff = D.effectiveStatus(remarkStatus, p.status, state.meta);
    const authorName = (r.author && r.author.name ? String(r.author.name).trim() : '') ||
      (state.users[r.author_system_id] ? state.users[r.author_system_id].name : '') ||
      String(r.author_system_id || '').trim();
    return {
      ...p,
      remarkStatus, remarks, note,
      effectiveStatus: eff,
      validationRequest: D.isVerifyRequest(remarkStatus),
      validated: D.isValidated(remarkStatus),
      remarkAuthor: authorName,
      remarkAt: r.created_at || '',
      remarkAuthorId: String(r.author_system_id || '').trim(),
      fromWorker: String(r.source || '').trim().toUpperCase() === 'WORKER',
    };
  }

  /* ── load flow ── */
  function setLoading(on, text) {
    $('cc-loading').hidden = !on;
    if (text) $('cc-loading-text').textContent = text;
    $('cc-load-btn').disabled = on;
  }

  function readCod(c) {
    const v = c.collectableAmount ?? c.cod ?? c.codAmount ?? 0;
    if (typeof v === 'number') return Math.round(v);
    const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? Math.round(n) : 0;
  }

  async function boot() {
    const dateEl = $('cc-date');
    dateEl.value = D.todayKey();
    try {
      const sync = await D.ensureProfileSynced();
      state.idToken = sync.idToken;
      if (sync.usersRowMissing) {
        $('cc-conn').textContent = '⚠ Not onboarded — ask admin';
        $('cc-list').innerHTML = '';
        $('cc-empty').hidden = false;
        $('cc-empty').innerHTML = '⚠<br>No employee record for this Google account.<br>Ask admin to onboard you, then press Load.';
        return;
      }
    } catch { state.idToken = null; }
    if (!state.idToken) {
      $('cc-conn').textContent = '🔴 Guest — log in via popup';
      $('cc-list').innerHTML = '';
      $('cc-empty').hidden = false;
      $('cc-empty').innerHTML = '🔒<br>Log in with Google in the extension popup first,<br>then press Load.';
      return;
    }
    const uid = await D.getUid().catch(() => null);
    $('cc-conn').textContent = `🟢 Connected${uid ? ' · ' + String(uid).slice(0, 6) : ''}`;
    try {
      const [branches, meta] = await Promise.all([D.loadBranches(state.idToken), D.loadStatusMeta(state.idToken)]);
      state.meta = meta;
      const sel = $('cc-branch');
      sel.innerHTML = '';
      if (!branches.length) {
        sel.innerHTML = '<option value="">No branches</option>';
        return;
      }
      for (const b of branches) {
        const o = document.createElement('option');
        o.value = b.id; o.textContent = b.name;
        sel.appendChild(o);
      }
      try {
        const saved = await chrome.storage.local.get(['cc_branch', 'cc_sort', 'cc_source']);
        if (saved.cc_branch && branches.some((b) => b.id === saved.cc_branch)) sel.value = saved.cc_branch;
        if (saved.cc_sort && ['auto', 'attempt', 'aging', 'smart'].includes(saved.cc_sort)) {
          state.sortMode = saved.cc_sort;
          $('cc-sort').value = saved.cc_sort;
        }
        if (saved.cc_source && ['request', 'live', 'mix'].includes(saved.cc_source)) {
          state.source = saved.cc_source;
          $('cc-source').value = saved.cc_source;
        }
      } catch { /* fresh defaults */ }
      await loadParcels();
    } catch (e) {
      $('cc-empty').hidden = false;
      $('cc-empty').textContent = `⚠ Load failed — ${e.message || 'network error'}`;
    }
  }

  /* Parcel master-data cache (runs + consignments change rarely intraday;
   * remarks/validations are always fetched fresh). 10-min TTL, memory first. */
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const memCache = {};
  async function readParcelCache(key) {
    if (memCache[key] && Date.now() - memCache[key].ts < CACHE_TTL_MS) return memCache[key].data;
    try {
      const s = await chrome.storage.session.get([key]);
      const v = s && s[key];
      if (v && Date.now() - v.ts < CACHE_TTL_MS) {
        memCache[key] = v;
        return v.data;
      }
    } catch { /* session storage unavailable */ }
    return null;
  }
  async function writeParcelCache(key, data) {
    const v = { ts: Date.now(), data };
    memCache[key] = v;
    try { await chrome.storage.session.set({ [key]: v }); } catch { /* quota/unsupported — memory still helps */ }
  }

  async function loadParcels() {
    const branchId = $('cc-branch').value;
    const dateStr = $('cc-date').value;
    if (!branchId || !dateStr) return;
    setLoading(true, state.source === 'request' ? 'Loading runs…' : 'Reading sheet…');
    $('cc-empty').hidden = true;
    $('cc-list').innerHTML = '';
    state.missingIds = [];
    state.sheetNote = '';
    try {
      const branchName = $('cc-branch').selectedOptions[0]?.textContent || branchId;
      if (state.source === 'request') {
        const parcels = await buildRequestParcels(branchId, dateStr, branchName);
        finishLoad(parcels || []);
      } else {
        // Sheet IDs first (bindings-driven, today's scope)
        setLoading(true, 'Reading sheet…');
        const live = await window.CcSheet.loadLiveIds(state.idToken, [branchId]);
        const b = (live && live[0]) || { ids: [], note: 'Sheet read failed', failed: true };
        state.sheetNote = b.note || '';
        state.lastSheetSig = b.ids.map((e) => e.cid).sort().join('|');
        if (b.failed) {
          $('cc-empty').hidden = false;
          $('cc-empty').textContent = `⚠ Sheet: ${b.note || 'read failed'}`;
        }
        if (state.source === 'live') {
          const built = await buildSheetParcels(b.ids, [], branchId, branchName);
          finishLoad(built.parcels);
          state.missingIds = built.missing;
          renderMissing();
        } else {
          // mix: request parcels + sheet extras (request wins on duplicates)
          const req = await buildRequestParcels(branchId, dateStr, branchName);
          const have = new Set((req || []).map((p) => p.id));
          const built = await buildSheetParcels(b.ids, [...have], branchId, branchName);
          finishLoad([...(req || []), ...built.parcels]);
          state.missingIds = built.missing;
          renderMissing();
        }
      }
      restartTick();
    } catch (e) {
      $('cc-empty').hidden = false;
      $('cc-empty').textContent = `⚠ Load failed — ${e.message || 'network error'}`;
    } finally {
      setLoading(false);
    }
  }

  /* Request flow (runs → routes → consignments), extracted for reuse. */
  async function buildRequestParcels(branchId, dateStr, branchName) {
      // all run types for this branch+date (delivery/return/…):
      // read the whole branch index once, keep every runType for this date
      const idx = await (async () => {
        const res = await fetch(
          `${CONFIG.FIREBASE_URL}/courier/runs_by_branchId/${encodeURIComponent(branchId)}.json?auth=${encodeURIComponent(state.idToken)}`);
        if (!res.ok) throw new Error(`runs index ${res.status}`);
        return res.json().catch(() => ({}));
      })();
      const runs = [];
      if (idx && typeof idx === 'object') {
        for (const [runType, runMap] of Object.entries(idx)) {
          if (!runMap || typeof runMap !== 'object') continue;
          for (const runId of Object.keys(runMap)) {
            if (D.runIdDateKey(runId) === dateStr) runs.push({ runType, runId });
          }
        }
      }
      if (!runs.length) return [];
      // Master data (runs + consignments) changes rarely intraday → cache it;
      // remarks always load fresh. Same run set = cache hit, else full fetch.
      const runKey = runs.map((r) => `${r.runType}/${r.runId}`).sort().join('|');
      const cacheKey = `cc_cache_${branchId}_${dateStr}`;
      let routes = null;
      let consMap = null;
      const cached = await readParcelCache(cacheKey);
      if (cached && cached.runKey === runKey && cached.routes && cached.cons) {
        routes = cached.routes;
        consMap = cached.cons;
        setLoading(true, 'Loading remarks…');
      } else {
        setLoading(true, `Loading ${runs.length} run(s)…`);
        // routes (8-way parallel — Firebase REST is one request per read)
        const routeResults = [];
        for (let w = 0; w < 8; w++) {
          routeResults.push((async () => {
            const out = [];
            for (let i = w; i < runs.length; i += 8) {
              const r = runs[i];
              const route = await D.loadRunRoute(state.idToken, r.runType, r.runId).catch(() => null);
              if (route) out.push({ ...r, ...route });
            }
            return out;
          })());
        }
        routes = (await Promise.all(routeResults)).flat();
        const ids = [...new Set(routes.flatMap((r) => r.consignmentIds))];
        if (!ids.length) return [];
        setLoading(true, `Loading 0/${ids.length} parcel(s)…`);
        consMap = await D.loadConsignments(state.idToken, ids, (done, total) => {
          const t = $('cc-loading-text');
          if (t) t.textContent = `Loading ${done}/${total} parcel(s)…`;
        });
        writeParcelCache(cacheKey, { runKey, routes, cons: consMap });
      }
      const conIds = [...new Set(routes.flatMap((r) => r.consignmentIds))];
      if (!conIds.length) return [];
      // Latest remarks: branch window (Edge, proven) + REST gap-fill for ids
      // whose latest remark predates the window.
      setLoading(true, 'Loading remarks…');
      const branchRows = await D.loadBranchValidations(state.idToken, branchId, 60);
      const latestMap = D.latestFromRows(branchRows);
      const missingIds = conIds.filter((cid) => !latestMap[cid]);
      if (missingIds.length) {
        const gap = await D.loadLatestRest(state.idToken, missingIds).catch(() => ({}));
        for (const [cid, row] of Object.entries(gap || {})) {
          if (!latestMap[cid]) latestMap[cid] = row;
        }
      }
      return assembleParcels(routes, consMap, latestMap, branchId, branchName);
  }

  /* Sheet extras: sheet IDs absent from the request set. Agent resolved via
   *  runs_by_consignmentId (1 indexed read per id); Firebase-less IDs come
   *  back as missing (ID-only chips, app parity). */
  async function buildSheetParcels(sheetIds, knownIds, branchId, branchName) {
    const fresh = (sheetIds || []).map((e) => e.cid).filter((cid) => cid && !knownIds.includes(cid));
    if (!fresh.length) return { parcels: [], missing: [] };
    setLoading(true, `Loading ${fresh.length} sheet parcel(s)…`);
    const consMap = await D.loadConsignments(state.idToken, fresh, (done, total) => {
      const t = $('cc-loading-text');
      if (t) t.textContent = `Loading ${done}/${total} sheet parcel(s)…`;
    });
    const missing = fresh.filter((cid) => !consMap[cid]);
    // agent per id via consignment index (parallel, best-effort)
    const routes = [];
    const queue = [...fresh.filter((cid) => consMap[cid])];
    const workers = Array(8).fill(0).map(async () => {
      while (queue.length) {
        const cid = queue.shift();
        try {
          const res = await fetch(
            `${CONFIG.FIREBASE_URL}/courier/runs_by_consignmentId/${encodeURIComponent(cid)}.json?auth=${encodeURIComponent(state.idToken)}`);
          const idx = res.ok ? await res.json().catch(() => null) : null;
          if (idx && typeof idx === 'object') {
            outer: for (const [runType, runs] of Object.entries(idx)) {
              if (!runs || typeof runs !== 'object') continue;
              for (const runId of Object.keys(runs)) {
                const route = await D.loadRunRoute(state.idToken, runType, runId).catch(() => null);
                if (route && route.agentSystemId) {
                  routes.push({ runType, runId, ...route, consignmentIds: [cid] });
                  break outer;
                }
              }
            }
          }
        } catch { /* best-effort — card still renders without agent */ }
      }
    });
    await Promise.all(workers);
    const withCons = fresh.filter((cid) => consMap[cid]);
    setLoading(true, 'Loading remarks…');
    const branchRows = await D.loadBranchValidations(state.idToken, branchId, 60).catch(() => []);
    const latestMap = D.latestFromRows(branchRows);
    const missingIds = withCons.filter((cid) => !latestMap[cid]);
    if (missingIds.length) {
      const gap = await D.loadLatestRest(state.idToken, missingIds).catch(() => ({}));
      for (const [cid, row] of Object.entries(gap || {})) {
        if (!latestMap[cid]) latestMap[cid] = row;
      }
    }
    const parcels = await assembleParcels(routes, consMap, latestMap || {}, branchId, branchName);
    return { parcels, missing };
  }

  function renderMissing() {
    const box = $('cc-missing');
    if (!box) return;
    const ids = state.missingIds || [];
    if (!ids.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = '';
    const label = document.createElement('span');
    label.style.cssText = 'font-size:11px;color:#94a3b8;align-self:center;flex:0 0 auto';
    label.textContent = `Sheet-only (${ids.length}):`;
    box.appendChild(label);
    ids.slice(0, 50).forEach((cid) => {
      const b = document.createElement('button');
      b.className = 'cc-miss';
      b.textContent = cid;
      b.title = 'In sheet, not in Firebase — tap to copy';
      b.onclick = () => copyText(cid, b);
      box.appendChild(b);
    });
  }

  /* 45s silent sheet tick (Sheets has no push — app parity). Rebuilds only
   * when the sheet ID set actually changed. */
  function restartTick() {
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
    if (state.source !== 'live' && state.source !== 'mix') return;
    state.tickTimer = setInterval(async () => {
      try {
        const branchId = $('cc-branch').value;
        if (!branchId || (state.source !== 'live' && state.source !== 'mix')) return;
        const live = await window.CcSheet.loadLiveIds(state.idToken, [branchId]).catch(() => null);
        const ids = ((live && live[0] && live[0].ids) || []).map((e) => e.cid).sort().join('|');
        if (ids && ids !== state.lastSheetSig) await loadParcels();
      } catch { /* silent tick never disturbs */ }
    }, 45000);
  }

  /* Shared parcel assembly: users + enrich (request flow and sheet extras). */
  async function assembleParcels(routes, consMap, latestMap, branchId, branchName) {
    const sysIds = (routes || []).map((r) => r.agentSystemId).filter(Boolean);
    Object.values(latestMap || {}).forEach((r) => { if (r && r.author_system_id) sysIds.push(r.author_system_id); });
    state.users = await D.loadUsersBySystemIds(state.idToken, sysIds).catch(() => ({}));
    const conIds = Object.keys(consMap || {});
    const parcels = [];
    for (const id of conIds) {
      const c = consMap[id];
      if (!c) continue;
      const holding = (routes || []).filter((r) => r.consignmentIds.includes(id));
      const workerId = (holding[0] && holding[0].agentSystemId) || '';
      const workerName = (state.users[workerId] && state.users[workerId].name) || workerId || '—';
      const workerPhone = (state.users[workerId] && state.users[workerId].phone) || '';
      const base = {
        id,
        customer: c.recipientName || c.customerName || '—',
        phone: c.recipientPhone || c.customerPhone || c.phone || '',
        address: c.recipientAddress || c.address || '—',
        hub: c.deliveryHub || c.hub || '',
        cod: readCod(c),
        status: c.status || 'pending',
        createdAt: c.createdAt || 0,
        updatedAt: c.updatedAt || 0,
        attempt: c.attempt || c.attemptCount || 0,
        worker: workerName,
        workerId,
        workerPhone,
        branchId,
        branchName,
      };
      parcels.push(enrichParcel(base, (latestMap || {})[id]));
    }
    return parcels;
  }

  function finishLoad(parcels) {
    state.parcels = parcels;
    state.statFilter = 'all';
    state.statusFilter = 'all';
    state.search = '';
    $('cc-search').value = '';
    renderAll();
    renderMissing();
  }

  /* ── filtering + sorting ── */
  function visibleParcels() {
    let list = [...state.parcels];
    if (state.agentFilter) list = list.filter((p) => p.workerId === state.agentFilter);
    if (state.search) {
      const q = state.search.toLowerCase();
      const qd = q.replace(/\D/g, '');
      list = list.filter((p) =>
        p.phone.includes(q) ||
        (qd && String(p.phone).replace(/\D/g, '').includes(qd)) ||
        p.id.toLowerCase().includes(q) ||
        String(p.customer).toLowerCase().includes(q) ||
        String(p.cod).includes(q));
    }
    if (state.statusFilter !== 'all') {
      list = list.filter((p) => D.normKey(p.effectiveStatus) === D.normKey(state.statusFilter));
    }
    if (state.statFilter === 'request') list = list.filter((p) => p.validationRequest);
    else if (state.statFilter === 'served') list = list.filter((p) => p.validated);
    else if (state.statFilter === 'rejected') list = list.filter((p) => D.normKey(p.effectiveStatus) === 'rejected');
    return list;
  }

  function sortGroups(groups) {
    // groups: phone-keyed arrays — same-phone stays adjacent (app parity)
    if (state.sortMode === 'aging') {
      const age = (p) => (p.createdAt > 0 ? p.createdAt : Number.MAX_SAFE_INTEGER);
      groups.sort((a, b) => Math.min(...a.map(age)) - Math.min(...b.map(age)));
      groups.forEach((g) => g.sort((x, y) => age(x) - age(y)));
    } else if (state.sortMode === 'smart') {
      const score = (p) => (p.attempt || 0) * 48 + (p.createdAt > 0 ? Math.max(0, (Date.now() - p.createdAt) / 3600000) : 0);
      const age = (p) => (p.createdAt > 0 ? p.createdAt : Number.MAX_SAFE_INTEGER);
      groups.sort((a, b) => Math.max(...b.map(score)) - Math.max(...a.map(score)) || Math.min(...a.map(age)) - Math.min(...b.map(age)));
      groups.forEach((g) => g.sort((x, y) => score(y) - score(x) || age(x) - age(y)));
    } else {
      // attempt (default): most-attempted group first, oldest tiebreak
      const age = (p) => (p.createdAt > 0 ? p.createdAt : Number.MAX_SAFE_INTEGER);
      groups.sort((a, b) => Math.max(...b.map((p) => p.attempt || 0)) - Math.max(...a.map((p) => p.attempt || 0)) ||
        Math.min(...a.map(age)) - Math.min(...b.map(age)));
      groups.forEach((g) => g.sort((x, y) => (y.attempt || 0) - (x.attempt || 0) || age(x) - age(y)));
    }
    return groups.flat();
  }

  /* ── render ── */
  function renderAll() {
    renderStats();
    renderAgents();
    renderChips();
    renderList();
  }

  function renderStats() {
    const byId = new Map(state.parcels.map((p) => [p.id, p]));
    const all = [...byId.values()];
    const req = all.filter((p) => p.validationRequest).length;
    const srv = all.filter((p) => p.validated).length;
    const rej = all.filter((p) => D.normKey(p.effectiveStatus) === 'rejected').length;
    $('cc-stat-total').textContent = all.length;
    $('cc-stat-request').textContent = req;
    $('cc-stat-served').textContent = srv;
    $('cc-stat-rejected').textContent = rej;
    document.querySelectorAll('#cc-stats .cc-stat').forEach((el) => {
      el.classList.toggle('active', el.dataset.stat === state.statFilter ||
        (state.statFilter === 'all' && el.dataset.stat === 'all'));
    });
  }

  function renderAgents() {
    const sel = $('cc-agent');
    const cur = state.agentFilter || '';
    const map = new Map();
    for (const p of state.parcels) {
      if (p.workerId && !map.has(p.workerId)) map.set(p.workerId, p.worker);
    }
    sel.innerHTML = '<option value="">👥 All Agents</option>';
    [...map.entries()].sort((a, b) => a[1].localeCompare(b[1])).forEach(([id, name]) => {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = `${name} (${state.parcels.filter((p) => p.workerId === id).length})`;
      sel.appendChild(o);
    });
    sel.value = cur;
  }

  function renderChips() {
    const box = $('cc-chips');
    const counts = new Map();
    for (const p of state.parcels) {
      const k = D.normKey(p.effectiveStatus) || 'unknown';
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const items = [...counts.entries()].map(([k, n]) => {
      const sample = state.parcels.find((p) => D.normKey(p.effectiveStatus) === k);
      const cfg = statusCfg(sample ? sample.effectiveStatus : k);
      return { key: sample ? sample.effectiveStatus : k, label: cfg.label, count: n, order: cfg.sortOrder };
    }).sort((a, b) => b.order - a.order || a.label.localeCompare(b.label));
    box.innerHTML = '';
    const mk = (key, label) => {
      const b = document.createElement('button');
      b.className = 'cc-chip' + (D.normKey(key) === D.normKey(state.statusFilter) ||
        (key === 'all' && state.statusFilter === 'all') ? ' active' : '');
      b.textContent = label;
      b.onclick = () => { state.statusFilter = key; renderChips(); renderList(); };
      box.appendChild(b);
    };
    mk('all', `All (${state.parcels.length})`);
    items.forEach((it) => mk(it.key, `${it.label} (${it.count})`));
  }

  function cardHtml(p, phoneIdx, phoneTotal) {
    const cfg = statusCfg(p.effectiveStatus);
    const remarkLine = p.remarks
      ? `<div class="cc-remark">💬 ${D.esc(p.remarks)}${p.note ? `<br>⚠️ Note: ${D.esc(p.note)}` : ''}` +
        `${p.remarkAuthor ? `<span class="cc-remark-time">${D.esc(p.remarkAuthor)}</span>` : ''}</div>`
      : '';
    const agentLine = state.sortMode !== 'auto' && p.worker && p.worker !== '—'
      ? `<div class="cc-agent-line">👤 ${D.esc(p.worker)}</div>` : '';
    const mates = phoneTotal > 1 ? ` <span class="cc-badge" style="background:#0b1526;color:#00d4ff">${phoneIdx}/${phoneTotal}</span>` : '';
    return `
      <div class="cc-card" data-id="${D.esc(p.id)}">
        <div class="cc-card-age">🕐 ${D.fmtAge(p.createdAt, p.attempt)}</div>
        <div class="cc-card-top">
          <span class="cc-cust">${D.esc(p.customer)}</span>
          <span class="cc-cod">৳${p.cod}</span>
        </div>
        <div class="cc-id-row">
          <span class="cc-id" data-copy="${D.esc(p.id)}" title="Tap to copy ID">${D.esc(p.id)}</span>
          <span class="cc-badge" style="color:${cfg.color};background:${cfg.bg}">${D.esc(cfg.label)}</span>
        </div>
        <div class="cc-phone-row">
          <a class="cc-phone" href="tel:${D.esc(String(p.phone).replace(/\D/g, ''))}" title="Tap to call">${D.esc(p.phone || '—')}</a>${mates}
          <button class="cc-copy" data-copy="${D.esc(p.phone)}" title="Copy number">📋</button>
        </div>
        <div class="cc-addr">📍 ${D.esc(p.address)}</div>
        ${agentLine}
        ${remarkLine}
        <div class="cc-actions">
          <a class="cc-act cc-act-call" style="text-decoration:none;text-align:center" href="tel:${D.esc(String(p.phone).replace(/\D/g, ''))}">📞 Call</a>
          <button class="cc-act cc-act-remark" data-act="remark">✏️ Remarks</button>
          <button class="cc-act cc-act-wa" data-act="wa-agent" title="Send parcel info to agent on WhatsApp">💬</button>
          <button class="cc-act cc-act-log" data-act="journey">🕘 Journey</button>
        </div>
      </div>`;
  }

  function renderList() {
    const list = visibleParcels();
    const box = $('cc-list');
    const res = $('cc-result');
    if (state.search || state.statusFilter !== 'all' || state.statFilter !== 'all' || state.agentFilter) {
      res.hidden = false;
      res.textContent = `${list.length} result${list.length === 1 ? '' : 's'}`;
    } else if (state.sheetNote && state.source !== 'request') {
      res.hidden = false;
      res.textContent = `Sheet: ${state.sheetNote}`;
    } else res.hidden = true;
    $('cc-empty').hidden = list.length > 0;
    box.innerHTML = '';
    // phone groups for 1/2 counters (display order)
    const withPhones = list.filter((p) => D.normPhone(p.phone));
    const counts = {};
    withPhones.forEach((p) => { const k = D.normPhone(p.phone); counts[k] = (counts[k] || 0) + 1; });
    const seen = {};
    const flat = state.sortMode !== 'auto';

    if (!flat) {
      // agent blocks (app Auto parity)
      const groups = new Map();
      for (const p of list) {
        const k = p.workerId || p.worker || '—';
        if (!groups.has(k)) groups.set(k, { name: p.worker, parcels: [] });
        groups.get(k).parcels.push(p);
      }
      for (const [, g] of groups) {
        const head = document.createElement('button');
        head.className = 'cc-agent-head';
        const initial = (g.name || '?').trim().charAt(0).toUpperCase();
        head.innerHTML = `<span class="cc-avatar">${D.esc(initial)}</span>
          <span class="cc-agent-name">${D.esc(g.name)}</span>
          <span class="cc-agent-count">${g.parcels.length}</span>`;
        head.onclick = () => {
          state.agentFilter = state.agentFilter ? '' : (g.parcels[0] ? g.parcels[0].workerId : '');
          renderAgents(); renderList();
        };
        box.appendChild(head);
        const wrap = document.createElement('div');
        wrap.innerHTML = sortGroups(phoneGroup(g.parcels)).map((p) => {
          const k = D.normPhone(p.phone);
          const idx = counts[k] > 1 ? ((seen[k] = (seen[k] || 0) + 1)) : 1;
          return cardHtml(p, idx, counts[k] || 1);
        }).join('');
        box.appendChild(wrap);
      }
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'cc-list-grid';
      wrap.innerHTML = `<div class="cc-cards">${sortGroups(phoneGroup(list)).map((p) => {
        const k = D.normPhone(p.phone);
        const idx = counts[k] > 1 ? ((seen[k] = (seen[k] || 0) + 1)) : 1;
        return cardHtml(p, idx, counts[k] || 1);
      }).join('')}</div>`;
      box.appendChild(wrap);
    }
    wireCards(box);
  }

  function phoneGroup(parcels) {
    // group same-phone adjacent, keep input relative order for group ranking
    const map = new Map();
    for (const p of parcels) {
      const k = D.normPhone(p.phone) || `__single__${p.id}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    }
    return [...map.values()];
  }

  function wireCards(root) {
    root.querySelectorAll('[data-copy]').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); copyText(el.dataset.copy, el); });
    });
    root.querySelectorAll('[data-act="remark"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.closest('.cc-card').dataset.id;
        openRemarkDialog(state.parcels.find((p) => p.id === id));
      });
    });
    root.querySelectorAll('[data-act="journey"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.closest('.cc-card').dataset.id;
        openJourneyDialog(state.parcels.find((p) => p.id === id));
      });
    });
    // 💬 → delivery agent's number (never the customer)
    root.querySelectorAll('[data-act="wa-agent"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = state.parcels.find((x) => x.id === btn.closest('.cc-card').dataset.id);
        if (!p) return;
        if (!p.workerPhone) {
          toast('⚠ No agent number on file', false);
          return;
        }
        window.open(waLink(p.workerPhone, parcelShareText(p)), '_blank', 'noopener');
      });
    });
  }

  /* ── remarks dialog ── */
  let remarkTarget = null;
  let remarkSelected = -1;
  let remarkOptions = [];

  async function openRemarkDialog(p) {
    if (!p) return;
    remarkTarget = p;
    remarkSelected = -1;
    $('cc-remark-title').textContent = `${p.customer} · ${p.id}`;
    $('cc-remark-note').value = '';
    $('cc-remark-msg').hidden = true;
    $('cc-remark-opts').innerHTML = '<div class="cc-msg">⏳ Loading remarks…</div>';
    $('cc-remark-modal').hidden = false;
    try {
      if (!state.remarkOpts) state.remarkOpts = await D.loadRemarkOptions(state.idToken);
      remarkOptions = state.remarkOpts;
      const box = $('cc-remark-opts');
      box.innerHTML = '';
      remarkOptions.forEach((o, i) => {
        const b = document.createElement('button');
        b.className = 'cc-opt';
        b.innerHTML = `${D.esc(o.label)}<span class="cc-opt-tag">→${D.esc(o.target)}</span>`;
        b.onclick = () => {
          remarkSelected = remarkSelected === i ? -1 : i;
          box.querySelectorAll('.cc-opt').forEach((el, j) => el.classList.toggle('selected', j === remarkSelected));
          if (remarkSelected >= 0 && remarkOptions[remarkSelected].instruction) {
            $('cc-remark-note').value = remarkOptions[remarkSelected].instruction;
          }
        };
        box.appendChild(b);
      });
    } catch (e) {
      $('cc-remark-opts').innerHTML = `<div class="cc-msg">⚠ Remarks load failed — ${D.esc(e.message || 'network error')}</div>`;
    }
  }

  async function saveRemarkDialog() {
    const p = remarkTarget;
    if (!p) return;
    const note = $('cc-remark-note').value.trim();
    const opt = remarkSelected >= 0 ? remarkOptions[remarkSelected] : null;
    if (!opt && !note) {
      const m = $('cc-remark-msg');
      m.textContent = 'Select a remark or write a note';
      m.hidden = false;
      return;
    }
    if (!p.workerId) {
      const m = $('cc-remark-msg');
      m.textContent = '⚠ No worker assigned/touched this parcel yet, so remarks cannot be saved';
      m.hidden = false;
      return;
    }
    const btn = $('cc-remark-save');
    btn.disabled = true;
    btn.textContent = '⏳ Saving…';
    try {
      await D.saveRemark(state.idToken, {
        consignmentId: p.id,
        branchId: p.branchId,
        assignedAgentSystemId: p.workerId,
        status: opt ? opt.target : '',
        remarksEn: opt ? opt.english : note,
        remarksBn: opt && opt.label !== opt.english ? opt.label : '',
        note,
        feedback: '',
        validatorName: '',
      });
      // optimistic update
      p.remarkStatus = opt ? opt.target : p.remarkStatus;
      p.remarks = opt ? opt.label : (note || p.remarks);
      p.note = note;
      p.effectiveStatus = D.effectiveStatus(p.remarkStatus, p.status, state.meta);
      p.validationRequest = D.isVerifyRequest(p.remarkStatus);
      p.validated = D.isValidated(p.remarkStatus);
      p.remarkAuthor = 'You';
      $('cc-remark-modal').hidden = true;
      toast('✅ Remark saved');
      renderAll();
    } catch (e) {
      const m = $('cc-remark-msg');
      m.textContent = `⚠ Save failed — ${e.message || 'network error'}`;
      m.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = '💾 Save';
    }
  }

  /* ── journey dialog ── */
  async function openJourneyDialog(p) {
    if (!p) return;
    $('cc-journey-title').textContent = 'Journey Log';
    $('cc-journey-sub').innerHTML =
      `${D.esc(p.id)} · ${D.esc(p.customer)} · <a href="tel:${D.esc(String(p.phone).replace(/\D/g, ''))}">📞 ${D.esc(p.phone || '—')}</a>`;
    $('cc-journey-timeline').innerHTML = '<div class="cc-msg">⏳ Loading history…</div>';
    $('cc-journey-modal').hidden = false;
    try {
      const [rows, assigns] = await Promise.all([
        D.loadHistory(state.idToken, p.id, p.branchId),
        D.loadAssignments(state.idToken, p.id).catch(() => []),
      ]);
      const nameMap = {};
      assigns.forEach((a) => { if (a.agentSystemId && !nameMap[a.agentSystemId]) nameMap[a.agentSystemId] = true; });
      rows.forEach((r) => {
        const sid = String((r && r.author_system_id) || '').trim();
        if (sid && !nameMap[sid]) nameMap[sid] = true;
      });
      const users = await D.loadUsersBySystemIds(state.idToken, Object.keys(nameMap)).catch(() => ({}));
      const items = [];
      for (const r of rows) {
        const st = String(r.remarks_status || '').trim();
        const rem = String(r.remarks_bn || r.remarks || '').trim();
        const note = String(r.note || '').trim();
        if (!st && !rem && !note) continue;
        // Author name: users map first (no FK embed — plain system_id text),
        // then raw id, then role fallback (app parity).
        const fromWorker = String(r.source || '').toUpperCase() === 'WORKER';
        const sid = String(r.author_system_id || '').trim();
        const author = (users[sid] && users[sid].name) || sid ||
          (fromWorker ? 'Agent' : 'CC');
        const ts = Date.parse(r.created_at) || 0;
        items.push({
          ts,
          role: fromWorker ? 'agent' : 'cc',
          author: author + (fromWorker ? '' : ' · CC'),
          status: st || 'NOTE',
          remark: [rem, note ? `Note: ${note}` : ''].filter(Boolean).join('\n'),
        });
      }
      for (const a of assigns) {
        const label = (users[a.agentSystemId] && users[a.agentSystemId].name) || a.agentSystemId;
        const ts = Number(a.createdAt) || 0;
        items.push({ ts, role: 'system', author: 'System', status: 'ASSIGNED', remark: `Assigned to ${label}` });
      }
      items.sort((x, y) => x.ts - y.ts);
      const tl = $('cc-journey-timeline');
      if (p.createdAt > 0) {
        items.unshift({ ts: p.createdAt, role: 'system', author: 'System', status: '', remark: 'Parcel created' });
      }
      if (!items.length) {
        tl.innerHTML = '<div class="cc-msg">📭 No remarks yet</div>';
        return;
      }
      let html = '';
      let lastDay = '';
      for (const it of items) {
        const dk = it.ts > 0 ? D.dayKey(it.ts) : '';
        if (dk && dk !== lastDay) {
          lastDay = dk;
          html += `<div class="cc-day"><span>${D.esc(dk)}</span></div>`;
        }
        const cfg = it.status ? statusCfg(it.status) : null;
        html += `<div class="cc-entry ${it.role}">
          <div><span class="cc-entry-author">${D.esc(it.author)}</span>` +
          (cfg ? `<span class="cc-entry-status" style="color:${cfg.color};background:${cfg.bg}">${D.esc(cfg.label)}</span>` : '') +
          `</div>
          ${it.remark ? `<div class="cc-entry-remark">${D.esc(it.remark)}</div>` : ''}
          <div class="cc-entry-time">${D.esc(D.fmtFull(it.ts))}</div>
        </div>`;
      }
      tl.innerHTML = html;
    } catch (e) {
      $('cc-journey-timeline').innerHTML = `<div class="cc-msg">⚠ Load failed — ${D.esc(e.message || 'network error')}</div>`;
    }
  }

  /* ── wire static UI ── */
  function wireStatic() {
    $('cc-load-btn').onclick = () => {
      try {
        chrome.storage.local.set({ cc_branch: $('cc-branch').value, cc_sort: state.sortMode, cc_source: state.source });
      } catch { /* ignore */ }
      loadParcels();
    };
    $('cc-branch').onchange = () => {
      try { chrome.storage.local.set({ cc_branch: $('cc-branch').value }); } catch { /* ignore */ }
      loadParcels();
    };
    $('cc-date').onchange = () => loadParcels();
    const searchEl = $('cc-search');
    let deb = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => {
        state.search = searchEl.value.trim();
        $('cc-search-clear').style.display = state.search ? '' : 'none';
        renderList();
      }, 250);
    });
    $('cc-search-clear').onclick = () => {
      searchEl.value = '';
      state.search = '';
      $('cc-search-clear').style.display = 'none';
      renderList();
      searchEl.focus();
    };
    $('cc-agent').onchange = (e) => { state.agentFilter = e.target.value; renderList(); };
    $('cc-source').onchange = (e) => {
      const v = e.target.value;
      if (!['request', 'live', 'mix'].includes(v)) return;
      state.source = v;
      try { chrome.storage.local.set({ cc_source: v }); } catch { /* ignore */ }
      loadParcels();
    };
    $('cc-sort').onchange = (e) => {
      state.sortMode = e.target.value;
      try { chrome.storage.local.set({ cc_sort: state.sortMode }); } catch { /* ignore */ }
      renderList();
    };
    document.querySelectorAll('#cc-stats .cc-stat').forEach((el) => {
      el.onclick = () => {
        const k = el.dataset.stat;
        state.statFilter = state.statFilter === k || k === 'all' ? 'all' : k;
        renderStats();
        renderList();
      };
    });
    $('cc-remark-cancel').onclick = () => { $('cc-remark-modal').hidden = true; };
    $('cc-remark-save').onclick = saveRemarkDialog;
    const noteEl = $('cc-remark-note');
    const noteClear = $('cc-note-clear');
    if (noteEl && noteClear) {
      noteEl.addEventListener('input', () => {
        noteClear.style.display = noteEl.value ? '' : 'none';
      });
      noteClear.onclick = () => {
        noteEl.value = '';
        noteClear.style.display = 'none';
        noteEl.focus();
      };
    }
    $('cc-journey-close').onclick = () => { $('cc-journey-modal').hidden = true; };
    [$('cc-remark-modal'), $('cc-journey-modal')].forEach((m) => {
      m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $('cc-remark-modal').hidden = true;
        $('cc-journey-modal').hidden = true;
      }
    });
    try {
      const syncTheme = () => {
        const t = localStorage.getItem('db_theme_ls');
        document.documentElement.dataset.theme = t === 'dark' ? 'dark' : 'light';
      };
      syncTheme();
      window.addEventListener('storage', syncTheme);
    } catch { /* theme-boot default */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireStatic();
    boot();
  });
})();
