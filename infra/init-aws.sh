#!/usr/bin/env bash
set -uo pipefail
# Builds (or repairs) every AWS resource of the Engagement Service on Floci, in order (01..09).
# Same idea as Lab 8's init-aws.sh. Every script is safe to run again, and each one also runs alone:
#   bash infra/services/05-eventbridge.sh
# Needs Floci running (bash infra/run-floci.sh starts it) and "npm install" done (Lambda zip).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICES_DIR="${SCRIPT_DIR}/services"
source "${SERVICES_DIR}/_lib.sh"

FAILED=()
for script in "${SERVICES_DIR}"/[0-9][0-9]-*.sh; do
  echo ""
  bash "$script" || FAILED+=("$(basename "$script")")
done

echo ""
echo "=================================================================="
echo " roadhub-engagement-service: AWS resources on Floci"
echo "=================================================================="
printf "%-18s %s\n" "DynamoDB:"        "6 tables (roadhub-votes, -comments, -engagement-counts, -engagement-links, -notifications, -processed-messages)"
printf "%-18s %s\n" "Secrets Manager:" "roadhub/resend"
printf "%-18s %s\n" "SQS:"             "$NOTIFY_QUEUE -> (3 tries) -> $NOTIFY_DLQ"
printf "%-18s %s\n" "SNS:"             "$OPS_TOPIC -> $OPS_INBOX"
printf "%-18s %s\n" "EventBridge:"     "bus $BUS: $NOTIFY_RULE -> $NOTIFY_QUEUE, $AUDIT_RULE -> $EVENTS_LOG_GROUP"
printf "%-18s %s\n" "IAM:"             "$SERVICE_ROLE, $WORKER_ROLE (least privilege)"
printf "%-18s %s\n" "CloudWatch:"      "$APP_LOG_GROUP ($APP_LOG_STREAM), metric filter, 2 alarms -> $OPS_TOPIC"
printf "%-18s %s\n" "Lambda:"          "$WORKER_FN (trigger: $NOTIFY_QUEUE)"
printf "%-18s %s\n" "ELB/ECS/Scaling:" "roadhub-engagement-tg, roadhub-engagement-service, 1-4 tasks (recorded only)"
echo "=================================================================="
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "Scripts that failed: ${FAILED[*]}   -> run them alone to see the error"
  exit 1
fi
echo "Next: npm start   then   bash infra/check-engagement.sh"
