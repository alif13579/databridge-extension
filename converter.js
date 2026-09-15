'use strict';
/* DataBridge Audio Converter — local file in, local file out.
 * Runs ffmpeg.wasm fully offline inside this extension page (MV3 service
 * workers have no DOM/AudioContext, so a full tab page is used instead of
 * the popup — the popup would also close mid-conversion).
 * Single-thread ffmpeg core: no SharedArrayBuffer / COOP-COEP needed.
 */

const $ = (id) => document.getElementById(id);

const PRESETS = {
  mp3:  { ext: 'mp3',  mime: 'audio/mpeg', bitrates: ['128k', '192k', '256k', '320k'], args: (q) => ['-c:a', 'libmp3lame', '-b:a', q] },
  m4a:  { ext: 'm4a',  mime: 'audio/mp4',  bitrates: ['128k', '192k', '256k'],          args: (q) => ['-c:a', 'aac', '-b:a', q] },
  ogg:  { ext: 'ogg',  mime: 'audio/ogg',  bitrates: ['128k', '192k', '256k'],          args: (q) => ['-c:a', 'libvorbis', '-b:a', q] },
  opus: { ext: 'opus', mime: 'audio/ogg',  bitrates: ['64k', '96k', '128k', '160k'],    args: (q) => ['-c:a', 'libopus', '-b:a', q] },
  wav:  { ext: 'wav',  mime: 'audio/wav',  bitrates: null,                              args: () => ['-c:a', 'pcm_s16le'] },
  flac: { ext: 'flac', mime: 'audio/flac', bitrates: null,                              args: () => ['-c:a', 'flac'] },
};

let pickedFile = null;
let ffmpeg = null;
let engineReady = false;
let engineLoading = null;
let lastLogLines = [];
const PREFS_KEY = 'audioConverterPrefs';
let prefs = { subfolder: '', saveAs: false };

function setStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}

function setProgress(ratio) {
  $('progress-wrap').hidden = false;
  $('progress-bar').style.width = `${Math.round(ratio * 100)}%`;
}

function refreshQualityOptions() {
  const preset = PRESETS[$('format-select').value];
  const qRow = $('quality-row');
  const qSel = $('quality-select');
  qSel.innerHTML = '';
  if (!preset.bitrates) {
    qRow.style.display = 'none';
    return;
  }
  qRow.style.display = '';
  preset.bitrates.forEach((b, i) => {
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = b.replace('k', ' kbps');
    if (i === 1 || (preset.bitrates.length === 1)) opt.selected = true;
    qSel.appendChild(opt);
  });
}

function pickFile(file) {
  if (!file) return;
  pickedFile = file;
  $('file-name').textContent = `📄 ${file.name} (${(file.size / 1048576).toFixed(1)} MB)`;
  $('drop-text').innerHTML = 'File ready — <span class="conv-link">change file</span>';
  $('convert-btn').disabled = false;
  $('download-link').hidden = true;
  updateSavePreview();
  setStatus('Ready. Pick an output format and hit Convert.');
}

