#!/usr/bin/env bash
set -euo pipefail

export NODE_ENV="${NODE_ENV:-development}"
export PORT="${PORT:-3000}"
export JWT_SECRET="${JWT_SECRET:-local-cloud-agent-dev-secret}"
export DISABLE_BACKGROUND_JOBS="${DISABLE_BACKGROUND_JOBS:-1}"
export DISABLE_RENDER_KEEPALIVE="${DISABLE_RENDER_KEEPALIVE:-1}"
export OTP_RETURN_CODE="${OTP_RETURN_CODE:-1}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://localhost:3000}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  export DATABASE_URL="postgresql://seminar:seminar_local_dev@127.0.0.1:5432/seminar"
fi

if command -v pg_isready >/dev/null 2>&1; then
  if ! pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; then
    sudo service postgresql start || true
    for _ in $(seq 1 30); do
      pg_isready -h 127.0.0.1 -p 5432 -q && break
      sleep 1
    done
  fi
fi

cd /workspace
exec node server.js
