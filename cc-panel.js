// ══════════════════════════════════════════════════════════════════════
// ☎️ CALL CENTER PANEL — floating overlay showing today's Hold Validation
// summary (all of the signed-in user's branches, combined) on whatever
// page(s) are configured in Settings → "Call Center Panel Pages"
// (chrome.storage.local key: cc_panel_urls — empty by default, same
// opt-in pattern as scan-receive-helper.js's Auto-fill Pages).
//
// A content script runs in its own JS execution context per file — it
// can't call popup.js's functions directly — so the pieces this needs
// (Firebase token refresh, the Supabase report fetch, branch lookup, BD
// date formatting) are ported here rather than shared. Keep these in sync
// with popup.js's versions if that logic ever changes.
// ══════════════════════════════════════════════════════════════════════
(() => {
  'use strict';

  const FIREBASE_URL          = CONFIG.FIREBASE_URL;
  const FIREBASE_WEB_API_KEY  = CONFIG.FIREBASE_WEB_API_KEY;
  const SUPABASE_URL          = CONFIG.SUPABASE_URL;
  const SUPABASE_ANON_KEY     = CONFIG.SUPABASE_ANON_KEY;
  const SUPABASE_REPORT_PAGE_SIZE = 100;

  // ── Firebase auth (ported from popup.js's refreshFirebaseIdToken/getValidFirebaseIdToken) ──
  async function refreshFirebaseIdToken(refreshToken) {
    const res = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_WEB_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString()
      }
    );
    const data = await res.json();
    if (!res.ok || !data.id_token) throw new Error(data?.error?.message || 'Token refresh failed');
    return {
      idToken: data.id_token,
      refreshToken: data.refresh_token,
      expiresIn: parseInt(data.expires_in, 10) || 3600
    };
  }

  async function getValidFirebaseIdToken() {
    const stored = await chrome.storage.local.get(['google_id_token', 'google_refresh_token', 'google_token_expires_at']);
    if (!stored.google_refresh_token) return null;
    const SAFETY_MARGIN_MS = 5 * 60 * 1000;
    if (stored.google_id_token && Date.now() < (stored.google_token_expires_at || 0) - SAFETY_MARGIN_MS) {
      return stored.google_id_token;
    }
    try {
      const { idToken, refreshToken, expiresIn } = await refreshFirebaseIdToken(stored.google_refresh_token);
      await chrome.storage.local.set({
        google_id_token: idToken,
        google_refresh_token: refreshToken,
        google_token_expires_at: Date.now() + expiresIn * 1000
      });
      return idToken;
    } catch (e) {
      console.warn('[DB CC Panel] token refresh failed:', e);
      return null;
    }
  }

  // ── BD-local date helpers (ported from popup.js — see its own comment on
  //    why Intl.DateTimeFormat with an explicit timeZone is used instead of
  //    trusting the machine's own timezone) ──
  const BD_DATE_PARTS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' });
  function localDateKey(isoString) { return BD_DATE_PARTS.format(new Date(isoString)); }
  function dateKeyToDdMmYyyy(dateKey) { const [y, m, d] = dateKey.split('-'); return `${d}-${m}-${y}`; }
  function todayBdDateKey() { return BD_DATE_PARTS.format(new Date()); }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  // ── Supabase report fetch (ported from popup.js's fetchSupabaseReportRows,
  //    identical logic — same Edge Function, same pagination) ──
  async function fetchSupabaseReportRows(branchId, startIso, endIso, idToken) {
    const rows = [];
    let page = 0;
    for (;;) {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/validations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          action: 'report', branch_id: branchId, start_iso: startIso, end_iso: endIso,
          page, page_size: SUPABASE_REPORT_PAGE_SIZE,
        }),
      });
      const data = await res.json();
      const pageRows = Array.isArray(data) ? data : [];
      rows.push(...pageRows);
      if (pageRows.length < SUPABASE_REPORT_PAGE_SIZE) break;
      page++;
    }
    return rows;
  }

  // ── Branch list (ported from popup.js's loadCcBranches — id + name lookup) ──
  async function fetchMyBranches(uid, idToken) {
    const authQuery = idToken ? `?auth=${idToken}` : '';
    const res  = await fetch(`${FIREBASE_URL}/users/${uid}/profile/company_info/branch_ids.json${authQuery}`);
    const data = await res.json();
    const ids  = Array.isArray(data) ? data.filter(Boolean) : Object.values(data || {});
    const names = {};
    await Promise.all(ids.map(async id => {
      try {
        const r = await fetch(`${FIREBASE_URL}/branches/${id}/name.json${authQuery}`);
        names[id] = (await r.json()) || id;
      } catch { names[id] = id; }
    }));
    return { ids, names };
  }

  // ── STYLES ──────────────────────────────────────────────────────────────
  // Light-card-on-dark-header widget, matching the existing Reconcile panel's
  // look (scan-receive-helper.js's #db-panel) rather than the extension's own
  // dark popup theme — this floats over an arbitrary host page, and that
  // established "widget" look is the one already proven to sit well there.
  function injectStyle() {
    if (document.getElementById('db-cc-style')) return;
    const s = document.createElement('style');
    s.id = 'db-cc-style';
    s.textContent = `
      #db-cc-panel {
        position: fixed; top: 0px; right: 375px; z-index: 2147483646;
        background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
        box-shadow: 0 4px 24px rgba(0,0,0,.13); width: 340px; max-height: 420px;
        min-width: 280px;
        font: 13px/1.5 -apple-system, Segoe UI, sans-serif; overflow: hidden;
        display: flex; flex-direction: column;
      }
      .db-cc-hdr {
        background: #1e293b; color: #fff; padding: 7px 10px;
        display: flex; justify-content: space-between; align-items: center;
        cursor: move; user-select: none; font-weight: 600; font-size: 11px;
        flex-shrink: 0;
      }
      .db-cc-hdr button {
        background: none; border: none; color: #fff; font-size: 18px;
        cursor: pointer; line-height: 1; padding: 0 2px;
      }
      .db-cc-body { padding: 8px; flex: 1; min-height: 0; overflow-y: auto; }
      .db-cc-status { font-size: 11px; color: #64748b; padding: 8px 2px; }
      .db-cc-summary { display: flex; gap: 6px; margin-bottom: 8px; }
      .db-cc-stat {
        flex: 1; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
        padding: 5px 4px; text-align: center; cursor: pointer;
      }
      .db-cc-stat.active { border-color: #3b82f6; background: #eff6ff; }
      .db-cc-stat-val { font-size: 15px; font-weight: 700; color: #1e293b; line-height: 1.2; }
      .db-cc-stat-val.validated { color: #16a34a; }
      .db-cc-stat-val.pending   { color: #d97706; }
      .db-cc-stat-label { font-size: 8px; color: #64748b; margin-top: 2px; text-transform: uppercase; letter-spacing: .3px; }
      .db-cc-row {
        background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
        padding: 6px 8px; margin-bottom: 6px; font-size: 11px;
      }
      .db-cc-row-pending   { border-left: 3px solid #d97706; }
      .db-cc-row-validated { border-left: 3px solid #16a34a; }
      .db-cc-row-top { display: flex; justify-content: space-between; font-weight: 600; color: #1e293b; }
      .db-cc-row-meta { color: #64748b; font-size: 10px; margin-top: 2px; }
      .db-cc-row-remark { margin-top: 3px; color: #334155; }
      .db-cc-row-bottom { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; }
      .db-cc-badge { font-size: 9px; padding: 2px 6px; border-radius: 3px; font-weight: 700; }
      .db-cc-badge-pending   { background: #fef3c7; color: #92400e; }
      .db-cc-badge-validated { background: #dcfce7; color: #15803d; }
      .db-cc-call-btn {
        background: #dcfce7; color: #15803d; border: 1px solid #86efac;
        border-radius: 4px; padding: 3px 8px; font-size: 10px; font-weight: 600; cursor: pointer;
      }
      .db-cc-call-btn:disabled { opacity: .6; cursor: default; }
      .db-cc-hist-btn, .db-cc-remark-btn {
        background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1;
        border-radius: 4px; padding: 3px 8px; font-size: 10px; font-weight: 600; cursor: pointer;
        margin-left: 4px;
      }
      .db-cc-hist-section, .db-cc-remark-section {
        margin-top: 6px; border-top: 1px dashed #cbd5e1; padding-top: 6px;
      }
      .db-cc-hist-entry {
        background: #fff; border: 1px solid #e2e8f0; border-radius: 4px;
        padding: 4px 6px; margin-bottom: 4px; font-size: 10px; color: #334155;
      }
      .db-cc-hist-worker { border-left: 3px solid #d97706; }
      .db-cc-hist-cc     { border-left: 3px solid #16a34a; }
      .db-cc-hist-head { display: flex; justify-content: space-between; font-weight: 700; color: #1e293b; }
      .db-cc-hist-status { color: #64748b; }
      .db-cc-chip-row { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
      .db-cc-chip {
        background: #f1f5f9; color: #1e293b; border: 1px solid #cbd5e1;
        border-radius: 12px; padding: 3px 9px; font-size: 10px; cursor: pointer;
      }
      .db-cc-chip.selected { background: #2563eb; color: #fff; border-color: #2563eb; font-weight: 700; }
      .db-cc-note {
        width: 100%; box-sizing: border-box; font: inherit; font-size: 11px;
        border: 1px solid #cbd5e1; border-radius: 4px; padding: 5px 6px; resize: vertical;
      }
      .db-cc-remark-actions { display: flex; gap: 6px; margin-top: 6px; }
      .db-cc-cancel-btn {
        flex: 1; background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1;
        border-radius: 4px; padding: 5px; font-size: 11px; font-weight: 600; cursor: pointer;
      }
      .db-cc-save-btn {
        flex: 1; background: #16a34a; color: #fff; border: none;
        border-radius: 4px; padding: 5px; font-size: 11px; font-weight: 700; cursor: pointer;
      }
      .db-cc-save-btn:disabled { opacity: .6; cursor: default; }
    `;
    document.head.appendChild(s);
  }

  // ── PANEL: create, drag-to-move (position saved under a fixed key — this
  //    panel isn't tied to a "run" the way the Reconcile panel is), minimize ──
  let minimized = false;
  function applyPanelPosition(panelEl) {
    try {
      const saved = localStorage.getItem('db-cc-panel-pos');
      if (!saved) return;
      const { left, top } = JSON.parse(saved);
      if (left) { panelEl.style.left = left; panelEl.style.right = 'auto'; }
      if (top)  panelEl.style.top = top;
    } catch (e) { /* ignore malformed/missing saved position */ }
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'db-cc-panel';
    panel.innerHTML = `
      <div class="db-cc-hdr" id="db-cc-hdr">
        <span>☎️ Call Center — Hold Validation</span>
        <button id="db-cc-min" title="Minimize">−</button>
      </div>
      <div class="db-cc-body" id="db-cc-body">
        <div class="db-cc-status">⏳ Loading…</div>
      </div>
    `;
    document.body.appendChild(panel);
    applyPanelPosition(panel);

    const hdr = panel.querySelector('#db-cc-hdr');
    hdr.addEventListener('mousedown', e => {
      if (e.target.id === 'db-cc-min') return;
      const startX = e.clientX, startY = e.clientY;
      const startLeft = panel.offsetLeft, startTop = panel.offsetTop;
      function onMove(ev) {
        panel.style.left  = (startLeft + ev.clientX - startX) + 'px';
        panel.style.top   = (startTop  + ev.clientY - startY) + 'px';
        panel.style.right = 'auto';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        localStorage.setItem('db-cc-panel-pos', JSON.stringify({ left: panel.style.left, top: panel.style.top }));
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    panel.querySelector('#db-cc-min').addEventListener('click', () => {
      minimized = !minimized;
      panel.querySelector('#db-cc-body').style.display = minimized ? 'none' : '';
      panel.querySelector('#db-cc-min').textContent = minimized ? '+' : '−';
    });

    return panel;
  }

  // ── DATA + RENDER ─────────────────────────────────────────────────────
  // Same (date, consignment) grouping / "must have a WORKER row" / "truly
  // latest row per group decides Pending vs Validated" rules as
  // generateHoldValidationReport()'s Summary mode in popup.js — this panel
  // shows exactly one day (today), across every branch the user has,
  // combined, with no date/branch pickers (no room for them here).
  let summaryRows = [];
  let filter = 'all'; // 'all' | 'pending' | 'validated'
  let ccIdToken = null;      // set per loadAndRender — remark options + save reuse it
  let ccBodyEl = null;
  let ccBranchNamesCache = {};
  let ccRemarkOpts = null;   // CC catalog, cached per page load

  function computeSummaryRows(allRows) {
    const groups = {};
    allRows.forEach(row => {
      const dateKey = localDateKey(row.created_at);
      const key = `${dateKey}__${row.consignment}`;
      if (!groups[key]) groups[key] = { dateKey, cId: row.consignment, branchId: row.branch_id, rows: [] };
      groups[key].rows.push(row);
    });
    const validGroups = Object.values(groups).filter(g => g.rows.some(r => r.source === 'WORKER'));

    const latestMs   = row => new Date(row.created_at).getTime();
    const earliestOf = rows => rows.reduce((e, r) => (!e || latestMs(r) < latestMs(e)) ? r : e, null);
    const latestOf   = rows => rows.reduce((l, r) => (!l || latestMs(r) >= latestMs(l)) ? r : l, null);

    return validGroups.map(g => {
      const workerRows  = g.rows.filter(r => r.source === 'WORKER');
      const ccRows      = g.rows.filter(r => r.source === 'CC');
      const firstWorker = earliestOf(workerRows);
      const lastCc      = ccRows.length ? latestOf(ccRows) : null;
      const latestOfAll = latestOf(g.rows);
      // Full chronological trail for the expandable history (already in memory —
      // no extra fetch). Same fields the dashboard Details mode renders.
      const trail = g.rows.slice().sort((a, b) => latestMs(a) - latestMs(b)).map(r => ({
        source:  r.source || '',
        remark:  r.remarks || '',
        note:    r.note || '',
        status:  r.remarks_status || '',
        created: r.created_at || '',
        author:  (r.author && r.author.employee_id) || r.author_system_id || '',
      }));
      return {
        dateLabel: dateKeyToDdMmYyyy(g.dateKey),
        branchId:  g.branchId,
        cId:       g.cId,
        agentSystemId: (g.rows[0] && g.rows[0].assigned_to_system_id) || '',
        customerPhone:     (latestOfAll.customer_phone || '').trim(),
        firstWorkerRemark: firstWorker.remarks || firstWorker.note || '',
        lastCcRemark:      lastCc ? (lastCc.remarks || lastCc.note || '') : '',
        stillPending:      latestOfAll.source === 'WORKER',
        trail,
      };
    });
  }

  function render(bodyEl, branchNames) {
    const totalReq   = summaryRows.length;
    const pendingCnt = summaryRows.filter(r => r.stillPending).length;
    const validCnt   = totalReq - pendingCnt;

    const filtered = filter === 'all' ? summaryRows
      : summaryRows.filter(r => filter === 'pending' ? r.stillPending : !r.stillPending);

    const rowsHtml = filtered.length ? filtered.map((r, idx) => `
      <div class="db-cc-row ${r.stillPending ? 'db-cc-row-pending' : 'db-cc-row-validated'}">
        <div class="db-cc-row-top">
          <span>${escapeHtml(r.cId)}</span>
          <span>${escapeHtml(branchNames[r.branchId] || r.branchId)}</span>
        </div>
        <div class="db-cc-row-remark">🙋 ${escapeHtml(r.firstWorkerRemark || '(no note)')}</div>
        ${r.lastCcRemark ? `<div class="db-cc-row-remark">↳ ${escapeHtml(r.lastCcRemark)}</div>` : ''}
        <div class="db-cc-row-bottom">
          <span class="db-cc-badge ${r.stillPending ? 'db-cc-badge-pending' : 'db-cc-badge-validated'}">
            ${r.stillPending ? '⏳ Pending' : '✓ Validated'}
          </span>
          <span>
            ${r.customerPhone ? `<button type="button" class="db-cc-call-btn" data-phone="${escapeHtml(r.customerPhone)}">📞 Call</button>` : ''}
            <button type="button" class="db-cc-hist-btn" data-idx="${idx}">▼ History (${r.trail.length})</button>
            <button type="button" class="db-cc-remark-btn" data-idx="${idx}">📝 Remarks</button>
          </span>
        </div>
        <div class="db-cc-hist-section" data-idx="${idx}" style="display:none"></div>
        <div class="db-cc-remark-section" data-idx="${idx}" style="display:none"></div>
      </div>`).join('') : `<div class="db-cc-status">এই filter-এ কোনো entry নেই</div>`;

    bodyEl.innerHTML = `
      <div class="db-cc-summary">
        <div class="db-cc-stat ${filter === 'all' ? 'active' : ''}" data-filter="all">
          <div class="db-cc-stat-val">${totalReq}</div><div class="db-cc-stat-label">Total</div>
        </div>
        <div class="db-cc-stat ${filter === 'validated' ? 'active' : ''}" data-filter="validated">
          <div class="db-cc-stat-val validated">${validCnt}</div><div class="db-cc-stat-label">Validated</div>
        </div>
        <div class="db-cc-stat ${filter === 'pending' ? 'active' : ''}" data-filter="pending">
          <div class="db-cc-stat-val pending">${pendingCnt}</div><div class="db-cc-stat-label">Pending</div>
        </div>
      </div>
      ${rowsHtml}
    `;

    bodyEl.querySelectorAll('.db-cc-stat').forEach(cell => {
      cell.addEventListener('click', () => {
        filter = cell.dataset.filter;
        render(bodyEl, branchNames);
      });
    });
    bodyEl.querySelectorAll('.db-cc-call-btn').forEach(btn => {
      // Same as the dashboard's Hold Validation Call button: send the number to
      // the app (background → Firebase session → app auto-dial), NOT a tel: link.
      btn.addEventListener('click', () => {
        const cleaned = btn.dataset.phone.replace(/[\s-()]/g, '');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ …';
        chrome.runtime.sendMessage({ action: 'send_to_app', text: cleaned }, () => {
          btn.textContent = '📞 Sent!';
          setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1500);
        });
      });
    });
    bodyEl.querySelectorAll('.db-cc-hist-btn').forEach(btn => {
      btn.addEventListener('click', () => toggleCcHistory(bodyEl, filtered, +btn.dataset.idx, btn));
    });
    bodyEl.querySelectorAll('.db-cc-remark-btn').forEach(btn => {
      btn.addEventListener('click', () => toggleCcRemarkSection(bodyEl, filtered, +btn.dataset.idx));
    });
  }

  function fmtHhMm(iso) {
    try {
      const d = new Date(iso);
      const p = n => String(n).padStart(2, '0');
      return `${p(d.getDate())}-${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch { return ''; }
  }

  // Expandable full trail (every WORKER request + CC response, chronological) —
  // the rows are already in memory from the report fetch, no extra request.
  function toggleCcHistory(bodyEl, rows, idx, btn) {
    const r = rows[idx];
    const section = bodyEl.querySelector(`.db-cc-hist-section[data-idx="${idx}"]`);
    if (!section || !r) return;
    if (section.style.display !== 'none') {
      section.style.display = 'none';
      btn.textContent = `▼ History (${r.trail.length})`;
      return;
    }
    section.style.display = '';
    btn.textContent = `▲ History (${r.trail.length})`;
    section.innerHTML = r.trail.length ? r.trail.map(t => {
      const who = t.source === 'CC' ? '↳ CC' : '🙋 Worker';
      const cls = t.source === 'CC' ? 'db-cc-hist-cc' : 'db-cc-hist-worker';
      const txt = [t.remark, t.note ? `📝 ${t.note}` : ''].filter(Boolean).join(' — ') || '(no text)';
      return `<div class="db-cc-hist-entry ${cls}">
        <div class="db-cc-hist-head"><span>${who}${t.author ? ' · ' + escapeHtml(t.author) : ''}</span><span>${escapeHtml(fmtHhMm(t.created))}</span></div>
        <div>${escapeHtml(txt)}${t.status ? ` <span class="db-cc-hist-status">[${escapeHtml(t.status)}]</span>` : ''}</div>
      </div>`;
    }).join('') : '<div class="db-cc-status">কোনো history নেই</div>';
  }

  // CC remark options catalog (ported from popup.js fetchCcDashboardRemarkOptions).
  async function fetchCcRemarkOptions() {
    if (ccRemarkOpts) return ccRemarkOpts;
    let remarkLang = 'bn';
    try {
      const langRes = await fetch(`${FIREBASE_URL}/config/language/ccLang.json?auth=${ccIdToken}`);
      remarkLang = ((((await langRes.json()) || '').trim()) || 'bn_en').split('_')[0] || 'bn';
    } catch { /* default bn */ }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/validation_remarks` +
      `?select=remarks_en,remarks_bn,target_status,instruction_text` +
      `&source=eq.CC&is_active=eq.true&order=priority.desc`, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${ccIdToken}`, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`remark options fetch failed (${res.status})`);
    const data = await res.json();
    ccRemarkOpts = (Array.isArray(data) ? data : []).map(x => {
      const en = (x.remarks_en || '').trim();
      const bn = (x.remarks_bn || '').trim();
      return {
        label: (remarkLang === 'en' ? (en || bn) : (bn || en)).trim(),
        english: en || bn,
        target: (x.target_status || '').trim(),
        instruction: (x.instruction_text || '').trim(),
      };
    }).filter(o => o.label && o.target);
    return ccRemarkOpts;
  }

  // Per-row 📝 Remarks → CC options + note + save, same catalog + write path as
  // the dashboard (popup.js toggleHvRemarkSection) and the app's CC sheet.
  // No sheet-verdict mirror here (needs the device Google account, app-side only).
  async function toggleCcRemarkSection(bodyEl, rows, idx) {
    const card = rows[idx];
    const section = bodyEl.querySelector(`.db-cc-remark-section[data-idx="${idx}"]`);
    if (!section || !card) return;
    if (section.style.display !== 'none') { section.style.display = 'none'; return; }
    section.style.display = '';
    if (section.dataset.loaded) return;
    section.innerHTML = '<div class="db-cc-status">⏳ Remarks লোড হচ্ছে…</div>';

    if (!ccIdToken) { section.innerHTML = '<div class="db-cc-status">⚠ Login করুন প্রথমে</div>'; return; }
    if (!card.agentSystemId) {
      section.innerHTML = '<div class="db-cc-status">⚠ এই parcel-এ এখনো কোনো worker assign/touch করেনি, তাই remark save করা যাচ্ছে না</div>';
      return;
    }
    let options;
    try {
      options = await fetchCcRemarkOptions();
    } catch (e) {
      section.innerHTML = `<div class="db-cc-status">⚠ Remarks load failed — ${escapeHtml(e.message || 'network error')}</div>`;
      return;
    }
    section.dataset.loaded = '1';

    const chipsHtml = options.length
      ? `<div class="db-cc-chip-row">${options.map((o, i) =>
          `<button type="button" class="db-cc-chip" data-opt="${i}" title="→ ${escapeHtml(o.target)}">${escapeHtml(o.label)}</button>`
        ).join('')}</div>`
      : '<div class="db-cc-status">⚠ Config-এ কোনো remark সেট করা নেই। নোট হিসেবে লিখতে পারেন:</div>';

    section.innerHTML = `
      ${chipsHtml}
      <textarea class="db-cc-note" rows="2" placeholder="নোট লিখুন (ঐচ্ছিক)"></textarea>
      <div class="db-cc-remark-actions">
        <button type="button" class="db-cc-cancel-btn">বন্ধ করুন</button>
        <button type="button" class="db-cc-save-btn">সেভ করুন</button>
      </div>
      <div class="db-cc-status" data-role="msg" style="display:none"></div>`;

    const msgEl   = section.querySelector('[data-role="msg"]');
    const noteEl  = section.querySelector('.db-cc-note');
    const saveBtn = section.querySelector('.db-cc-save-btn');
    let selected = -1;
    const say = t => { msgEl.textContent = t; msgEl.style.display = t ? '' : 'none'; };

    section.querySelectorAll('.db-cc-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const i = +chip.dataset.opt;
        selected = (selected === i) ? -1 : i;
        section.querySelectorAll('.db-cc-chip').forEach(c =>
          c.classList.toggle('selected', +c.dataset.opt === selected));
        noteEl.value = selected >= 0 ? options[selected].instruction : '';
      });
    });
    section.querySelector('.db-cc-cancel-btn').addEventListener('click', () => {
      section.style.display = 'none';
    });
    saveBtn.addEventListener('click', async () => {
      const note = noteEl.value.trim();
      const opt = selected >= 0 ? options[selected] : null;
      if (!opt && !note) { say('একটি রিমার্কস বেছে নিন বা নোট লিখুন'); return; }
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ …';
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/validations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ccIdToken}`, 'apikey': SUPABASE_ANON_KEY },
          body: JSON.stringify({ action: 'write', row: {
            consignment: card.cId, branch_id: card.branchId,
            assigned_to_system_id: card.agentSystemId, source: 'CC',
            remarks_status: opt ? opt.target : '',
            remarks: opt ? opt.english : '',
            note,
            remarks_bn: (opt && opt.label !== opt.english) ? opt.label : '',
          }}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
        say('✓ রিমার্কস সেভ হয়েছে — reload হচ্ছে…');
        setTimeout(() => { if (ccBodyEl) loadAndRender(ccBodyEl); }, 800);
      } catch (e) {
        say(`⚠ Save failed — ${e.message || 'network error'}`);
        saveBtn.disabled = false;
        saveBtn.textContent = 'সেভ করুন';
      }
    });
  }

  async function loadAndRender(bodyEl) {
    const idToken = await getValidFirebaseIdToken();
    if (!idToken) { bodyEl.innerHTML = '<div class="db-cc-status">⚠ Extension-এ Google দিয়ে login করুন প্রথমে</div>'; return; }
    ccIdToken = idToken;
    ccBodyEl = bodyEl;
    const { google_uid } = await chrome.storage.local.get(['google_uid']);
    if (!google_uid) { bodyEl.innerHTML = '<div class="db-cc-status">⚠ Google login পাওয়া যায়নি</div>'; return; }

    const { ids: branchIds, names: branchNames } = await fetchMyBranches(google_uid, idToken);
    if (!branchIds.length) { bodyEl.innerHTML = '<div class="db-cc-status">⚠ কোনো branch assigned নেই</div>'; return; }

    const dateKey  = todayBdDateKey();
    const startIso = new Date(`${dateKey}T00:00:00+06:00`).toISOString();
    const endIso   = new Date(new Date(startIso).getTime() + 24 * 60 * 60 * 1000).toISOString();

    try {
      const allRows = [];
      await Promise.all(branchIds.map(async id => {
        const rows = await fetchSupabaseReportRows(id, startIso, endIso, idToken);
        allRows.push(...rows);
      }));
      summaryRows = computeSummaryRows(allRows);
      ccBranchNamesCache = branchNames;
      render(bodyEl, branchNames);
    } catch (e) {
      console.error('[DB CC Panel] load failed:', e);
      bodyEl.innerHTML = '<div class="db-cc-status">⚠ Load failed — console (F12) দেখো</div>';
    }
  }

  // ── INIT — opt-in per page via Settings → "Call Center Panel Pages"
  //    (chrome.storage.local key: cc_panel_urls), same pattern as
  //    scan-receive-helper.js's initIfAllowed(); empty by default. ──
  async function initIfAllowed() {
    let urls = [];
    try {
      const result = await chrome.storage.local.get(['cc_panel_urls']);
      if (Array.isArray(result.cc_panel_urls)) urls = result.cc_panel_urls;
    } catch (e) {
      console.warn('[DB CC Panel] Could not read cc_panel_urls:', e);
    }
    if (!urls.some(u => u && window.location.href.includes(u))) return;

    injectStyle();
    const panel = createPanel();
    await loadAndRender(panel.querySelector('#db-cc-body'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initIfAllowed);
  } else {
    initIfAllowed();
  }
})();
