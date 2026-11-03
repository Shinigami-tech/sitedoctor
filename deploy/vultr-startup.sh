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
const page = (msg = "") => `<!doctype html><meta name=viewport content="width=device-width"><body style="font:16px system-ui;max-width:520px;margin:60px auto">
<h2>SiteDoctor · AI key</h2><p>Paste your Vultr Serverless Inference API key. This page closes itself after saving.</p>
<form method=post><input name=key type=password style="width:100%;padding:10px" required><p><input name=model placeholder="model (optional)" style="width:100%;padding:10px"></p><button style="padding:10px 18px">Save</button></form><p>${msg}</p>`;
http.createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page()); }
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const p = new URLSearchParams(b); const key = (p.get("key") || "").trim(); const model = (p.get("model") || "").trim();
    if (!/^[A-Za-z0-9_\-\.]{16,}$/.test(key)) { res.writeHead(400, { "content-type": "text/html" }); return res.end(page("That doesn't look like a key.")); }
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
echo SETUP_DONE
