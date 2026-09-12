// Run validation details window — popup Run tab theke khole.
// Snapshot chrome.storage.local ('db-run-report-snapshot') theke pore,
// ?status= / ?verdict= / ?view= filter onujayi status-wise remarks dekhay.
(function () {
  'use strict';
  const SNAP_KEY = 'db-run-report-snapshot';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function badge(r) {
    if (r.verdict === 'ok') return `<span class="rr-badge rr-badge-ok">✅ ${esc(r.tag || 'Validated')}</span>`;
    if (r.verdict === 'warn') return `<span class="rr-badge rr-badge-warn">🚫 ${esc(r.tag || 'Warning')}</span>`;
    if (r.verdict === 'cc') return `<span class="rr-badge rr-badge-cc">📋 ${esc(r.tag || 'CC remark')}</span>`;
    return `<span class="rr-badge rr-badge-none">➖ No CC request</span>`;
  }

  function remarkLine(r) {
    const parts = [];
    if (r.remarksStatus) parts.push(`<b>${esc(r.remarksStatus)}</b>`);
    const txt = r.remarkBn || r.remarkEn;
    if (txt) parts.push(esc(txt));
    return parts.length ? parts.join(' — ') : '—';
  }

  function rowHtml(r) {
    const meta = [];
    if (r.st) meta.push(`run: ${esc(r.st)}`);
    if (r.dateKey) meta.push(r.carried ? `📅 ${esc(r.dateKey)}` : 'Today');
    if (r.note) meta.push(`📝 ${esc(r.note)}`);
    return `<div class="rr-row">
      <div><span class="rr-id">${esc(r.id)}</span>${badge(r)}</div>
      <div class="rr-remark">${remarkLine(r)}</div>
      ${meta.length ? `<div class="rr-meta">${meta.join(' · ')}</div>` : ''}
    </div>`;
  }

  function toTsv(rows) {
    const clean = v => String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' / ');
    const lines = ['Consignment\tRun status\tVerdict\tCC status\tCC remark\tNote\tDate'];
    rows.forEach(r => lines.push([
      r.id, r.st, r.tag, r.remarksStatus, (r.remarkBn || r.remarkEn), r.note, r.dateKey || '',
    ].map(clean).join('\t')));
    return lines.join('\n');
  }

  async function init() {
    const q = new URLSearchParams(location.search);
    const fStatus = q.get('status') || '';
    const fVerdict = q.get('verdict') || '';
    const fView = q.get('view') || 'all';
    const titleEl = document.getElementById('rr-title');
    const subEl = document.getElementById('rr-sub');
    const listEl = document.getElementById('rr-list');

    let snap = null;
    try {
      const r = await chrome.storage.local.get([SNAP_KEY]);
      snap = r[SNAP_KEY] || null;
    } catch {}
    if (!snap || !Array.isArray(snap.rows)) {
      if (subEl) subEl.textContent = 'No snapshot — load the report from the popup Run tab, then reopen.';
      if (listEl) listEl.innerHTML = '<div class="rr-empty">—</div>';
      return;
    }
    let rows = snap.rows.slice();
    let scope = 'All Parcels';
    if (fStatus) { rows = rows.filter(r => (r.st || '') === fStatus); scope = `Status: ${fStatus}`; }
    else if (fVerdict) {
      rows = rows.filter(r => r.verdict === fVerdict);
      scope = fVerdict === 'ok' ? 'Validated' : fVerdict === 'warn' ? 'Warning / Not Delivered'
        : fVerdict === 'none' ? 'No CC Request' : fVerdict === 'cc' ? 'CC Remarks' : fVerdict;
    } else if (fView === 'today') { rows = rows.filter(r => r.dateKey && !r.carried); scope = 'Latest CC Remarks Today'; }

    if (titleEl) titleEl.textContent = `🔍 Run ${snap.runId} — ${scope} (${rows.length})`;
    if (subEl) {
      const checked = snap.checkedAt ? new Date(snap.checkedAt).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
      subEl.textContent = `Check: ${checked}` + (snap.sync ? ` · 🔄 Supabase update: ${snap.sync}` : '');
    }
    if (!rows.length) {
      if (listEl) listEl.innerHTML = '<div class="rr-empty">Nothing here.</div>';
      return;
    }
    // Status-wise grouping (single group when a status filter is active).
    const groups = new Map();
    rows.forEach(r => {
      const key = (r.st || '?').trim() || '?';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });
    const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    if (listEl) listEl.innerHTML = ordered.map(([st, rs]) => {
      const ok = rs.filter(r => r.verdict === 'ok').length;
      const warn = rs.filter(r => r.verdict === 'warn').length;
      return `<div class="rr-group">
        <div class="rr-group-hdr">${esc(st)} — total: ${rs.length} · validated: ${ok} · warning: ${warn}</div>
        ${rs.map(rowHtml).join('')}
      </div>`;
    }).join('');

    const copyBtn = document.getElementById('rr-copy-btn');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const orig = copyBtn.textContent;
      try {
        await navigator.clipboard.writeText(toTsv(rows));
        copyBtn.textContent = '✓ Copied';
      } catch { copyBtn.textContent = '✗ Failed'; }
      setTimeout(() => { copyBtn.textContent = orig; }, 1500);
    });
    const closeBtn = document.getElementById('rr-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => window.close());
  }

  document.addEventListener('DOMContentLoaded', init);
})();