async function ensureEngine() {
  if (engineReady) return;
  if (engineLoading) return engineLoading;
  engineLoading = (async () => {
    const { FFmpeg } = FFmpegWASM;
    ffmpeg = new FFmpeg();
    ffmpeg.on('progress', ({ progress }) => {
      if (typeof progress === 'number' && isFinite(progress)) setProgress(Math.min(1, Math.max(0, progress)));
    });
    ffmpeg.on('log', ({ message }) => {
      lastLogLines.push(message);
      if (lastLogLines.length > 20) lastLogLines.shift();
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('Engine load timed out after 120s.')), 120000);
    try {
      await ffmpeg.load({
        coreURL: chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.wasm'),
      }, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    engineReady = true;
  })();
  return engineLoading;
}

function baseName(name) {
  const i = name.lastIndexOf('.');
  return (i > 0 ? name.slice(0, i) : name).replace(/[^\w\- ]+/g, '_').trim() || 'audio';
}

/* Save location: Chrome only allows writing inside the browser Downloads
 * folder (subfolder path), or a one-off Save-As dialog (anywhere).
 * The subfolder + toggle persist in storage = changed default sticks. */
function cleanFolder(s) {
  return (s || '').replace(/[\\:*?"<>|]/g, '').split('/')
    .map((p) => p.trim().replace(/^\.+$/, ''))
    .filter(Boolean).join('/');
}

function updateSavePreview() {
  const preset = PRESETS[$('format-select').value];
  const f = cleanFolder($('folder-input').value);
  const name = pickedFile ? `${baseName(pickedFile.name)}.${preset.ext}` : `<name>.${preset.ext}`;
  $('save-preview').textContent = `Downloads/${f ? f + '/' : ''}${name}`;
}

async function persistPrefs() {
  prefs = { subfolder: cleanFolder($('folder-input').value), saveAs: $('saveas-check').checked };
  $('folder-input').value = prefs.subfolder;
  try { await chrome.storage.local.set({ [PREFS_KEY]: prefs }); } catch (e) {}
  updateSavePreview();
}

async function loadPrefs() {
  try {
    const got = await chrome.storage.local.get(PREFS_KEY);
    if (got && got[PREFS_KEY]) prefs = { subfolder: '', saveAs: false, ...got[PREFS_KEY] };
  } catch (e) {}
  $('folder-input').value = prefs.subfolder || '';
  $('saveas-check').checked = !!prefs.saveAs;
  updateSavePreview();
}

async function saveBlob(blob, filename) {
  const rel = prefs.subfolder ? `${prefs.subfolder}/${filename}` : filename;
  if (chrome.downloads && chrome.downloads.download) {
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url,
        filename: rel,
        conflictAction: 'uniquify',
        saveAs: !!prefs.saveAs,
      });
      return { how: 'api', rel: `Downloads/${rel}` };
    } catch (err) {
      console.warn('[converter] downloads API failed, anchor fallback (subfolder/Save-As prefs do not apply to the fallback)', err);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { how: 'anchor', rel: `Downloads/${filename}` };
}

async function convert() {
  if (!pickedFile) return;
  const preset = PRESETS[$('format-select').value];
  const quality = preset.bitrates ? $('quality-select').value : null;
  const btn = $('convert-btn');
  btn.disabled = true;
  $('download-link').hidden = true;
  $('progress-wrap').hidden = false;
  setProgress(0);

  try {
    if (!engineReady) {
      setStatus('Loading offline engine first time (~32 MB)…');
      await ensureEngine();
    }
    setStatus(`Converting to ${preset.ext.toUpperCase()}…`);
    lastLogLines = [];

    const inName = 'input.dat';
    const outName = `output.${preset.ext}`;
    await ffmpeg.writeFile(inName, new Uint8Array(await pickedFile.arrayBuffer()));
    const code = await ffmpeg.exec(['-hide_banner', '-y', '-i', inName, ...preset.args(quality), outName]);
    if (code !== 0) throw new Error(lastLogLines.slice(-3).join('\n') || `ffmpeg exited with code ${code}`);

    const outData = await ffmpeg.readFile(outName);
    const bytes = (typeof outData === 'string') ? new TextEncoder().encode(outData) : outData;
    const blob = new Blob([bytes], { type: preset.mime });
    const filename = `${baseName(pickedFile.name)}.${preset.ext}`;
    const saved = await saveBlob(blob, filename);
    // Green button stays as a manual re-download backup.
    const link = $('download-link');
    if (link.href && link.href.startsWith('blob:')) URL.revokeObjectURL(link.href);
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.hidden = false;
    setProgress(1);
    setStatus(`Done — ${(blob.size / 1048576).toFixed(1)} MB → ${saved.rel}`);

    await ffmpeg.deleteFile(inName).catch(() => {});
    await ffmpeg.deleteFile(outName).catch(() => {});
  } catch (err) {
    console.error('[converter]', err);
    setStatus(`Failed: ${err && err.message ? err.message : err}`, true);
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  refreshQualityOptions();
  loadPrefs();
  $('format-select').addEventListener('change', () => { refreshQualityOptions(); updateSavePreview(); });
  $('folder-input').addEventListener('input', updateSavePreview);
  $('folder-input').addEventListener('change', persistPrefs);
  $('saveas-check').addEventListener('change', persistPrefs);

  const zone = $('drop-zone');
  const input = $('file-input');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', () => pickFile(input.files[0]));
  ['dragover', 'dragenter'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); }));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]);
  });

  $('convert-btn').addEventListener('click', convert);
});
