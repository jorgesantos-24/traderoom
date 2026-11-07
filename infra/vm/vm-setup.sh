#!/usr/bin/env bash
# One-time (and re-runnable) VM preparation, as root, from the directory deploy.sh uploaded.
# Installs Node 22, Caddy, Redis and jq; creates the service user; installs units, sysctl,
# Redis and Caddy config. Safe to run again: every step checks before it changes anything.
set -euo pipefail
cd "$(dirname "$0")"
[[ $EUID -eq 0 ]] || { echo 'run as root' >&2; exit 1; }
[[ -f traderoom.env ]] || { echo 'traderoom.env missing next to vm-setup.sh' >&2; exit 1; }

NODE_MAJOR=22
export DEBIAN_FRONTEND=noninteractive
log() { printf '\n== %s\n' "$*"; }

log 'base packages'
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg jq redis-server debian-keyring debian-archive-keyring apt-transport-https >/dev/null

log "Node.js $NODE_MAJOR"
if ! node --version 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

log 'Caddy'
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
caddy version

log 'service user and directories'
id traderoom >/dev/null 2>&1 || useradd --system --home-dir /opt/traderoom --shell /usr/sbin/nologin traderoom
install -d -m 0755 -o root -g root /opt/traderoom /opt/traderoom/releases /opt/traderoom/bin
install -d -m 0750 -o root -g traderoom /etc/traderoom
install -m 0640 -o root -g traderoom traderoom.env /etc/traderoom/traderoom.env
install -m 0644 -o root -g root cloudsql-server-ca.pem /etc/traderoom/cloudsql-server-ca.pem
install -m 0750 -o root -g root fetch-secrets.sh /opt/traderoom/bin/fetch-secrets.sh
install -m 0750 -o root -g root release.sh /opt/traderoom/bin/release.sh

log 'kernel settings'
install -m 0644 sysctl/99-traderoom.conf /etc/sysctl.d/99-traderoom.conf
sysctl --system >/dev/null

log 'swap (1 GiB safety net on a 2 GiB e2-small)'
if ! swapon --show | grep -q /swapfile; then
  [[ -f /swapfile ]] || { fallocate -l 1G /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
install -m 0644 /dev/stdin /etc/sysctl.d/98-swappiness.conf <<<'vm.swappiness = 10'
sysctl -q -p /etc/sysctl.d/98-swappiness.conf

log 'Redis (127.0.0.1 only)'
install -m 0640 -o redis -g redis redis/traderoom.conf /etc/redis/traderoom.conf
grep -q '^include /etc/redis/traderoom.conf' /etc/redis/redis.conf || echo 'include /etc/redis/traderoom.conf' >>/etc/redis/redis.conf
systemctl enable --now redis-server >/dev/null
systemctl restart redis-server
redis-cli ping

log 'Caddy config'
# shellcheck disable=SC1091
source /etc/traderoom/traderoom.env
install -m 0644 Caddyfile /etc/caddy/Caddyfile
printf 'TRADEROOM_DOMAIN=%s\nTRADEROOM_ACME_EMAIL=%s\n' "$TRADEROOM_DOMAIN" "$TRADEROOM_ACME_EMAIL" >/etc/default/caddy
install -d -m 0755 /etc/systemd/system/caddy.service.d
install -m 0644 /dev/stdin /etc/systemd/system/caddy.service.d/traderoom.conf <<'EOF'
[Service]
EnvironmentFile=/etc/default/caddy
EOF
install -d -m 0755 -o caddy -g caddy /var/log/caddy

log 'systemd units'
for u in systemd/*.service; do install -m 0644 "$u" /etc/systemd/system/; done
systemctl daemon-reload
systemctl enable traderoom-secrets traderoom-api traderoom-ws traderoom-worker caddy >/dev/null
systemctl restart traderoom-secrets
# The apps start on the first release (there is no /opt/traderoom/current yet on a fresh VM).
if [[ -e /opt/traderoom/current ]]; then systemctl restart traderoom-api traderoom-ws traderoom-worker; fi
systemctl reload-or-restart caddy

log 'done'
