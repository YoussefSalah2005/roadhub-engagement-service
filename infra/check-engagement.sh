#!/usr/bin/env bash
# Checks the Engagement Service on Floci: every AWS resource it owns AND that the app really uses them.
# Lab 8 check-lab8.sh style (every FAIL says how to fix it), with the 4 labels from our project brief:
#   PASS        resource configured and workflow verified
#   FAIL        resource or workflow broken
#   NOT TESTED  could not be verified now (for example the service is not running)
#   SIMULATED   only recorded in Floci; a local substitute does the real work
# Run it with the service started (npm start) and a worker running (Lambda from 08-lambda.sh, or npm run worker):
#   bash infra/check-engagement.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/services/_lib.sh"
cd "$PROJECT_ROOT"; mkdir -p "$OUT_DIR"
APP="${APP:-http://localhost:3002}"
PASS=0; FAIL=0; NT=0; SIM=0
pass() { echo "  PASS        $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL        $1"; echo "              fix: $2"; FAIL=$((FAIL+1)); }
nt()   { echo "  NOT TESTED  $1"; echo "              how: $2"; NT=$((NT+1)); }
sim()  { echo "  SIMULATED   $1"; SIM=$((SIM+1)); }
q() { awsl "$@" 2>/dev/null; }

echo "== Floci and the AWS resources of the Engagement Service =="
if curl -s -o /dev/null --max-time 5 "$ENDPOINT/_floci/health" || awsl sts get-caller-identity >/dev/null 2>&1; then pass "Floci answers on :4566"
else fail "Floci answers on :4566" "bash infra/run-floci.sh"; echo; echo "Result: $PASS PASS, $FAIL FAIL"; exit 1; fi

TABLE_LIST=$(q dynamodb list-tables --query 'TableNames' --output text)
for t in $TABLES; do
  echo "$TABLE_LIST" | grep -qw "$t" && pass "DynamoDB table $t" || fail "DynamoDB table $t" "bash infra/services/01-dynamodb.sh"
done
[ "$(q dynamodb describe-time-to-live --table-name roadhub-processed-messages --query 'TimeToLiveDescription.TimeToLiveStatus' --output text)" = "ENABLED" ] \
  && pass "TTL on roadhub-processed-messages (old message ids expire)" || fail "TTL on roadhub-processed-messages" "bash infra/services/01-dynamodb.sh"

if q secretsmanager describe-secret --secret-id roadhub/resend >/dev/null; then
  # Only compared here, never printed.
  if q secretsmanager get-secret-value --secret-id roadhub/resend --query SecretString --output text | grep -q '"RESEND_API_KEY": *"not-set"'; then
    nt "Secret roadhub/resend holds a real Resend key (now: not-set, e-mails are recorded as skipped)" "put RESEND_API_KEY in infra/.env, then bash infra/services/02-secrets-manager.sh"
  else
    pass "Secret roadhub/resend (key stored, never printed)"
  fi
else fail "Secret roadhub/resend" "bash infra/services/02-secrets-manager.sh"; fi
for s in roadhub/jwt-public roadhub/internal; do
  q secretsmanager describe-secret --secret-id "$s" >/dev/null && pass "Secret $s (made by the admin-service repo)" \
    || fail "Secret $s" "in roadhub-admin-service: bash infra/scripts/create-secrets.sh"
done

QUEUE_URL=$(q sqs get-queue-url --queue-name "$NOTIFY_QUEUE" --query QueueUrl --output text)
if [ -n "$QUEUE_URL" ] && [ "$QUEUE_URL" != "None" ]; then
  REDRIVE=$(q sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names RedrivePolicy --query Attributes.RedrivePolicy --output text)
  if echo "$REDRIVE" | grep -q "$NOTIFY_DLQ" && echo "$REDRIVE" | grep -Eq '"maxReceiveCount": *"?3'; then
    pass "SQS $NOTIFY_QUEUE -> after 3 failed tries -> $NOTIFY_DLQ"
  else fail "SQS redrive policy (3 tries -> $NOTIFY_DLQ)" "bash infra/services/03-sqs.sh"; fi
else fail "SQS queue $NOTIFY_QUEUE" "bash infra/services/03-sqs.sh"; fi

TOPIC_ARN="$(topic_arn "$OPS_TOPIC")"
q sns get-topic-attributes --topic-arn "$TOPIC_ARN" >/dev/null && pass "SNS topic $OPS_TOPIC" || fail "SNS topic $OPS_TOPIC" "bash infra/services/04-sns.sh"
q sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --output text | grep -q "$OPS_INBOX" \
  && pass "SNS $OPS_TOPIC delivers to queue $OPS_INBOX" || fail "SNS subscription $OPS_INBOX" "bash infra/services/04-sns.sh"

