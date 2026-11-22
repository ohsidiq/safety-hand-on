#!/usr/bin/env bash
# Spike S-3: outbox transaksional dan worker harus tahan dimatikan paksa (NFR-REL-003: 0 kehilangan).
# Memerlukan: database sudah dimigrasi, PG* diset, serta dua perintah dari lingkungan pemanggil:
#   CRASH_CMD  mematikan SEMUA proses PostgreSQL dengan SIGKILL
#   START_CMD  menjalankan ulang server (memicu crash recovery) dan menunggu siap
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${CRASH_CMD:?}"; : "${START_CMD:?}"
total="${TOTAL:-50000}"
q() { psql -X -Atq -c "$1"; }

psql -X -q -v ON_ERROR_STOP=1 -f "$here/setup.sql"

echo "[1] Fase 1: produsen dan konsumen berjalan, lalu SIGKILL pada saat sibuk"
pgbench -n -c 4 -j 2 -t $((total / 4)) -f "$here/producer.pgb" "$PGDATABASE" >/dev/null 2>&1 &
pp=$!
pgbench -n -c 2 -j 1 -T 30 -f "$here/consumer.pgb" "$PGDATABASE" >/dev/null 2>&1 &
cp=$!
sleep 1.5
echo "    sebelum crash: bisnis=$(q 'select count(*) from s3_business') outbox=$(q 'select count(*) from outbox_event') efek=$(q 'select count(*) from s3_effect')"
eval "$CRASH_CMD"
wait $pp 2>/dev/null || true; wait $cp 2>/dev/null || true
eval "$START_CMD"
b1=$(q 'select count(*) from s3_business'); o1=$(q 'select count(*) from outbox_event')
echo "    setelah pemulihan: bisnis=$b1 outbox=$o1 efek=$(q 'select count(*) from s3_effect')"
[[ "$b1" == "$o1" ]] || { echo "GAGAL: baris bisnis dan event outbox tidak sama (atomisitas)"; exit 1; }

echo "[2] Fase 2: sisa produsen jalan, lalu konsumen saja, crash kedua saat menguras antrean"
left=$((total - b1)); (( left < 0 )) && left=0
if (( left > 0 )); then
  pgbench -n -c 4 -j 2 -t $((left / 4 + 1)) -f "$here/producer.pgb" "$PGDATABASE" >/dev/null 2>&1 || true
fi
pgbench -n -c 2 -j 1 -T 30 -f "$here/consumer.pgb" "$PGDATABASE" >/dev/null 2>&1 &
cp=$!
sleep 0.4
echo "    saat crash kedua: antrean tertunda=$(q 'select count(*) from outbox_event where processed_at is null')"
eval "$CRASH_CMD"
wait $cp 2>/dev/null || true
eval "$START_CMD"

echo "[3] Fase 3: kuras sampai habis"
for i in $(seq 1 200); do
  pend=$(q 'select count(*) from outbox_event where processed_at is null')
  (( pend == 0 )) && break
  pgbench -n -c 2 -j 1 -t 200 -f "$here/consumer.pgb" "$PGDATABASE" >/dev/null 2>&1 || true
done

bus=$(q 'select count(*) from s3_business')
out=$(q 'select count(*) from outbox_event')
proc=$(q 'select count(*) from outbox_event where processed_at is not null')
eff=$(q 'select count(*) from s3_effect')
lost=$(q 'select count(*) from s3_business b where not exists (select 1 from outbox_event o where (o.payload->>$$business_id$$)::bigint = b.id)')
noeff=$(q 'select count(*) from outbox_event o where not exists (select 1 from s3_effect e where e.event_id = o.id)')
echo "    bisnis=$bus outbox=$out diproses=$proc efek=$eff | bisnis tanpa event=$lost event tanpa efek=$noeff"
if [[ "$bus" == "$out" && "$out" == "$proc" && "$proc" == "$eff" && "$lost" == 0 && "$noeff" == 0 && "$bus" -ge "$total" ]]; then
  echo "LULUS: 0 kehilangan, 0 duplikat efek ($bus event, 2 crash SIGKILL)"
else
  echo "GAGAL"; exit 1
fi
