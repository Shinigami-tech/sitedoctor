#!/usr/bin/env bash
# One-shot setup for a fresh Vultr Ubuntu 24.04 VM (2 vCPU / 4 GB recommended).
# Usage:  git clone https://github.com/Shinigami-tech/sitedoctor && cd sitedoctor && sudo bash deploy/setup-vultr.sh
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR=$(pwd)

echo "==> Installing Docker and Node.js 22"
apt-get update -y
apt-get install -y ca-certificates curl gnupg iptables-persistent
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Installing app dependencies and building the sandbox image"
npm ci --omit=dev || npm install --omit=dev
docker build -t sitedoctor-sandbox sandbox

echo "==> Containment layer 2: sandboxes can never reach the cloud metadata service"
iptables -C DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null || iptables -I DOCKER-USER -d 169.254.169.254 -j DROP
netfilter-persistent save || true

[ -f .env ] || { cp .env.example .env; IP=$(curl -s4 ifconfig.me || hostname -I | awk '{print $1}'); sed -i "s#YOUR_VM_IP#$IP#" .env; }

echo "==> Installing systemd service"
cat > /etc/systemd/system/sitedoctor.service <<UNIT
[Unit]
Description=SiteDoctor control layer
After=docker.service network-online.target
Requires=docker.service

[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$(command -v node) app/server.mjs
Restart=always
User=root

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now sitedoctor
command -v ufw >/dev/null && ufw allow 8080/tcp || true

echo "==> Done. Put your Vultr Inference key in $APP_DIR/.env, then: systemctl restart sitedoctor"
echo "    Open: $(grep SD_PUBLIC_URL .env | cut -d= -f2)"
