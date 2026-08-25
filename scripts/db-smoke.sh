#!/usr/bin/env bash
# scripts/db-smoke.sh
#
# Verifies SQL-dialect-specific behavior that vitest's fixture tests cannot check — they
# exercise the SQL-builder functions against a fake D1 stub, never a real SQLite engine.
# Two things checked here:
#   1. The Tier B hourly upsert's idempotency guard (migration 0002's last_tick_ts).
#   2. The bounded-delete pruning pattern (composite-key row-value IN, no DELETE LIMIT).
#
# Run against local D1 after touching either query builder or the schema they run
# against: bash scripts/db-smoke.sh
#
# Uses COUNT(*) before/after rather than relying on `wrangler d1 execute --json`'s
# meta.changes — empirically, the CLI's JSON output does not populate that field locally,
# even though the D1 Workers Binding API used by the actual application code does.
# Counting rows directly is portable and tests the real observable effect either way.

set -euo pipefail

DB=bazaar
TAG="SMOKE_TEST_$$"

run() {
  npx wrangler d1 execute "$DB" --local --command "$1" >/dev/null
}

query_json() {
  npx wrangler d1 execute "$DB" --local --json --command "$1"
}

cleanup() {
  run "DELETE FROM hourly WHERE tag = '$TAG'" || true
  run "DELETE FROM snapshots WHERE tag = '$TAG'" || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

echo "== Tier B hourly upsert idempotency (migration 0002's last_tick_ts guard) =="

UPSERT_SQL="INSERT INTO hourly (tag, hour_ts, ask_avg, ask_min, ask_max, bid_avg, bid_min, bid_max, ask_depth, bid_depth, ib_week, is_week, samples, source, last_tick_ts)
VALUES ('$TAG', 0, 10, 10, 10, 9, 9, 9, 100, 100, 0, 0, 1, 'hypixel', 1000)
ON CONFLICT(tag, hour_ts) DO UPDATE SET
  ask_avg = (hourly.ask_avg * hourly.samples + excluded.ask_avg) / (hourly.samples + 1),
  ask_min = min(hourly.ask_min, excluded.ask_min),
  ask_max = max(hourly.ask_max, excluded.ask_max),
  bid_avg = (hourly.bid_avg * hourly.samples + excluded.bid_avg) / (hourly.samples + 1),
  bid_min = min(hourly.bid_min, excluded.bid_min),
  bid_max = max(hourly.bid_max, excluded.bid_max),
  ask_depth = (hourly.ask_depth * hourly.samples + excluded.ask_depth) / (hourly.samples + 1),
  bid_depth = (hourly.bid_depth * hourly.samples + excluded.bid_depth) / (hourly.samples + 1),
  ib_week = excluded.ib_week,
  is_week = excluded.is_week,
  samples = hourly.samples + 1,
  last_tick_ts = excluded.last_tick_ts
WHERE hourly.last_tick_ts < excluded.last_tick_ts;"

run "$UPSERT_SQL"
# Retry at the SAME tick timestamp (1000) -- must be a no-op, not a second increment.
run "$UPSERT_SQL"

SAMPLES=$(query_json "SELECT samples FROM hourly WHERE tag = '$TAG' AND hour_ts = 0" | jq '.[0].results[0].samples')
[ "$SAMPLES" = "1" ] || fail "expected samples=1 after a retried tick at the same timestamp, got $SAMPLES"
echo "PASS: samples stayed at 1 after a retried tick"

# A DIFFERENT tick timestamp must still increment normally -- the guard should not be
# stuck permanently closed.
run "${UPSERT_SQL//1000/2000}"
SAMPLES=$(query_json "SELECT samples FROM hourly WHERE tag = '$TAG' AND hour_ts = 0" | jq '.[0].results[0].samples')
[ "$SAMPLES" = "2" ] || fail "expected samples=2 after a genuinely new tick, got $SAMPLES"
echo "PASS: a new tick timestamp still increments samples"

echo "== bounded delete pruning (composite-key row-value IN, batch size 5) =="

for i in $(seq 1 8); do
  run "INSERT INTO snapshots (tag, ts, ask, bid, ask_depth, bid_depth, ib_week, is_week) VALUES ('$TAG', $i, 1, 1, 1, 1, 1, 1)"
done

DELETE_SQL="DELETE FROM snapshots WHERE (tag, ts) IN (SELECT tag, ts FROM snapshots WHERE tag = '$TAG' AND ts < 100 LIMIT 5)"

BEFORE_FIRST=$(query_json "SELECT COUNT(*) as n FROM snapshots WHERE tag = '$TAG'" | jq '.[0].results[0].n')
run "$DELETE_SQL"
AFTER_FIRST=$(query_json "SELECT COUNT(*) as n FROM snapshots WHERE tag = '$TAG'" | jq '.[0].results[0].n')
FIRST_DELETED=$((BEFORE_FIRST - AFTER_FIRST))

run "$DELETE_SQL"
AFTER_SECOND=$(query_json "SELECT COUNT(*) as n FROM snapshots WHERE tag = '$TAG'" | jq '.[0].results[0].n')
SECOND_DELETED=$((AFTER_FIRST - AFTER_SECOND))

[ "$FIRST_DELETED" = "5" ] || fail "expected the first bounded delete to remove exactly 5 rows (batch size), got $FIRST_DELETED"
[ "$SECOND_DELETED" -lt "$FIRST_DELETED" ] || fail "expected the second delete to remove fewer rows than the first (got first=$FIRST_DELETED second=$SECOND_DELETED)"
[ "$AFTER_SECOND" = "0" ] || fail "expected all 8 rows gone after two bounded deletes, $AFTER_SECOND remain"
echo "PASS: bounded delete removed rows in capped batches (first=$FIRST_DELETED, second=$SECOND_DELETED), nothing left un-pruned"

echo ""
echo "All db-smoke checks passed."
