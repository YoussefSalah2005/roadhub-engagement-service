#!/usr/bin/env bash
set -euo pipefail
# [6/9] IAM: two "badges" (roles), each with a least-privilege policy (Lab 7 Concept 2, Lab 8 07-iam.sh).
#   roadhub-engagement-service-role  worn by the API (an ECS task):   infra/iam/engagement-service-*.json
#   roadhub-notify-worker-role       worn by the Lambda worker:        infra/iam/notify-worker-*.json
# Every statement names exact resources: this service's own tables, queue, topic, bus, log groups
# and only the secrets it reads. Never "Resource": "*".
# Floci stores IAM but does not check it by default; real AWS always checks it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"
cd "$PROJECT_ROOT"   # relative file:// paths work for aws.exe in Git Bash

echo "=== [6/9] IAM: $SERVICE_ROLE and $WORKER_ROLE (least privilege) ==="
ok awsl iam create-role --role-name "$SERVICE_ROLE" \
  --assume-role-policy-document file://infra/iam/engagement-service-trust.json
awsl iam put-role-policy --role-name "$SERVICE_ROLE" --policy-name roadhub-engagement-service-policy \
  --policy-document file://infra/iam/engagement-service-policy.json

ok awsl iam create-role --role-name "$WORKER_ROLE" \
  --assume-role-policy-document file://infra/iam/notify-worker-trust.json
awsl iam put-role-policy --role-name "$WORKER_ROLE" --policy-name roadhub-notify-worker-policy \
  --policy-document file://infra/iam/notify-worker-policy.json
echo "[6/9] done: $SERVICE_ROLE, $WORKER_ROLE"
