#!/usr/bin/env bash
set -euo pipefail
# [3/9] SQS: roadhub-notify-queue (jobs for the notification worker) and its dead-letter queue.
# Lab 8 left its queue without a consumer and said "a real system would add a worker and a DLQ":
# this is that real system. A job that fails 3 times moves to roadhub-notify-dlq (redrive policy).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"
cd "$PROJECT_ROOT"; mkdir -p "$OUT_DIR"

echo "=== [3/9] SQS: $NOTIFY_QUEUE + dead-letter queue $NOTIFY_DLQ ==="
ok awsl sqs create-queue --queue-name "$NOTIFY_DLQ"
ok awsl sqs create-queue --queue-name "$NOTIFY_QUEUE"
DLQ_URL=$(awsl sqs get-queue-url --queue-name "$NOTIFY_DLQ" --query QueueUrl --output text)
QUEUE_URL=$(awsl sqs get-queue-url --queue-name "$NOTIFY_QUEUE" --query QueueUrl --output text)

# Keep failed jobs 14 days, so there is time to look at them.
cat > "$OUT_DIR/dlq-attributes.json" <<JSON
{ "MessageRetentionPeriod": "1209600" }
JSON
# VisibilityTimeout 60 s: longer than the Lambda timeout (10 s), as AWS requires for a Lambda trigger.
# Policy: only the EventBridge rule roadhub-notify-rule may put messages into this queue.
cat > "$OUT_DIR/notify-queue-attributes.json" <<JSON
{
  "VisibilityTimeout": "60",
  "ReceiveMessageWaitTimeSeconds": "10",
  "MessageRetentionPeriod": "345600",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$(queue_arn "$NOTIFY_DLQ")\",\"maxReceiveCount\":\"3\"}",
  "Policy": "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"OnlyTheNotifyRule\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"events.amazonaws.com\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"$(queue_arn "$NOTIFY_QUEUE")\",\"Condition\":{\"ArnEquals\":{\"aws:SourceArn\":\"arn:aws:events:us-east-1:${ACCOUNT_ID}:rule/${BUS}/${NOTIFY_RULE}\"}}}]}"
}
JSON
awsl sqs set-queue-attributes --queue-url "$DLQ_URL" --attributes "file://$OUT_DIR/dlq-attributes.json"
awsl sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes "file://$OUT_DIR/notify-queue-attributes.json"
echo "  $NOTIFY_QUEUE -> after 3 failed tries -> $NOTIFY_DLQ"
echo "[3/9] done: $NOTIFY_QUEUE, $NOTIFY_DLQ"
