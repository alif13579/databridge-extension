/* ══════════════════════════════════════════════════════════════
 * 📞 CALL CENTER desktop — live-sheet engine (Sheets/Request/Mix modes).
 * App parity with RemarkSheetMirror.fetchLiveConsignments + bindings:
 *   Firebase: config/sheetBindings/{branch}/cc, config/connectors/{branch}/current
 *   Sheets:   values.get per resolved column letter (fetch + filter + dates)
 * Which sheet Live reads is defined ONLY by enabled CC bindings in scope.
 * ══════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const D = window.CcData;
  const FIREBASE_URL = CONFIG.FIREBASE_URL;

  /* ── sheets token (background relay, same as popup get_sheets_token) ── */
  function getSheetsToken() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'get_sheets_token' }, (res) => {
          if (chrome.runtime.lastError) return resolve({ token: null, error: chrome.runtime.lastError.message });
          resolve({ token: (res && res.token) || null, error: (res && res.error) || null });
        });
      } catch (e) { resolve({ token: null, error: e.message }); }
    });
  }

  /* ── column utils (ConfigSheetParseUtil parity) ── */
  function parseColInput(raw) {
    const s = String(raw || '').trim().toUpperCase();
    if (!s) return null;
    const asNum = parseInt(s, 10);
    if (String(asNum) === s && asNum > 0) return asNum;
    if (!/^[A-Z]{1,3}$/.test(s)) return null;
    let n = 0;
    for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  }
  function colIndexToLetter(n) {
    let num = n, out = '';
    while (num > 0) {
      const rem = (num - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      num = Math.floor((num - 1) / 26);
    }
    return out;
  }
  const LETTER_RE = /^[A-Za-z]{1,3}$/;

  /* ── scope (SheetScope parity, Dhaka today) ── */
  function dhakaTodayStr() {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch { return new Date().toISOString().slice(0, 10); }
  }
  function scopeCovers(type, month, from, to, todayStr) {
    if (type === 'month') {
      const m = String(month || '').trim().replace(/^(\d{4})-(\d)$/, '$1-0$2');
      return /^\d{4}-\d{2}$/.test(m) && m === todayStr.slice(0, 7);
    }
    if (type === 'range') {
      const f = String(from || '').trim(), t = String(to || '').trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(t) && todayStr >= f && todayStr <= t;
    }
    return true; // global + legacy blank
  }

  /* ── tab pattern (resolveTabName parity, Dhaka date) ── */
  function resolveTabName(pattern, atDate) {
    const d = atDate instanceof Date ? atDate : new Date();
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    const dd = get('day'), mm = get('month'), yyyy = get('year');
    return String(pattern || 'Day {dd}')
      .replace('{dd}', dd).replace('{d}', String(+dd))
      .replace('{mm}', mm).replace('{m}', String(+mm))
      .replace('{yyyy}', yyyy).replace('{yy}', yyyy.slice(2));
  }

  /* ── date parse (SheetCellCompare.parseDate subset + slash ambiguity) ── */
  function parseDateLocal(s) {
    const t = String(s || '').trim();
    if (!t) return null;
    // ISO yyyy-MM-dd (+ optional time)
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    // dd-MM-yyyy (+ optional Dhaka stamp time)
    m = t.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})/);
    if (m) {
      let y = +m[3]; if (y < 100) y += 2000;
      return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    }
    // yyyy/MM/dd
    m = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    return null;
  }
  function slashCandidates(cell) {
    // "09/10" or "09/10/2026": d/M first (existing dd/MM sheets), then M/d
    const m = String(cell || '').trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (!m) return [];
    let y = m[3] ? +m[3] : new Date().getFullYear();
    if (y < 100) y += 2000;
    const a = +m[1], b = +m[2];
    const out = [];
    const p = (d, mo) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
      ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
    const first = p(a, b), second = p(b, a);
    if (first) out.push(first);
    if (second && second !== first) out.push(second);
    return out;
  }
  function rowDateKeys(dateCols, i) {
    for (const col of dateCols) {
      const cell = (col[i] || '').trim();
      if (!cell) continue;
      const keys = [];
      const primary = parseDateLocal(cell);
      if (primary) keys.push(primary);
      for (const c of slashCandidates(cell)) if (!keys.includes(c)) keys.push(c);
      if (keys.length) return keys;
    }
    return [];
  }

  /* ── filter compare (SheetCellCompare.pass parity) ── */
  function compareOrdered(a, b) {
    const an = parseFloat(String(a).replace(/,/g, ''));
    const bn = parseFloat(String(b).replace(/,/g, ''));
    if (Number.isFinite(an) && Number.isFinite(bn)) return an < bn ? -1 : an > bn ? 1 : 0;
    const ad = parseDateLocal(a), bd = parseDateLocal(b);
    if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : 0;
    const x = String(a).trim().toLowerCase(), y = String(b).trim().toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  function filterPass(op, cell, value, valueType) {
    const c = String(cell || '').trim();
    const t = valueType === 'today' ? dhakaTodayStr() : String(value || '').trim();
    switch (String(op || '').toLowerCase()) {
      case 'blank': return !c;
      case 'notblank': return !!c;
      case 'equals': return valueType === 'text' ? c === t : compareOrdered(c, t) === 0;
      case 'notequals': return valueType === 'text' ? c !== t : compareOrdered(c, t) !== 0;
      case 'gt': return compareOrdered(c, t) > 0;
      case 'gte': return compareOrdered(c, t) >= 0;
      case 'lt': return compareOrdered(c, t) < 0;
      case 'lte': return compareOrdered(c, t) <= 0;
      default: return true;
    }
  }

  /* ── Firebase config reads ── */
  async function fbJson(path, idToken) {
    const res = await fetch(`${FIREBASE_URL}/${path}.json?auth=${encodeURIComponent(idToken)}`);
    if (!res.ok) throw new Error(`Firebase ${res.status}`);
    return res.json().catch(() => null);
  }

  function mapBinding(id, branchId, b) {
    const g = (k) => (b && b[k] !== undefined ? b[k] : '');
    const maps = (arr) => (Array.isArray(arr) ? arr : []).map((r) => ({
      colRef: r.colRef || '', mode: r.mode === 'text' ? 'text' : 'index', field: r.field || '',
    })).filter((r) => r.colRef && r.field);
    const filters = (Array.isArray(b.filters) ? b.filters : []).map((r) => ({
      colRef: r.colRef || '', mode: r.mode === 'text' ? 'text' : 'index',
      op: r.op || 'blank', value: r.value || '', valueType: r.valueType || 'text',
    })).filter((r) => r.colRef && r.op);
    return {
      bindingId: id, libraryId: g('libraryId'), branchId,
      enabled: b.enabled !== false,
      fetchColRef: g('fetchColRef'), fetchColMode: g('fetchColMode') === 'text' ? 'text' : 'index',
      filterLogic: g('filterLogic') === 'OR' ? 'OR' : 'AND',
      filters,
      lookups: maps(b.lookups),
    };
  }

  /* ── Sheets values.get ── */
  async function sheetColumn(token, sheetId, tab, letter) {
    const range = encodeURIComponent(`${tab}!${letter}:${letter}`);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Sheets ${res.status}`);
    const body = await res.json().catch(() => ({}));
    const values = Array.isArray(body.values) ? body.values : [];
    return values.map((r) => (Array.isArray(r) && r.length ? String(r[0]) : ''));
  }
  async function sheetRow(token, sheetId, tab, rowNum) {
    const range = encodeURIComponent(`${tab}!${rowNum}:${rowNum}`);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Sheets ${res.status}`);
    const body = await res.json().catch(() => ({}));
    const values = Array.isArray(body.values) ? body.values : [];
    return (values[0] || []).map((c) => String(c == null ? '' : c));
  }

  function resolveLetter(ref, mode, headerRowValues) {
    const t = String(ref || '').trim();
    if (!t) return null;
    if (mode !== 'text') {
      if (LETTER_RE.test(t)) return t.toUpperCase();
      return colIndexToLetter(parseColInput(t) || 0) || null;
    }
    const idx = headerRowValues.findIndex((h) => String(h).trim() === t);
    return idx < 0 ? null : colIndexToLetter(idx + 1);
  }

  function effectiveColStart(lib) {
    if (lib.colStart >= 1) return lib.colStart;
    const idx = [...(lib.lookupCols || []), ...(lib.writeCols || [])]
      .map((r) => (r.mode === 'text' ? null : parseColInput(r.colRef))).filter((n) => n);
    return idx.length ? Math.min(...idx) : 1;
  }

  /* ── one binding's live IDs ── */
  async function fetchLiveIdsForBinding(sheetsToken, binding, lib, headerCache) {
    const tab = resolveTabName(lib.tabPattern || 'Day {dd}');
    const headerRow = (lib.headerRow >= 1 && lib.headerRow <= 20) ? lib.headerRow : 1;
    const letterOf = async (ref, mode) => {
      const t = String(ref || '').trim();
      if (!t) return null;
      if (mode !== 'text') {
        if (LETTER_RE.test(t)) return t.toUpperCase();
        const idx = parseColInput(t);
        return idx ? colIndexToLetter(idx) : null;
      }
      const key = `${lib.sheetId}#${tab}#${headerRow}`;
      if (!headerCache.has(key)) {
        headerCache.set(key, await sheetRow(sheetsToken, lib.sheetId, tab, headerRow));
      }
      return resolveLetter(t, mode, headerCache.get(key));
    };
    // fetch column: socket choice else range start
    const s = effectiveColStart(lib);
    const rangeStart = colIndexToLetter(s);
    const wantFetchRef = String(binding.fetchColRef || '').trim() || rangeStart;
    if (!wantFetchRef) return { ids: [], scanned: 0, dropped: 0, note: 'No lookup column' };
    const colValues = new Map();
    const colOf = async (ref, mode) => {
      const letter = await letterOf(ref, mode);
      if (!letter) return null;
      if (!colValues.has(letter)) {
        colValues.set(letter, await sheetColumn(sheetsToken, lib.sheetId, tab, letter));
      }
      return colValues.get(letter);
    };
    const missing = [];
    const ruleCols = [];
    for (const r of binding.filters) {
      const values = await colOf(r.colRef, r.mode).catch(() => null);
      if (values === null) missing.push(String(r.colRef).trim());
      ruleCols.push({ filter: r, values });
    }
    const idCol = await colOf(wantFetchRef, binding.fetchColMode).catch(() => null);
    if (idCol === null) return { ids: [], scanned: 0, dropped: 0, note: `ID column '${wantFetchRef}' not found` };
    const useOr = binding.filters.length > 0 && binding.filterLogic === 'OR';
    // date columns: lookup TODAY / CREATED_AT fields
    const dateCols = [];
    for (const lk of binding.lookups) {
      if (lk.field !== 'today' && lk.field !== 'created_at') continue;
      const vals = await colOf(lk.colRef, lk.mode).catch(() => null);
      if (vals) dateCols.push(vals);
    }
    const ids = [];
    const seen = new Set();
    let dropped = 0;
    idCol.forEach((cell, i) => {
      const cid = String(cell || '').trim();
      if (!cid) return;
      const results = ruleCols.map(({ filter, values }) =>
        values === null ? true : filterPass(filter.op, values[i] || '', filter.value, filter.valueType));
      const pass = useOr && results.length ? results.some(Boolean) : results.every(Boolean);
      if (!pass) { dropped++; return; }
      if (seen.has(cid)) return;
      seen.add(cid);
      ids.push({ cid, dateKeys: rowDateKeys(dateCols, i) });
    });
    return {
      ids, scanned: idCol.length, dropped,
      note: missing.length ? `Column ${[...new Set(missing)].join(',')} not found (skipped)` : null,
    };
  }

  /* ── public: live IDs for branches (fetchLiveConsignments parity) ── */
  async function loadLiveIds(idToken, branchIds) {
    const { token, error } = await getSheetsToken();
    if (!token) {
      return branchIds.map((branchId) => ({
        branchId, ids: [], note: `No Sheets permission (${error || 'login needed'})`, failed: true,
      }));
    }
    const today = dhakaTodayStr();
    const out = [];
    for (const branchId of branchIds) {
      try {
        const [bindObj, connObj] = await Promise.all([
          fbJson(`config/sheetBindings/${encodeURIComponent(branchId)}/cc`, idToken).catch(() => null),
          fbJson(`config/connectors/${encodeURIComponent(branchId)}/current`, idToken).catch(() => null),
        ]);
        const bindings = Object.entries(bindObj && typeof bindObj === 'object' ? bindObj : {})
          .map(([id, b]) => mapBinding(id, branchId, b || {}))
          .filter((b) => b.enabled && b.libraryId);
        if (!bindings.length) {
          out.push({ branchId, ids: [], note: 'No CC binding — bind a sheet from the CallCenter socket', failed: false });
          continue;
        }
        const libs = {};
        Object.entries(connObj && typeof connObj === 'object' ? connObj : {}).forEach(([lid, l]) => {
          if (l && l.isLibrary && l.enabled !== false) {
            libs[lid] = {
              libraryId: lid,
              nickname: l.nickname || '', sheetId: l.sheetId || '', sheetName: l.sheetName || '',
              tabPattern: l.tabPattern || 'Day {dd}', headerRow: l.headerRow || 1,
              colStart: l.colStart || 0, colEnd: l.colEnd || 0,
              lookupCols: l.lookupCols || [], writeCols: l.writeCols || [],
              enabled: true,
              scopeType: l.scopeType || 'global', scopeMonth: l.scopeMonth || '',
              scopeFrom: l.scopeFrom || '', scopeTo: l.scopeTo || '',
            };
          }
        });
        const targets = bindings
          .map((b) => ({ b, lib: libs[b.libraryId] }))
          .filter(({ b, lib }) => lib && lib.sheetId && scopeCovers(lib.scopeType, lib.scopeMonth, lib.scopeFrom, lib.scopeTo, today));
        if (!targets.length) {
          out.push({ branchId, ids: [], note: "No bound sheet in today's scope", failed: false });
          continue;
        }
        const ids = [];
        const seenIds = new Set();
        let scanned = 0, dropped = 0;
        const notes = [];
        const headerCache = new Map();
        for (const { b, lib } of targets) {
          const r = await fetchLiveIdsForBinding(token, b, lib, headerCache).catch(() => null);
          if (!r) { notes.push(`${lib.nickname || lib.sheetName}: read failed`); continue; }
          scanned += r.scanned; dropped += r.dropped;
          if (r.note) notes.push(`${lib.nickname || lib.sheetName}: ${r.note}`);
          for (const e of r.ids) {
            if (seenIds.has(e.cid)) continue;
            seenIds.add(e.cid);
            ids.push(e);
          }
        }
        const genuine = ['No CC binding', 'No bound sheet', 'No consignments today'];
        const failedRead = ids.length === 0 && notes.some((n) => {
          const t = String(n).split(': ').slice(1).join(': ').trim();
          return t && !genuine.some((g) => t.startsWith(g));
        });
        out.push({
          branchId, ids,
          note: ids.length && notes.length ? notes.join('; ')
            : ids.length ? null
            : notes[0] || `No consignments today (${scanned} rows scanned)`,
          failed: failedRead,
        });
      } catch (e) {
        out.push({ branchId, ids: [], note: String((e && e.message) || 'could not read sheet').slice(0, 80), failed: true });
      }
    }
    return out;
  }

  window.CcSheet = { loadLiveIds, getSheetsToken };
})();
