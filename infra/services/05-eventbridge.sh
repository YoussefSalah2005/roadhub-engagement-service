#!/usr/bin/env bash
set -euo pipefail
# [5/9] EventBridge: the bus roadhub-events (shared by the 3 services; made here if missing) and
# this service's two rules:
#   roadhub-notify-rule            FeatureStatusChanged (from roadmap) + FeatureMerged (from admin)
#                                  -> SQS roadhub-notify-queue  -> notification e-mails
#   roadhub-engagement-audit-rule  every event this service publishes (VoteAdded, CommentAdded ...)
#                                  -> CloudWatch Logs /aws/events/roadhub-engagement-audit (Lab 8 audit rule)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"

echo "=== [5/9] EventBridge: bus $BUS, rules $NOTIFY_RULE and $AUDIT_RULE ==="
ok awsl events create-event-bus --name "$BUS"

ok awsl events put-rule --name "$NOTIFY_RULE" --event-bus-name "$BUS" \
  --description "Status changes and merges -> notification e-mails (engagement worker)" \
  --event-pattern '{"source":["roadhub.roadmap","roadhub.admin"],"detail-type":["FeatureStatusChanged","FeatureMerged"]}'
awsl events put-targets --event-bus-name "$BUS" --rule "$NOTIFY_RULE" \
  --targets "Id=notify-queue,Arn=$(queue_arn "$NOTIFY_QUEUE")" >/dev/null

ok awsl logs create-log-group --log-group-name "$EVENTS_LOG_GROUP"
ok awsl events put-rule --name "$AUDIT_RULE" --event-bus-name "$BUS" \
  --description "Every engagement event -> CloudWatch Logs (audit trail)" \
  --event-pattern '{"source":["roadhub.engagement"]}'
awsl events put-targets --event-bus-name "$BUS" --rule "$AUDIT_RULE" \
  --targets "Id=engagement-audit-log,Arn=arn:aws:logs:us-east-1:${ACCOUNT_ID}:log-group:${EVENTS_LOG_GROUP}" >/dev/null
echo "[5/9] done: $BUS, $NOTIFY_RULE -> $NOTIFY_QUEUE, $AUDIT_RULE -> $EVENTS_LOG_GROUP"
