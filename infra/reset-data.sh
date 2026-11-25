#!/usr/bin/env bash
set -euo pipefail
# Empties the 6 Engagement tables (delete + create again), so every k6 run starts from the same
# data (Lab 8 reset-data.sh). THIS DELETES EVERY VOTE, COMMENT AND NOTIFICATION on your Floci.
#   bash infra/reset-data.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/services/_lib.sh"

read -r -p "Delete ALL engagement data on Floci (votes, comments, notifications)? Type yes: " answer
[ "$answer" = "yes" ] || { echo "Nothing deleted."; exit 0; }
for t in $TABLES; do
  awsl dynamodb delete-table --table-name "$t" >/dev/null 2>&1 && echo "  deleted $t" || echo "  $t did not exist"
done
for t in $TABLES; do awsl dynamodb wait table-not-exists --table-name "$t" 2>/dev/null || true; done
bash "${SCRIPT_DIR}/services/01-dynamodb.sh"
echo "[reset-data] the 6 tables are empty again."
