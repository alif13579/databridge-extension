/* ══════════════════════════════════════════════════════════════
 * 📊 DASHBOARD desktop — extension popup dashboard parity for cc.html.
 * Hold Validation summary/details + Team Performance + CSV export.
 * Same Supabase Edge report source both popup tabs use; no Firebase reads
 * except the branch list (CcData). No DOM shared with popup.js — all
 * builders/renderers below are self-contained ports.
 * ══════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const D = window.CcData;
  const $ = (id) => document.getElementById(id);

  const S = {
    booted: false,
    idToken: null,
    branches: [],       // [{id, name}]
    branchNames: {},
    report: 'hv',       // hv | perf
    hvMode: 'summary',   // summary | details
    hvRows: [],          // summary rows OR detail rows (per hvMode)
    hvFilter: 'all',     // all | validated | pending
    perfMode: 'team',    // team | agent
    perfFilter: 'all',
    perfCache: null,     // { summary, modeRows, parcels }
  };

  /* ── date helpers (popup parity, Dhaka) ── */
  const BD_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' });
  const HM_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: true });
  const localDateKey = (iso) => { try { return BD_FMT.format(new Date(iso)); } catch { return ''; } };
  const dateKeyToDdMmYyyy = (k) => {
    const [y, m, d] = String(k || '').split('-');
    return (y && m && d) ? `${d}-${m}-${y}` : (k || '');
  };
  const fmtHm = (iso) => { try { return HM_FMT.format(new Date(iso)); } catch { return ''; } };

  const PERF_STATUS_LABELS = {
    delivery_request: '📦 Delivery Request',
    hold_verified: '🔒 Hold Verified',
    return_verified: '↩ Return Verified',
  };
  const PERF_BUCKET_LABELS = {
    delivery_request: 'Delivery Request',
    hold_verified: 'Hold Verified',
    return_verified: 'Return Verified',
    other: 'Other',
  };
  const PERF_DELIVERY_FAMILY = new Set(['delivered', 'partial delivery', 'partial', 'paid return', 'exchange']);
  const perfFamilyKey = (s) => (s || '').trim().toLowerCase().replace(/_/g, ' ');
  const perfPct = (n, d) => (d > 0 ? Math.round((n * 100) / d) : 0);

  const hvWho = (name, emp, sys) => {
    const n = (name || '').trim(), e = (emp || '').trim(), s = (sys || '').trim();
    if (n && e && e !== n) return `${n} (${e})`;
    if (n) return n;
    return e || s || '—';
  };

  function toast(msg, ok = true) {
    const el = $('cc-toast');
    el.textContent = msg;
    el.style.background = ok ? '#15803d' : '#b91c1c';
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function setLoading(on, text) {
    $('dash-loading').hidden = !on;
    if (text) $('dash-loading-text').textContent = text;
    $('dash-hv-generate').disabled = on;
    $('dash-perf-generate').disabled = on;
  }
  function say(t) {
    const el = $('dash-status');
    el.hidden = false;
    el.textContent = t;
  }

  function rangeIso() {
    const t = D.todayKey();
    let from = ($('dash-from') && $('dash-from').value) || t;
    let to = ($('dash-to') && $('dash-to').value) || t;
    if (from > to) { const s = from; from = to; to = s; }
    return {
      from, to,
      startIso: new Date(`${from}T00:00:00+06:00`).toISOString(),
      endIso: new Date(new Date(`${to}T00:00:00+06:00`).getTime() + 86400000).toISOString(),
    };
  }
  function selBranches() {
    const v = $('dash-branch') ? $('dash-branch').value : '';
    if (!v || v === '__all') return S.branches.map((b) => b.id);
    return [v];
  }

  async function fetchRows(branchIds, startIso, endIso) {
    const allRows = [];
    const settled = await Promise.allSettled(branchIds.map(async (branchId) => {
      const r = await D.edgeReport(S.idToken, { branchId, startIso, endIso, maxPages: 50 });
      return { branchId, rows: r.rows || [] };
    }));
    settled.forEach((r) => { if (r.status === 'fulfilled') allRows.push(...r.value.rows); });
    return allRows;
  }

  async function fillUserNames(rows) {
    // Edge-join miss → users table fallback (card + detail level).
    const need = [...new Set(rows.flatMap((r) => {
      const out = [];
      if (!r.agentName && r.agentSystemId) out.push(r.agentSystemId);
      if (!r.authorName && r.authorSystemId) out.push(r.authorSystemId);
      if (r.validatorSystemId && !r.validatorName) out.push(r.validatorSystemId);
      (r.days || []).forEach((d) => {
        if (d.workerSys && (!d.workerName || !d.workerEmp)) out.push(d.workerSys);
        if (d.hasCc && d.ccSys && (!d.ccName || !d.ccEmp)) out.push(d.ccSys);
      });
      return out;
    }))];
    if (!need.length) return;
    try {
      const map = await D.loadUsersBySystemIds(S.idToken, need);
      const apply = (obj, sysKey, nameKey, empKey) => {
        const hit = obj[sysKey] && map[obj[sysKey]];
        if (hit) {
          if (!obj[nameKey] && hit.name) obj[nameKey] = hit.name;
          if (empKey && !obj[empKey] && hit.employeeId) obj[empKey] = hit.employeeId;
        }
      };
      rows.forEach((r) => {
        apply(r, 'agentSystemId', 'agentName', 'agentEmpId');
        apply(r, 'authorSystemId', 'authorName', null);
        apply(r, 'validatorSystemId', 'validatorName', 'validatorEmpId');
        (r.days || []).forEach((d) => {
          apply(d, 'workerSys', 'workerName', 'workerEmp');
          apply(d, 'ccSys', 'ccName', 'ccEmp');
        });
      });
    } catch { /* best-effort */ }
  }

  /* ══ HOLD VALIDATION builder (popup generateHoldValidationReport parity) ══ */
  async function buildHV(allRows) {
    const latestMs = (row) => new Date(row.created_at).getTime();
    const earliestOf = (rows) => rows.reduce((e, r) => (!e || latestMs(r) < latestMs(e)) ? r : e, null);
    const latestOf = (rows) => rows.reduce((l, r) => (!l || latestMs(r) >= latestMs(l)) ? r : l, null);

    const groups = {};
    allRows.forEach((row) => {
      const dateKey = localDateKey(row.created_at);
      const key = `${dateKey}__${row.consignment}`;
      if (!groups[key]) groups[key] = { dateKey, cId: row.consignment, branchId: row.branch_id, rows: [] };
      groups[key].rows.push(row);
    });
    const validGroups = Object.values(groups).filter((g) =>
      g.rows.some((r) => r.source === 'WORKER' && String(r.remarks_status || '').trim().toUpperCase() === 'VERIFY_REQUEST'));
    if (!validGroups.length) return { summary: [], details: [] };

    // ── summary: one card per consignment across the range ──
    const byCid = {};
    validGroups.forEach((g) => {
      const key = `${g.branchId}__${g.cId}`;
      if (!byCid[key]) byCid[key] = { branchId: g.branchId, cId: g.cId, rows: [], dayMap: {} };
      const grp = byCid[key];
      grp.rows.push(...g.rows);
      const workerVerifyRows = g.rows.filter((r) => r.source === 'WORKER' && String(r.remarks_status || '').trim().toUpperCase() === 'VERIFY_REQUEST');
      const ccRows = g.rows.filter((r) => r.source === 'CC');
      grp.dayMap[g.dateKey] = {
        dateKey: g.dateKey,
        dateLabel: dateKeyToDdMmYyyy(g.dateKey),
        firstWorker: earliestOf(workerVerifyRows),
        lastCc: ccRows.length ? latestOf(ccRows) : null,
      };
    });
    const summary = Object.values(byCid).map((grp) => {
      const days = Object.values(grp.dayMap).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
      const verifyAll = grp.rows.filter((r) => r.source === 'WORKER' && String(r.remarks_status || '').trim().toUpperCase() === 'VERIFY_REQUEST');
      const ccAll = grp.rows.filter((r) => r.source === 'CC');
      const latestVerify = latestOf(verifyAll);
      const latestCc = ccAll.length ? latestOf(ccAll) : null;
      const latestOfAll = latestOf(grp.rows);
      const lastDay = days[days.length - 1];
      return {
        dateKey: lastDay.dateKey,
        dateLabel: days.length > 1 ? `${days[0].dateLabel} → ${lastDay.dateLabel}` : lastDay.dateLabel,
        branchId: grp.branchId,
        cId: grp.cId,
        agentSystemId: latestOfAll.assigned_to_system_id,
        agentName: ((latestOfAll.assigned && latestOfAll.assigned.name) || grp.rows.find((r) => r.assigned && r.assigned.name)?.assigned?.name || '').trim(),
        agentEmpId: ((latestOfAll.assigned && latestOfAll.assigned.employee_id) || '').trim(),
        customerPhone: ((latestOfAll.customer_phone || '') + '').trim(),
        parcelStatus: (((latestOfAll.consignment_status || (latestCc && latestCc.consignment_status)) || '') + '').trim(),
        firstWorkerRemark: lastDay.firstWorker.remarks || '',
        firstWorkerStatus: lastDay.firstWorker.remarks_status || '',
        firstWorkerTime: fmtHm(lastDay.firstWorker.created_at),
        lastCcRemark: lastDay.lastCc ? (lastDay.lastCc.remarks || '') : '',
        lastCcNote: lastDay.lastCc ? (lastDay.lastCc.note || '') : '',
        lastCcStatus: lastDay.lastCc ? (lastDay.lastCc.remarks_status || '') : '',
        lastCcTime: lastDay.lastCc ? fmtHm(lastDay.lastCc.created_at) : '',
        validatorSystemId: lastDay.lastCc ? (lastDay.lastCc.author_system_id || '') : '',
        validatorName: (((lastDay.lastCc && lastDay.lastCc.author && lastDay.lastCc.author.name) || '') + '').trim(),
        validatorEmpId: (((lastDay.lastCc && lastDay.lastCc.author && lastDay.lastCc.author.employee_id) || '') + '').trim(),
        validatorEmployeeId: '',
        stillPending: !latestCc || latestMs(latestVerify) > latestMs(latestCc),
        days: days.map((d) => ({
          dateKey: d.dateKey,
          dateLabel: d.dateLabel,
          workerRemark: d.firstWorker.remarks || '',
          workerStatus: d.firstWorker.remarks_status || '',
          workerTime: fmtHm(d.firstWorker.created_at),
          workerName: (((d.firstWorker.assigned && d.firstWorker.assigned.name) || '') + '').trim(),
          workerEmp: (((d.firstWorker.assigned && d.firstWorker.assigned.employee_id) || '') + '').trim(),
          workerSys: d.firstWorker.assigned_to_system_id || '',
          hasCc: !!d.lastCc,
          ccRemark: d.lastCc ? (d.lastCc.remarks || '') : '',
          ccNote: d.lastCc ? (d.lastCc.note || '') : '',
          ccStatus: d.lastCc ? (d.lastCc.remarks_status || '') : '',
          ccTime: d.lastCc ? fmtHm(d.lastCc.created_at) : '',
          ccName: (((d.lastCc && d.lastCc.author && d.lastCc.author.name) || '') + '').trim(),
          ccEmp: (((d.lastCc && d.lastCc.author && d.lastCc.author.employee_id) || '') + '').trim(),
          ccSys: d.lastCc ? (d.lastCc.author_system_id || '') : '',
        })),
      };
    });
    summary.forEach((r) => {
      if (!r.agentName) r.agentName = r.agentEmpId || r.agentSystemId || '—';
      r.agentWho = hvWho(r.agentName === '—' ? '' : r.agentName, r.agentEmpId, r.agentSystemId);
      r.validatorEmployeeId = r.validatorEmpId || r.validatorSystemId;
      if (r.validatorSystemId && !r.validatorName) r.validatorName = r.validatorEmployeeId || r.validatorSystemId;
      r.validatorWho = r.validatorSystemId ? hvWho(r.validatorName, r.validatorEmpId, r.validatorSystemId) : '';
      (r.days || []).forEach((d) => {
        d.workerWho = hvWho(d.workerName, d.workerEmp, d.workerSys);
        d.ccWho = d.hasCc ? hvWho(d.ccName, d.ccEmp, d.ccSys) : '';
      });
    });
    summary.sort((a, b) => {
      if (!!a.stillPending !== !!b.stillPending) return a.stillPending ? -1 : 1;
      return b.dateKey.localeCompare(a.dateKey);
    });

    // ── details: every raw remark row ──
    const details = [];
    validGroups.forEach((g) => {
      g.rows.slice().sort((a, b) => latestMs(a) - latestMs(b)).forEach((r) => {
        details.push({
          dateKey: g.dateKey,
          dateLabel: dateKeyToDdMmYyyy(g.dateKey),
          timeLabel: fmtHm(r.created_at),
          branchId: g.branchId,
          cId: g.cId,
          agentSystemId: r.assigned_to_system_id,
          agentName: ((r.assigned && r.assigned.name) || '').trim(),
          authorSystemId: r.author_system_id || '',
          authorName: ((r.author && r.author.name) || '').trim(),
          authorEmployeeId: (((r.author && r.author.employee_id) || '') + '').trim(),
          parcelStatus: (((r.consignment_status || '') + '')).trim(),
          source: r.source,
          remark: r.remarks || '',
          note: r.note || '',
          status: r.remarks_status || '',
        });
      });
    });
    details.sort((a, b) => (b.dateKey.localeCompare(a.dateKey)) || ((b.timeLabel || '').localeCompare(a.timeLabel || '')));

    await fillUserNames([...summary, ...details]);
    // re-apply display fallbacks after fill (popup parity)
    summary.forEach((r) => {
      if (!r.agentName) r.agentName = r.agentEmpId || r.agentSystemId || '—';
      r.agentWho = hvWho(r.agentName === '—' ? '' : r.agentName, r.agentEmpId, r.agentSystemId);
      (r.days || []).forEach((d) => {
        d.workerWho = hvWho(d.workerName, d.workerEmp, d.workerSys);
        d.ccWho = d.hasCc ? hvWho(d.ccName, d.ccEmp, d.ccSys) : '';
      });
    });
    details.forEach((r) => {
      if (!r.agentName) r.agentName = r.agentSystemId || '—';
      if (r.authorSystemId && !r.authorName) r.authorName = r.authorEmployeeId || r.authorSystemId;
    });
    return { summary, details };
  }

  /* ══ PERFORMANCE builder (popup generateTeamPerformanceReport parity) ══ */
  async function buildPerf(allRows, mode) {
    const latestMs = (row) => new Date(row.created_at).getTime();
    const statusKeyOf = (row) => String(row.remarks_status || '').trim().toLowerCase();
    const ccRows = allRows.filter((r) => r.source === 'CC');
    if (!ccRows.length) return null;

    const byConsignment = {};
    ccRows.forEach((r) => { (byConsignment[r.consignment] ||= []).push(r); });
    const byConsAll = {};
    allRows.forEach((r) => { (byConsAll[r.consignment] ||= []).push(r); });
    const counts = { delivery_request: 0, hold_verified: 0, return_verified: 0, other: 0 };
    const perfParcels = [];
    Object.entries(byConsignment).forEach(([cid, rows]) => {
      const latest = rows.reduce((a, b) => (latestMs(a) >= latestMs(b) ? a : b));
      const key = statusKeyOf(latest);
      const bucket = (key in counts) ? key : 'other';
      counts[bucket]++;
      const all = byConsAll[cid] || rows;
      const nowRow = all.reduce((a, b) => (latestMs(a) >= latestMs(b) ? a : b));
      const nowStatus = (nowRow.consignment_status || '').trim();
      const drRows = rows.filter((r) => statusKeyOf(r) === 'delivery_request');
      perfParcels.push({
        cid, bucket,
        inDr: drRows.length > 0,
        drCount: drRows.length,
        firstDrAt: drRows.length ? drRows.reduce((a, b) => (latestMs(a) <= latestMs(b) ? a : b)).created_at : null,
        latestAt: latest.created_at,
        agent: (latest.author && latest.author.name) || latest.author_system_id || '—',
        ccLabel: PERF_STATUS_LABELS[key] || key,
        nowStatus: nowStatus || '—',
        converted: PERF_DELIVERY_FAMILY.has(perfFamilyKey(nowStatus)),
      });
    });
    const totalUnique = Object.keys(byConsignment).length;

    const drConsignments = new Set();
    ccRows.forEach((r) => { if (statusKeyOf(r) === 'delivery_request') drConsignments.add(r.consignment); });
    let drConverted = 0;
    drConsignments.forEach((cid) => {
      const rows = byConsAll[cid] || [];
      if (!rows.length) return;
      const latest = rows.reduce((a, b) => (latestMs(a) >= latestMs(b) ? a : b));
      if (PERF_DELIVERY_FAMILY.has(perfFamilyKey(latest.consignment_status))) drConverted++;
    });
    const drUnique = drConsignments.size;
    const drSummary = {
      unique: drUnique,
      pctOfTotal: perfPct(drUnique, totalUnique),
      converted: drConverted,
      convertedPct: perfPct(drConverted, drUnique),
    };

    let modeRows;
    if (mode === 'team') {
      const perAuthorLatest = {};
      ccRows.forEach((r) => {
        const author = r.author_system_id || '—';
        const key = `${r.consignment}__${author}`;
        const prev = perAuthorLatest[key];
        if (!prev || latestMs(r) > latestMs(prev)) perAuthorLatest[key] = r;
      });
      const groups = {};
      Object.values(perAuthorLatest).forEach((row) => {
        const agentId = row.author_system_id || '—';
        const g = groups[agentId] ||= {
          agentId, agentName: (row.author && row.author.name) || '', agentEmpId: (row.author && row.author.employee_id) || '',
          total: 0, delivery_request: 0, hold_verified: 0, return_verified: 0, other: 0,
        };
        if (!g.agentName && row.author && row.author.name) { g.agentName = row.author.name; g.agentEmpId = row.author.employee_id || ''; }
        g.total++;
        const key = statusKeyOf(row);
        if (key in counts) g[key]++; else g.other++;
      });
      const missing = Object.values(groups).filter((g) => !g.agentName && g.agentId !== '—').map((g) => g.agentId);
      if (missing.length) {
        try {
          const map = await D.loadUsersBySystemIds(S.idToken, missing);
          Object.values(groups).forEach((g) => {
            const hit = map.get(g.agentId);
            if (hit && hit.name) { g.agentName = hit.name; g.agentEmpId = hit.empId; }
            if (!g.agentName) g.agentName = g.agentId;
          });
        } catch { /* ignore */ }
      }
      modeRows = Object.values(groups).sort((a, b) => b.total - a.total);
    } else {
      const groups = {};
      Object.values(byConsAll).forEach((rows) => {
        if (!rows.some((r) => r.source === 'WORKER')) return;
        const latest = rows.reduce((a, b) => (latestMs(a) >= latestMs(b) ? a : b));
        const agentId = latest.assigned_to_system_id || rows[0].assigned_to_system_id || '—';
        const joinHit = latest.assigned && latest.assigned.name ? latest.assigned
          : ((rows.find((r) => r.assigned && r.assigned.name) || {}).assigned);
        const g = groups[agentId] ||= {
          agentId, agentName: (joinHit && joinHit.name) || '', agentEmpId: (joinHit && joinHit.employee_id) || '',
          requested: 0, validated: 0,
        };
        g.requested++;
        if (latest.source === 'CC') g.validated++;
      });
      const missing = Object.values(groups).filter((g) => !g.agentName && g.agentId !== '—').map((g) => g.agentId);
      if (missing.length) {
        try {
          const map = await D.loadUsersBySystemIds(S.idToken, missing);
          Object.values(groups).forEach((g) => {
            const hit = map.get(g.agentId);
            if (hit && hit.name) { g.agentName = hit.name; g.agentEmpId = hit.empId; }
            if (!g.agentName) g.agentName = g.agentId;
          });
        } catch { /* ignore */ }
      }
      modeRows = Object.values(groups).sort((a, b) => b.requested - a.requested || b.validated - a.validated);
    }
    return { totalUnique, counts, drSummary, modeRows, perfParcels };
  }

  /* ══ RENDER ══ */
  function branchNameOf(id) { return S.branchNames[id] || id; }

  function renderHVSummary() {
    const rows = S.hvRows;
    const total = rows.length;
    const pending = rows.filter((r) => r.stillPending).length;
    const validated = total - pending;
    const filtered = rows.filter((r) =>
      S.hvFilter === 'validated' ? !r.stillPending :
      S.hvFilter === 'pending' ? r.stillPending : true);
    const box = $('dash-report');
    const stat = $('dash-stats');
    stat.hidden = false;
    stat.innerHTML = `
      <button class="cc-stat${S.hvFilter === 'all' ? ' active' : ''}" data-hvf="all">
        <span class="cc-stat-val">${total}</span><span class="cc-stat-label">Total</span></button>
      <button class="cc-stat${S.hvFilter === 'validated' ? ' active' : ''}" data-hvf="validated">
        <span class="cc-stat-val cc-green">${validated}</span><span class="cc-stat-label">Validated</span></button>
      <button class="cc-stat${S.hvFilter === 'pending' ? ' active' : ''}" data-hvf="pending">
        <span class="cc-stat-val cc-yellow">${pending}</span><span class="cc-stat-label">Pending</span></button>
      <span></span>`;
    stat.querySelectorAll('[data-hvf]').forEach((el) => {
      el.onclick = () => { S.hvFilter = el.dataset.hvf; renderHVSummary(); };
    });
    if (!filtered.length) {
      box.innerHTML = '';
      $('dash-empty').hidden = false;
      $('dash-empty').innerHTML = '📭<br>No entries for this filter';
      return;
    }
    $('dash-empty').hidden = true;
    box.innerHTML = filtered.map((r) => {
      const badge = r.stillPending
        ? '<span class="dash-badge dash-badge-pending">⏳ Pending</span>'
        : '<span class="dash-badge dash-badge-validated">✓ Validated</span>';
      const dayBlocks = (r.days || []).map((d) => `
        ${(r.days.length > 1) ? `<div class="dash-day-label"><span>${D.esc(d.dateLabel)}</span></div>` : ''}
        <div class="dash-bubble dash-bubble-worker">
          <div class="dash-bubble-label">🙋 ${D.esc(d.workerWho)}${d.workerStatus ? ' · ' + D.esc(d.workerStatus) : ''}</div>
          <div class="dash-bubble-text">${D.esc(d.workerRemark || '(no remark)')}</div>
          <div class="dash-bubble-meta">${D.esc(d.workerTime || '')}</div>
        </div>
        ${d.hasCc ? `<div class="dash-bubble dash-bubble-cc">
            <div class="dash-bubble-label">✓ ${D.esc(d.ccWho)}${d.ccStatus ? ' · ' + D.esc(d.ccStatus) : ''}</div>
            ${d.ccRemark ? `<div class="dash-bubble-text">${D.esc(d.ccRemark)}</div>` : '<div class="dash-bubble-text" style="opacity:.65">(no CC text)</div>'}
            ${d.ccNote ? `<div class="dash-bubble-note">📝 ${D.esc(d.ccNote)}</div>` : ''}
            <div class="dash-bubble-meta">${D.esc(d.ccTime || '')}</div>
          </div>` : ''}`).join('');
      return `
        <div class="dash-row ${r.stillPending ? 'dash-row-pending' : 'dash-row-validated'}">
          <div class="dash-row-top"><span class="dash-row-id">${D.esc(r.cId)}</span><span>${D.esc(r.dateLabel)}</span></div>
          <div class="dash-row-meta">${D.esc(branchNameOf(r.branchId))}${r.parcelStatus ? ` · 📦 ${D.esc(r.parcelStatus)}` : ''} · 👤 ${D.esc(r.agentWho || '')}${r.customerPhone ? ` · 📞 ${D.esc(r.customerPhone)}` : ''}</div>
          <div class="dash-chat">${dayBlocks}</div>
          <div class="dash-row-meta" style="margin-top:6px">${badge}</div>
        </div>`;
    }).join('');
  }

  function renderHVDetails() {
    const rows = S.hvRows;
    $('dash-stats').hidden = true;
    const box = $('dash-report');
    if (!rows.length) {
      box.innerHTML = '';
      $('dash-empty').hidden = false;
      $('dash-empty').innerHTML = '📭<br>No detail rows';
      return;
    }
    $('dash-empty').hidden = true;
    box.innerHTML = `<div class="dash-table-wrap"><table class="dash-table">
      <thead><tr><th>Date</th><th>Time</th><th>Branch</th><th>Consignment</th><th>Agent</th><th>Author</th><th>Src</th><th>Remark</th><th>Note</th><th>Status</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${D.esc(r.dateLabel)}</td><td>${D.esc(r.timeLabel)}</td><td>${D.esc(branchNameOf(r.branchId))}</td>
        <td>${D.esc(r.cId)}</td><td>${D.esc(r.agentName || '')}</td><td>${D.esc(r.authorName || '')}</td>
        <td>${r.source === 'WORKER' ? 'Worker' : 'CC'}</td><td>${D.esc(r.remark || '')}</td>
        <td>${D.esc(r.note || '')}</td><td>${D.esc(r.status || '')}</td>
      </tr>`).join('')}</tbody></table></div>
      <div class="dash-listhead">${rows.length} rows</div>`;
  }

  function renderPerf() {
    const c = S.perfCache;
    const box = $('dash-report');
    if (!c) {
      box.innerHTML = '';
      $('dash-empty').hidden = false;
      return;
    }
    const { totalUnique, counts, drSummary } = c.summary;
    const dr = drSummary;
    const card = (key, valHtml, label) => `
      <div class="dash-stat${S.perfFilter === key ? ' active' : ''}" data-perf="${key}">
        <div class="dash-stat-val">${valHtml}</div><div class="dash-stat-label">${label}</div></div>`;
    const head = `
      <div class="dash-grid">
        ${card('all', totalUnique, 'Total Unique')}
        <div class="dash-stat${S.perfFilter === 'delivery_request' ? ' active' : ''}" data-perf="delivery_request">
          <div class="dash-stat-val validated">${dr.unique}</div>
          <div class="dash-stat-label">Delivery Request · ${dr.pctOfTotal}%</div>
          <div class="dash-stat-sub">✅ ${dr.converted} converted (${dr.convertedPct}%)</div>
        </div>
        ${card('hold_verified', `<span class="pending">🔒 ${counts.hold_verified}</span>`, `Hold Verified · ${perfPct(counts.hold_verified, totalUnique)}%`)}
        ${card('return_verified', `↩ ${counts.return_verified}`, `Return Verified · ${perfPct(counts.return_verified, totalUnique)}%`)}
        ${counts.other ? card('other', `❓ ${counts.other}`, 'Other') : ''}
      </div>`;
    let list;
    if (S.perfFilter === 'all') {
      list = (S.perfMode === 'team'
        ? c.modeRows.map((r, i) => `
          <div class="dash-row"><div class="dash-row-top">
            <span class="dash-row-id">#${i + 1} ${D.esc(r.agentName)}${r.agentEmpId ? ' (' + D.esc(r.agentEmpId) + ')' : ''}</span>
            <span>Total ${r.total}</span></div>
            <div class="dash-row-meta">🔒 ${r.hold_verified} · ↩ ${r.return_verified} · 📦 ${r.delivery_request}${r.other ? ' · ❓ ' + r.other : ''}</div>
          </div>`).join('')
        : c.modeRows.map((r, i) => `
          <div class="dash-row"><div class="dash-row-top">
            <span class="dash-row-id">#${i + 1} ${D.esc(r.agentName)}${r.agentEmpId ? ' (' + D.esc(r.agentEmpId) + ')' : ''}</span>
            <span>Request ${r.requested}</span></div>
            <div class="dash-row-meta">✅ Validated ${r.validated} · ⏳ Pending ${r.requested - r.validated}</div>
          </div>`).join(''));
    } else {
      const plist = c.perfParcels
        .filter((p) => (S.perfFilter === 'delivery_request' ? p.inDr : p.bucket === S.perfFilter))
        .sort((a, b) => new Date(b.latestAt) - new Date(a.latestAt));
      list = `<div class="dash-listhead">${plist.length} parcels · ${PERF_BUCKET_LABELS[S.perfFilter] || S.perfFilter}</div>` +
        plist.map((p) => `
          <div class="dash-row"><div class="dash-row-top">
            <span class="dash-row-id">${D.esc(p.cid)}</span>
            <span>${p.converted ? '✅ Delivered' : D.esc(S.perfFilter === 'delivery_request' ? `⏳ ${p.nowStatus}` : p.ccLabel)}</span></div>
            <div class="dash-row-meta">${D.esc(p.agent)} · now: ${D.esc(p.nowStatus)}</div>
          </div>`).join('');
    }
    $('dash-stats').hidden = true;
    $('dash-empty').hidden = true;
    box.innerHTML = head + list;
    box.querySelectorAll('[data-perf]').forEach((cell) => {
      cell.onclick = () => {
        const f = cell.dataset.perf;
        S.perfFilter = (S.perfFilter === f) ? 'all' : f;
        renderPerf();
      };
    });
  }

  /* ══ CSV EXPORT (popup downloadHvReport columns parity) ══ */
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return (/[",\n]/.test(s)) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function downloadCsv(filename, rows) {
    const text = rows.map((r) => r.map(csvCell).join(',')).join('\n');
    const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  function exportHV() {
    if (!S.hvRows.length) { toast('Generate the report first', false); return; }
    const { from, to } = rangeIso();
    const branchVal = $('dash-branch') ? $('dash-branch').value : '__all';
    const tag = (!branchVal || branchVal === '__all') ? 'all' : (S.branchNames[branchVal] || branchVal);
    const rows = S.hvMode === 'summary'
      ? [['Date', 'Branch', 'Consignment ID', 'Agent Name', 'Agent System ID', 'Parcel Status', 'Validator Name', 'Validator Employee ID',
        'First Worker Remark', 'First Worker Remark Status', 'Last CC Remark', 'Last CC Note', 'Last CC Remark Status', 'Validation Status']]
      : [['Date', 'Time', 'Branch', 'Consignment ID', 'Agent Name', 'Agent System ID', 'Parcel Status', 'Author Name', 'Author System ID', 'Source', 'Remark', 'Note', 'Remark Status']];
    S.hvRows.forEach((r) => {
      if (S.hvMode === 'summary') {
        rows.push([
          r.dateLabel, branchNameOf(r.branchId), r.cId,
          r.agentName || '', r.agentSystemId || '', r.parcelStatus || '',
          r.validatorName || '', r.validatorEmployeeId || '',
          r.firstWorkerRemark || '', r.firstWorkerStatus || '',
          r.lastCcRemark || '', r.lastCcNote || '', r.lastCcStatus || '',
          r.stillPending ? 'Pending' : 'Validated',
        ]);
      } else {
        rows.push([
          r.dateLabel, r.timeLabel, branchNameOf(r.branchId), r.cId,
          r.agentName || '', r.agentSystemId || '', r.parcelStatus || '',
          r.authorName || '', r.authorSystemId || '',
          r.source === 'WORKER' ? 'Worker' : 'CC',
          r.remark || '', r.note || '', r.status || '',
        ]);
      }
    });
    downloadCsv(`databridge-hv-${S.hvMode}-${from}_${to}-${tag}.csv`, rows);
    toast(`⬇ Exported ${S.hvRows.length} ${S.hvMode} rows`);
  }

  /* ══ ACTIONS ══ */
  async function generateHV() {
    const { from, to, startIso, endIso } = rangeIso();
    const branchIds = selBranches();
    if (!branchIds.length) { say('⚠ No branch available'); return; }
    setLoading(true, 'Loading hold validations…');
    say(`⏳ Hold Validation (${S.hvMode}) ${from} → ${to}…`);
    try {
      const t0 = performance.now();
      const allRows = await fetchRows(branchIds, startIso, endIso);
      try { D.log('dash', `hv rows=${allRows.length} branches=${branchIds.length} ms=${Math.round(performance.now() - t0)}`); } catch { /* ignore */ }
      if (!allRows.length) { say('No validation data in this date range/branch'); setLoading(false); return; }
      const { summary, details } = await buildHV(allRows);
      S.hvRows = S.hvMode === 'summary' ? summary : details;
      S.hvFilter = 'all';
      if (!S.hvRows.length) { say('No validation requests in this date range/branch'); setLoading(false); return; }
      say(`✓ ${S.hvRows.length} ${S.hvMode} rows`);
      if (S.hvMode === 'summary') renderHVSummary(); else renderHVDetails();
    } catch (e) {
      say(`✕ ${e.message || 'report failed'}`);
    } finally {
      setLoading(false);
    }
  }

  async function generatePerf() {
    const { from, to, startIso, endIso } = rangeIso();
    const branchIds = selBranches();
    if (!branchIds.length) { say('⚠ No branch available'); return; }
    setLoading(true, `Loading performance (${S.perfMode})…`);
    say(`⏳ Performance ${from} → ${to}…`);
    try {
      const t0 = performance.now();
      const allRows = await fetchRows(branchIds, startIso, endIso);
      try { D.log('dash', `perf rows=${allRows.length} branches=${branchIds.length} ms=${Math.round(performance.now() - t0)}`); } catch { /* ignore */ }
      const built = await buildPerf(allRows, S.perfMode);
      if (!built) { say('No CC resolutions in this date range/branch'); setLoading(false); return; }
      S.perfCache = { summary: built, modeRows: built.modeRows, parcels: built.perfParcels };
      S.perfFilter = 'all';
      say(`✓ ${built.totalUnique} unique consignments`);
      renderPerf();
    } catch (e) {
      say(`✕ ${e.message || 'report failed'}`);
    } finally {
      setLoading(false);
    }
  }

  function paintReportTabs() {
    document.querySelectorAll('#dash-report-tabs .cc-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.report === S.report);
    });
    $('dash-hv-row').hidden = S.report !== 'hv';
    $('dash-perf-row').hidden = S.report !== 'perf';
  }

  async function boot() {
    if (S.booted) return;
    S.booted = true;
    const t = D.todayKey();
    if ($('dash-from')) $('dash-from').value = t;
    if ($('dash-to')) $('dash-to').value = t;
    try {
      const sync = await D.ensureProfileSynced();
      S.idToken = sync.idToken;
      if (sync.usersRowMissing) {
        $('dash-conn').textContent = '⚠ Not onboarded — ask admin';
        return;
      }
    } catch { S.idToken = null; }
    if (!S.idToken) {
      $('dash-conn').textContent = '🔴 Guest — log in via popup';
      return;
    }
    $('dash-conn').textContent = '🟢 Connected';
    try {
      S.branches = await D.loadBranches(S.idToken);
      S.branchNames = {};
      S.branches.forEach((b) => { S.branchNames[b.id] = b.name; });
      const sel = $('dash-branch');
      sel.innerHTML = '<option value="__all">🌐 All branches</option>';
      S.branches.forEach((b) => {
        const o = document.createElement('option');
        o.value = b.id; o.textContent = b.name;
        sel.appendChild(o);
      });
    } catch (e) {
      say(`⚠ Branches failed — ${e.message || 'network error'}`);
    }
    paintReportTabs();
    document.querySelectorAll('#dash-report-tabs .cc-tab').forEach((b) => {
      b.onclick = () => {
        S.report = b.dataset.report;
        paintReportTabs();
      };
    });
    document.querySelectorAll('[data-hvmode]').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('[data-hvmode]').forEach((x) => x.classList.toggle('active', x === b));
        S.hvMode = b.dataset.hvmode;
        if (S.hvRows.length) { /* re-generate for fresh mode data */ }
      };
    });
    document.querySelectorAll('[data-perfmode]').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('[data-perfmode]').forEach((x) => x.classList.toggle('active', x === b));
        S.perfMode = b.dataset.perfmode;
      };
    });
    $('dash-hv-generate').onclick = generateHV;
    $('dash-perf-generate').onclick = generatePerf;
    $('dash-hv-export').onclick = exportHV;
  }

  window.CcDash = { boot };
})();
