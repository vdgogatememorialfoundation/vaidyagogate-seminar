#!/usr/bin/env bash
set -euo pipefail

cd /workspace

if ! command -v psql >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-client
fi

if ! pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; then
  sudo service postgresql start || true
  for _ in $(seq 1 30); do
    pg_isready -h 127.0.0.1 -p 5432 -q && break
    sleep 1
  done
fi

if pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL' || true
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'seminar') THEN
    CREATE ROLE seminar LOGIN PASSWORD 'seminar_local_dev';
  END IF;
END $$;
SELECT 'CREATE DATABASE seminar OWNER seminar'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'seminar')\gexec
GRANT ALL PRIVILEGES ON DATABASE seminar TO seminar;
SQL
fi

npm ci
npm run build
