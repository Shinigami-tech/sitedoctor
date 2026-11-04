#!/bin/bash
# Vultr "Startup Script" (boot): installs SiteDoctor on first boot, no SSH needed.
# Also starts a one-time key form on port 8081 so the owner can paste the
# Vultr Inference key in the browser; the form shuts itself down after saving.
exec > /var/log/sitedoctor-setup.log 2>&1
set -x
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y git
git clone https://github.com/Shinigami-tech/sitedoctor /opt/sitedoctor
cd /opt/sitedoctor && bash deploy/setup-vultr.sh

cat > /opt/sd-keyform.mjs <<'JS'
import http from "node:http"; import fs from "node:fs"; import { execSync } from "node:child_process";
const ENV = "/opt/sitedoctor/.env";
const page = (msg = "") => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><body style="font:16px system-ui;max-width:520px;margin:60px auto">
<h2>SiteDoctor · AI key</h2><p>Paste the API key from <b>Serverless Inference → your subscription → API Key</b> (not the account API key). It is checked with Vultr before saving; this page closes itself after a successful save.</p>
<form method=post><input name=key type=password style="width:100%;padding:10px" required><p><input name=model placeholder="model (optional)" style="width:100%;padding:10px"></p><button style="padding:10px 18px">Save</button></form><p>${msg}</p>`;
http.createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page()); }
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
    const p = new URLSearchParams(b); const key = (p.get("key") || "").trim(); const model = (p.get("model") || "").trim();
    if (!/^[A-Za-z0-9_\-\.]{16,}$/.test(key)) { res.writeHead(400, { "content-type": "text/html" }); return res.end(page("That doesn't look like a key.")); }
    let ok = false;
    // /models is public, so probe an authenticated endpoint; a bogus model name costs nothing and still reveals 401/403 for a bad key
    try { const r = await fetch("https://api.vultrinference.com/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ model: "sitedoctor-key-check", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }) }); ok = r.status !== 401 && r.status !== 403; } catch {}
    if (!ok) { res.writeHead(400, { "content-type": "text/html" }); return res.end(page("Vultr rejected this key. Copy the key from Serverless Inference → your subscription → API Key and try again.")); }
    let env = fs.readFileSync(ENV, "utf8").replace(/^VULTR_INFERENCE_KEY=.*$/m, "VULTR_INFERENCE_KEY=" + key);
    if (model) env = env.replace(/^VULTR_MODEL=.*$/m, "VULTR_MODEL=" + model);
    fs.writeFileSync(ENV, env, { mode: 0o600 });
    execSync("systemctl restart sitedoctor");
    res.writeHead(200, { "content-type": "text/html" }); res.end("<p style='font:16px system-ui;margin:60px'>Saved. SiteDoctor restarted with AI on. You can close this tab.</p>");
    setTimeout(() => { execSync("systemctl disable --now sd-keyform"); }, 1500);
  });
}).listen(8081);
JS
cat > /etc/systemd/system/sd-keyform.service <<'UNIT'
[Unit]
Description=SiteDoctor one-time key form
After=network-online.target
[Service]
ExecStart=/usr/bin/node /opt/sd-keyform.mjs
[Install]
WantedBy=multi-user.target
UNIT
command -v ufw >/dev/null && ufw allow 8081/tcp || true
systemctl daemon-reload && systemctl enable --now sd-keyform

# Auto-update: every 5 minutes pull the public repo; if it changed, reinstall deps, rebuild the sandbox
# image when sandbox/ changed, and restart. The .env with the key is untracked, so it is never touched.
cat > /opt/sd-update.sh <<'SH'
#!/bin/bash
cd /opt/sitedoctor || exit 0
old=$(git rev-parse HEAD)
git fetch -q origin && git reset -q --hard origin/HEAD || exit 0
new=$(git rev-parse HEAD)
[ "$old" = "$new" ] && exit 0
git diff --name-only "$old" "$new" | grep -q '^sandbox/' && docker build -q -t sitedoctor-sandbox sandbox
git diff --name-only "$old" "$new" | grep -q '^package' && (npm ci --omit=dev || npm install --omit=dev)
systemctl restart sitedoctor
echo "updated $old -> $new"
SH
chmod +x /opt/sd-update.sh
cat > /etc/systemd/system/sd-update.service <<'UNIT'
[Unit]
Description=SiteDoctor auto-update from GitHub
[Service]
Type=oneshot
ExecStart=/opt/sd-update.sh
UNIT
cat > /etc/systemd/system/sd-update.timer <<'UNIT'
[Unit]
Description=SiteDoctor auto-update every 5 minutes
[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload && systemctl enable --now sd-update.timer
echo SETUP_DONE
