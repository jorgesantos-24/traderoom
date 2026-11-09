#!/usr/bin/env bash
# Traderoom on GCP — idempotent: every step checks what exists and only creates what is missing.
# Run from the repo root on a machine with gcloud (authenticated), node 22+, npm and tar.
#
#   export GCP_PROJECT=my-project TRADEROOM_DOMAIN=trade.example.com ACME_EMAIL=ops@example.com
#   export RESEND_API_KEY=re_...           # optional; stored in Secret Manager, never on disk
#   export NOVUS_API_KEY=...               # Pix deposits/withdrawals (Novus private key); Secret Manager, never on disk
#   export NOVUS_WEBHOOK_SECRET=whsec_...  # optional: secret of a global webhook made in the Novus dashboard
#   export EAGLE_CLIENT_ID=... EAGLE_PUBLIC_KEY=... EAGLE_SECRET_KEY=...  # EaglePay (Integrações → API e Webhooks); Secret Manager
#   # With EaglePay keys set, new deposits/withdrawals go to EaglePay; Novus still finishes what it already holds.
#   export MAIL_FROM='Traderoom <nao-responda@example.com>'
#   export FIREBASE_STORAGE_BUCKET=my-project.firebasestorage.app   # optional: KYC photos in Firebase Storage
#   # Firebase project: `source infra/firebase.env` sets all of the above for traderoom-48951.
#   infra/deploy.sh provision   # network, static IP, firewall, Cloud SQL, secrets, VM, uptime check
#   infra/deploy.sh setup       # packages, users, units, Caddy, Redis on the VM (re-runnable)
#   infra/deploy.sh release     # build, upload, migrate, switch, health-check (rolls back on failure)
#   infra/deploy.sh all         # the three above
#
# After `provision`, point an A record for $TRADEROOM_DOMAIN at the printed IP before `setup`,
# so Caddy can get the TLS certificate.
set -euo pipefail

: "${GCP_PROJECT:?set GCP_PROJECT}"
: "${TRADEROOM_DOMAIN:?set TRADEROOM_DOMAIN (e.g. trade.example.com)}"
REGION=${REGION:-southamerica-east1}
ZONE=${ZONE:-southamerica-east1-a}
NETWORK=${NETWORK:-traderoom-vpc}
SUBNET=${SUBNET:-traderoom-subnet}
SUBNET_RANGE=${SUBNET_RANGE:-10.20.0.0/24}
PSA_RANGE=${PSA_RANGE:-traderoom-psa}
VM=${VM:-traderoom-vm}
MACHINE=${MACHINE:-e2-small}
IP_NAME=${IP_NAME:-traderoom-ip}
# An existing instance (e.g. the one Firebase SQL Connect created) is adopted and hardened, not recreated.
SQL=${SQL:-traderoom-db}
SQL_VERSION=${SQL_VERSION:-POSTGRES_18}
SQL_TIER=${SQL_TIER:-db-g1-small}
# 1: also move an existing instance to $SQL_TIER (restarts it; on a SQL Connect trial it ends the free trial).
SQL_RESIZE=${SQL_RESIZE:-0}
FIREBASE_STORAGE_BUCKET=${FIREBASE_STORAGE_BUCKET:-}
DB_NAME=${DB_NAME:-traderoom}
DB_USER=${DB_USER:-traderoom}
SA_NAME=${SA_NAME:-traderoom-vm}
SA="$SA_NAME@$GCP_PROJECT.iam.gserviceaccount.com"
TAG=traderoom-web
ACME_EMAIL=${ACME_EMAIL:-}
MAIL_FROM=${MAIL_FROM:-Traderoom <nao-responda@$TRADEROOM_DOMAIN>}
# IAP's fixed range: SSH reaches the VM only through `gcloud compute ssh --tunnel-through-iap`.
IAP_RANGE=35.235.240.0/20

g() { gcloud --project "$GCP_PROJECT" --quiet "$@"; }
log() { printf '\n== %s\n' "$*"; }
exists() { "$@" >/dev/null 2>&1; }

