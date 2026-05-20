#!/bin/bash
# Indico container entrypoint for the visual regression stack.
#
# Phases:
#  1) wait for postgres (compose already waits via healthcheck, but defensive)
#  2) drop+create the indico_visual database, install extensions
#  3) `indico db prepare` to lay down the schema
#  4) seed scenarios (writes manifest.json into the bind-mounted /regressions)
#  5) exec the dev server via our freezegun wrapper

set -euo pipefail

PG_HOST="${PG_HOST:-postgres}"
PG_USER="${PG_USER:-indico}"
DB_NAME="${DB_NAME:-indico_visual}"

echo "[entrypoint-indico] waiting for postgres..."
until pg_isready -h "$PG_HOST" -U "$PG_USER" >/dev/null 2>&1; do
  sleep 1
done

echo "[entrypoint-indico] (re)creating database $DB_NAME"
psql -h "$PG_HOST" -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -q \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS $DB_NAME;" \
  -c "CREATE DATABASE $DB_NAME;"
psql -h "$PG_HOST" -U "$PG_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q \
  -c "CREATE EXTENSION IF NOT EXISTS unaccent; CREATE EXTENSION IF NOT EXISTS pg_trgm;"

echo "[entrypoint-indico] applying schema"
python /regressions/hooks/run_indico.py db prepare

echo "[entrypoint-indico] seeding scenarios"
PYTHONPATH=/regressions python -m seed

echo "[entrypoint-indico] starting dev server on 0.0.0.0:8000"
exec python /regressions/hooks/run_indico.py run \
  -q -h 0.0.0.0 -p 8000 -u "http://indico:8000" --reloader none