q events list-targets-by-rule --rule "$NOTIFY_RULE" --event-bus-name "$BUS" --output text | grep -q "$NOTIFY_QUEUE" \
  && pass "EventBridge $NOTIFY_RULE -> $NOTIFY_QUEUE" || fail "EventBridge $NOTIFY_RULE -> $NOTIFY_QUEUE" "bash infra/services/05-eventbridge.sh"
q events list-targets-by-rule --rule "$AUDIT_RULE" --event-bus-name "$BUS" --output text | grep -q "$EVENTS_LOG_GROUP" \
  && pass "EventBridge $AUDIT_RULE -> CloudWatch Logs" || fail "EventBridge $AUDIT_RULE" "bash infra/services/05-eventbridge.sh"

for pair in "$SERVICE_ROLE:roadhub-engagement-service-policy" "$WORKER_ROLE:roadhub-notify-worker-policy"; do
  role="${pair%%:*}"; policy="${pair##*:}"
  DOC=$(q iam get-role-policy --role-name "$role" --policy-name "$policy" --output json)
  if [ -n "$DOC" ] && ! echo "$DOC" | grep -Eq '"(Resource|Action)": *"\*"'; then pass "IAM $role: least privilege (no \"*\")"
  else fail "IAM $role with its own policy (no \"*\")" "bash infra/services/06-iam.sh"; fi
done

q logs describe-log-streams --log-group-name "$APP_LOG_GROUP" --output text | grep -q "$APP_LOG_STREAM" \
  && pass "CloudWatch log group $APP_LOG_GROUP ($APP_LOG_STREAM)" || fail "CloudWatch log group $APP_LOG_GROUP" "bash infra/services/07-cloudwatch.sh"
q logs describe-metric-filters --log-group-name "$APP_LOG_GROUP" --output text | grep -q roadhub-engagement-security-alerts \
  && pass "CloudWatch metric filter counts SECURITY_ALERT lines" || nt "CloudWatch metric filter" "bash infra/services/07-cloudwatch.sh (may not be supported by your Floci)"
ALARMS=$(q cloudwatch describe-alarms --alarm-names roadhub-notify-dlq-not-empty roadhub-engagement-security-alerts-high --query 'MetricAlarms[].AlarmName' --output text)
[ "$(echo "$ALARMS" | wc -w)" -ge 2 ] && pass "CloudWatch alarms (DLQ not empty, security alerts high) -> $OPS_TOPIC" \
  || nt "CloudWatch alarms" "bash infra/services/07-cloudwatch.sh (may not be supported by your Floci)"

STATE=$(q lambda get-function --function-name "$WORKER_FN" --query Configuration.State --output text)
if [ "$STATE" = "Active" ]; then
  pass "Lambda $WORKER_FN is Active"
  ESM=$(q lambda list-event-source-mappings --function-name "$WORKER_FN" --query 'EventSourceMappings[0].State' --output text)
  [ "$ESM" = "Enabled" ] && pass "Lambda trigger $NOTIFY_QUEUE -> $WORKER_FN is Enabled" \
    || fail "Lambda trigger from $NOTIFY_QUEUE (state: ${ESM:-none})" "bash infra/services/08-lambda.sh"
else
  nt "Lambda $WORKER_FN (state: ${STATE:-not created})" "bash infra/services/08-lambda.sh, or use the process worker: npm run worker"
fi

if [ "$(q ecs describe-clusters --clusters roadhub-cluster --query 'clusters[0].status' --output text)" = "ACTIVE" ] \
   && q elbv2 describe-target-groups --names roadhub-engagement-tg >/dev/null; then
  DESIRED=$(q ecs describe-services --cluster roadhub-cluster --services roadhub-engagement-service --query 'services[0].desiredCount' --output text)
  sim "ELB target group roadhub-engagement-tg + ECS service (desired ${DESIRED:-?}) + Auto Scaling 1-4: recorded; real traffic = local Node.js processes"
else
  nt "ELB/ECS/Auto Scaling records" "bash infra/services/09-ecs.sh"
fi

echo "== The service on ${APP} =="
HEALTH=$(curl -s --max-time 3 "$APP/health" || true)
if ! echo "$HEALTH" | grep -q '"service":"engagement"'; then
  nt "the service answers /health (service tests below skipped)" "npm start   (in a second window)"