provision() {
  log 'APIs'
  g services enable compute.googleapis.com sqladmin.googleapis.com servicenetworking.googleapis.com \
    secretmanager.googleapis.com monitoring.googleapis.com iap.googleapis.com logging.googleapis.com

  log "network $NETWORK (own VPC: none of the default network's open rules apply)"
  exists g compute networks describe "$NETWORK" || g compute networks create "$NETWORK" --subnet-mode=custom
  exists g compute networks subnets describe "$SUBNET" --region "$REGION" ||
    g compute networks subnets create "$SUBNET" --network "$NETWORK" --region "$REGION" --range "$SUBNET_RANGE" --enable-private-ip-google-access

  log 'firewall: 80/443 from anywhere, 22 only from IAP'
  exists g compute firewall-rules describe traderoom-allow-web ||
    g compute firewall-rules create traderoom-allow-web --network "$NETWORK" --direction INGRESS \
      --allow tcp:80,tcp:443 --source-ranges 0.0.0.0/0 --target-tags "$TAG"
  exists g compute firewall-rules describe traderoom-allow-iap-ssh ||
    g compute firewall-rules create traderoom-allow-iap-ssh --network "$NETWORK" --direction INGRESS \
      --allow tcp:22 --source-ranges "$IAP_RANGE" --target-tags "$TAG"

  log "static IP $IP_NAME"
  exists g compute addresses describe "$IP_NAME" --region "$REGION" || g compute addresses create "$IP_NAME" --region "$REGION"

  log 'private services access (Cloud SQL on a private IP)'
  exists g compute addresses describe "$PSA_RANGE" --global ||
    g compute addresses create "$PSA_RANGE" --global --purpose VPC_PEERING --prefix-length 20 --network "$NETWORK"
  if ! g services vpc-peerings list --network "$NETWORK" --format='value(service)' | grep -q servicenetworking; then
    g services vpc-peerings connect --service servicenetworking.googleapis.com --ranges "$PSA_RANGE" --network "$NETWORK"
  fi

  log "Cloud SQL $SQL (private IP, TLS only, daily backups kept 7 days, point-in-time recovery)"
  if ! exists g sql instances describe "$SQL"; then
    g sql instances create "$SQL" --database-version "$SQL_VERSION" --edition ENTERPRISE --tier "$SQL_TIER" \
      --region "$REGION" --network "projects/$GCP_PROJECT/global/networks/$NETWORK" --no-assign-ip \
      --ssl-mode ENCRYPTED_ONLY --storage-type SSD --storage-size 10 --storage-auto-increase \
      --backup-start-time 06:00 --retained-backups-count 7 --enable-point-in-time-recovery \
      --retained-transaction-log-days 7 --maintenance-window-day SUN --maintenance-window-hour 7
  else
    harden_sql
  fi
  exists g sql databases describe "$DB_NAME" --instance "$SQL" || g sql databases create "$DB_NAME" --instance "$SQL"

  log 'secrets'
  exists g secrets describe traderoom-db-password || g secrets create traderoom-db-password --replication-policy user-managed --locations "$REGION"
  if ! g sql users list --instance "$SQL" --format='value(name)' | grep -qx "$DB_USER"; then
    # Hex: no characters that need escaping in a connection URL.
    pw=$(openssl rand -hex 24)
    printf '%s' "$pw" | g secrets versions add traderoom-db-password --data-file=-
    g sql users create "$DB_USER" --instance "$SQL" --password "$pw"
    unset pw
  fi
  if [[ -n ${RESEND_API_KEY:-} ]]; then
    exists g secrets describe traderoom-resend-api-key ||
      g secrets create traderoom-resend-api-key --replication-policy user-managed --locations "$REGION"
    current=$(g secrets versions access latest --secret traderoom-resend-api-key 2>/dev/null || true)
    [[ $current == "$RESEND_API_KEY" ]] || printf '%s' "$RESEND_API_KEY" | g secrets versions add traderoom-resend-api-key --data-file=-
    unset current
  fi
  local name var
  for pair in traderoom-novus-api-key:NOVUS_API_KEY traderoom-novus-webhook-secret:NOVUS_WEBHOOK_SECRET     traderoom-eagle-client-id:EAGLE_CLIENT_ID traderoom-eagle-public-key:EAGLE_PUBLIC_KEY traderoom-eagle-secret-key:EAGLE_SECRET_KEY; do
    name=${pair%%:*} var=${pair#*:}
    [[ -n ${!var:-} ]] || continue
    exists g secrets describe "$name" || g secrets create "$name" --replication-policy user-managed --locations "$REGION"
    current=$(g secrets versions access latest --secret "$name" 2>/dev/null || true)
    [[ $current == "${!var}" ]] || printf '%s' "${!var}" | g secrets versions add "$name" --data-file=-
    unset current
  done

  log "service account $SA (read its secrets, write logs and metrics; nothing else)"
  exists g iam service-accounts describe "$SA" || g iam service-accounts create "$SA_NAME" --display-name 'Traderoom VM'
  for role in roles/logging.logWriter roles/monitoring.metricWriter; do
    g projects add-iam-policy-binding "$GCP_PROJECT" --member "serviceAccount:$SA" --role "$role" --condition None >/dev/null
  done
  for s in traderoom-db-password traderoom-resend-api-key traderoom-novus-api-key traderoom-novus-webhook-secret     traderoom-eagle-client-id traderoom-eagle-public-key traderoom-eagle-secret-key; do
    if exists g secrets describe "$s"; then
      g secrets add-iam-policy-binding "$s" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
    fi
  done

  if [[ -n $FIREBASE_STORAGE_BUCKET ]]; then
    log "KYC photos: gs://$FIREBASE_STORAGE_BUCKET, object read/write/delete for $SA on this bucket only"
    g storage buckets add-iam-policy-binding "gs://$FIREBASE_STORAGE_BUCKET"       --member "serviceAccount:$SA" --role roles/storage.objectUser >/dev/null
  fi

  log "VM $VM ($MACHINE, Debian 12)"
  if ! exists g compute instances describe "$VM" --zone "$ZONE"; then
    g compute instances create "$VM" --zone "$ZONE" --machine-type "$MACHINE" \
      --image-family debian-12 --image-project debian-cloud --boot-disk-size 20GB --boot-disk-type pd-balanced \
      --network "$NETWORK" --subnet "$SUBNET" --address "$IP_NAME" --tags "$TAG" \
      --service-account "$SA" --scopes cloud-platform \
      --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
      --metadata enable-oslogin=TRUE,block-project-ssh-keys=TRUE
  fi

  log 'uptime check on https://'"$TRADEROOM_DOMAIN"'/api/health'
  if ! g monitoring uptime list-configs --format='value(displayName)' | grep -qx traderoom-health; then
    g monitoring uptime create traderoom-health --resource-type uptime-url \
      --resource-labels "host=$TRADEROOM_DOMAIN,project_id=$GCP_PROJECT" \
      --protocol https --path /api/health --port 443 --period 1 --timeout 10 \
      --validate-ssl=true --status-classes=2xx
  fi

  ip=$(g compute addresses describe "$IP_NAME" --region "$REGION" --format='value(address)')
  log "done. Create DNS: $TRADEROOM_DOMAIN  A  $ip   (then run: infra/deploy.sh setup)"
}

# The instance already exists (Firebase SQL Connect creates one with public IP only, no backups and
# unencrypted connections allowed). Bring it to the same standard as one we create. Each change runs
# only if needed. The public IP stays (SQL Connect and `npm run db:tunnel` use it) but has no
# authorized networks, so only IAM-authorized connectors can reach it.
harden_sql() {
  local v
  v() { g sql instances describe "$SQL" --format="value($1)"; }
  if [[ -z $(v settings.ipConfiguration.privateNetwork) ]]; then
    log "Cloud SQL $SQL: attach private IP on $NETWORK (restarts the instance)"
    g sql instances patch "$SQL" --network "projects/$GCP_PROJECT/global/networks/$NETWORK"
  fi
  if [[ $(v settings.ipConfiguration.sslMode) != ENCRYPTED_ONLY ]]; then
    log "Cloud SQL $SQL: TLS only"
    g sql instances patch "$SQL" --ssl-mode ENCRYPTED_ONLY
  fi
  if [[ $(v settings.backupConfiguration.enabled) != True || $(v settings.backupConfiguration.pointInTimeRecoveryEnabled) != True ]]; then
    log "Cloud SQL $SQL: daily backups (7 kept) + point-in-time recovery (7 days)"
    g sql instances patch "$SQL" --backup-start-time 06:00 --retained-backups-count 7       --enable-point-in-time-recovery --retained-transaction-log-days 7       --maintenance-window-day SUN --maintenance-window-hour 7
  fi
  local tier
  tier=$(v settings.tier)
  if [[ $tier != "$SQL_TIER" ]]; then
    if [[ $SQL_RESIZE == 1 ]]; then
      log "Cloud SQL $SQL: $tier -> $SQL_TIER (restarts the instance)"
      g sql instances patch "$SQL" --tier "$SQL_TIER"
    else
      log "Cloud SQL $SQL stays on $tier (SQL_RESIZE=1 SQL_TIER=... to change it)"
    fi
  fi
}

ssh_vm() { g compute ssh "$VM" --zone "$ZONE" --tunnel-through-iap --strict-host-key-checking=no --command "$1"; }
scp_vm() { g compute scp --zone "$ZONE" --tunnel-through-iap --strict-host-key-checking=no "$@"; }
# Local scratch inside the repo (gitignored): gcloud on Windows cannot read Git Bash's /tmp.
WORK=.deploy
fresh_dir() { rm -rf "${WORK:?}/$1" && mkdir -p "$WORK/$1" && printf '%s' "$WORK/$1"; }

setup() {
  local stage db_host
  stage=$(fresh_dir setup)
  trap 'rm -rf "$stage"' RETURN
  db_host=$(g sql instances describe "$SQL" --format='value(ipAddresses.filter("type:PRIVATE").extract(ipAddress).flatten())')
  [[ -n $db_host ]] || { echo "Cloud SQL $SQL has no private IP (run provision first)" >&2; exit 1; }
  # Pools sized to the tier's connection limit, with room left for migrations and psql.
  local tier pools
  tier=$(g sql instances describe "$SQL" --format='value(settings.tier)')
  case $tier in
    db-f1-micro) pools='10 5 4' ;;  # ~25 connections
    db-g1-small) pools='16 8 6' ;;  # ~50
    *) pools='40 15 10' ;;          # dedicated-core tiers: 100+
  esac
  read -r api_pool ws_pool worker_pool <<<"$pools"
  g sql instances describe "$SQL" --format='value(serverCaCert.cert)' >"$stage/cloudsql-server-ca.pem"
  [[ -s $stage/cloudsql-server-ca.pem ]] || { echo 'could not read the Cloud SQL server CA' >&2; exit 1; }

  log 'staging VM files'
  cp -r infra/systemd infra/sysctl infra/redis infra/Caddyfile infra/vm/*.sh "$stage/"
  # No contact e-mail: the certificate is issued without one (ACME allows it).
  [[ -n $ACME_EMAIL ]] || sed -i '/^\temail {\$TRADEROOM_ACME_EMAIL}$/d' "$stage/Caddyfile"
  # Non-secret settings. Secrets (DATABASE_URL, RESEND_API_KEY, NOVUS_*, EAGLE_*) are built at boot by fetch-secrets.sh.
  cat >"$stage/traderoom.env" <<EOF
GCP_PROJECT=$GCP_PROJECT
TRADEROOM_DOMAIN=$TRADEROOM_DOMAIN
TRADEROOM_ACME_EMAIL=$ACME_EMAIL
NODE_ENV=production
LOG_LEVEL=info
PUBLIC_ORIGIN=https://$TRADEROOM_DOMAIN
COOKIE_SECURE=true
RATE_LIMIT_GLOBAL_PER_MIN=120
MAIL_FROM="$MAIL_FROM"
API_HOST=127.0.0.1
API_PORT=3000
WS_HOST=127.0.0.1
WS_PORT=3001
WORKER_HOST=127.0.0.1
WORKER_PORT=3002
DB_HOST=$db_host
DB_NAME=$DB_NAME
DB_USER=$DB_USER
# Cloud SQL tier $tier: pools leave room for migrations and psql.
DATABASE_POOL_MAX=$api_pool
WS_DATABASE_POOL_MAX=$ws_pool
WORKER_DATABASE_POOL_MAX=$worker_pool
# KYC photos (empty: kept in Postgres). Credentials: the VM's service account, no key file.
FIREBASE_STORAGE_BUCKET=$FIREBASE_STORAGE_BUCKET
REDIS_URL=redis://127.0.0.1:6379
BINANCE_WS_URL=wss://data-stream.binance.vision:443/stream
BINANCE_REST_URL=https://data-api.binance.vision
BINANCE_BACKUP_WS_URL=wss://stream.binance.com:443/stream
FEED_STALE_MS=2000
ORDER_ENTRY_DELAY_MS=500
HEALTH_FEED_MAX_AGE_MS=5000
# The Pix gateway posts payment status changes to https://$TRADEROOM_DOMAIN/api/webhooks/<eagle|novus>
PAYMENT_POSTBACKS=true
SNAPSHOT_RETENTION_DAYS=7
EOF

  log 'upload and run vm-setup.sh'
  ssh_vm 'rm -rf /tmp/traderoom-setup && mkdir -p /tmp/traderoom-setup'
  scp_vm --recurse "$stage"/* "$VM:/tmp/traderoom-setup/"
  ssh_vm 'sudo bash /tmp/traderoom-setup/vm-setup.sh && sudo rm -rf /tmp/traderoom-setup'
}

release() {
  local id tarball
  id=$(date -u +%Y%m%d%H%M%S)
  tarball="traderoom-$id.tar.gz"

  log 'build'
  # SKIP_NPM_CI=1 keeps the current node_modules (e.g. dev servers on Windows lock them).
  [[ ${SKIP_NPM_CI:-0} == 1 ]] || npm ci --no-audit --no-fund
  npm run typecheck
  npm test
  npm run build

  log "pack $tarball"
  local out
  out=$(fresh_dir release)/$tarball
  tar -czf "$out" \
    package.json package-lock.json README.md db/migrations \
    packages/shared/package.json packages/shared/dist \
    apps/api/package.json apps/api/dist \
    apps/ws/package.json apps/ws/dist \
    apps/web/package.json apps/web/dist

  log 'upload and install'
  scp_vm "$out" "$VM:/tmp/$tarball"
  ssh_vm "sudo /opt/traderoom/bin/release.sh /tmp/$tarball"
  rm -rf "$WORK/release"
  log "live: https://$TRADEROOM_DOMAIN"
}

case ${1:-} in
  provision) provision ;;
  setup) setup ;;
  release) release ;;
  all) provision && setup && release ;;
  *) sed -n '2,14p' "$0"; exit 64 ;;
esac
