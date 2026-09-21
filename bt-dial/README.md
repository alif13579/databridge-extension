# BT Dial Server (Windows) — button phone diye dial

Laptop-e paired button/feature phone thakle DataBridge extension-er 📞 Call
button chaplei phone nijer SIM diye dial korbe — Bluetooth RFCOMM-e
`ATD<number>;` command jay (Hands-Free profile-er standard dial command).
Helper offline thakle extension ager moto Firebase path-e (app auto-dial)
fallback kore, tai server na chalaleo kichu bhangbe na.

## Setup (protita CC PC-te ekbar)

1. **Node.js LTS** install koro (https://nodejs.org) — `node -v` te 18+ dekhabe.
2. **Phone pair koro:** Windows Settings → Bluetooth & devices → Add device →
   phone select koro. Phone-e Bluetooth ON + discoverable rakhte hobe.
3. **MAC address nao:** phone-er Settings → About → Bluetooth address
   (jemon `AA:BB:CC:DD:EE:FF`). Bikolpo: `http://127.0.0.1:17891/devices`
   (server chalu thakle, best-effort list).
4. **Install + config:**
   ```
   cd bt-dial
   npm install
   copy config.example.json config.json
   ```
   `config.json`-e `defaultDevice`-te MAC bosao. Ek PC-te ekadhik phone hole
   `devices`-e agent system-id → MAC mapping dao (jemon `"9727": "AA:…"`) —
   extension card-er agent onujayi thik phone-e dial korbe.
5. **Chalao:** `node server.js` → `listening on http://127.0.0.1:17891` asbe.
   Browser-e `http://127.0.0.1:17891/status` khule check koro.
6. **Autostart (optional):** `shell:startup` folder-e `node C:\path\to\bt-dial\server.js`
   sortcut rakho, nahole Task Scheduler-e logon trigger dao.

## Test

- `GET /status` → `btAvailable: true` hote hobe (`false` hole `npm install` hoyni).
- Extension-e jekono card-e 📞 Call chap dao → phone-e call lagbe,
  button-e `📞 Dialed!` uthbe. Helper off thakle ager moto `📞 Sent!` asbe.

## Troubleshooting

- **RFCOMM channel not found** — phone paired + range-er moddhe ache kina dekho;
  kichu model-e prothombar Windows-e "serial port" service allow korte hoy
  (Bluetooth settings → device → Services).
- **phone rejected dial** — number format check koro (desher code soho try koro);
  khub purono model ATD support na korle ei poth ochol.
- **Ekadhik bar dial / hang** — ek dial sesh howar age arekta chap dio na;
  server ek somoye ekta connection khole.
- Port bodlate chaile `config.json`-e `port` + extension-er `BT_DIAL_URL`
  (background.js) — duitatei milate hobe.