else
  pass "the service answers /health ($(echo "$HEALTH" | grep -o '"instanceId":"[^"]*"'))"
  HEADERS=$(curl -sI "$APP/health" | tr -d '\r')
  for h in X-Content-Type-Options X-Frame-Options Content-Security-Policy X-Instance-Id; do
    echo "$HEADERS" | grep -qi "^$h:" && pass "header $h" || fail "header $h" "check app.js (securityHeaders and X-Instance-Id)"
  done
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$APP/api/features/11111111-1111-4111-8111-111111111111/votes" -H 'Content-Type: application/json' -d '{}')
  [ "$CODE" = "401" ] && pass "vote without login -> 401" || fail "vote without login -> 401 (got $CODE)" "check middleware/auth.js"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$APP/internal/engagement/_ping")
  [ "$CODE" = "401" ] && pass "internal route without a service token -> 401" || fail "internal route without a service token -> 401 (got $CODE)" "check routes/internal.js"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$APP/internal/engagement/_ping" -H 'X-Service-Token: forged.token.value')
  [ "$CODE" = "401" ] && pass "internal route with a forged service token -> 401" || fail "forged service token -> 401 (got $CODE)" "check shared/internal-auth.js"
  sleep 3   # the audit lines are sent in the background every second
  AUDIT=$(q logs get-log-events --log-group-name "$APP_LOG_GROUP" --log-stream-name "$APP_LOG_STREAM" --limit 100 --query 'events[].message' --output text)
  echo "$AUDIT" | grep -q 'SECURITY_ALERT' && pass "CloudWatch audit trail has SECURITY_ALERT lines (from the 401s above)" \
    || fail "CloudWatch audit trail has SECURITY_ALERT lines" "bash infra/services/07-cloudwatch.sh, then restart the service"
  echo "$AUDIT" | grep -q '@' && fail "no e-mail address in the audit trail" "find the audit() call that adds an e-mail and remove it" \
    || pass "no e-mail address in the audit trail"
fi

echo "== Background jobs: EventBridge -> SQS -> worker -> DynamoDB =="
# A test event with no voters and no author: it goes the whole way, but nobody gets an e-mail.
EVENT_ID="check-$(date +%s)-$RANDOM"
cat > "$OUT_DIR/check-event.json" <<JSON
[{"Source":"roadhub.roadmap","DetailType":"FeatureStatusChanged","EventBusName":"$BUS",
  "Detail":"{\"eventId\":\"$EVENT_ID\",\"featureId\":\"00000000-0000-4000-8000-000000000000\",\"title\":\"check-engagement.sh\",\"oldStatus\":\"under_review\",\"newStatus\":\"planned\"}"}]
JSON
if [ "$(q events put-events --entries "file://$OUT_DIR/check-event.json" --query FailedEntryCount --output text)" != "0" ]; then
  fail "EventBridge accepts a FeatureStatusChanged event" "bash infra/services/05-eventbridge.sh"
else
  BY=""
  for i in $(seq 1 20); do
    BY=$(q dynamodb get-item --table-name roadhub-processed-messages --key "{\"messageId\":{\"S\":\"$EVENT_ID\"}}" --query 'Item.processedBy.S' --output text)
    [ -n "$BY" ] && [ "$BY" != "None" ] && break
    BY=""; sleep 2
  done
  if [ -n "$BY" ]; then
    pass "event -> $NOTIFY_RULE -> $NOTIFY_QUEUE -> worker ($BY) -> roadhub-processed-messages"
  else
    WAITING=$(q sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)
    if [ "${WAITING:-0}" != "0" ]; then
      nt "a worker takes the job ($WAITING message(s) waiting in $NOTIFY_QUEUE)" "start a worker: bash infra/services/08-lambda.sh (Lambda) or npm run worker (process)"
    else
      fail "the event reached the queue and was processed" "check rule $NOTIFY_RULE (05) and the worker logs"
    fi
  fi
fi
DLQ_URL=$(q sqs get-queue-url --queue-name "$NOTIFY_DLQ" --query QueueUrl --output text)
DEAD=$(q sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)
echo "  INFO        jobs waiting in $NOTIFY_DLQ: ${DEAD:-?} (0 is good; more = failed jobs to look at)"

echo
echo "Result: $PASS PASS, $FAIL FAIL, $NT NOT TESTED, $SIM SIMULATED"
[ "$FAIL" -eq 0 ]
