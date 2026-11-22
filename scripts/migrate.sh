#!/usr/bin/env bash
# Menjalankan db/migrations/*.sql berurutan, sekali saja per berkas.
# Koneksi memakai variabel standar PostgreSQL (PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD)
# atau DATABASE_URL. Aman dijalankan berulang.
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../db/migrations" && pwd)"
psql_cmd=(psql -X -q -v ON_ERROR_STOP=1)
[[ -n "${DATABASE_URL:-}" ]] && psql_cmd+=("$DATABASE_URL")

"${psql_cmd[@]}" -c "create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now())"

applied=0
for f in "$dir"/*.sql; do
  v="$(basename "$f")"
  done_already="$("${psql_cmd[@]}" -Atc "select 1 from schema_migrations where version = '$v'")"
  if [[ -z "$done_already" ]]; then
    echo "menerapkan $v"
    "${psql_cmd[@]}" -1 -f "$f"
    "${psql_cmd[@]}" -c "insert into schema_migrations(version) values ('$v')"
    applied=$((applied + 1))
  fi
done
echo "selesai: $applied migrasi baru"
