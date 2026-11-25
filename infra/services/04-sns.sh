#!/usr/bin/env bash
set -euo pipefail
# [4/9] SNS: roadhub-ops-alerts (operations alerts) + a subscriber queue that keeps every alert.
# Who publishes: the notification worker (a job failed 3 times) and the CloudWatch alarms (07).
# Who receives: the queue roadhub-ops-alerts-inbox (so an admin, or check-engagement.sh, can read
# the alerts later). Joseph's admin service adds its own HTTP subscription to the same topic.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"
cd "$PROJECT_ROOT"; mkdir -p "$OUT_DIR"

echo "=== [4/9] SNS: $OPS_TOPIC + subscriber queue $OPS_INBOX ==="
ok awsl sns create-topic --name "$OPS_TOPIC"
TOPIC_ARN="$(topic_arn "$OPS_TOPIC")"

ok awsl sqs create-queue --queue-name "$OPS_INBOX"
INBOX_URL=$(awsl sqs get-queue-url --queue-name "$OPS_INBOX" --query QueueUrl --output text)
# Only this topic may put messages into the inbox queue.
cat > "$OUT_DIR/ops-inbox-attributes.json" <<JSON
{
  "MessageRetentionPeriod": "1209600",
  "Policy": "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"OnlyTheOpsTopic\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"sns.amazonaws.com\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"$(queue_arn "$OPS_INBOX")\",\"Condition\":{\"ArnEquals\":{\"aws:SourceArn\":\"$TOPIC_ARN\"}}}]}"
}
JSON
awsl sqs set-queue-attributes --queue-url "$INBOX_URL" --attributes "file://$OUT_DIR/ops-inbox-attributes.json"

EXISTING=$(awsl sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" \
  --query "Subscriptions[?Endpoint=='$(queue_arn "$OPS_INBOX")'].SubscriptionArn | [0]" --output text 2>/dev/null || true)
if [ -z "$EXISTING" ] || [ "$EXISTING" = "None" ]; then
  awsl sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$(queue_arn "$OPS_INBOX")" >/dev/null
  echo "  subscribed $OPS_INBOX to $OPS_TOPIC"
else
  echo "  (subscription already exists, skipping)"
fi
echo "[4/9] done: $OPS_TOPIC -> $OPS_INBOX"
