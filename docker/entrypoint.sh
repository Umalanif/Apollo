#!/usr/bin/env bash
set -euo pipefail

mkdir -p /app/logs /app/exports /app/storage /app/runtime

required_vars=(
  PROXY_HOST
  PROXY_USERNAME
  PROXY_PASSWORD
  PROXY_PORT
  TWO_CAPTCHA_API_KEY
)

for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    echo "Missing required environment variable: ${var_name}" >&2
    exit 1
  fi
done

if [[ -z "${APOLLO_MS_EMAIL:-}" && -z "${APOLLO_EMAIL:-}" ]]; then
  echo "Either APOLLO_MS_EMAIL or APOLLO_EMAIL must be set." >&2
  exit 1
fi

if [[ -z "${APOLLO_MS_PASSWORD:-}" && -z "${APOLLO_PASSWORD:-}" ]]; then
  echo "Either APOLLO_MS_PASSWORD or APOLLO_PASSWORD must be set." >&2
  exit 1
fi

if [[ -n "${TARGETING_JSON:-}" ]]; then
  TARGETING_FILE="/app/runtime/targeting.json"
  printf '%s\n' "${TARGETING_JSON}" > "${TARGETING_FILE}"
fi

if [[ -z "${TARGETING_FILE:-}" ]]; then
  echo "Set TARGETING_FILE or TARGETING_JSON before starting the container." >&2
  exit 1
fi

if [[ ! -f "${TARGETING_FILE}" ]]; then
  echo "Targeting file does not exist: ${TARGETING_FILE}" >&2
  exit 1
fi

export DATABASE_URL="${DATABASE_URL:-file:./storage/apollo.db}"
JOB_ID="${JOB_ID:-apollo-$(date -u +%Y%m%dT%H%M%SZ)}"

npx prisma db push --skip-generate

worker_args=(
  dist/worker-cli.js
  --targeting-file "${TARGETING_FILE}"
  --job-id "${JOB_ID}"
)

if [[ -n "${MAX_LEADS:-}" ]]; then
  worker_args+=(--max-leads "${MAX_LEADS}")
fi

exec xvfb-run -a node "${worker_args[@]}"
