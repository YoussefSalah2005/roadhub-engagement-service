#!/usr/bin/env bash
set -euo pipefail
# [1/9] DynamoDB: the Engagement Service's 6 tables. Only this service reads or writes them;
# the other services ask over HTTP (/internal/engagement/...). Standalone-safe: skips existing tables.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"

echo "=== [1/9] DynamoDB: votes, comments, counts, merge links, notifications, processed messages ==="

# gsi <indexName> <hashAttr> [rangeAttr]  ->  one index, written as JSON for --global-secondary-indexes
gsi() {
  if [ -n "${3:-}" ]; then
    printf '{"IndexName":"%s","KeySchema":[{"AttributeName":"%s","KeyType":"HASH"},{"AttributeName":"%s","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}' "$1" "$2" "$3"
  else
    printf '{"IndexName":"%s","KeySchema":[{"AttributeName":"%s","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}' "$1" "$2"
  fi
}

# Key (featureId, userId): the same person can never have two vote rows on one request.
ok awsl dynamodb create-table --table-name roadhub-votes --billing-mode PAY_PER_REQUEST \
  --attribute-definitions AttributeName=featureId,AttributeType=S AttributeName=userId,AttributeType=S AttributeName=createdAt,AttributeType=S \
  --key-schema AttributeName=featureId,KeyType=HASH AttributeName=userId,KeyType=RANGE \
  --global-secondary-indexes "[$(gsi user-index userId createdAt)]"
ok awsl dynamodb create-table --table-name roadhub-comments --billing-mode PAY_PER_REQUEST \
  --attribute-definitions AttributeName=commentId,AttributeType=S AttributeName=featureId,AttributeType=S AttributeName=createdAt,AttributeType=S \
  --key-schema AttributeName=commentId,KeyType=HASH \
  --global-secondary-indexes "[$(gsi feature-index featureId createdAt)]"
ok awsl dynamodb create-table --table-name roadhub-engagement-counts --billing-mode PAY_PER_REQUEST \
  --attribute-definitions AttributeName=featureId,AttributeType=S \
  --key-schema AttributeName=featureId,KeyType=HASH
# Merge links: duplicate -> main request (a logical merge: nothing is copied, so undo is exact)
ok awsl dynamodb create-table --table-name roadhub-engagement-links --billing-mode PAY_PER_REQUEST \
  --attribute-definitions AttributeName=featureId,AttributeType=S AttributeName=canonicalId,AttributeType=S \
  --key-schema AttributeName=featureId,KeyType=HASH \
  --global-secondary-indexes "[$(gsi canonical-index canonicalId)]"
ok awsl dynamodb create-table --table-name roadhub-notifications --billing-mode PAY_PER_REQUEST \
  --attribute-definitions AttributeName=notificationId,AttributeType=S AttributeName=recipientId,AttributeType=S AttributeName=createdAt,AttributeType=S \
  --key-schema AttributeName=notificationId,KeyType=HASH \
  --global-secondary-indexes "[$(gsi recipient-index recipientId createdAt)]"
# SQS can deliver a message more than once: the ids of handled events are kept here for 7 days
ok awsl dynamodb create-table --table-name roadhub-processed-messages --billing-mode PAY_PER_REQUEST \
  --attribute-definitions AttributeName=messageId,AttributeType=S \
  --key-schema AttributeName=messageId,KeyType=HASH

for t in $TABLES; do awsl dynamodb wait table-exists --table-name "$t"; done

# Old processed-message ids delete themselves (TTL); votes and comments get point-in-time backups.
awsl dynamodb update-time-to-live --table-name roadhub-processed-messages \
  --time-to-live-specification Enabled=true,AttributeName=expiresAt >/dev/null 2>&1 \
  || echo "  (TTL already on or not supported)"
for t in roadhub-votes roadhub-comments; do
  awsl dynamodb update-continuous-backups --table-name "$t" \
    --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true >/dev/null 2>&1 \
    || echo "  WARNING: point-in-time recovery not supported for $t; continuing."
done
echo "[1/9] done: $TABLES"
