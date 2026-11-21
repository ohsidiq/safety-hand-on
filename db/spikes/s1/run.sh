#!/usr/bin/env bash
# Menjalankan skenario pgbench terhadap database yang sudah berisi seed besar.
# Hasil: p50/p95/p99 per skenario dalam milidetik. Memakai peran app_runtime (RLS berlaku).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
clients="${CLIENTS:-4}"; secs="${SECS:-15}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
run() {
  local label="$1" script="$2"
  rm -f "$tmp"/log*
  PGUSER=app_runtime pgbench -n -c "$clients" -j 2 -T "$secs" -l --log-prefix="$tmp/log" -f "$here/$script" "$PGDATABASE" >"$tmp/out" 2>&1 || { cat "$tmp/out"; return 1; }
  cat "$tmp"/log* | awk '{print $3}' | sort -n | awk -v L="$label" '
    {a[NR]=$1} END {
      printf "%-34s n=%-6d p50=%7.1f ms  p95=%7.1f ms  p99=%7.1f ms  max=%7.1f ms\n", L, NR, a[int(NR*0.50)]/1000, a[int(NR*0.95)]/1000, a[int(NR*0.99)]/1000, a[NR]/1000}'
}
run "A Supervisor daftar (1 Site)" A_spv_list.pgb
run "B HSE Mgr daftar (10.000)" B_mgr_list.pgb
run "C Detail pekerja + kompetensi" C_detail.pgb
run "D Dashboard WRR (10.000)" D_dashboard.pgb
run "E 21 tenant campuran" E_multitenant.pgb
