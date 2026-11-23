#!/usr/bin/env bash
# Creates the secret owned by the Engagement Service in AWS Secrets Manager (owner: Youssef). Safe to run again.
#   roadhub/resend   (RESEND_API_KEY and RESEND_FROM from infra/.env, never typed into the code)
# The value is read from infra/.env by Node and never printed.
source "$(dirname "$0")/../lib.sh"
step "Secrets Manager: engagement-service"
[ -f "$ROOT_DIR/infra/.env" ] && set -a && . <(sed 's/\r$//' "$ROOT_DIR/infra/.env") && set +a
node "$ROOT_DIR/infra/scripts/create-secrets.js"
