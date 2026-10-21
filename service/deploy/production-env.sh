#!/usr/bin/env bash
# Operator setup for the hosted service's Vercel production environment.
# Prompts for secrets without echoing them and writes them straight to Vercel.
#
#   service/deploy/production-env.sh [auth|database|oauth|cantelop|all]
#
# DRY_RUN=1 skips Vercel writes, which lets the database step run against a
# local PostgreSQL. Stripe is optional and not configured here.
set -euo pipefail
cd "$(dirname "$0")/../.."

PROJECT=${VERCEL_PROJECT:-juiced}
SCOPE=${VERCEL_SCOPE:-stepandels-projects}
SERVICE_URL=https://juiced.codes

existing() {
  [[ -n ${DRY_RUN:-} ]] && return 1
  vercel env ls production --project "$PROJECT" --scope "$SCOPE" 2>/dev/null |
    awk 'NR>1{print $1}' | grep -qx "$1"
}
put() {
  local name=$1 value=$2
  if [[ -n ${DRY_RUN:-} ]]; then
    echo "  (dry run) $name"
    return
  fi
  printf %s "$value" |
    vercel env add "$name" production --sensitive --force --project "$PROJECT" --scope "$SCOPE" >/dev/null
  echo "  set $name"
}
secret() {
  local value
  read -rsp "$1: " value
  echo >&2
  [[ -n $value ]] || { echo "$1 is required" >&2; exit 1; }
  printf %s "$value"
}

auth() {
  echo "Auth secret"
  # Rotating this invalidates sessions and encrypted provider tokens.
  if existing JUICED_AUTH_SECRET; then
    echo "  JUICED_AUTH_SECRET already exists; leaving it unchanged"
  else
    put JUICED_AUTH_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
  fi
}

database() {
  echo "Database"
  command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }
  local owner api worker
  owner=$(secret 'Owner PostgreSQL URL (used here only, never stored in Vercel)')
  JUICED_DATABASE_URL=$owner JUICED_SERVICE_URL=$SERVICE_URL NODE_ENV=development \
    JUICED_AUTH_SECRET=$(openssl rand -hex 32) npm run --silent migrate:service
  api=$(openssl rand -hex 24)
  worker=$(openssl rand -hex 24)
  {
    echo "DO \$\$BEGIN"
    echo "  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='juiced_api') THEN CREATE ROLE juiced_api LOGIN; END IF;"
    echo "  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='juiced_worker') THEN CREATE ROLE juiced_worker LOGIN; END IF;"
    echo "END\$\$;"
    sed '/^CREATE ROLE/d' service/deploy/roles.sql
    echo "ALTER ROLE juiced_api PASSWORD '$api';"
    echo "ALTER ROLE juiced_worker PASSWORD '$worker';"
  } | psql "$owner" -q -v ON_ERROR_STOP=1 >/dev/null
  echo "  migrations, roles and grants applied"
  role_url() {
    ROLE_URL=$owner ROLE_USER=$1 ROLE_PASSWORD=$2 node -e '
      const u = new URL(process.env.ROLE_URL);
      u.username = process.env.ROLE_USER;
      u.password = process.env.ROLE_PASSWORD;
      process.stdout.write(u.href);'
  }
  local api_url worker_url
  api_url=$(role_url juiced_api "$api")
  worker_url=$(role_url juiced_worker "$worker")
  psql "$api_url" -qAtc 'SELECT 1 FROM juiced_migrations LIMIT 1' >/dev/null
  psql "$worker_url" -qAtc 'SELECT 1 FROM juiced_migrations LIMIT 1' >/dev/null
  echo "  juiced_api and juiced_worker can connect"
  put JUICED_DATABASE_URL "$api_url"
  put JUICED_WORKER_DATABASE_URL "$worker_url"
}

oauth() {
  echo "OAuth (callbacks: $SERVICE_URL/api/auth/callback/github and /google)"
  put JUICED_GITHUB_CLIENT_ID "$(secret 'GitHub client ID')"
  put JUICED_GITHUB_CLIENT_SECRET "$(secret 'GitHub client secret')"
  put JUICED_GOOGLE_CLIENT_ID "$(secret 'Google client ID')"
  put JUICED_GOOGLE_CLIENT_SECRET "$(secret 'Google client secret')"
}

cantelop() {
  echo "Cantelop Fleet"
  local fleet api worker
  fleet=$(secret 'Fleet ID (flt_...)')
  [[ $fleet =~ ^flt_[a-f0-9]{32}$ ]] || { echo "Invalid Fleet ID" >&2; exit 1; }
  api=$(secret 'API principal token (credentials:read, installations:read)')
  worker=$(secret 'Worker principal token (installations:read/write, policy:write, usage:read, credentials:read)')
  for token in "$api" "$worker"; do
    [[ $token =~ ^fsp_[a-f0-9]{32}\.[a-f0-9]{64}$ ]] || { echo "Invalid Fleet token" >&2; exit 1; }
  done
  [[ $api != "$worker" ]] || { echo "Use separate API and worker principals" >&2; exit 1; }
  put CANTELOP_API_URL https://cantelop.com
  put CANTELOP_FLEET_ID "$fleet"
  put CANTELOP_FLEET_TOKEN "$api"
  put CANTELOP_WORKER_FLEET_TOKEN "$worker"
  put JUICED_PACKAGE_ID "$(secret 'Approved package ID')"
  put JUICED_RUNTIME_ID "$(secret 'Runtime ID')"
  existing JUICED_MINIMUM_CLI || put JUICED_MINIMUM_CLI 0.2.0
}

case ${1:-all} in
  auth | database | oauth | cantelop) "$1" ;;
  all) auth && database && oauth && cantelop ;;
  *) echo "Usage: $0 [auth|database|oauth|cantelop|all]" >&2; exit 2 ;;
esac
echo "Redeploy production for new values to take effect."
