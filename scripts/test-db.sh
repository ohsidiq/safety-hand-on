#!/usr/bin/env bash
# Membuat database uji dari nol, menerapkan migrasi, memuat seed kecil, menjalankan uji db/tests.
# Koneksi memakai variabel PG* standar. DATABASE_NAME (bawaan m0test) akan DIHAPUS dan dibuat ulang.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="${DATABASE_NAME:-m0test}"

PGDATABASE=postgres dropdb --if-exists "$name"
PGDATABASE=postgres createdb "$name"
export PGDATABASE="$name"

"$root/scripts/migrate.sh"
"$root/scripts/migrate.sh"   # kedua kali: harus tanpa migrasi baru (idempoten)
psql -X -q -v ON_ERROR_STOP=1 -v n_orgs=2 -v n_workers=50 -v n_sites=3 -f "$root/db/seed/synthetic_seed.sql" >/dev/null

for t in "$root"/db/tests/*.sql; do
  echo "== $(basename "$t")"
  psql -X -q -v ON_ERROR_STOP=1 -f "$t"
done
echo "semua uji database lulus"
