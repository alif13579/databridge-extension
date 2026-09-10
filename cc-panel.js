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
  // Picked-date label: Today / Yesterday / dd-MM-yyyy.
  function ccDateLabel(key) {
    const today = todayBdDateKey();
    if (key === today) return 'Today';
    const yest = new Date(new Date(`${today}T00:00:00+06:00`).getTime() - 24 * 3600 * 1000);
    if (key === BD_DATE_PARTS.format(yest)) return 'Yesterday';
    return dateKeyToDdMmYyyy(key);
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Supabase report fetch (ported from popup.js's fetchSupabaseReportRows,
  //    identical logic — same Edge Function, same pagination) ──
  async function fetchSupabaseReportRows(branchId, startIso, endIso, idToken) {
    const rows = [];
    let page = 0;
    const MAX_PAGES = 50; // safety: exact-multiple-of-page-size must not loop forever
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
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Supabase report fetch failed (${res.status}) for branch "${branchId}": ${body.slice(0, 200)}`);
      }
      const data = await res.json().catch(() => []);
      if (!Array.isArray(data)) {
        throw new Error(`Supabase report fetch returned non-array for branch "${branchId}" — aborting paging (would loop forever)`);
      }
      rows.push(...data);
      if (data.length < SUPABASE_REPORT_PAGE_SIZE) break;
      page++;
      if (page >= MAX_PAGES) {
        console.warn('[DB CC Panel] report paging stopped at MAX_PAGES for branch', branchId);
        break;
      }
    }
    return rows;
  }

  // Live card-er jonno nirdisto ID-gulor validations (app buildLiveParcels-er moto).
  async function fetchValidationsByIds(ids, idToken) {
    const uniq = [...new Set((ids || []).map(String).map(s => s.trim()).filter(Boolean))];
    const out = [];
    for (let i = 0; i < uniq.length; i += 200) {
      const ch = uniq.slice(i, i + 200);
      const res = await fetch(`${SUPABASE_URL}/rest/v1/validations` +
        `?select=consignment,branch_id,assigned_to_system_id,source,remarks_status,remarks,note,customer_phone,created_at` +
        `&consignment=in.(${ch.map(encodeURIComponent).join(',')})` +
        `&order=created_at.desc`, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${idToken}`, 'Accept': 'application/json' },
      });
      if (!res.ok) throw new Error(`Supabase validations fetch failed (${res.status})`);
      const arr = await res.json().catch(() => []);
      if (Array.isArray(arr)) out.push(...arr);
    }
    return out;
  }

  // ── Branch list (branch_ids from Firebase profile + names from Supabase,
  //    which is source of truth since the branch cutover — Firebase
  //    branches/{id}/name no longer exists, so that lookup only ever
  //    returned the id back) ──
  async function fetchMyBranches(uid, idToken) {
    const authQuery = idToken ? `?auth=${idToken}` : '';
    const res  = await fetch(`${FIREBASE_URL}/users/${uid}/profile/company_info/branch_ids.json${authQuery}`);
    const data = await res.json();
    const ids  = Array.isArray(data) ? data.filter(Boolean) : Object.values(data || {});
    const names = {};
    if (!ids.length) return { ids, names };
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/branches?select=branch_id,name`, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${idToken}`, 'Accept': 'application/json' },
      });
      const rows = await r.json();
      (Array.isArray(rows) ? rows : []).forEach(b => {
        if (b && b.branch_id) names[b.branch_id] = b.name || b.branch_id;
      });
    } catch { /* fall through to id fallback below */ }
    ids.forEach(id => { if (!names[id]) names[id] = id; });
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
      .db-cc-spinner {
        display: inline-block; width: 11px; height: 11px; margin-right: 6px;
        border: 2px solid #cbd5e1; border-top-color: #1e293b; border-radius: 50%;
        animation: db-cc-spin .7s linear infinite; vertical-align: -1px;
      }
      @keyframes db-cc-spin { to { transform: rotate(360deg); } }
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
      .db-cc-badge-none      { background: #f1f5f9; color: #64748b; }
      .db-cc-row-none { border-left: 3px solid #cbd5e1; }
      .db-cc-modes { display: flex; gap: 2px; margin-left: auto; }
      .db-cc-mode-btn {
        background: #f1f5f9; color: #64748b; border: 1px solid #cbd5e1;
        border-radius: 4px; padding: 1px 7px; font-size: 10px; font-weight: 700; cursor: pointer;
      }
      .db-cc-mode-btn.active { background: #1e293b; color: #fff; border-color: #1e293b; }
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
      #db-cc-sync-sheet {
        background: #ede9fe; color: #6d28d9; border: 1px solid #c4b5fd;
        border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 700; cursor: pointer;
        margin-right: 4px;
      }
      #db-cc-sync-sheet:disabled { opacity: .6; cursor: default; }
      .db-cc-datebar {
        display: flex; align-items: center; gap: 6px;
        padding: 5px 10px; border-bottom: 1px solid #e2e8f0;
        font-size: 11px; color: #475569; background: #f8fafc;
      }
      #db-cc-date { font: inherit; font-size: 11px; color: #1e293b; border: 1px solid #cbd5e1; border-radius: 4px; padding: 1px 4px; }
      #db-cc-date-label { font-weight: 700; }
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
      .db-cc-more-btn {
        width: 100%; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe;
        border-radius: 6px; padding: 7px; font-size: 11px; font-weight: 700; cursor: pointer;
        margin: 2px 0 6px;
      }
      /* Narrow viewports (<720px): 340px panel would overflow — shrink + pin to edge */
      @media (max-width: 720px) {
        #db-cc-panel { width: calc(100vw - 16px) !important; min-width: 0 !important; right: 8px !important; }
      }
    `;
    document.head.appendChild(s);
  }

  // ── Parcel details (customer name / COD / address live on the consignment
  //    node — the validations report only carries the phone). One parallel
  //    batch per load; failures leave blanks, never block the panel. ──
  async function enrichWithParcelDetails(idToken) {
    const authQuery = idToken ? `?auth=${idToken}` : '';
    await Promise.all(summaryRows.map(async r => {
      try {
        const res = await fetch(
          `${FIREBASE_URL}/courier/consignments/${encodeURIComponent(r.cId)}.json${authQuery}`);
        const c = await res.json() || {};
        r.customerName = (c.recipientName || '').trim();
        r.address = (c.recipientAddress || '').trim();
        const cod = c.collectableAmount;
        r.codAmount = typeof cod === 'number' ? cod : parseFloat(cod) || 0;
        r.parcelStatus = (c.status || '').trim();
      } catch { /* blanks stay */ }
    }));
  }

  function fmtTaka(n) {
    try { return '৳' + Number(Math.round(n || 0)).toLocaleString('en-US'); }
    catch { return ''; }
  }
  let minimized = false;
  // Max visible cards before "show more" — unbounded DOM on a big "today" set
  // used to freeze the host page; History (20/page) was already capped, CC was not.
  const CC_RENDER_LIMIT = 50;
  let ccVisibleCount = CC_RENDER_LIMIT;
  function applyPanelPosition(panelEl) {
    try {
      const saved = localStorage.getItem('db-cc-panel-pos');
      if (!saved) return;
      const { left, top } = JSON.parse(saved);
      const w = panelEl.offsetWidth || 340, h = panelEl.offsetHeight || 200;
      const px = parseFloat(left), py = parseFloat(top);
      // Validate: a pos saved on a bigger monitor can strand the panel fully
      // off-screen on a smaller one — ignore it and fall back to CSS default.
      if (!isNaN(px) && px > -w + 80 && px < window.innerWidth - 80) {
        panelEl.style.left = px + 'px';
        panelEl.style.right = 'auto';
      }
      if (!isNaN(py) && py > -20 && py < window.innerHeight - 40) {
        panelEl.style.top = py + 'px';
      }
    } catch (e) { /* ignore malformed/missing saved position */ }
  }

  function clampPanelToViewport(panel) {
    const w = panel.offsetWidth || 340, h = panel.offsetHeight || 200;
    let l = panel.offsetLeft, t = panel.offsetTop;
    l = Math.min(Math.max(l, -w + 80), window.innerWidth - 80);
    t = Math.min(Math.max(t, 0), window.innerHeight - 40);
    panel.style.left = l + 'px';
    panel.style.top = t + 'px';
    panel.style.right = 'auto';
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'db-cc-panel';
    panel.innerHTML = `
      <div class="db-cc-hdr" id="db-cc-hdr">
        <span>☎️ Call Center — Hold Validation</span>
        <span><button id="db-cc-sync-sheet" title="Sync to Sheet — নির্বাচিত date-এর sheet blank + Supabase CC মিলিয়ে bulk update">⇪ Sheet</button><button id="db-cc-refresh" title="Reload now">⟳</button><button id="db-cc-min" title="Minimize">−</button></span>
      </div>
      <div class="db-cc-datebar">
        <span>📅</span><input type="date" id="db-cc-date"><span id="db-cc-date-label"></span>
        <span class="db-cc-modes" id="db-cc-modes">
          <button type="button" class="db-cc-mode-btn" data-mode="live" title="Sheet library theke ajker ID">Live</button><button type="button" class="db-cc-mode-btn" data-mode="request" title="Supabase validation requests">Req</button><button type="button" class="db-cc-mode-btn" data-mode="mix" title="Live + Request eksathe">Mix</button>
        </span>
      </div>
      <div class="db-cc-body" id="db-cc-body">
        <div class="db-cc-status">⏳ Loading…</div>
      </div>
    `;
    document.body.appendChild(panel);
    // Cascade: scan-receive panel (#db-panel) defaults to the same top:0/right:375px —
    // without this both widgets stack exactly on top of each other when both activate.
    try {
      if (document.getElementById('db-panel') && !localStorage.getItem('db-cc-panel-pos')) {
        panel.style.right = '735px';
      }
    } catch (_) { /* non-fatal */ }
    applyPanelPosition(panel);

    const hdr = panel.querySelector('#db-cc-hdr');
    hdr.addEventListener('mousedown', e => {
      if (e.target.closest && e.target.closest('button')) return;
      const startX = e.clientX, startY = e.clientY;
      const startLeft = panel.offsetLeft, startTop = panel.offsetTop;
      function onMove(ev) {
        panel.style.left  = (startLeft + ev.clientX - startX) + 'px';
        panel.style.top   = (startTop  + ev.clientY - startY) + 'px';
        panel.style.right = 'auto';
        clampPanelToViewport(panel);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        clampPanelToViewport(panel);
        localStorage.setItem('db-cc-panel-pos', JSON.stringify({ left: panel.style.left, top: panel.style.top }));
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // Touch drag + double-click header to reset a stranded position.
    hdr.addEventListener('touchstart', e => {
      if (e.target.closest && e.target.closest('button')) return;
      const t = e.touches[0];
      const startX = t.clientX, startY = t.clientY;
      const startLeft = panel.offsetLeft, startTop = panel.offsetTop;
      function onMove(ev) {
        const m = ev.touches[0];
        panel.style.left = (startLeft + m.clientX - startX) + 'px';
        panel.style.top = (startTop + m.clientY - startY) + 'px';
        panel.style.right = 'auto';
        clampPanelToViewport(panel);
        ev.preventDefault();
      }
      function onEnd() {
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        clampPanelToViewport(panel);
        try { localStorage.setItem('db-cc-panel-pos', JSON.stringify({ left: panel.style.left, top: panel.style.top })); } catch (_) {}
      }
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
    }, { passive: true });
    hdr.addEventListener('dblclick', e => {
      if (e.target.closest && e.target.closest('button')) return;
      try { localStorage.removeItem('db-cc-panel-pos'); } catch (_) {}
      panel.style.left = ''; panel.style.top = ''; panel.style.right = '';
    });

    panel.querySelector('#db-cc-min').addEventListener('click', () => {
      minimized = !minimized;
      panel.querySelector('#db-cc-body').style.display = minimized ? 'none' : '';
      panel.querySelector('#db-cc-min').textContent = minimized ? '+' : '−';
    });

    panel.querySelector('#db-cc-refresh').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.textContent = '⏳';
      try { if (ccBodyEl) await loadAndRender(ccBodyEl); }
      finally { btn.textContent = '⟳'; }
    });

    // Date picker — default today; বদলালে ওই date-এর Supabase data + sync scope.
    const dateInput = panel.querySelector('#db-cc-date');
    function paintCcDate() {
      dateInput.max = todayBdDateKey();
      if (!dateInput.value) dateInput.value = ccDateKey;
      panel.querySelector('#db-cc-date-label').textContent = ccDateLabel(dateInput.value || ccDateKey);
    }
    paintCcDate();
    dateInput.addEventListener('change', async () => {
      let v = dateInput.value || todayBdDateKey();
      if (v > todayBdDateKey()) v = todayBdDateKey(); // future-এ data নেই
      dateInput.value = v;
      ccDateKey = v;
      paintCcDate();
      filter = 'all';
      ccVisibleCount = CC_RENDER_LIMIT;
      if (ccBodyEl) await loadAndRender(ccBodyEl);
    });

    const paintModes = () => {
      panel.querySelectorAll('#db-cc-modes .db-cc-mode-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.mode === ccMode));
    };
    try {
      chrome.storage.local.get(['db-cc-mode'], r => {
        if (r && (r['db-cc-mode'] === 'live' || r['db-cc-mode'] === 'mix')) ccMode = r['db-cc-mode'];
        paintModes();
      });
    } catch {}
    paintModes();
    panel.querySelectorAll('#db-cc-modes .db-cc-mode-btn').forEach(b =>
      b.addEventListener('click', async () => {
        if (ccMode === b.dataset.mode) return;
        ccMode = b.dataset.mode;
        try { chrome.storage.local.set({ 'db-cc-mode': ccMode }); } catch {}
        paintModes();
        filter = 'all';
        ccVisibleCount = CC_RENDER_LIMIT;
        if (ccBodyEl) await loadAndRender(ccBodyEl);
      }));

    panel.querySelector('#db-cc-sync-sheet').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      await bulkSyncToSheet(btn);
    });

    return panel;
  }

  function armAutoRefresh() {
    if (ccRefreshTimer) return;
    ccRefreshTimer = setInterval(() => {
      // Skip while the tab is hidden — reload on return instead (visibility
      // handler below). Minimized panel still refreshes so expand shows fresh.
      // In-flight guard: manual ⟳ / post-save reload / visibility reload must
      // not overlap into parallel Supabase+Firebase storms + out-of-order render.
      // Past dates are static — no auto-refresh (manual ⟳ still works).
      if (document.hidden || !ccBodyEl || ccLoading || ccDateKey !== todayBdDateKey()) return;
      loadAndRender(ccBodyEl, { quiet: true }).catch(e => console.warn('[DB CC Panel] auto-refresh failed:', e));
    }, CC_REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && ccBodyEl && !ccLoading && ccDateKey === todayBdDateKey()) {
        loadAndRender(ccBodyEl, { quiet: true }).catch(e => console.warn('[DB CC Panel] visible-refresh failed:', e));
      }
    });
    window.addEventListener('pagehide', () => {
      if (ccRefreshTimer) { clearInterval(ccRefreshTimer); ccRefreshTimer = null; }
    });
  }

  // ── DATA + RENDER ─────────────────────────────────────────────────────
  // Same (date, consignment) grouping / "must have a WORKER row" / "truly
  // latest row per group decides Pending vs Validated" rules as
  // generateHoldValidationReport()'s Summary mode in popup.js — this panel
  // shows exactly one day (today), across every branch the user has,
  // combined, with no date/branch pickers (no room for them here).
  let summaryRows = [];
  let filter = 'all'; // 'all' | 'pending' | 'validated'
  let ccMode = 'request'; // 'live' | 'request' | 'mix' — app-er same library (bindings) theke Live
  let ccDateKey = todayBdDateKey(); // picked date (default today) — panel + sync scope
  let ccIdToken = null;      // set per loadAndRender — remark options + save reuse it
  let ccBodyEl = null;
  let ccBranchNamesCache = {};
  let ccBranchIdsCache = []; // user's branches (bulk sync iterates these)
  let ccAllReportRows = [];  // raw report rows for today (bulk sync consolidates CC)
  let ccRemarkOpts = null;   // CC catalog, cached per page load
  let ccRefreshTimer = null;
  let ccLoading = false; // in-flight guard for auto/manual/visibility reloads
  const CC_REFRESH_MS = 60_000; // auto-refresh: new parcels + called-status updates

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

  // Live/Mix card builder — request card-er same shape (render FILTER chips reuse),
  // sudhu source: sheet library ID + Supabase rows. Row nei = noActivity.
  function buildLiveCards(liveIdsByBranch, rowsByCid, dateKey) {
    const [y, m, d] = String(dateKey || '').split('-');
    const dateLabel = (d && m && y) ? `${d}-${m}-${y}` : (dateKey || '');
    const cards = [];
    Object.entries(liveIdsByBranch).forEach(([branchId, ids]) => {
      (ids || []).forEach(cId => {
        const rows = (rowsByCid[cId] || []).slice()
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const latest = rows.length ? rows[rows.length - 1] : null;
        const workerRows = rows.filter(r => r.source === 'WORKER');
        const ccRows = rows.filter(r => r.source === 'CC');
        const firstWorker = workerRows.length ? workerRows[0] : null;
        const lastCc = ccRows.length ? ccRows[ccRows.length - 1] : null;
        cards.push({
          dateLabel, branchId, cId,
          agentSystemId: latest ? (latest.assigned_to_system_id || '') : '',
          customerPhone: latest ? (latest.customer_phone || '').trim() : '',
          firstWorkerRemark: firstWorker ? (firstWorker.remarks || firstWorker.note || '') : '',
          lastCcRemark: lastCc ? (lastCc.remarks || lastCc.note || '') : '',
          stillPending: latest ? latest.source === 'WORKER' : false,
          noActivity: !rows.length,
          trail: rows.map(r => ({
            source: r.source || '', remark: r.remarks || '', note: r.note || '',
            status: r.remarks_status || '', created: r.created_at || '',
            author: r.author_system_id || '',
          })),
        });
      });
    });
    return cards;
  }

  function render(bodyEl, branchNames) {
    const totalReq   = summaryRows.length;
    const pendingCnt = summaryRows.filter(r => r.stillPending).length;
    const noneCnt    = summaryRows.filter(r => r.noActivity).length;
    const validCnt   = totalReq - pendingCnt - noneCnt;

    const filtered = filter === 'all' ? summaryRows
      : filter === 'pending' ? summaryRows.filter(r => r.stillPending)
      : summaryRows.filter(r => !r.stillPending && !r.noActivity);

    const visible = filtered.slice(0, ccVisibleCount);
    const hiddenCount = filtered.length - visible.length;
    const rowsHtml = visible.length ? visible.map((r, idx) => `
      <div class="db-cc-row ${r.stillPending ? 'db-cc-row-pending' : (r.noActivity ? 'db-cc-row-none' : 'db-cc-row-validated')}">
        <div class="db-cc-row-top">
          <span>${escapeHtml(r.cId)}</span>
          <span>${escapeHtml(branchNames[r.branchId] || r.branchId)}</span>
        </div>
        ${r.customerName ? `<div class="db-cc-row-meta">👤 ${escapeHtml(r.customerName)}${r.codAmount ? ` • ${escapeHtml(fmtTaka(r.codAmount))}` : ''}</div>` : (r.codAmount ? `<div class="db-cc-row-meta">${escapeHtml(fmtTaka(r.codAmount))}</div>` : '')}
        ${r.address ? `<div class="db-cc-row-meta">📍 ${escapeHtml(r.address)}</div>` : ''}
        <div class="db-cc-row-remark">🙋 ${escapeHtml(r.firstWorkerRemark || '(no note)')}</div>
        ${r.lastCcRemark ? `<div class="db-cc-row-remark">↳ ${escapeHtml(r.lastCcRemark)}</div>` : ''}
        <div class="db-cc-row-bottom">
          <span class="db-cc-badge ${r.stillPending ? 'db-cc-badge-pending' : (r.noActivity ? 'db-cc-badge-none' : 'db-cc-badge-validated')}">
            ${r.stillPending ? '⏳ Pending' : (r.noActivity ? '➖ No activity' : '✓ Validated')}
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
      ${hiddenCount > 0 ? `<button type="button" class="db-cc-more-btn" id="db-cc-more">▼ আরও ${hiddenCount}টি দেখুন (${visible.length}/${filtered.length})</button>` : ''}
    `;

    bodyEl.querySelectorAll('.db-cc-stat').forEach(cell => {
      cell.addEventListener('click', () => {
        filter = cell.dataset.filter;
        ccVisibleCount = CC_RENDER_LIMIT;
        render(bodyEl, branchNames);
      });
    });
    const moreBtn = bodyEl.querySelector('#db-cc-more');
    if (moreBtn) moreBtn.addEventListener('click', () => {
      ccVisibleCount += CC_RENDER_LIMIT;
      render(bodyEl, branchNames);
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
      btn.addEventListener('click', () => toggleCcHistory(bodyEl, visible, +btn.dataset.idx, btn));
    });
    bodyEl.querySelectorAll('.db-cc-remark-btn').forEach(btn => {
      btn.addEventListener('click', () => toggleCcRemarkSection(bodyEl, visible, +btn.dataset.idx));
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
    if (!langRes.ok) throw new Error(`ccLang fetch failed (${langRes.status})`);
    const langJson = await langRes.json().catch(() => '');
    remarkLang = (((typeof langJson === 'string' ? langJson.trim() : '') || 'bn_en').split('_')[0]) || 'bn';
  } catch { /* default bn */ }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/validation_remarks` +
      `?select=remarks_en,remarks_bn,target_status,instruction_text,category` +
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
        category: (x.category || '').trim(),
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
        setTimeout(() => { if (ccBodyEl) loadAndRender(ccBodyEl, { quiet: true }); }, 800);
      } catch (e) {
        say(`⚠ Save failed — ${e.message || 'network error'}`);
        saveBtn.disabled = false;
        saveBtn.textContent = 'সেভ করুন';
      }
    });
  }

  // opts.quiet=true → purono content rekhe silent refresh (auto/visibility/
  // post-save reload-এ spinner flash হবে না)। Default (mode/date/manual)
  // → spinner দেখিয়ে বোঝায় fresh data আসছে।
  async function loadAndRender(bodyEl, opts = {}) {
    if (ccLoading) return;
    ccLoading = true;
    // Preserve bulk-sync status across render() — render() overwrites
    // bodyEl.innerHTML which would otherwise destroy #db-cc-bulk-msg.
    const prevBulkMsg = bodyEl.querySelector('#db-cc-bulk-msg')?.textContent || '';
    const prevBulkVisible = prevBulkMsg ? bodyEl.querySelector('#db-cc-bulk-msg')?.style.display !== 'none' : false;
    if (!opts.quiet) {
      bodyEl.innerHTML = '<div class="db-cc-status"><span class="db-cc-spinner"></span>⏳ Loading…</div>';
    }
    try {
    const idToken = await getValidFirebaseIdToken();
    if (!idToken) { bodyEl.innerHTML = '<div class="db-cc-status">⚠ Extension-এ Google দিয়ে login করুন প্রথমে</div>'; return; }
    ccIdToken = idToken;
    ccBodyEl = bodyEl;
    const { google_uid } = await chrome.storage.local.get(['google_uid']);
    if (!google_uid) { bodyEl.innerHTML = '<div class="db-cc-status">⚠ Google login পাওয়া যায়নি</div>'; return; }

    const { ids: branchIds, names: branchNames } = await fetchMyBranches(google_uid, idToken);
    if (!branchIds.length) { bodyEl.innerHTML = '<div class="db-cc-status">⚠ কোনো branch assigned নেই</div>'; return; }

    const dateKey  = ccDateKey || todayBdDateKey();
    const startIso = new Date(`${dateKey}T00:00:00+06:00`).toISOString();
    const endIso   = new Date(new Date(startIso).getTime() + 24 * 60 * 60 * 1000).toISOString();

    const allRows = [];
      await Promise.all(branchIds.map(async id => {
        const rows = await fetchSupabaseReportRows(id, startIso, endIso, idToken);
        allRows.push(...rows);
      }));
      summaryRows = computeSummaryRows(allRows);
      // Live / Mix: same library (bindings) theke sheet ID + fetch criteria —
      // app Live-er same niyom. Request card thakle setai wins (remark trail soho).
      if (ccMode === 'live' || ccMode === 'mix') {
        const targets = await fetchCcTargets(idToken, branchIds, dateKey);
        if (targets.length) {
          const { token: sheetsToken, error: sheetsErr } = await getSheetsToken();
          if (!sheetsToken) throw new Error(sheetsErr || 'Sheets auth nei — popup Connect theke Google sign in koro');
          const liveIdsByBranch = {};
          await Promise.all(targets.map(async t => {
            try {
              const r = await fetchLiveIdsForBinding(sheetsToken, t.binding, t.lib, dateKey);
              if (r.ids.length) {
                liveIdsByBranch[t.branchId] = [...(liveIdsByBranch[t.branchId] || []), ...r.ids];
              }
            } catch (e) {
              console.warn('[DB CC] live fetch failed:', t.branchId, e?.message || e);
            }
          }));
          const liveIds = [...new Set(Object.values(liveIdsByBranch).flat())];
          if (liveIds.length) {
            const liveRows = await fetchValidationsByIds(liveIds, idToken);
            const rowsByCid = {};
            liveRows.forEach(r => { (rowsByCid[r.consignment] = rowsByCid[r.consignment] || []).push(r); });
            const liveCards = buildLiveCards(liveIdsByBranch, rowsByCid, dateKey);
            if (ccMode === 'live') {
              summaryRows = liveCards;
            } else {
              const seen = new Set(summaryRows.map(r => r.cId));
              liveCards.forEach(c => { if (!seen.has(c.cId)) { seen.add(c.cId); summaryRows.push(c); } });
            }
          } else if (ccMode === 'live') {
            summaryRows = [];
          }
        } else if (ccMode === 'live') {
          summaryRows = [];
        }
      }
      ccVisibleCount = CC_RENDER_LIMIT;
      ccBranchNamesCache = branchNames;
      ccBranchIdsCache = branchIds.slice();
      ccAllReportRows = allRows;
      await enrichWithParcelDetails(idToken);
      render(bodyEl, branchNames);
      if (prevBulkMsg) bulkSay(prevBulkMsg);
      if (prevBulkMsg && !prevBulkVisible) { const el = bulkStatusEl(); if (el) el.style.display = 'none'; }
    } catch (e) {
      console.error('[DB CC Panel] load failed:', e);
      if (ccBodyEl === bodyEl) {
        bodyEl.innerHTML = '<div class="db-cc-status">⚠ Load failed — console (F12) দেখো</div>';
        if (prevBulkMsg) bulkSay(prevBulkMsg);
      }
    } finally {
      ccLoading = false;
    }
  }

  // ── SHEET SYNC (per card) ─────────────────────────────────────────
  // Same dynamic lookup/write rules as the app's RemarkSheetMirror (see
  // ScannerSheetModels.kt): stored lists only, no legacy conversion.
  // Column ref = letter ("C") or header text ("Consignment ID", matched
  // against the connection's headerRow). ALL lookups must match exactly on
  // one row; writes (feedback/validation/validator_name) go together;
  // blank stays blank; never appended.
  function deriveValidation(feedback) {
    const f = String(feedback || '').trim();
    if (!f) return '';
    return f.toLowerCase() === 'willing to receive today' ? 'Invalid' : 'Valid';
  }

  function effectiveLookups(conn) {
    const dyn = (conn.lookups || []).filter(r => r && String(r.colRef || '').trim());
    return dyn.map(r => ({ colRef: String(r.colRef).trim(), kind: String(r.kind || 'consignment'), mode: r.mode === 'text' ? 'text' : 'index' }));
  }

  function effectiveWrites(conn) {
    const dyn = (conn.writes || []).filter(r => r && String(r.colRef || '').trim());
    return dyn.map(r => ({ colRef: String(r.colRef).trim(), kind: String(r.kind || 'feedback'), mode: r.mode === 'text' ? 'text' : 'index' }));
  }

  function isRemarkConn(conn) {
    if (!conn || conn.enabled === false) return false;
    if (conn.isLibrary) return false; // neutral libraries bind per-fragment (app 🔌); kinds carry no meaning
    if (conn.purpose === 'scanner' || conn.purpose === 'routing') return false;
    if (conn.purpose === 'remark') return true;
    return effectiveLookups(conn).length > 0 && effectiveWrites(conn).length > 0;
  }

  // Socket binding (CC 🔌) + neutral library → legacy conn shape, so
  // bulkSyncOneConnection reuses one code path. binding-এর field keys legacy
  // kind strings-এর সমান by design (app CcField); scope আসে LIB থেকে।
  function ccAdaptBinding(b, lib) {
    const mapKind = list => (Array.isArray(list) ? list : [])
      .filter(r => r && String(r.colRef || '').trim())
      .map(r => ({ colRef: String(r.colRef).trim(), kind: String(r.field || r.kind || ''), mode: r.mode === 'text' ? 'text' : 'index' }));
    return {
      lookups: mapKind(b.lookups), writes: mapKind(b.writes),
      tabPattern: lib.tabPattern || 'Day {dd}', headerRow: lib.headerRow || 1,
      sheetId: lib.sheetId || '', sheetName: lib.sheetName || lib.nickname || '',
      scopeType: lib.scopeType || 'global', scopeMonth: lib.scopeMonth || '',
      scopeFrom: lib.scopeFrom || '', scopeTo: lib.scopeTo || '', enabled: true,
    };
  }

  // Date scope: most-specific covering scope wins (range > month > global),
  // same as the app's SheetScope.selectForDate. yyyy-MM-dd strings compare
  // lexicographically, so no date parsing is needed.
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
    const cov = conns.filter(c => scopeCovers(c, dateKey));
    if (!cov.length) return [];
    const rank = c => (c.scopeType === 'range' ? 0 : c.scopeType === 'month' ? 1 : 2);
    const best = Math.min(...cov.map(rank));
    return cov.filter(c => rank(c) === best);
  }

  function indexToLetter(n) { // 1-based
    let s = '', num = n;
    while (num > 0) { const rem = (num - 1) % 26; s = String.fromCharCode(65 + rem) + s; num = Math.floor((num - 1) / 26); }
    return s;
  }

  const SHEET_DATE_RES = [
    [/^(\d{4})-(\d{2})-(\d{2})$/, (m) => [m[1], m[2], m[3]]],
    [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, (m) => [m[3], m[1].padStart(2, '0'), m[2].padStart(2, '0')]], // M/d/yyyy first…
    [/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, (m) => ['20' + m[3], m[1].padStart(2, '0'), m[2].padStart(2, '0')]], // M/d/yy ("9/10/26" → Sep 10)
    [/^(\d{1,2})-(\d{1,2})-(\d{4})$/, (m) => [m[3], m[2].padStart(2, '0'), m[1].padStart(2, '0')]],
    [/^(\d{4})\/(\d{2})\/(\d{2})$/, (m) => [m[1], m[2], m[3]]],
    [/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, (m) => [m[3], m[2].padStart(2, '0'), m[1].padStart(2, '0')]],
  ];
  const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  // yyyy-MM-dd key or null. Covers the sheet zoo + our Dhaka stamp + ISO.
  function parseSheetDate(raw) {
    const s2 = String(raw || '').trim();
    if (!s2) return null;
    let m = s2.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s2.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s2.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
      const isoDmy = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      const isoMdy = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      return isoDmy;
    }
    m = s2.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})/);
    if (m) return `20${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; // M/d/yy
    m = s2.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
    if (m) {
      const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
      const mo = months[m[2].toLowerCase()];
      if (mo) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${mo}-${m[1].padStart(2, '0')}`;
    }
    const d = new Date(s2);
    if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return null;
  }

  function sheetCellIsDate(cell, dateKey) {    const raw = String(cell || '').trim();
    if (!raw) return false;
    for (const [re, fn] of SHEET_DATE_RES) {
      const m = raw.match(re);
      if (m) { const [y, mo, d] = fn(m); if (`${y}-${mo}-${d}` === dateKey) return true; }
    }
    // dd-MMM-yyyy / dd-MMM-yy ("03-Jul-2026", "03-Jul-26")
    let m = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
    if (m) {
      const mo = MONTHS[m[2].toLowerCase()];
      if (mo) {
        const y = m[3].length === 2 ? '20' + m[3] : m[3];
        if (`${y}-${mo}-${m[1].padStart(2, '0')}` === dateKey) return true;
      }
    }
    // dd/MM/yyyy (day-first) — try when the M/d reading above didn't hit today
    m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const cand = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      if (cand === dateKey) return true;
    }
    // M/d/yy + d/M/yy ("9/10/26") — either reading matching today counts
    m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
    if (m) {
      const y = '20' + m[3];
      if (`${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` === dateKey) return true;
      if (`${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` === dateKey) return true;
    }
    return false;
  }

  async function sheetsGet(token, url) {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    return res.json();
  }

  // mode-aware like the app: {mode:'text'} = exact header match in the
  // connection's headerRow; otherwise letter (or 1-based number).
  async function resolveLetter(token, sheetId, tab, rule, headerRow, headerCache) {
    const t = String(rule?.colRef || '').trim();
    if (!t) return null;
    const mode = rule?.mode === 'text' ? 'text' : 'index';
    if (mode !== 'text') {
      if (/^[A-Za-z]{1,3}$/.test(t)) return t.toUpperCase();
      const n = parseInt(t, 10);
      if (!isNaN(n) && n >= 1 && n <= 702) {
        let s2 = '', num = n;
        while (num > 0) { const rem = (num - 1) % 26; s2 = String.fromCharCode(65 + rem) + s2; num = Math.floor((num - 1) / 26); }
        return s2;
      }
      return null;
    }
    const hr = (headerRow >= 1 && headerRow <= 20) ? headerRow : 1;
    const key = tab + '#' + hr;
    if (!headerCache[key]) {
      const data = await sheetsGet(token,
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab + '!' + hr + ':' + hr)}`);
      const rows = data.values || [];
      headerCache[key] = rows.length ? rows[0] : [];
    }
    const idx = headerCache[key].findIndex(h => String(h || '').trim() === t);
    return idx >= 0 ? indexToLetter(idx + 1) : null;
  }

  function getSheetsToken() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ action: 'get_sheets_token' }, res => {
          if (chrome.runtime.lastError) return resolve({ token: null, error: chrome.runtime.lastError.message });
          resolve({ token: res?.token || null, error: res?.error || null });
        });
      } catch (e) { resolve({ token: null, error: e.message }); }
    });
  }

  // ── SAME LIBRARY AS APP (bindings + libraries) ─────────────────────
  // App-er socket binding (CC 🔌) thekei Live ID + filter ase — alada
  // config nei, tai app ar extension sobsomoy same sheet/rules dekhe.
  // Firebase: config/sheetBindings/{branch}/cc + config/connectors/{branch}/current(isLibrary).
  async function fetchCcTargets(idToken, branchIds, dateKey) {
    const authQuery = idToken ? `?auth=${idToken}` : '';
    const out = [];
    await Promise.all(branchIds.map(async branchId => {
      try {
        const [bRes, lRes] = await Promise.all([
          fetch(`${FIREBASE_URL}/config/sheetBindings/${encodeURIComponent(branchId)}/cc.json${authQuery}`),
          fetch(`${FIREBASE_URL}/config/connectors/${encodeURIComponent(branchId)}/current.json${authQuery}`),
        ]);
        const bObj = await bRes.json().catch(() => null) || {};
        const lObj = await lRes.json().catch(() => null) || {};
        const libs = {};
        Object.entries(lObj).forEach(([lid, l]) => {
          if (l && l.isLibrary && l.enabled !== false) libs[lid] = l;
        });
        Object.entries(bObj).forEach(([bid, b]) => {
          if (!b || b.enabled === false) return;
          const lib = libs[b.libraryId];
          if (!lib) return;
          if (!scopeCovers(lib.scopeType || 'global', lib.scopeMonth || '', lib.scopeFrom || '', lib.scopeTo || '', dateKey)) return;
          out.push({ branchId, bindingId: bid, binding: b, lib });
        });
      } catch (e) {
        console.warn('[DB CC] bindings read failed:', branchId, e?.message || e);
      }
    }));
    return out;
  }

  // App resolveTabName-er same tokens ({dd}=09, {d}=9, {mm}, {m}, {yyyy}, {yy}).
  function resolveConnTab(pattern, dateKey) {
    const p = (pattern || '').trim() || 'Day {dd}';
    const m = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return p;
    const yyyy = m[1], mm = m[2], dd = m[3];
    const d = String(parseInt(dd, 10) || 0), mo = String(parseInt(mm, 10) || 0);
    return p.split('{dd}').join(dd).split('{d}').join(d)
      .split('{mm}').join(mm).split('{m}').join(mo)
      .split('{yyyy}').join(yyyy).split('{yy}').join(yyyy.slice(-2));
  }

  function colLetterToIndex(letter) {
    const t = String(letter || '').trim().toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(t)) return -1;
    let n = 0;
    for (const ch of t) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  }

  function columnLettersRange(start, end) {
    const s = Math.max(1, start || 1), e = Math.max(s, end || s);
    const out = [];
    for (let i = s; i <= Math.min(e, s + 51); i++) out.push(indexToLetter(i));
    return out;
  }

  function dhakaTodayKey() {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());
    } catch { return todayBdDateKey(); }
  }

  // "2026-09-10", "10/09/2026", "10-09-2026", "10.09.2026", "10-Sep-2026",
  // "10-Sep-26", "Sep 10, 2026" → yyyymmdd number, else null.
  function parseDateJs(raw) {
    const t = String(raw || '').trim();
    if (!t) return null;
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    let m;
    if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return +`${m[1]}${String(m[2]).padStart(2, '0')}${String(m[3]).padStart(2, '0')}`;
    if ((m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/))) return +`${m[3]}${String(m[2]).padStart(2, '0')}${String(m[1]).padStart(2, '0')}`;
    if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})/))) { // M/d/yy ("9/10/26" → Sep 10)
      const y = 2000 + (+m[3]);
      return +(String(y) + String(m[1]).padStart(2, '0') + String(m[2]).padStart(2, '0'));
    }
    if ((m = t.match(/^(\d{1,2})[\-\.]([A-Za-z]{3})[\-\.](\d{2,4})/))) {
      const mo = months[m[2].toLowerCase().slice(0, 3)];
      if (!mo) return null;
      let y = +m[3]; if (y < 100) y += 2000;
      return +(String(y) + String(mo).padStart(2, '0') + String(m[1]).padStart(2, '0'));
    }
    if ((m = t.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/))) {
      const mo = months[m[1].toLowerCase().slice(0, 3)];
      if (!mo) return null;
      return +(`${m[3]}${String(mo).padStart(2, '0')}${String(m[2]).padStart(2, '0')}`);
    }
    const iso = Date.parse(t);
    if (!Number.isNaN(iso)) {
      try {
        const k = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
        return +k.replace(/-/g, '');
      } catch { return null; }
    }
    return null;
  }

  // App SheetCellCompare-er same semantics (typed value: text/number/date/today).
  function cellPassJs(op, cell, value, valueType) {
    const c = String(cell == null ? '' : cell).trim();
    const vt = valueType || 'text';
    const t = vt === 'today' ? dhakaTodayKey().replace(/-/g, '') : String(value == null ? '' : value).trim();
    const num = s => { const n = parseFloat(String(s).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    const ord = (a, b) => {
      const an = num(a), bn = num(b);
      if (an !== null && bn !== null) return an < bn ? -1 : an > bn ? 1 : 0;
      const ad = parseDateJs(a), bd = parseDateJs(b);
      if (ad !== null && bd !== null) return ad < bd ? -1 : ad > bd ? 1 : 0;
      const al = String(a).trim().toLowerCase(), bl = String(b).trim().toLowerCase();
      return al < bl ? -1 : al > bl ? 1 : 0;
    };
    switch (op) {
      case 'blank': return c === '';
      case 'notblank': return c !== '';
      case 'equals': return vt === 'text' ? c === t : ord(c, t) === 0;
      case 'notequals': return vt === 'text' ? c !== t : ord(c, t) !== 0;
      case 'gt': return ord(c, t) > 0;
      case 'gte': return ord(c, t) >= 0;
      case 'lt': return ord(c, t) < 0;
      case 'lte': return ord(c, t) <= 0;
      default: return true;
    }
  }

  // One binding's Live IDs — app fetchLiveIdsForBinding-er same niyom:
  // fetch col (default range start), AND/OR filters, unresolvable never blocks.
  async function fetchLiveIdsForBinding(sheetsToken, binding, lib, dateKey) {
    const b = binding || {}, L = lib || {};
    const tab = resolveConnTab(L.tabPattern, dateKey);
    const headerRow = (L.headerRow >= 1 && L.headerRow <= 20) ? L.headerRow : 1;
    const headerCache = {};
    const letterOf = async (ref, mode) => {
      const t = String(ref || '').trim();
      if (!t) return null;
      return resolveLetter(sheetsToken, L.sheetId, tab, { colRef: t, mode }, headerRow, headerCache);
    };
    const rangeStart = L.colStart >= 1 ? L.colStart : 1;
    const fetchRef = String(b.fetchColRef || '').trim();
    const fetchLetter = fetchRef
      ? await letterOf(fetchRef, b.fetchColMode)
      : indexToLetter(rangeStart);
    if (!fetchLetter) return { ids: [], note: `ID column '${fetchRef}' paini` };
    const rules = Array.isArray(b.filters) ? b.filters.filter(r => r && String(r.colRef || '').trim() && r.op) : [];
    const useOr = rules.length > 0 && b.filterLogic === 'OR';
    const colCache = {};
    const colOf = async (ref, mode) => {
      const letter = await letterOf(ref, mode);
      if (!letter) return null;
      if (!colCache[letter]) {
        colCache[letter] = await sheetsGet(sheetsToken,
          `https://sheets.googleapis.com/v4/spreadsheets/${L.sheetId}/values/${encodeURIComponent(tab + '!' + letter + ':' + letter)}`)
          .then(d => (((d || {}).values) || []).map(r => (r || [])[0] || ''));
      }
      return colCache[letter];
    };
    const missing = [];
    const ruleCols = [];
    for (const r of rules) {
      const vals = await colOf(r.colRef, r.mode);
      if (!vals) missing.push(String(r.colRef || '').trim());
      else ruleCols.push({ r, vals });
    }
    const idCol = await colOf(
      fetchRef || indexToLetter(rangeStart),
      fetchRef ? (b.fetchColMode || 'index') : 'index');
    if (!idCol) return { ids: [], note: 'ID column paini' };
    const ids = [];
    let dropped = 0;
    idCol.forEach((cell, i) => {
      const cid = String(cell || '').trim();
      if (!cid) return;
      const results = ruleCols.map(({ r, vals }) => cellPassJs(r.op, vals[i] || '', r.value, r.valueType));
      const pass = useOr && results.length ? results.some(Boolean) : results.every(Boolean);
      if (!pass) { dropped++; return; }
      if (ids.indexOf(cid) === -1) ids.push(cid);
    });
    return { ids, dropped, note: missing.length ? `column ${[...new Set(missing)].join(',')} paini (skip)` : null };
  }

  // ── BULK SYNC TO SHEET (header) ────────────────────────────────
  // Branch-wise: every branch uses ONLY its own remark connections
  // (config/connectors/{branchId}/current) → its own sheet.
  // Sheet-driven: read the connection's today tab, take rows whose write
  // cells are blank, match by consignment id against Supabase's
  // consolidated CC (latest CC remark per consignment today), fill ONLY
  // the blank cells. Never overwrites filled cells, never appends.
  function bulkStatusEl() {
    if (!ccBodyEl) return null;
    let el = ccBodyEl.querySelector('#db-cc-bulk-msg');
    if (!el) {
      el = document.createElement('div');
      el.id = 'db-cc-bulk-msg';
      el.className = 'db-cc-status';
      el.style.display = 'none';
      ccBodyEl.insertAdjacentElement('afterbegin', el);
    }
    return el;
  }

  function bulkSay(t) {
    const el = bulkStatusEl();
    if (!el) return;
    el.textContent = t;
    el.style.display = t ? '' : 'none';
  }

  async function sheetsWriteCell(token, sheetId, tab, letter, row1, value) {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab + '!' + letter + row1)}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: `${tab}!${letter}${row1}`, majorDimension: 'ROWS', values: [[value]] }),
      });
    if (!res.ok) throw new Error(`Sheets write ${res.status}`);
  }

  // Consolidated CC per (branch, consignment) for today: latest CC row →
  // feedback (catalog map) / validation (derived) / validator_name / created_at.
  async function buildConsolidatedCc() {
    const opts = await fetchCcRemarkOptions().catch(() => []);
    const byKey = new Map(); // `${branchId}__${consignment}` -> {rows:[]}
    (ccAllReportRows || []).forEach(r => {
      if (!r || !r.consignment || !r.branch_id) return;
      const k = `${r.branch_id}__${r.consignment}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    });
    const out = new Map();
    byKey.forEach((rows, k) => {
      const ccRows = rows.filter(r => r.source === 'CC')
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      if (!ccRows.length) return; // Supabase-এ CC remark নেই — sheet-এ লেখার কিছু নেই
      const latest = ccRows[ccRows.length - 1];
      const engKey = (latest.remarks || '').trim();
      const hit = (opts || []).find(o => o.english === engKey);
      const feedback = (hit && hit.category) || '';
      out.set(k, {
        feedback,
        validation: deriveValidation(feedback),
        validator_name: ((latest.author && latest.author.name) || latest.author_system_id || '').trim(),
        created_at: latest.created_at || '',
      });
    });
    return out;
  }

  // One connection → its own sheet. Returns counts for the summary line.
  async function bulkSyncOneConnection(token, branchId, conn, consolidated, dateKey) {
    const res = { scanned: 0, filled: 0, syncedRows: 0, syncedCells: 0, noCc: 0, skipped: 0 };
    const lookups = effectiveLookups(conn);
    const writes = effectiveWrites(conn).filter(r =>
      r.kind === 'feedback' || r.kind === 'validation' || r.kind === 'validator_name');
    if (!lookups.length || !writes.length) throw new Error('lookup/write rule নেই');
    const cidRule = lookups.find(r => r.kind === 'consignment');
    if (!cidRule) throw new Error('consignment lookup নেই — কোন column দিযে মিলাবো বোঝা যাচ্ছে না');
    const tab = resolveConnTab(conn.tabPattern, dateKey);
    const hr = (conn.headerRow >= 1 && conn.headerRow <= 20) ? conn.headerRow : 1;
    const headerCache = {};
    const cidLetter = await resolveLetter(token, conn.sheetId, tab, cidRule, hr, headerCache);
    if (!cidLetter) throw new Error(`consignment column '${cidRule.colRef}' পাওয়া যায়নি`);
    // Date lookups verify the row is really today's (tab-scoped safety).
    const dateRules = lookups.filter(r => r.kind === 'today' || r.kind === 'created_at');
    const dateLetters = new Map();
    for (const rule of dateRules) {
      const letter = await resolveLetter(token, conn.sheetId, tab, rule, hr, headerCache);
      if (!letter) throw new Error(`lookup column '${rule.colRef}' পাওয়া যায়নি`);
      dateLetters.set(rule, letter);
    }
    const writeLetters = [];
    for (const rule of writes) {
      const letter = await resolveLetter(token, conn.sheetId, tab, rule, hr, headerCache);
      if (!letter) throw new Error(`write column '${rule.colRef}' পাওয়া যায়নি`);
      writeLetters.push({ rule, letter });
    }
    // One fetch per column (shared across all rows of this connection).
    async function colValues(letter) {
      const data = await sheetsGet(token,
        `https://sheets.googleapis.com/v4/spreadsheets/${conn.sheetId}/values/${encodeURIComponent(tab + '!' + letter + ':' + letter)}`);
      return (data.values || []).map(r => (r && r[0]) || '');
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
    for (let i = 0; i < cidCol.length; i++) {
      const cid = String(cidCol[i] || '').trim();
      if (!cid) continue;
      // Date check: TODAY / CREATED_AT lookups must be today (tab safety).
      let dateOk = true;
      for (const [rule, letter] of dateLetters) {
        const cell = (dateCols.get(letter) || [])[i] || '';
        if (!sheetCellIsDate(String(cell || '').trim(), dateKey)) { dateOk = false; break; }
      }
      if (!dateOk) continue;
      // Blank check: at least one write cell empty → needs filling.
      const blanks = writeLetters.filter(({ letter }) =>
        String((writeCols.get(letter) || [])[i] || '').trim() === '');
      if (!blanks.length) { res.filled++; continue; }
      const vals = consolidated.get(`${branchId}__${cid}`);
      if (!vals) { res.noCc++; continue; }
      // Fill ONLY the blank cells (filled ones are never overwritten).
      try {
        for (const { rule, letter } of blanks) {
          const v = vals[rule.kind] != null ? String(vals[rule.kind]) : '';
          await sheetsWriteCell(token, conn.sheetId, tab, letter, i + 1, v);
          const col = writeCols.get(letter) || [];
          col[i] = v;
          res.syncedCells++;
        }
        res.syncedRows++;
      } catch (e) {
        res.skipped++;
        console.warn('[DB CC Panel] bulk row write failed:', cid, e);
      }
    }
    return res;
  }

  async function bulkSyncToSheet(btn) {
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ …'; }
    try {
      if (!ccIdToken) throw new Error('login missing — extension-এ Google দিয়ে login করুন');
      const branchIds = (ccBranchIdsCache && ccBranchIdsCache.length)
        ? ccBranchIdsCache.slice()
        : [...new Set((summaryRows || []).map(r => r.branchId).filter(Boolean))];
      if (!branchIds.length) throw new Error('কোনো branch পাওয়া যায়নি — আগে reload করুন');
      const dateKey = ccDateKey || todayBdDateKey();
      const dateLabel = dateKeyToDdMmYyyy(dateKey);
      bulkSay('⏳ Consolidated CC বানানো হচ্ছে…');
      const consolidated = await buildConsolidatedCc();
      if (!consolidated.size) throw new Error(`Supabase-এ ${dateLabel}-এর কোনো CC remark নেই — লেখার কিছু নেই`);
      const { token, error } = await getSheetsToken();
      if (!token) throw new Error(error || 'Sheets permission নেই — extension popup থেকে re-login করুন');
      let totConns = 0, totScanned = 0, totFilled = 0, totRows = 0, totCells = 0, totNoCc = 0;
      const errs = [];
      // NEW all-in-one bindings (socket 🔌 + library) — fetchCcTargets scope
      // filter করেই দেয়; legacy conns-এর সাথে merge করে নিচে একসাথে চালাই।
      const adaptedByBranch = {};
      try {
        const tgts = await fetchCcTargets(ccIdToken, branchIds, dateKey);
        tgts.forEach(t => {
          const ad = ccAdaptBinding(t.binding, t.lib);
          if (!ad.lookups.length || !ad.writes.length) return;
          (adaptedByBranch[t.branchId] = adaptedByBranch[t.branchId] || []).push(ad);
        });
      } catch (e) {
        console.warn('[DB CC] bulk: bindings read failed:', e?.message || e);
      }
      for (const branchId of branchIds) {
        let conns = [];
        try {
          const connRes = await fetch(
            `${FIREBASE_URL}/config/connectors/${encodeURIComponent(branchId)}/current.json?auth=${ccIdToken}`);
          const connObj = await connRes.json().catch(() => ({})) || {};
          conns = selectForDate(
            [...Object.values(connObj).filter(isRemarkConn).filter(c => c.enabled !== false),
             ...(adaptedByBranch[branchId] || [])],
            dateKey);
        } catch (e) {
          errs.push(`${branchId}: connection পড়া যায়নি`);
          continue;
        }
        if (!conns.length) continue; // আজকের scope-এ remark connection নেই — skip (error না)
        for (const conn of conns) {
          totConns++;
          const label = conn.sheetName || conn.sheetId || branchId;
          bulkSay(`⏳ ${label} — sheet পড়ছে…`);
          try {
            const r = await bulkSyncOneConnection(token, branchId, conn, consolidated, dateKey);
            totScanned += r.scanned; totFilled += r.filled;
            totRows += r.syncedRows; totCells += r.syncedCells; totNoCc += r.noCc;
          } catch (e) {
            errs.push(`${label}: ${e.message || 'sync failed'}`);
          }
        }
      }
      if (!totConns) throw new Error(`${dateLabel}-এর জন্য কোনো branch-এ remark connection নেই (scope দেখুন)`);
      let msg = `✓ ${totRows} row synced (${totCells} cells) · ${totFilled} already filled · ${totNoCc} no CC yet · ${totScanned} sheet rows দেখা (${totConns} connection)`;
      if (errs.length) msg += ` · ⚠ ${errs.length} error: ${errs.slice(0, 2).join('; ')}${errs.length > 2 ? '…' : ''}`;
      bulkSay(msg);
      if (btn) btn.textContent = '✓ Done';
    } catch (e) {
      bulkSay(`✕ ${e.message || 'sync failed'}`);
      if (btn) btn.textContent = '⚠ Failed';
    } finally {
      if (btn) setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
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
    armAutoRefresh();
    await loadAndRender(panel.querySelector('#db-cc-body'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initIfAllowed);
  } else {
    initIfAllowed();
  }
})();
