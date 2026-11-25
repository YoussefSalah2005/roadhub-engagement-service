#!/usr/bin/env bash
# Kept for roadhub-frontend/scripts/setup-local.sh: the secret is now made by infra/services/02-secrets-manager.sh
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/services/02-secrets-manager.sh"
