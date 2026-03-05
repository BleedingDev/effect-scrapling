#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: scripts/beads-stabilize.sh [--purge-foreign] [--yes]

Stabilizes bd/br parity using a single direction:
  bd (dolt) -> .beads/issues.jsonl -> br (sqlite)

Options:
  --purge-foreign  Delete non-bd issue IDs from bd before syncing.
  --yes            Required with --purge-foreign to confirm deletion.
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 127
  fi
}

require_cmd bd
require_cmd br
require_cmd jq

PURGE_FOREIGN=0
CONFIRM_DELETE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge-foreign)
      PURGE_FOREIGN=1
      shift
      ;;
    --yes)
      CONFIRM_DELETE=1
      shift
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done
if [[ "$CONFIRM_DELETE" -eq 1 && "$PURGE_FOREIGN" -ne 1 ]]; then
  usage >&2
  exit 2
fi

TMP_EXPORT="$(mktemp)"
TMP_FOREIGN="$(mktemp)"
cleanup() {
  rm -f "$TMP_EXPORT" "$TMP_FOREIGN"
}
trap cleanup EXIT

refresh_bd_import_timestamp() {
  local raw_ts formatted_ts
  raw_ts="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  formatted_ts="${raw_ts:0:22}:${raw_ts:22:2}"
  bd --allow-stale --json sql "UPDATE metadata SET value='${formatted_ts}' WHERE \`key\`='last_import_time'" >/dev/null
}

JSONL_REL="$(jq -r '.jsonl_export // "issues.jsonl"' .beads/metadata.json 2>/dev/null || echo "issues.jsonl")"
if [[ "$JSONL_REL" = /* ]]; then
  JSONL_PATH="$JSONL_REL"
elif [[ "$JSONL_REL" == .beads/* ]]; then
  JSONL_PATH="$JSONL_REL"
else
  JSONL_PATH=".beads/$JSONL_REL"
fi

echo "Exporting canonical issues from bd to $JSONL_PATH..."
bd --allow-stale --json export -o "$JSONL_PATH" >/dev/null
refresh_bd_import_timestamp
cp "$JSONL_PATH" "$TMP_EXPORT"

jq -r 'select(.id | test("^bd-") | not) | .id' "$TMP_EXPORT" > "$TMP_FOREIGN"
FOREIGN_COUNT="$(wc -l < "$TMP_FOREIGN" | tr -d ' ')"

if [[ "$FOREIGN_COUNT" -gt 0 ]]; then
  echo "Found $FOREIGN_COUNT foreign issue IDs (non-bd prefix)." >&2
  cp "$TMP_FOREIGN" .beads/foreign-ids.pending.txt
  echo "Saved foreign ID list to .beads/foreign-ids.pending.txt" >&2
  if [[ "$PURGE_FOREIGN" -ne 1 ]]; then
    echo "Re-run with --purge-foreign to clean them, then sync." >&2
    exit 3
  fi
  if [[ "$CONFIRM_DELETE" -ne 1 ]]; then
    echo "Refusing destructive delete without --yes." >&2
    echo "Re-run with: scripts/beads-stabilize.sh --purge-foreign --yes" >&2
    exit 3
  fi
  echo "Purging foreign issue IDs from bd..."
  bd --allow-stale --json delete --from-file "$TMP_FOREIGN" --force >/dev/null
  bd --allow-stale --json export -o "$JSONL_PATH" >/dev/null
  refresh_bd_import_timestamp
fi

sync_br() {
  br sync --import-only --rebuild > /dev/null
}

echo "Rebuilding br sqlite mirror from JSONL..."
rm -f .beads/beads.db .beads/beads.db-wal .beads/beads.db-shm
sync_br

BD_COUNT="$(bd --allow-stale --json count | jq -r '.count')"
BR_COUNT="$(br --json count | jq -r '.count')"
if [[ "$BD_COUNT" != "$BR_COUNT" ]]; then
  echo "Count mismatch after sync: bd=$BD_COUNT br=$BR_COUNT" >&2
  exit 5
fi

br doctor > /dev/null
br dep cycles > /dev/null

echo "Stable sync complete (bd=$BD_COUNT, br=$BR_COUNT)."
