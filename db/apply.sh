#!/bin/bash
# Apply pending SQL migrations under db/migrations/ against $DATABASE_URL.
#
# Usage:
#   DATABASE_URL=postgres://...  ./db/apply.sh
#
# Each migration runs inside a single transaction that takes a Postgres
# advisory lock first, so:
#   - partial DDL failures roll back the whole file (transactional DDL),
#   - concurrent runs serialize on the advisory lock,
#   - the applied set is re-queried before each file so a parallel run that
#     committed first is skipped on the next iteration.

set -euo pipefail

MIGRATIONS_DIR="$(cd "$(dirname "$0")/migrations" && pwd)"
ADVISORY_LOCK_KEY=712348

if [ -z "${DATABASE_URL:-}" ]; then
    echo "DATABASE_URL must be set" >&2
    exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
    );
" >/dev/null

for f in "$MIGRATIONS_DIR"/*.sql; do
    base="$(basename "$f" .sql)"
    if psql "$DATABASE_URL" -tAc \
        "SELECT 1 FROM schema_migrations WHERE version = '$base'" | grep -q '^1$'; then
        echo "skip   $base (already applied)"
        continue
    fi
    echo "apply  $base"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
SELECT pg_advisory_xact_lock($ADVISORY_LOCK_KEY);
\i $f
COMMIT;
SQL
done

echo
echo "done. applied migrations:"
psql "$DATABASE_URL" -c "SELECT version, applied_at FROM schema_migrations ORDER BY version"
