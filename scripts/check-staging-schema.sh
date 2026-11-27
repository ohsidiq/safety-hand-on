#!/usr/bin/env bash
# Memeriksa apakah database staging sudah menerima migrasi yang dibutuhkan kode ter-deploy.
# Sumber: /api/v1/health/ready (data.schema: state, expected, applied). Tanpa rahasia.
#   MODE=wait  : tunggu deploy terbaru (expected >= migrasi terbaru repo) lalu tunggu IN_SYNC, maksimum WAIT_MINUTES.
#   MODE=once  : satu kali periksa (jadwal berkala).
# Keluar 1 bila database tertinggal (BEHIND) atau API tidak dapat dijangkau.
set -euo pipefail

HEALTH_URL="${HEALTH_URL:-https://soh-api.vercel.app/api/v1/health/ready}"
MODE="${MODE:-once}"
WAIT_MINUTES="${WAIT_MINUTES:-20}"
cd "$(dirname "$0")/.."
repo_latest="$(ls db/migrations | grep -E '^[0-9]{4}_.+\.sql$' | sort | tail -1 | cut -c1-4)"
repo_file="$(ls db/migrations | grep -E "^${repo_latest}_" | head -1)"

probe() {
  local body
  body="$(curl -fsS --max-time 20 "$HEALTH_URL" 2>/dev/null || true)"
  [[ -n "$body" ]] || body='{}'
  state="$(jq -r '.data.schema.state // "MISSING"' <<<"$body" 2>/dev/null)" || state="MISSING"
  expected="$(jq -r '.data.schema.expected // ""' <<<"$body" 2>/dev/null)" || expected=""
  applied="$(jq -r '.data.schema.applied // ""' <<<"$body" 2>/dev/null)" || applied=""
}

report() {
  echo "repo: ${repo_latest} | kode ter-deploy butuh: ${expected:-?} | database: ${applied:-?} | status: ${state}"
}

deadline=$(( $(date +%s) + WAIT_MINUTES * 60 ))
while true; do
  probe
  report
  if [[ "$MODE" == "once" ]]; then break; fi
  # deploy sudah memuat kode terbaru dan database sudah sesuai
  if [[ -n "$expected" && ! "$expected" < "$repo_latest" && ( "$state" == "IN_SYNC" || "$state" == "AHEAD" ) ]]; then break; fi
  if (( $(date +%s) >= deadline )); then break; fi
  sleep 30
done

case "$state" in
  IN_SYNC|AHEAD)
    if [[ -n "$expected" && "$expected" < "$repo_latest" ]]; then
      echo "::warning title=Deploy tertinggal::Core API ter-deploy masih membutuhkan ${expected}, repo sudah ${repo_latest}. Periksa deploy Vercel soh-api."
    fi
    echo "Database staging sesuai dengan kode ter-deploy."
    ;;
  BEHIND)
    need_file="$(ls db/migrations | grep -E "^${expected}_" | head -1 || true)"
    echo "::error title=Database staging tertinggal::Kode ter-deploy membutuhkan migrasi ${expected}, database baru ${applied}. Terapkan db/migrations/${need_file:-$repo_file} (dan yang belum diterapkan sebelumnya) ke Supabase staging, lalu jalankan uji db/tests/staging/."
    exit 1
    ;;
  *)
    echo "::error title=Status skema tidak terbaca::/health/ready tidak melaporkan data.schema (state=${state}). API mati atau belum memuat pemeriksaan ini."
    exit 1
    ;;
esac
