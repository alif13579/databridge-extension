/* ══════════════════════════════════════════════════════════════
 * 📞 CALL CENTER desktop — Sync to Sheet (popup syncHvToSheet parity,
 *  scoped to one branch + one Dhaka date: the CC page's loaded scope).
 *  Flow: Edge report rows for the day → consolidated latest-CC per parcel →
 *  per remark connection (bindings + legacy): match consignment rows →
 *  fill blank write cells (latest-wins overwrite), ~200 cells per batch.
 * ══════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const D = window.CcData;
  const FIREBASE_URL = CONFIG.FIREBASE_URL;
  const SUPABASE_URL = CONFIG.SUPABASE_URL;
  const SUPABASE_ANON_KEY = CONFIG.SUPABASE_ANON_KEY;

  /* ── derive helpers (popup parity) ── */
  function deriveValidation(feedback) {
    const f = String(feedback || '').trim();
    if (!f) return '';
    return f.toLowerCase() === 'willing to receive today' ? 'Invalid' : 'Valid';
  }
  function deriveFinalStatus(consignmentStatus) {
    const s = String(consignmentStatus || '').trim().toLowerCase();
    if (!s) return 'Hold';
    if (s === 'assigned' || s.startsWith('assigned ') || s.includes('on the way')) return '';
    if (s === 'delivered' || s === 'partial delivery' || s === 'paid return') return 'Delivered';
    if (s === 'return' || s === 'return requested') return 'Returned';
    return 'Hold';
  }
  function deriveAction(finalStatus) {
    const s = String(finalStatus || '').trim();
    if (s === 'Delivered') return 'Re-assigned';
    if (s === 'Hold') return 'Hold';
    return '';
  }

  let catMapCache = null;
  async function fetchCategories(idToken) {
    if (catMapCache) return catMapCache;
    const m = new Map();
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/validation_remarks` +
        `?select=remarks_en,category&source=eq.CC&is_active=eq.true`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${idToken}`, Accept: 'application/json' },
      });
      const arr = await res.json().catch(() => []);
      (Array.isArray(arr) ? arr : []).forEach((x) => {
        const en = (x.remarks_en || '').trim();
        if (en && x.category && !m.has(en)) m.set(en, String(x.category).trim());
      });
    } catch { /* best-effort */ }
    catMapCache = m;
    return m;
  }

  function buildConsolidated(allRows, dateKey, catMap) {
    const byKey = new Map();
    (allRows || []).forEach((r) => {
      if (!r || !r.consignment || !r.branch_id) return;
      if (D.dayKey(new Date(r.created_at).getTime()) !== dateKey) return;
      const k = `${r.branch_id}__${r.consignment}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    });
    const out = new Map();
    byKey.forEach((rows, k) => {
      const ccRows = rows.filter((r) => r.source === 'CC')
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      if (!ccRows.length) return;
      const latest = ccRows[ccRows.length - 1];
      const engKey = (latest.remarks || '').trim();
      const feedback = catMap.get(engKey) || '';
      const finalStatus = deriveFinalStatus(latest.consignment_status || '');
      out.set(k, {
        feedback,
        validation: deriveValidation(feedback),
        validator_name: ((latest.author && latest.author.name) || latest.author_system_id || '').trim(),
        consignment_status: finalStatus,
        action: deriveAction(finalStatus),
        created_at: latest.created_at || '',
      });
    });
    return out;
  }

  /* ── connections (adapted bindings + legacy remark conns) ── */
  function adaptBinding(b, lib) {
    const mapKind = (list) => (Array.isArray(list) ? list : [])
      .filter((r) => r && String(r.colRef || '').trim())
      .map((r) => ({ colRef: String(r.colRef).trim(), kind: String(r.field || r.kind || ''), mode: r.mode === 'text' ? 'text' : 'index' }));
    return {
      lookups: mapKind(b.lookups), writes: mapKind(b.writes),
      tabPattern: lib.tabPattern || 'Day {dd}',
      headerRow: lib.headerRow || 1,
      sheetId: lib.sheetId || '', sheetName: lib.sheetName || lib.nickname || '',
      scopeType: lib.scopeType || 'global', scopeMonth: lib.scopeMonth || '',
      scopeFrom: lib.scopeFrom || '', scopeTo: lib.scopeTo || '',
      enabled: true,
    };
  }
  function isRemarkConn(conn) {
    if (!conn || conn.enabled === false) return false;
    if (conn.isLibrary) return false;
    if (conn.purpose === 'scanner' || conn.purpose === 'routing') return false;
    if (conn.purpose === 'remark') return true;
    const has = (list) => (Array.isArray(list) ? list : []).some((r) => r && String(r.colRef || '').trim());
    return has(conn.lookups) && has(conn.writes);
  }
  function effectiveRules(conn, kind) {
    const list = kind === 'lookup' ? conn.lookups || [] : conn.writes || [];
    return list.filter((r) => r && String(r.colRef || '').trim())
      .map((r) => ({ colRef: String(r.colRef).trim(), kind: String(r.kind || (kind === 'lookup' ? 'consignment' : 'feedback')), mode: r.mode === 'text' ? 'text' : 'index' }));
  }
  function scopeCovers(conn, dateKey) {
    const t = conn.scopeType || 'global';
    if (t === 'month') {
      const m = String(conn.scopeMonth || '').trim();
      return m.length >= 7 && dateKey.slice(0, 7) === m.slice(0, 7);
    }
    if (t === 'range') {
      const f = String(conn.scopeFrom || '').trim(), to = String(conn.scopeTo || '').trim();
      if (!f || !to) return false;
      return f <= dateKey && dateKey <= to;
    }
    return true;
  }
  function selectForDate(conns, dateKey) {
    const cov = conns.filter((c) => scopeCovers(c, dateKey));
    if (!cov.length) return [];
    const rank = (c) => (c.scopeType === 'range' ? 0 : c.scopeType === 'month' ? 1 : 2);
    const best = Math.min(...cov.map(rank));
    return cov.filter((c) => rank(c) === best);
  }
  function resolveConnTab(pattern, dateKey) {
    const p = String(pattern || '').trim() || 'Day {dd}';
    const m = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return p;
    const dd = m[3], mm = m[2], yyyy = m[1];
    return p.split('{dd}').join(dd).split('{d}').join(String(+dd))
      .split('{mm}').join(mm).split('{m}').join(String(+mm))
      .split('{yyyy}').join(yyyy).split('{yy}').join(yyyy.slice(-2));
  }

  /* ── sheets IO ── */
  async function sheetsGet(token, url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    return res.json();
  }
  function indexToLetter(n) {
    let s = '', num = n;
    while (num > 0) { const rem = (num - 1) % 26; s = String.fromCharCode(65 + rem) + s; num = Math.floor((num - 1) / 26); }
    return s;
  }
  async function resolveLetter(token, sheetId, tab, rule, headerRow, headerCache) {
    const t = String((rule && rule.colRef) || '').trim();
    if (!t) return null;
    if ((rule && rule.mode) !== 'text') {
      if (/^[A-Za-z]{1,3}$/.test(t)) return t.toUpperCase();
      const n = parseInt(t, 10);
      if (!isNaN(n) && n >= 1 && n <= 702) return indexToLetter(n);
      return null;
    }
    const hr = headerRow >= 1 && headerRow <= 20 ? headerRow : 1;
    const key = `${tab}#${hr}`;
    if (!headerCache[key]) {
      const data = await sheetsGet(token,
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`${tab}!${hr}:${hr}`)}`);
      const rows = data.values || [];
      headerCache[key] = rows.length ? rows[0] : [];
    }
    const idx = headerCache[key].findIndex((h) => String(h || '').trim() === t);
    return idx >= 0 ? indexToLetter(idx + 1) : null;
  }
  function quoteTab(tab) {
    const t = String(tab || '').trim();
    return /[' !"()+\-*/:?@]/.test(t) ? `'${t.replace(/'/g, "''")}'` : t;
  }
  async function batchWriteCells(token, sheetId, tab, cells, chunkSize = 200) {
    if (!cells.length) return;
    const quoted = quoteTab(tab);
    for (let i = 0; i < cells.length; i += Math.max(1, chunkSize)) {
      const data = cells.slice(i, i + Math.max(1, chunkSize)).map(({ letter, row1, value }) => ({
        range: `${quoted}!${letter}${row1}`, majorDimension: 'ROWS', values: [[value]],
      }));
      const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'RAW', data }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Sheets batch write ${res.status} ${txt.slice(0, 120)}`.trim());
      }
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function cellIsDate(cell, dateKey) {
    const raw = String(cell || '').trim();
    if (!raw) return false;
    // Cells may carry a time suffix ("02/10/2026 14:30", ISO datetime) —
    // try full text, then the leading date token.
    const candidates = [raw];
    const firstTok = raw.split(/\s+/)[0];
    if (firstTok && firstTok !== raw) candidates.push(firstTok);
    const tPart = raw.split('T')[0];
    if (tPart && tPart !== raw && !candidates.includes(tPart)) candidates.push(tPart);
    const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const res = [
      // Slashed full-year: d/M FIRST (existing dd/MM sheets), then M/d fallback.
      [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, (m) => [[m[3], m[2].padStart(2, '0'), m[1].padStart(2, '0')], [m[3], m[1].padStart(2, '0'), m[2].padStart(2, '0')]]],
      [/^(\d{4})-(\d{2})-(\d{2})$/, (m) => [[m[1], m[2], m[3]]]],
      [/^(\d{1,2})-(\d{1,2})-(\d{4})$/, (m) => [[m[3], m[2].padStart(2, '0'), m[1].padStart(2, '0')]]],
      [/^(\d{4})\/(\d{2})\/(\d{2})$/, (m) => [[m[1], m[2], m[3]]]],
      [/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, (m) => [[m[3], m[2].padStart(2, '0'), m[1].padStart(2, '0')]]],
      [/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/, (m) => {
        const mo = MONTHS[m[2].toLowerCase()];
        if (!mo) return [];
        const y = m[3].length === 2 ? '20' + m[3] : m[3];
        return [[y, mo, String(m[1]).padStart(2, '0')]];
      }],
      [/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/, (m) => {
        const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
        if (!mo) return [];
        return [[m[3], mo, String(m[2]).padStart(2, '0')]];
      }],
    ];
    for (const text of candidates) {
      for (const [re, fn] of res) {
        const m = text.match(re);
        if (m) {
          for (const [y, mo, d] of fn(m)) {
            if (`${y}-${mo}-${d}` === dateKey) return true;
          }
        }
      }
    }
    return false;
  }

  /* ── one connection sync ── */
  async function syncOneConnection(token, branchId, conn, consolidated, dateKey) {
    const res = { scanned: 0, filled: 0, syncedRows: 0, syncedCells: 0, overwrittenRows: 0, overwrittenCells: 0, noCc: 0, skipped: 0, dateSkipped: 0, perKind: {} };
    const lookups = effectiveRules(conn, 'lookup');
    const writes = effectiveRules(conn, 'write').filter((r) =>
      ['feedback', 'validation', 'validator_name', 'consignment_status', 'action'].includes(r.kind));
    if (!lookups.length || !writes.length) throw new Error('no lookup/write rule');
    const cidRule = lookups.find((r) => r.kind === 'consignment');
    if (!cidRule) throw new Error('no consignment lookup — unclear which column to match on');
    const tab = resolveConnTab(conn.tabPattern, dateKey);
    const hr = conn.headerRow >= 1 && conn.headerRow <= 20 ? conn.headerRow : 1;
    const headerCache = {};
    const resolveL = (rule) => resolveLetter(token, conn.sheetId, tab, rule, hr, headerCache);
    const cidLetter = await resolveL(cidRule);
    if (!cidLetter) throw new Error(`consignment column '${cidRule.colRef}' not found`);
    const dateRules = lookups.filter((r) => r.kind === 'today' || r.kind === 'created_at');
    const dateLetters = new Map();
    for (const rule of dateRules) {
      const letter = await resolveL(rule);
      if (!letter) throw new Error(`lookup column '${rule.colRef}' not found`);
      dateLetters.set(rule, letter);
    }
    const writeLetters = [];
    for (const rule of writes) {
      const letter = await resolveL(rule);
      if (!letter) throw new Error(`write column '${rule.colRef}' not found`);
      writeLetters.push({ rule, letter });
    }
    async function colValues(letter) {
      const data = await sheetsGet(token,
        `https://sheets.googleapis.com/v4/spreadsheets/${conn.sheetId}/values/${encodeURIComponent(`${tab}!${letter}:${letter}`)}`);
      return (data.values || []).map((r) => (r && r[0]) || '');
    }
    const cidCol = await colValues(cidLetter);
    const dateCols = new Map();
    for (const [, letter] of dateLetters) {
      if (![...dateCols.values()].includes(letter)) dateCols.set(letter, await colValues(letter));
    }
    const writeCols = new Map();
    for (const { letter } of writeLetters) {
      if (!writeCols.has(letter)) writeCols.set(letter, await colValues(letter));
    }
    res.scanned = cidCol.length;
    const pending = [];
    async function flushQueue() {
      if (!pending.length) return;
      const cells = pending.map((p) => ({ letter: p.letter, row1: p.row1, value: p.value }));
      const waits = [0, 30000, 60000];
      for (let attempt = 0; attempt < waits.length; attempt++) {
        if (waits[attempt] > 0) await sleep(waits[attempt]);
        try {
          await batchWriteCells(token, conn.sheetId, tab, cells);
          const rowsF = new Set(), rowsO = new Set();
          let fills = 0, overs = 0;
          for (const p of pending) {
            if (p.isBlank) { fills++; rowsF.add(p.row1); } else { overs++; rowsO.add(p.row1); }
            res.perKind[p.kind] = (res.perKind[p.kind] || 0) + 1;
          }
          if (fills) { res.syncedRows += rowsF.size; res.syncedCells += fills; }
          if (overs) { res.overwrittenRows += rowsO.size; res.overwrittenCells += overs; }
          pending.length = 0;
          return;
        } catch (e) {
          const quota = String((e && e.message) || '').includes('429');
          if (!quota || attempt === waits.length - 1) throw e;
        }
      }
    }
    for (let i = 0; i < cidCol.length; i++) {
      const cid = String(cidCol[i] || '').trim();
      if (!cid) continue;
      let dateOk = true;
      for (const [, letter] of dateLetters) {
        const cell = (dateCols.get(letter) || [])[i] || '';
        if (!cellIsDate(String(cell || '').trim(), dateKey)) { dateOk = false; break; }
      }
      if (!dateOk) { res.dateSkipped++; continue; }
      const vals = consolidated.get(`${branchId}__${cid}`);
      if (!vals) { res.noCc++; continue; }
      const needs = [];
      for (const { rule, letter } of writeLetters) {
        const cur = String((writeCols.get(letter) || [])[i] || '').trim();
        const v = vals[rule.kind] != null ? String(vals[rule.kind]).trim() : '';
        if (!v) continue;
        if (cur !== v) needs.push({ rule, letter, v, isBlank: cur === '' });
      }
      if (!needs.length) { res.filled++; continue; }
      for (const { rule, letter, v, isBlank } of needs) {
        pending.push({ letter, row1: i + 1, value: v, isBlank, kind: rule.kind });
        const col = writeCols.get(letter) || [];
        col[i] = v;
      }
      if (pending.length >= 200) {
        try { await flushQueue(); }
        catch { res.skipped += needs.length; pending.length = 0; }
      }
    }
    try { await flushQueue(); }
    catch { res.skipped += pending.length; pending.length = 0; }
    return res;
  }

  /* ── public: sync one branch + date ── */
  async function syncDay(idToken, sheetsToken, branchId, dateKey, dayRows, onStatus) {
    const say = (t) => { try { onStatus && onStatus(t); } catch { /* ignore */ } };
    const t0 = (() => { try { return performance.now(); } catch { return 0; } })();
    const tlog = (tag) => {
      try {
        window.CcData.log('sync', `${tag}: ${Math.round(performance.now() - t0)}ms`);
      } catch { /* ignore */ }
    };
    tlog(`start branch=${branchId} date=${dateKey} rows=${(dayRows || []).length}`);
    const catMap = await fetchCategories(idToken);
    const consolidated = buildConsolidated(dayRows, dateKey, catMap);
    tlog(`consolidated=${consolidated.size}`);
    if (!consolidated.size) return 'No CC remarks for this date — nothing to sync';
    const fbBase = `${FIREBASE_URL}/config`;
    const auth = `?auth=${encodeURIComponent(idToken)}`;
    const [bObj, lObj] = await Promise.all([
      fetch(`${fbBase}/sheetBindings/${encodeURIComponent(branchId)}/cc.json${auth}`).then((r) => r.json().catch(() => ({}))).catch(() => ({})),
      fetch(`${fbBase}/connectors/${encodeURIComponent(branchId)}/current.json${auth}`).then((r) => r.json().catch(() => ({}))).catch(() => ({})),
    ]);
    const libs = {};
    Object.entries(lObj || {}).forEach(([lid, l]) => {
      if (l && l.isLibrary && l.enabled !== false) libs[lid] = l;
    });
    const adapted = [];
    Object.entries(bObj || {}).forEach(([, b]) => {
      if (!b || b.enabled === false) return;
      const lib = libs[b.libraryId];
      if (!lib) return;
      const ad = adaptBinding(b, lib);
      if (ad.lookups.length && ad.writes.length) adapted.push(ad);
    });
    const legacy = Object.values(lObj || {}).filter(isRemarkConn).filter((c) => c.enabled !== false);
    const conns = selectForDate([...adapted, ...legacy], dateKey);
    tlog(`connections=${conns.length} (adapted+legacy)`);
    if (!conns.length) return 'No remark connection for this date (check scope)';
    let rows = 0, cells = 0, filled = 0, noCc = 0, scanned = 0, dateSkipped = 0;
    const errs = [];
    for (const conn of conns) {
      say(`⏳ ${conn.sheetName || conn.sheetId || branchId} — syncing…`);
      try {
        const c0 = (() => { try { return performance.now(); } catch { return 0; } })();
        const r = await syncOneConnection(sheetsToken, branchId, conn, consolidated, dateKey);
        rows += r.syncedRows; cells += r.syncedCells; filled += r.filled; noCc += r.noCc;
        scanned += r.scanned || 0; dateSkipped += r.dateSkipped || 0;
        try {
          window.CcData.log('sync',
            `${conn.sheetName || conn.sheetId}: ${Math.round(performance.now() - c0)}ms ` +
            `scanned=${r.scanned} synced=${r.syncedRows}/${r.syncedCells} filled=${r.filled} noCc=${r.noCc} dateSkipped=${r.dateSkipped || 0}`);
        } catch { /* ignore */ }
      } catch (e) {
        errs.push(e.message || 'sync failed');
      }
    }
    let msg = `✓ ${rows} row synced (${cells} cells) · ${filled} already filled · ${noCc} no CC yet · sheet rows ${scanned} (date-skipped ${dateSkipped})`;
    if (errs.length) msg += ` · ⚠ ${errs.length} error: ${errs.slice(0, 2).join('; ')}`;
    return msg;
  }

  window.CcSync = { syncDay };
})();
