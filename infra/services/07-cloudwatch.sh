#!/usr/bin/env bash
set -euo pipefail
# [7/9] CloudWatch: the audit trail, a metric filter and two alarms that warn on SNS.
#   Log group /aws/ecs/roadhub-engagement, stream app-audit-stream:
#       AUDIT ... lines (every vote, comment, merge step, notification job)
#       SECURITY_ALERT ... lines (401, 403, rate limit, bad service token)
#   Metric filter: counts SECURITY_ALERT lines -> metric RoadmapHub/EngagementSecurityAlerts
#   Alarm 1: a job reached the dead-letter queue          -> SNS roadhub-ops-alerts
#   Alarm 2: 20 or more security alerts in 5 minutes       -> SNS roadhub-ops-alerts
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"
TOPIC_ARN="$(topic_arn "$OPS_TOPIC")"

echo "=== [7/9] CloudWatch: log group $APP_LOG_GROUP, metric filter, alarms ==="
ok awsl logs create-log-group --log-group-name "$APP_LOG_GROUP"
ok awsl logs create-log-stream --log-group-name "$APP_LOG_GROUP" --log-stream-name "$APP_LOG_STREAM"
awsl logs put-retention-policy --log-group-name "$APP_LOG_GROUP" --retention-in-days 30 >/dev/null 2>&1 \
  || echo "  WARNING: retention not supported; continuing."

awsl logs put-metric-filter --log-group-name "$APP_LOG_GROUP" \
  --filter-name roadhub-engagement-security-alerts --filter-pattern SECURITY_ALERT \
  --metric-transformations metricName=EngagementSecurityAlerts,metricNamespace=RoadmapHub,metricValue=1,defaultValue=0 \
  >/dev/null 2>&1 || echo "  WARNING: metric filter not supported here; continuing."

awsl cloudwatch put-metric-alarm --alarm-name roadhub-notify-dlq-not-empty \
  --alarm-description "A notification job failed 3 times and is waiting in roadhub-notify-dlq" \
  --namespace AWS/SQS --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions "Name=QueueName,Value=$NOTIFY_DLQ" \
  --statistic Maximum --period 60 --evaluation-periods 1 --threshold 0 \
  --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC_ARN" >/dev/null 2>&1 \
  || echo "  WARNING: alarm roadhub-notify-dlq-not-empty not supported here; continuing."

awsl cloudwatch put-metric-alarm --alarm-name roadhub-engagement-security-alerts-high \
  --alarm-description "20 or more SECURITY_ALERT lines in 5 minutes (attack or broken client)" \
  --namespace RoadmapHub --metric-name EngagementSecurityAlerts \
  --statistic Sum --period 300 --evaluation-periods 1 --threshold 20 \
  --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC_ARN" >/dev/null 2>&1 \
  || echo "  WARNING: alarm roadhub-engagement-security-alerts-high not supported here; continuing."
echo "[7/9] done: $APP_LOG_GROUP ($APP_LOG_STREAM), 1 metric filter, 2 alarms -> $OPS_TOPIC"
