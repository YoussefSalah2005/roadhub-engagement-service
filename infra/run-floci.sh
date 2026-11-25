#!/usr/bin/env bash
set -euo pipefail
# Starts Floci if it is not answering on :4566, waits until it is ready, then builds every
# Engagement resource (init-aws.sh). Same idea as Lab 8's run-floci.sh, plus one fix: if a
# container called "floci" already exists (for example from the labs), it is started again
# instead of creating a second one (that is the "container name /floci is already in use" error).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMEOUT_SECS=300   # Floci loads every service's saved data at start: this can take 2-3 minutes

# Floci's own health address (the main address "/" can be slow while the web console starts).
# If curl cannot reach it, ask Floci with the AWS CLI instead.
is_floci_up() {
  curl -s -o /dev/null --max-time 5 "http://localhost:4566/_floci/health" \
    || AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test aws --endpoint-url http://localhost:4566 \
         --region us-east-1 sts get-caller-identity >/dev/null 2>&1
}

if is_floci_up; then
  echo "[run-floci] Floci already answers on :4566"
else
  if ! docker info >/dev/null 2>&1; then
    echo "[run-floci] ERROR: Docker is not running. Open Docker Desktop, wait for 'Engine running', run this again." >&2
    exit 1
  fi
  if docker ps -a --format '{{.Names}}' | grep -qx floci; then
    echo "[run-floci] starting your existing Floci container..."
    docker start floci >/dev/null
    for dash in floci-dash floci-aws-dash; do
      docker ps -a --format '{{.Names}}' | grep -qx "$dash" && docker start "$dash" >/dev/null || true
    done
  else
    echo "[run-floci] no Floci container yet: creating it (infra/floci/docker-compose.yml)..."
    (cd "${SCRIPT_DIR}/floci" && docker compose -f docker-compose.yml up -d)
  fi
  echo "[run-floci] waiting for Floci (up to ${TIMEOUT_SECS}s)..."
  elapsed=0
  until is_floci_up; do
    if [ "$elapsed" -ge "$TIMEOUT_SECS" ]; then
      echo "[run-floci] ERROR: Floci did not answer. Check: docker logs floci --tail 30" >&2
      exit 1
    fi
    sleep 2; elapsed=$((elapsed + 2))
  done
fi
echo "[run-floci] Floci is ready. Console: http://localhost:4566/_floci/ui"
exec bash "${SCRIPT_DIR}/init-aws.sh"
