#!/usr/bin/env bash
set -euo pipefail
# [2/9] Secrets Manager: roadhub/resend (the Resend API key the notification worker uses).
# The key is read from infra/.env (git-ignored) by Node.js and stored in Secrets Manager.
# It is never typed into the code, never printed, and never committed.
# roadhub/jwt-public, roadhub/internal and roadhub/turnstile are made by the admin-service repo.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"

echo "=== [2/9] Secrets Manager: roadhub/resend ==="
if [ -f "$PROJECT_ROOT/infra/.env" ]; then
  set -a; . <(sed 's/\r$//' "$PROJECT_ROOT/infra/.env"); set +a
else
  echo "  infra/.env not found: storing 'not-set' (e-mails will be recorded as skipped)."
  echo "  To add your key: cp infra/.env.example infra/.env, put the key in it, run this script again."
fi
cd "$PROJECT_ROOT" && node infra/scripts/create-secrets.js
echo "[2/9] done: roadhub/resend"
