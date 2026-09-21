/**
 * BT Dial Server (Windows) — DataBridge helper.
 *
 * Laptop-e paired button/feature phone thakle ei server Bluetooth RFCOMM
 * diye `ATD<number>;` pathay — phone nijer SIM diye dial kore. Extension-er
 * 📞 Call button localhost-e POST kore; helper offline thakle extension
 * Firebase path-e (app auto-dial) fallback kore.
 *
 *   GET  /status   -> { ok, btAvailable, defaultDevice, devices }
 *   GET  /devices  -> paired/configured device list (best-effort)
 *   POST /dial     -> { phone, agent? } => { ok, device, channel } | { ok:false, error }
 *
 * Run:  npm install  →  copy config.example.json to config.json  →  node server.js
 * Native BT module missing thakleo server othe (/dial tokhon error dey).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  const cfg = {
    port: 17891,
    defaultDevice: '',
    devices: {},
    channels: {},
    connectTimeoutMs: 12000,
    commandTimeoutMs: 10000,
  };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    for (const k of Object.keys(cfg)) if (raw[k] !== undefined) cfg[k] = raw[k];
  } catch (_) { /* config.json optional — example thaklei hobe na */ }
  return cfg;
}

let BTSerialPort = null;
try {
  BTSerialPort = require('bluetooth-serial-port').BluetoothSerialPort;
} catch (e) {
  console.warn('[bt-dial] bluetooth-serial-port module missing — run `npm install`. BT dial disabled until then.');
}

function cleanPhone(phone) {
  return String(phone || '').replace(/[\s\-().]/g, '').trim();
}

function normMac(mac) {
  return String(mac || '').trim().toUpperCase();
}

function resolveDevice(cfg, agent) {
  const byAgent = agent && cfg.devices ? normMac(cfg.devices[String(agent).trim()] || '') : '';
  return byAgent || normMac(cfg.defaultDevice);
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timeout')), ms);
  });
  return Promise.race([promise, gate]).finally(() => { if (timer) clearTimeout(timer); });
}

function findChannel(address, timeoutMs) {
  return withTimeout(new Promise((resolve, reject) => {
    try {
      const probe = new BTSerialPort();
      probe.findSerialPortChannel(address,
        ch => { try { probe.close(); } catch (_) {} resolve(ch); },
        () => { try { probe.close(); } catch (_) {} reject(new Error('RFCOMM channel not found (phone paired + reachable?)')); });
    } catch (e) { reject(e); }
  }), timeoutMs, 'channel discovery');
}

function dialOnce(address, channel, phone, cfg) {
  return withTimeout(new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, info) => {
      if (settled) return;
      settled = true;
      try { serial.close(); } catch (_) {}
      if (err) reject(err);
      else resolve(info || {});
    };
    let serial;
    try {
      serial = new BTSerialPort();
    } catch (e) { reject(e); return; }
    let buffer = '';
    const onData = chunk => {
      buffer += chunk.toString('utf8', 0, chunk.length);
      const upper = buffer.toUpperCase();
      // HFP AG replies: OK / ERROR / +CME ERROR / ... — first verdict wins.
      if (/(^|\r|\n)OK(\r|\n|$)/.test(upper)) done(null, { response: 'OK' });
      else if (/ERROR/.test(upper)) done(new Error('phone rejected dial (' + buffer.trim().slice(0, 80) + ')'));
    };
    try {
      serial.on('data', onData);
      serial.on('closed', () => { if (!settled) done(new Error('connection closed before verdict')); });
      serial.on('failure', err => { if (!settled) done(new Error('connection failed: ' + (err && err.message ? err.message : err))); });
      serial.connect(address, channel,
        () => {
          if (settled) return;
          // Voice call dial: ATD<number>; — ';' charai phone data-call vabe.
          const cmd = `ATD${phone};\r`;
          serial.write(Buffer.from(cmd, 'utf8'), err => {
            if (err && !settled) done(new Error('write failed: ' + (err.message || err)));
          });
        },
        () => { if (!settled) done(new Error('connect failed (phone in range + paired?)')); });
    } catch (e) { done(e); }
  }), cfg.commandTimeoutMs + cfg.connectTimeoutMs, 'dial');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (_) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleDial(cfg, body) {
  const phone = cleanPhone(body && body.phone);
  if (!phone || !/^\+?\d{7,15}$/.test(phone)) {
    return { ok: false, error: 'invalid phone number' };
  }
  if (!BTSerialPort) {
    return { ok: false, error: 'BT module not installed (run npm install in bt-dial)' };
  }
  const device = resolveDevice(cfg, body && body.agent);
  if (!device) {
    return { ok: false, error: 'no BT phone configured (set defaultDevice in config.json)' };
  }
  const override = cfg.channels ? cfg.channels[device] || cfg.channels[device.toLowerCase()] : null;
  const channel = override || await findChannel(device, cfg.connectTimeoutMs);
  await dialOnce(device, channel, phone, cfg);
  return { ok: true, device, channel };
}

function listDevices(cfg) {
  return new Promise(resolve => {
    const configured = Object.entries(cfg.devices || {}).map(([agent, mac]) => ({ agent, mac: normMac(mac) }));
    if (cfg.defaultDevice) configured.unshift({ agent: 'default', mac: normMac(cfg.defaultDevice) });
    if (!BTSerialPort) return resolve({ ok: true, configured, paired: [], note: 'BT module missing — configured list only' });
    try {
      const probe = new BTSerialPort();
      if (typeof probe.listPairedDevices !== 'function') {
        try { probe.close(); } catch (_) {}
        return resolve({ ok: true, configured, paired: [], note: 'paired listing unsupported — configured list only' });
      }
      probe.listPairedDevices(
        paired => {
          try { probe.close(); } catch (_) {}
          resolve({ ok: true, configured, paired: (paired || []).map(p => ({ name: p.name || '', mac: normMac(p.address || p.bdaddr || '') })) });
        },
        () => {
          try { probe.close(); } catch (_) {}
          resolve({ ok: true, configured, paired: [], note: 'paired listing failed' });
        });
    } catch (e) {
      resolve({ ok: true, configured, paired: [], note: String((e && e.message) || e) });
    }
  });
}

function start() {
  const cfg = loadConfig();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        return send(res, 200, {
          ok: true, version: VERSION, btAvailable: !!BTSerialPort,
          defaultDevice: normMac(cfg.defaultDevice),
          devices: cfg.devices || {},
        });
      }
      if (req.method === 'GET' && url.pathname === '/devices') {
        return send(res, 200, await listDevices(cfg));
      }
      if (req.method === 'POST' && url.pathname === '/dial') {
        const body = await readBody(req);
        try {
          const out = await handleDial(cfg, body);
          return send(res, out.ok ? 200 : 502, out);
        } catch (e) {
          return send(res, 502, { ok: false, error: String((e && e.message) || e) });
        }
      }
      return send(res, 404, { ok: false, error: 'unknown endpoint (GET /status, GET /devices, POST /dial)' });
    } catch (e) {
      return send(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });
  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`[bt-dial] v${VERSION} listening on http://127.0.0.1:${cfg.port} (BT ${BTSerialPort ? 'available' : 'UNAVAILABLE — npm install'})`);
  });
}

start();
