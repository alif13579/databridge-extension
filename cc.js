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
    lang: { remark: 'bn', status: 'bn' },
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
    if (e) {
      const label = state.lang.status === 'en' ? (e.en || e.bn || statusKey) : (e.bn || e.en || statusKey);
      return { label, color: e.color, bg: e.bg, sortOrder: e.sortOrder };
    }
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
      const [branches, meta, lang] = await Promise.all([
        D.loadBranches(state.idToken),
        D.loadStatusMeta(state.idToken),
        D.loadCcLang(state.idToken).catch(() => ({ remark: 'bn', status: 'bn' })),
      ]);
      state.meta = meta;
      state.lang = lang || { remark: 'bn', status: 'bn' };
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
        }
        paintSourceTabs();
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

  /* ── timing: per-stage ms into the diagnostics log ── */
  function tlog(tag, t0, extra = '') {
    try {
      D.log('time', `${tag}: ${Math.round(performance.now() - t0)}ms${extra ? ' ' + extra : ''}`);
    } catch { /* ignore */ }
  }

  async function loadParcels() {
    const branchId = $('cc-branch').value;
    const dateStr = $('cc-date').value;
    if (!branchId || !dateStr) return;
    const t0 = performance.now();
    state.loadT0 = t0;
    D.log('time', `load start branch=${branchId} date=${dateStr} source=${state.source}`);
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
      state.sheetDebug = b.debug || null;
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
      $('cc-empty').textContent = `⚠ Load failed — ${e.message || 'network error'} (🐞 Log copy kore pathao)`;
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
      // Consignments + branch remarks fetch in PARALLEL (bulk) — neither
      // depends on the other, so sequential awaits just waste wall time.
      const runKey = runs.map((r) => `${r.runType}/${r.runId}`).sort().join('|');
      const cacheKey = `cc_cache_${branchId}_${dateStr}`;
      let routes = null;
      let consMap = null;
      let branchRows = null;
      const cached = await readParcelCache(cacheKey);
      const branchValidP = D.loadBranchValidations(state.idToken, branchId, 60);
      if (cached && cached.runKey === runKey && cached.routes && cached.cons) {
        routes = cached.routes;
        consMap = cached.cons;
        setLoading(true, 'Loading remarks…');
        branchRows = await branchValidP;
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
        if (state.loadT0) tlog('run routes', state.loadT0, `runs=${runs.length}`);
        const ids = [...new Set(routes.flatMap((r) => r.consignmentIds))];
        if (!ids.length) { await branchValidP.catch(() => []); return []; }
        setLoading(true, `Loading 0/${ids.length} parcel(s)…`);
        const consP = D.loadConsignments(state.idToken, ids, (done, total) => {
          const t = $('cc-loading-text');
          if (t) t.textContent = `Loading ${done}/${total} parcel(s)…`;
        });
        [consMap, branchRows] = await Promise.all([consP, branchValidP]);
        if (state.loadT0) tlog('parcels + branch remarks (parallel)', state.loadT0, `parcels=${ids.length}`);
        writeParcelCache(cacheKey, { runKey, routes, cons: consMap });
      }
      const conIds = [...new Set(routes.flatMap((r) => r.consignmentIds))];
      if (!conIds.length) return [];
      // Latest remarks from the already-fetched branch window + REST gap-fill
      // for ids whose latest remark predates the window.
      const latestMap = D.latestFromRows(branchRows);
      const missingIds = conIds.filter((cid) => !latestMap[cid]);
      if (missingIds.length) {
        const gap = await D.loadLatestRest(state.idToken, missingIds).catch(() => ({}));
        if (state.loadT0) tlog('remarks gap-fill', state.loadT0, `missing=${missingIds.length}`);
        for (const [cid, row] of Object.entries(gap || {})) {
          if (!latestMap[cid]) latestMap[cid] = row;
        }
      }
      const assembled = await assembleParcels(routes, consMap, latestMap, branchId, branchName);
      if (state.loadT0) tlog('users + assemble', state.loadT0, `users=${Object.keys(state.users || {}).length}`);
      return assembled;
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
    if (state.loadT0) tlog('sheet agents resolved', state.loadT0);
    const withCons = fresh.filter((cid) => consMap[cid]);
    setLoading(true, 'Loading remarks…');
    // Targeted per-parcel Edge latest (1 page each, parallel) — far cheaper
    // than a 60-day branch scan when the sheet set is small.
    const latestMap = {};
    {
      const q = [...withCons];
      const perWorkers = Array(8).fill(0).map(async () => {
        while (q.length) {
          const cid = q.shift();
          try {
            const r = await D.edgeReport(state.idToken, {
              branchId, startIso: '2020-01-01T00:00:00.000Z',
              endIso: new Date().toISOString(), consignment: cid, maxPages: 1,
            });
            if (r.rows.length) latestMap[cid] = r.rows[0];
          } catch { /* gap-fill below */ }
        }
      });
      await Promise.all(perWorkers);
    }
    if (state.loadT0) tlog('remarks (targeted edge)', state.loadT0, `found=${Object.keys(latestMap).length}/${withCons.length}`);
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
    if (state.loadT0) tlog('load total (incl render)', state.loadT0, `parcels=${parcels.length}`);
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
          <button class="cc-act cc-act-call" data-act="call" title="Send number to app (app auto-dials)">📞 Call</button>
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
        wrap.className = 'cc-list-grid';
        wrap.innerHTML = `<div class="cc-cards">${sortGroups(phoneGroup(g.parcels)).map((p) => {
          const k = D.normPhone(p.phone);
          const idx = counts[k] > 1 ? ((seen[k] = (seen[k] || 0) + 1)) : 1;
          return cardHtml(p, idx, counts[k] || 1);
        }).join('')}</div>`;
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
    watchPresence();
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
    // 📞 Call → number goes to the app (auto-dial), popup parity.
    root.querySelectorAll('[data-act="call"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = state.parcels.find((x) => x.id === btn.closest('.cc-card').dataset.id);
        if (!p || !p.phone) return;
        const cleaned = String(p.phone).replace(/[\s-()]/g, '');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ …';
        try {
          chrome.runtime.sendMessage({ action: 'send_to_app', text: cleaned }, () => {
            if (chrome.runtime.lastError) {
              btn.textContent = '❌ Failed';
            } else {
              btn.textContent = '📞 Sent!';
            }
            setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1500);
          });
        } catch {
          btn.textContent = '❌ Failed';
          setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1500);
        }
      });
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
  /* Journey: per-day groups — day divider, then that day's ASSIGNED rows,
   *  then that day's remarks chronological (assigned always on top of its
   *  date, so "who held it → what happened" reads in order). Newest 100
   *  first + "older" button (lazy pagination). */
  async function openJourneyDialog(p) {
    if (!p) return;
    $('cc-journey-title').textContent = 'Journey Log';
    $('cc-journey-sub').innerHTML =
      `${D.esc(p.id)} · ${D.esc(p.customer)} · <a href="tel:${D.esc(String(p.phone).replace(/\D/g, ''))}">📞 ${D.esc(p.phone || '—')}</a>`;
    $('cc-journey-timeline').innerHTML = '<div class="cc-msg">⏳ Loading history…</div>';
    $('cc-journey-modal').hidden = false;
    let maxPages = 1;

    const load = async () => {
      $('cc-journey-timeline').innerHTML = '<div class="cc-msg">⏳ Loading history…</div>';
      try {
        const [hist, assigns] = await Promise.all([
          D.loadHistory(state.idToken, p.id, p.branchId, maxPages),
          D.loadAssignments(state.idToken, p.id).catch(() => []),
        ]);
        const rows = hist.rows || [];
        const nameMap = {};
        assigns.forEach((a) => { if (a.agentSystemId && !nameMap[a.agentSystemId]) nameMap[a.agentSystemId] = true; });
        rows.forEach((r) => {
          const sid = String((r && r.author_system_id) || '').trim();
          if (sid && !nameMap[sid]) nameMap[sid] = true;
        });
        const users = await D.loadUsersBySystemIds(state.idToken, Object.keys(nameMap)).catch(() => ({}));
        renderJourney(p, rows, assigns, users, hist.hasMore);
      } catch (e) {
        $('cc-journey-timeline').innerHTML = `<div class="cc-msg">⚠ Load failed — ${D.esc(e.message || 'network error')}</div>`;
      }
    };

    const renderJourney = (p, rows, assigns, users, hasMore) => {
      const assigned = [];
      for (const a of assigns) {
        const label = (users[a.agentSystemId] && users[a.agentSystemId].name) || a.agentSystemId;
        const ts = Number(a.createdAt) || 0;
        if (ts > 0) assigned.push({ ts, role: 'system', author: 'System', status: 'ASSIGNED', remark: `Assigned to ${label}` });
      }
      const remarks = [];
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
        remarks.push({
          ts,
          role: fromWorker ? 'agent' : 'cc',
          author: author + (fromWorker ? '' : ' · CC'),
          status: st || 'NOTE',
          remark: [rem, note ? `Note: ${note}` : ''].filter(Boolean).join('\n'),
        });
      }
      // group by Dhaka day; per day: assigned (by time) first, then remarks
      const days = new Map();
      const dayOf = (ts) => (ts > 0 ? D.dayKey(ts) : '');
      for (const it of [...assigned, ...remarks]) {
        const dk = dayOf(it.ts) || 'undated';
        if (!days.has(dk)) days.set(dk, { assigned: [], remarks: [] });
        const bucket = days.get(dk);
        if (it.status === 'ASSIGNED') bucket.assigned.push(it);
        else bucket.remarks.push(it);
      }
      for (const [, b] of days) {
        b.assigned.sort((x, y) => x.ts - y.ts);
        b.remarks.sort((x, y) => x.ts - y.ts);
      }
      const order = [...days.keys()].sort();
      const tl = $('cc-journey-timeline');
      const items = [];
      if (p.createdAt > 0) {
        items.push({ ts: p.createdAt, role: 'system', author: 'System', status: '', remark: 'Parcel created', day: dayOf(p.createdAt) });
      }
      let html = '';
      const entryHtml = (it) => {
        const cfg = it.status ? statusCfg(it.status) : null;
        return `<div class="cc-entry ${it.role}">
          <div><span class="cc-entry-author">${D.esc(it.author)}</span>` +
          (cfg ? `<span class="cc-entry-status" style="color:${cfg.color};background:${cfg.bg}">${D.esc(cfg.label)}</span>` : '') +
          `</div>
          ${it.remark ? `<div class="cc-entry-remark">${D.esc(it.remark)}</div>` : ''}
          <div class="cc-entry-time">${D.esc(D.fmtFull(it.ts))}</div>
        </div>`;
      };
      // created entry under its own day divider
      const created = items[0];
      const seenDays = new Set();
      const emitDay = (dk) => {
        if (!dk || dk === 'undated' || seenDays.has(dk)) return;
        seenDays.add(dk);
        html += `<div class="cc-day"><span>${D.esc(dk)}</span></div>`;
      };
      if (created) {
        emitDay(created.day);
        html += entryHtml(created);
      }
      for (const dk of order) {
        emitDay(dk === 'undated' ? '' : dk);
        const b = days.get(dk);
        for (const it of [...b.assigned, ...b.remarks]) html += entryHtml(it);
      }
      if (!html) {
        tl.innerHTML = '<div class="cc-msg">📭 No remarks yet</div>';
        return;
      }
      if (hasMore) {
        html += `<button class="cc-btn" id="cc-journey-older" style="margin-top:10px;width:100%">↓ Show older remarks</button>`;
      }
      tl.innerHTML = html;
      const older = $('cc-journey-older');
      if (older) older.onclick = () => { maxPages++; load(); };
    };

    await load();
  }

  /* ── Sync to Sheet (popup syncHvToSheet parity, this date + branch) ── */
  async function syncToSheet() {
    const btn = $('cc-sync-btn');
    const res = $('cc-result');
    const branchId = $('cc-branch').value;
    const dateKey = $('cc-date').value;
    if (!branchId || !dateKey) { toast('Select branch + date first', false); return; }
    const origBtn = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="cc-mini-spinner"></span> Syncing…';
    const say = (t) => {
      res.hidden = false;
      res.textContent = t;
    };
    try {
      say('⏳ Sheets permission…');
      const { token, error } = await window.CcSheet.getSheetsToken();
      if (!token) { say(`⚠ ${error || 'No Sheets permission — re-login'}`); return; }
      say('⏳ Loading day validations…');
      const startIso = new Date(`${dateKey}T00:00:00+06:00`).toISOString();
      const endIso = new Date(new Date(startIso).getTime() + 86400000).toISOString();
      const dayRows = await D.edgeReport(state.idToken, {
        branchId, startIso, endIso, maxPages: 50,
      }).then((r) => r.rows).catch(() => []);
      if (!dayRows.length) { say('No validation data for this date/branch'); return; }
      const msg = await window.CcSync.syncDay(state.idToken, token, branchId, dateKey, dayRows, say);
      say(msg);
      if (msg.startsWith('✓')) toast('⇪ Sheet synced');
    } catch (e) {
      say(`✕ ${e.message || 'sync failed'}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = origBtn;
    }
  }

  /* ── diagnostics: one tap copies everything needed to debug ── */
  function copyDiagnostics() {
    const ver = (() => { try { return chrome.runtime.getManifest().version; } catch { return '?'; } })();
    const head = [
      `DataBridge CC diagnostics — ext v${ver} — ${new Date().toISOString()}`,
      `date=${$('cc-date').value} branch=${$('cc-branch').value} source=${state.source} sort=${state.sortMode}`,
      `parcels=${state.parcels.length} stat=${state.statFilter} status=${state.statusFilter} agent=${state.agentFilter || 'all'} search=${state.search || '-'}`,
      `missing=${(state.missingIds || []).length} sheetNote=${state.sheetNote || '-'}`,
      `sheetDebug=${JSON.stringify(state.sheetDebug || null)}`,
      `sheetsAcct=${$('cc-acct-email') ? $('cc-acct-email').textContent.trim() : '-'}`,
      `lang=${JSON.stringify(state.lang)}`,
      '--- log ---',
    ].join('\n');
    const body = head + '\n' + D.getLog();
    navigator.clipboard.writeText(body).then(
      () => toast('🐞 Log copied — paste it to support'),
      () => toast('Copy failed', false));
  }
  /* Source tabs (popup dashboard button parity). */
  function paintSourceTabs() {
    document.querySelectorAll('#cc-source-tabs .cc-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.source === state.source);
    });
  }

  /* ── engaged presence (app EngagedStateManager parity, REST version).
   *  Path: courier/consignments/{cid}/engaged_at/{uid} = {timestamp, agentName,
   *  agentRole, state}. Freshness 5 min at display (same window as app).
   *  REST has no onDisconnect: entries are cleared on leave/save/pagehide,
   *  and anything older than 5 min is treated as gone (covers crashes).
   *  Presence reads cover VISIBLE cards only (IntersectionObserver). ── */
  const ENGAGED_FRESH_MS = 5 * 60 * 1000;
  const engagedMine = new Set(); // cids this page marked
  let engagedUid = '';
  let engagedName = '';

  async function engagedIdentity() {
    if (engagedUid) return { uid: engagedUid, name: engagedName };
    try {
      const s = await new Promise((r) => chrome.storage.local.get(['google_uid', 'google_name', 'google_email'], r));
      engagedUid = s.google_uid || '';
      engagedName = s.google_name || (s.google_email ? s.google_email.split('@')[0] : '') || 'Agent';
    } catch { engagedUid = ''; engagedName = 'Agent'; }
    return { uid: engagedUid, name: engagedName };
  }

  async function markEngaged(cid) {
    if (!cid || engagedMine.has(cid)) return;
    const { uid, name } = await engagedIdentity();
    if (!uid) return;
    engagedMine.add(cid);
    try {
      await fetch(
        `${CONFIG.FIREBASE_URL}/courier/consignments/${encodeURIComponent(cid)}/engaged_at/${encodeURIComponent(uid)}.json?auth=${encodeURIComponent(state.idToken)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: Date.now(), agentName: name, agentRole: 'cc', state: 'viewing' }),
        });
    } catch { /* best-effort */ }
  }

  async function clearEngaged(cid) {
    if (!cid || !engagedMine.has(cid)) return;
    engagedMine.delete(cid);
    const { uid } = await engagedIdentity();
    if (!uid) return;
    try {
      await fetch(
        `${CONFIG.FIREBASE_URL}/courier/consignments/${encodeURIComponent(cid)}/engaged_at/${encodeURIComponent(uid)}.json?auth=${encodeURIComponent(state.idToken)}`,
        { method: 'DELETE' });
    } catch { /* best-effort */ }
  }

  function clearAllEngaged() {
    if (!engagedMine.size) return;
    const ids = [...engagedMine];
    engagedMine.clear();
    engagedIdentity().then(({ uid }) => {
      if (!uid) return;
      ids.forEach((cid) => {
        try {
          fetch(
            `${CONFIG.FIREBASE_URL}/courier/consignments/${encodeURIComponent(cid)}/engaged_at/${encodeURIComponent(uid)}.json?auth=${encodeURIComponent(state.idToken)}`,
            { method: 'DELETE', keepalive: true });
        } catch { /* pagehide — best-effort */ }
      });
    });
  }

  async function fetchEngaged(cid) {
    try {
      const res = await fetch(
        `${CONFIG.FIREBASE_URL}/courier/consignments/${encodeURIComponent(cid)}/engaged_at.json?auth=${encodeURIComponent(state.idToken)}`);
      if (!res.ok) return [];
      const obj = await res.json().catch(() => null);
      if (!obj || typeof obj !== 'object') return [];
      const now = Date.now();
      return Object.entries(obj)
        .map(([uid, e]) => ({
          uid,
          name: (e && e.agentName) || '',
          ts: (e && e.timestamp) || 0,
          state: (e && e.state) || 'viewing',
        }))
        .filter((a) => a.ts > 0 && now - a.ts < ENGAGED_FRESH_MS);
    } catch { return []; }
  }

  /* Paint ring + avatars for one card element from an agents list. */
  function paintPresence(cardEl, agents) {
    if (!cardEl) return;
    const others = agents.filter((a) => a.uid !== engagedUid);
    const mine = agents.some((a) => a.uid === engagedUid);
    cardEl.classList.toggle('engaged', others.length > 0 || mine);
    let row = cardEl.querySelector('.cc-presence');
    if (!others.length && !mine) {
      if (row) row.remove();
      return;
    }
    if (!row) {
      row = document.createElement('div');
      row.className = 'cc-presence';
      const top = cardEl.querySelector('.cc-card-top');
      if (top && top.nextSibling) top.parentNode.insertBefore(row, top.nextSibling);
      else cardEl.prepend(row);
    }
    const show = [...others.slice(0, 3)];
    row.innerHTML = show.map((a) => {
      const initial = (a.name || '?').trim().charAt(0).toUpperCase();
      return `<span class="cc-pres-av" title="${D.esc(a.name)}${a.state === 'calling' ? ' 📞 calling' : ' viewing'}">${D.esc(initial)}${a.state === 'calling' ? '<i>📞</i>' : ''}</span>`;
    }).join('') +
      (others.length > 3 ? `<span class="cc-pres-more">+${others.length - 3}</span>` : '') +
      `<span class="cc-pres-text">${others.length ? `${D.esc(others[0].name)}${others.length > 1 ? ` +${others.length - 1}` : ''} viewing` : 'You are viewing'}</span>`;
  }

  /* Visible-card presence: observe + 30s poll (visible ids only). */
  let presenceObserver = null;
  let presenceTimer = null;
  const presenceCache = new Map(); // cid -> {agents, at}

  async function refreshPresenceFor(cid) {
    const cardEl = document.querySelector(`.cc-card[data-id="${CSS.escape(cid)}"]`);
    if (!cardEl) return;
    const agents = await fetchEngaged(cid);
    presenceCache.set(cid, { agents, at: Date.now() });
    paintPresence(cardEl, agents);
  }

  function watchPresence() {
    if (presenceObserver) presenceObserver.disconnect();
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    presenceCache.clear();
    const cards = document.querySelectorAll('.cc-card[data-id]');
    if (!cards.length || !('IntersectionObserver' in window)) return;
    const visible = new Set();
    presenceObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const cid = en.target.dataset && en.target.dataset.id;
        if (!cid) continue;
        if (en.isIntersecting) {
          if (!visible.has(cid)) {
            visible.add(cid);
            refreshPresenceFor(cid);
          }
        } else visible.delete(cid);
      }
    }, { rootMargin: '200px' });
    cards.forEach((el) => presenceObserver.observe(el));
    presenceTimer = setInterval(() => {
      [...visible].forEach((cid) => refreshPresenceFor(cid));
    }, 30000);
    // hover = working on the card (app expand parity)
    cards.forEach((el) => {
      const cid = el.dataset.id;
      el.addEventListener('mouseenter', () => markEngaged(cid));
      el.addEventListener('mouseleave', () => clearEngaged(cid));
    });
    window.addEventListener('pagehide', clearAllEngaged, { once: false });
  }

  /* ── Sheets account row (popup refreshSheetsAccountRow/bindSheetsAccountOnce parity) ── */
  function sendBgMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve({});
          resolve(res || {});
        });
      } catch { resolve({}); }
    });
  }

  async function refreshSheetsAccountRow() {
    const emailEl = $('cc-acct-email');
    if (!emailEl) return;
    const switchBtn = $('cc-acct-switch');
    const connectBtn = $('cc-acct-connect');
    // Below Switch: the active Google account; logged out → Connect instead.
    let uid = '';
    try {
      const s = await new Promise((r) => chrome.storage.local.get(['google_uid'], r));
      uid = s.google_uid || '';
    } catch { /* ignore */ }
    if (switchBtn) switchBtn.style.display = uid ? '' : 'none';
    if (connectBtn) connectBtn.style.display = uid ? 'none' : '';
    if (!uid) {
      emailEl.textContent = '📧 Not connected';
      emailEl.title = 'Connect with Google to load parcels';
      return;
    }
    try {
      const res = await sendBgMessage({ action: 'get_sheets_account' });
      const email = res && res.email ? res.email : '';
      emailEl.textContent = email ? `📧 ${email}` : '📧 Chrome profile account';
      emailEl.title = email ? `Sheet reads use ${email}` : 'Sheet reads use the Chrome profile account';
    } catch {
      emailEl.textContent = '📧 Chrome profile account';
    }
  }

  /* Google connect from the CC page (popup handleGoogleLogin parity):
   * background runs the chooser, then finish from google_pending_login. */
  async function connectGoogle() {
    const btn = $('cc-acct-connect');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Signing in…'; }
    try {
      const res = await sendBgMessage({ action: 'db_google_login' });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Google login failed');
      const done = await finishGoogleLoginFromPending();
      if (!done) throw new Error('Google login failed');
      toast('✅ Connected — reloading…');
      await boot();
    } catch (e) {
      toast(`⚠ ${e.message || 'Google login failed'}`, false);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Connect Google'; }
    }
  }

  function getOrCreateExtensionID() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['extension_id'], (result) => {
        if (result.extension_id) return resolve(result.extension_id);
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yy = String(now.getFullYear()).slice(-2);
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        let suffix = '';
        for (let i = 0; i < 6; i++) suffix += chars[bytes[i] % chars.length];
        const newId = `DB-${dd}${mm}${yy}-${suffix}`;
        chrome.storage.local.set({ extension_id: newId }, () => resolve(newId));
      });
    });
  }

  async function ensureUserProfileCc(uid, idToken, displayName, email, photoUrl) {
    const authParam = idToken ? `?auth=${idToken}` : '';
    const profileUrl = `${CONFIG.FIREBASE_URL}/users/${uid}/profile.json${authParam}`;
    const existing = await fetch(profileUrl).then((r) => r.json()).catch(() => null);
    if (existing) return existing;
    const now = Date.now();
    const fresh = {
      name: displayName || (email ? email.split('@')[0] : 'User'),
      email: email || '',
      containerId: `container_${uid}`,
      user_id: uid,
      photo_url: photoUrl || '',
      createdAt: now,
      lastActive: now,
      company_info: {
        role_id: 'guest', branch_ids: [], employee_id: '', designation: '',
        agent_type: '', salary_model: '', salary_type: '', fixed_amount: '', status: 'active',
      },
    };
    await fetch(profileUrl, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fresh),
    });
    return fresh;
  }

  async function finishGoogleLoginFromPending() {
    const { google_pending_login: p } = await chrome.storage.local.get(['google_pending_login']);
    if (!p || !p.uid || !p.idToken) return false;
    const { uid, email, displayName, photoUrl, idToken, refreshToken, expiresIn } = p;
    const profile = await ensureUserProfileCc(uid, idToken, displayName, email, photoUrl).catch(() => null);
    const name = (profile && profile.name) || displayName || email;
    await chrome.storage.local.set({
      google_uid: uid,
      google_email: email,
      google_name: name,
      google_photo_url: (profile && profile.photo_url) || photoUrl || '',
      google_id_token: idToken,
      google_refresh_token: refreshToken,
      google_token_expires_at: Date.now() + expiresIn * 1000,
      container_id: `container_${uid}`,
      user_id: uid,
    });
    await chrome.storage.local.remove(['google_pending_login']).catch(() => {});
    try {
      const extensionId = await getOrCreateExtensionID();
      const now = Date.now();
      await fetch(`${CONFIG.FIREBASE_URL}/sessions/${extensionId}/meta.json`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ google_uid: uid, google_email: email, linked_at: now }),
      }).catch(() => {});
      const freshToken = await D.getIdToken().catch(() => null);
      const authP = freshToken ? `?auth=${freshToken}` : '';
      const extConnPath = `users/${uid}/connections/extensions/${extensionId}`;
      const existingConn = await fetch(`${CONFIG.FIREBASE_URL}/${extConnPath}.json${authP}`)
        .then((r) => r.json()).catch(() => null);
      await fetch(`${CONFIG.FIREBASE_URL}/${extConnPath}.json${authP}`, {
        method: existingConn && typeof existingConn === 'object' ? 'PATCH' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(existingConn && typeof existingConn === 'object'
          ? { status: 'connected', last_sync: now }
          : { status: 'connected', type: 'google_linked', connected_at: now, last_sync: now }),
      }).catch(() => {});
    } catch { /* linking best-effort */ }
    await refreshSheetsAccountRow();
    return true;
  }

  function wireSheetsAccountOnce() {
    const btn = $('cc-acct-switch');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ Account picker…';
      try {
        const res = await sendBgMessage({ action: 'db_sheets_switch' });
        if (res && res.ok) {
          await refreshSheetsAccountRow();
          toast(`Sheet account: ${res.email || 'switched'} — reloading…`);
          await loadParcels();
        } else {
          toast('Account switch failed — previous account still active', false);
        }
      } catch {
        toast('Account switch failed — previous account still active', false);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });
  }

  function wireStatic() {
    $('cc-log-btn').onclick = copyDiagnostics;
    $('cc-sync-btn').onclick = syncToSheet;
    wireSheetsAccountOnce();
    refreshSheetsAccountRow();
    const connectBtn = $('cc-acct-connect');
    if (connectBtn && !connectBtn.dataset.bound) {
      connectBtn.dataset.bound = '1';
      connectBtn.addEventListener('click', connectGoogle);
    }
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
    document.querySelectorAll('#cc-source-tabs .cc-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.source;
        if (!['request', 'live', 'mix'].includes(v) || state.source === v) return;
        state.source = v;
        try { chrome.storage.local.set({ cc_source: v }); } catch { /* ignore */ }
        paintSourceTabs();
        loadParcels();
      });
    });
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
