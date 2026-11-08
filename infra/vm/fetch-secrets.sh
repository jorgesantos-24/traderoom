#!/usr/bin/env bash
# Runs at boot (traderoom-secrets.service), as root. Reads secrets from Secret Manager with the
# VM's service account and writes /run/traderoom/secrets.env (tmpfs: gone on reboot, never on disk).
set -euo pipefail

ENV_FILE=/etc/traderoom/traderoom.env
OUT_DIR=/run/traderoom
OUT="$OUT_DIR/secrets.env"
META=http://metadata.google.internal/computeMetadata/v1

# shellcheck disable=SC1090
source "$ENV_FILE"
: "${GCP_PROJECT:?missing in $ENV_FILE}" "${DB_HOST:?}" "${DB_NAME:?}" "${DB_USER:?}"

token=$(curl -fsS -H 'Metadata-Flavor: Google' "$META/instance/service-accounts/default/token" | jq -r .access_token)

# Prints the latest version of a secret. `secret NAME optional` prints nothing (exit 0) when the
# secret is not set up: Secret Manager answers 403, not 404, for a secret that does not exist when
# the caller has no project-wide access (provision grants access per secret, only to existing ones).
secret() {
  local name=$1 optional=${2:-} body code
  body=$(mktemp)
  code=$(curl -sS -o "$body" -w '%{http_code}' -H "Authorization: Bearer $token" \
    "https://secretmanager.googleapis.com/v1/projects/$GCP_PROJECT/secrets/$name/versions/latest:access")
  if [[ $optional == optional && ( $code == 404 || $code == 403 ) ]]; then
    echo "secret $name: not set up (HTTP $code), skipped" >&2
    rm -f "$body"
    return 0
  fi
  if [[ $code != 200 ]]; then echo "secret $name: HTTP $code" >&2; rm -f "$body"; return 1; fi
  jq -r .payload.data "$body" | base64 -d
  rm -f "$body"
}

db_password=$(secret traderoom-db-password)
[[ -n $db_password ]] || { echo 'traderoom-db-password is empty or missing' >&2; exit 1; }
resend_key=$(secret traderoom-resend-api-key optional)
novus_key=$(secret traderoom-novus-api-key optional)
novus_whsec=$(secret traderoom-novus-webhook-secret optional)

install -d -m 0750 -o root -g traderoom "$OUT_DIR"
tmp=$(mktemp "$OUT_DIR/.secrets.XXXXXX")
# The password is hex (deploy.sh generates it), so it needs no URL encoding.
# Cloud SQL only accepts TLS (ENCRYPTED_ONLY); verify-ca checks the instance's own CA. Its cert
# names the instance, not the private IP, so hostname checks (verify-full) cannot pass.
{
  # Double quotes: systemd strips them, and release.sh can `source` this file (the URL has "&").
  echo "DATABASE_URL=\"postgres://$DB_USER:$db_password@$DB_HOST:5432/$DB_NAME?sslmode=verify-ca&sslrootcert=/etc/traderoom/cloudsql-server-ca.pem&uselibpqcompat=true\""
  if [[ -n $resend_key ]]; then echo "RESEND_API_KEY=\"$resend_key\""; fi
  if [[ -n $novus_key ]]; then echo "NOVUS_API_KEY=\"$novus_key\""; fi
  if [[ -n $novus_whsec ]]; then echo "NOVUS_WEBHOOK_SECRET=\"$novus_whsec\""; fi
} >"$tmp"
chown root:traderoom "$tmp"
chmod 0640 "$tmp"
mv -f "$tmp" "$OUT"
echo "wrote $OUT"
