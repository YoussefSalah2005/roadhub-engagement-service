#!/usr/bin/env bash
set -euo pipefail
# [8/9] Lambda: the notification worker as a function (Lab 7) triggered by the SQS queue.
#   function roadhub-notify-worker  runtime nodejs24.x, handler workers/lambda.handler, role roadhub-notify-worker-role
#   trigger  roadhub-notify-queue -> function (batch of 5, "report only the failed messages")
# Needs 03-sqs.sh and 06-iam.sh first. Floci runs the function in a real Docker container
# (its docker-compose.yml mounts the Docker socket, as in Lab 7).
# Use EITHER this Lambda OR the process "npm run worker", not both at the same time.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"
cd "$PROJECT_ROOT"; mkdir -p "$OUT_DIR"

echo "=== [8/9] Lambda: $WORKER_FN (triggered by $NOTIFY_QUEUE) ==="
[ -d node_modules ] || { echo "  ERROR: run npm install first." >&2; exit 1; }
node scripts/zip-worker.js

# Settings of the function (no secrets here: the Resend key stays in Secrets Manager).
# The function runs inside Docker: "host.docker.internal" is Docker's name for YOUR PC, where the
# admin service listens on :3003 (it gives the worker the names and e-mail addresses).
read_env() { [ -f .env ] && sed -n "s/^$1=//p" .env | tr -d '\r' | tail -n 1 || true; }
EMAIL_REDIRECT_TO="$(read_env EMAIL_REDIRECT_TO)"
WEBSITE_URL="$(read_env WEBSITE_URL)"
cat > "$OUT_DIR/worker-env.json" <<JSON
{
  "Variables": {
    "NODE_ENV": "production",
    "SERVICE_NAME": "engagement-lambda",
    "ADMIN_URL": "${WORKER_ADMIN_URL:-http://host.docker.internal:3003}",
    "WEBSITE_URL": "${WEBSITE_URL:-http://localhost:8080}",
    "EMAIL_REDIRECT_TO": "${EMAIL_REDIRECT_TO}",
    "EVENTS": "off"
  }
}
JSON

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${WORKER_ROLE}"
if awsl lambda get-function --function-name "$WORKER_FN" >/dev/null 2>&1; then
  awsl lambda update-function-code --function-name "$WORKER_FN" --zip-file fileb://build/notify-worker.zip >/dev/null
  awsl lambda wait function-updated-v2 --function-name "$WORKER_FN" 2>/dev/null || sleep 5
  awsl lambda update-function-configuration --function-name "$WORKER_FN" --timeout 10 \
    --environment "file://$OUT_DIR/worker-env.json" >/dev/null
  awsl lambda wait function-updated-v2 --function-name "$WORKER_FN" 2>/dev/null || sleep 5
  echo "  function updated"
else
  awsl lambda create-function --function-name "$WORKER_FN" --runtime nodejs24.x \
    --handler workers/lambda.handler --role "$ROLE_ARN" --timeout 10 --memory-size 256 \
    --zip-file fileb://build/notify-worker.zip --environment "file://$OUT_DIR/worker-env.json" >/dev/null
  awsl lambda wait function-active-v2 --function-name "$WORKER_FN" 2>/dev/null || sleep 10
  echo "  function created"
fi

UUID=$(awsl lambda list-event-source-mappings --function-name "$WORKER_FN" \
  --event-source-arn "$(queue_arn "$NOTIFY_QUEUE")" --query 'EventSourceMappings[0].UUID' --output text 2>/dev/null || true)
if [ -z "$UUID" ] || [ "$UUID" = "None" ]; then
  awsl lambda create-event-source-mapping --function-name "$WORKER_FN" \
    --event-source-arn "$(queue_arn "$NOTIFY_QUEUE")" --batch-size 5 \
    --function-response-types ReportBatchItemFailures >/dev/null
  echo "  trigger created: $NOTIFY_QUEUE -> $WORKER_FN"
else
  echo "  (trigger already exists, skipping)"
fi
echo "[8/9] done: $WORKER_FN"
echo "  Test it with a saved event (Lab 7 style):"
echo "    awsl lambda invoke --function-name $WORKER_FN --payload file://events/1-status-changed.json --cli-binary-format raw-in-base64-out infra/.out/result.json && cat infra/.out/result.json"
