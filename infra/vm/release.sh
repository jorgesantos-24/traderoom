#!/usr/bin/env bash
# Installs one release tarball on the VM, as root:
#   release.sh /tmp/traderoom-<id>.tar.gz
# Unpacks into /opt/traderoom/releases/<id>, installs production dependencies, runs migrations,
# switches /opt/traderoom/current atomically and restarts the services. If /api/health does not
# come up, it switches back to the previous release.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'run as root' >&2; exit 1; }
TARBALL=${1:?usage: release.sh <tarball>}
ROOT=/opt/traderoom
KEEP=5
id=$(basename "$TARBALL" .tar.gz)
id=${id#traderoom-}
dir="$ROOT/releases/$id"
log() { printf '\n== %s\n' "$*"; }

log "unpack $id"
rm -rf "$dir"
install -d -m 0755 "$dir"
tar -xzf "$TARBALL" -C "$dir"

log 'production dependencies'
(cd "$dir" && HOME=/root npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$dir"
chmod -R go-w "$dir"

log 'migrations'
set -a
# shellcheck disable=SC1091
source /etc/traderoom/traderoom.env
# shellcheck disable=SC1091
source /run/traderoom/secrets.env
set +a
(cd "$dir" && node apps/api/dist/cli/migrate.js up)

# Only a real previous release counts: on a first deploy (or a broken link) there is nothing to roll back to.
previous=''
if [[ -L $ROOT/current ]]; then
  previous=$(readlink -e "$ROOT/current" 2>/dev/null || true)
  [[ $previous == "$ROOT"/releases/* ]] || previous=''
fi
switch_to() {
  ln -sfn "$1" "$ROOT/current.tmp"
  mv -Tf "$ROOT/current.tmp" "$ROOT/current"
}

log 'switch and restart'
switch_to "$dir"
systemctl restart traderoom-worker traderoom-api traderoom-ws
systemctl reload-or-restart caddy

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:3000/api/health \
      && curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:3001/healthz \
      && curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:3002/healthz; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if ! healthy; then
  echo "release $id is unhealthy" >&2
  journalctl -u traderoom-api -u traderoom-ws -u traderoom-worker -n 40 --no-pager >&2 || true
  if [[ -n $previous && -d $previous && $previous != "$dir" ]]; then
    echo "rolling back to $(basename "$previous") (migrations are forward-only and stay applied)" >&2
    switch_to "$previous"
    systemctl restart traderoom-worker traderoom-api traderoom-ws
  else
    echo 'no previous release to roll back to; this one stays in place for diagnosis' >&2
  fi
  exit 1
fi

log 'prune old releases'
# shellcheck disable=SC2012
ls -1dt "$ROOT"/releases/*/ | tail -n +$((KEEP + 1)) | while read -r old; do
  [[ $(readlink -f "$old") == "$(readlink -f "$ROOT/current")" ]] || rm -rf "$old"
done
rm -f "$TARBALL"
echo "release $id is live"
