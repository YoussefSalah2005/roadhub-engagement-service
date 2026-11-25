# Shared helpers + settings for infra/services/*.sh (same idea as Lab 8's _lib.sh).
# Every service script sources this, which keeps each one runnable on its own:
#   bash infra/services/03-sqs.sh
# In a new Git Bash window you can also type:  source infra/services/_lib.sh   (then use awsl ...)

export AWS_ACCESS_KEY_ID=test          # Floci accepts any keys: these are not secrets
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export AWS_REGION=us-east-1
export AWS_PAGER=""
export ENDPOINT="${ENDPOINT:-http://localhost:4566}"
export AWS_ENDPOINT_URL="$ENDPOINT"    # used by the Node.js scripts (AWS SDK)
export ACCOUNT_ID="000000000000"       # Floci's account id

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PROJECT_ROOT="$(cd "${LIB_DIR}/../.." && pwd)"
export ROOT_DIR="$PROJECT_ROOT"

# ---- Names of every resource this service owns (one place, used by all scripts) ----
export PREFIX="roadhub"
export TABLES="roadhub-votes roadhub-comments roadhub-engagement-counts roadhub-engagement-links roadhub-notifications roadhub-processed-messages"
export NOTIFY_QUEUE="roadhub-notify-queue"            # SQS: jobs for the notification worker
export NOTIFY_DLQ="roadhub-notify-dlq"                # SQS: dead-letter queue (a job lands here after 3 failed tries)
export OPS_TOPIC="roadhub-ops-alerts"                 # SNS: operations alerts
export OPS_INBOX="roadhub-ops-alerts-inbox"           # SQS: keeps every alert so it can be read later
export BUS="roadhub-events"                           # EventBridge bus shared by the 3 services
export NOTIFY_RULE="roadhub-notify-rule"              # EventBridge: status changes + merges -> notify queue
export AUDIT_RULE="roadhub-engagement-audit-rule"     # EventBridge: engagement events -> CloudWatch Logs
export EVENTS_LOG_GROUP="/aws/events/roadhub-engagement-audit"
export APP_LOG_GROUP="/aws/ecs/roadhub-engagement"    # CloudWatch Logs: the service's audit trail
export APP_LOG_STREAM="app-audit-stream"
export SERVICE_ROLE="roadhub-engagement-service-role" # IAM: the API (an ECS task)
export WORKER_ROLE="roadhub-notify-worker-role"       # IAM: the notification worker (a Lambda function)
export WORKER_FN="roadhub-notify-worker"              # Lambda function name

queue_arn() { echo "arn:aws:sqs:us-east-1:${ACCOUNT_ID}:$1"; }
topic_arn() { echo "arn:aws:sns:us-east-1:${ACCOUNT_ID}:$1"; }

# aws pointed at Floci. MSYS_NO_PATHCONV=1 stops Git Bash turning /aws/... into C:/Program Files/Git/aws/...
awsl() {
  MSYS_NO_PATHCONV=1 aws --endpoint-url "$ENDPOINT" "$@"
}

# Run a provisioning command; tolerate "already exists" errors so each
# service script is safe to re-run on its own (same as Lab 8).
ok() {
  local output
  if ! output=$("$@" 2>&1); then
    if echo "$output" | grep -qiE 'already exists|ResourceInUseException|ResourceAlreadyExistsException|EntityAlreadyExists|QueueAlreadyExists|TopicAlreadyExists'; then
      echo "  (already exists, skipping)"
    else
      echo "$output" >&2
      return 1
    fi
  fi
}

# Files that the AWS CLI reads with file://... are written here (inside the project:
# /tmp paths do not work for aws.exe in Git Bash). The folder is git-ignored.
OUT_DIR="infra/.out"
