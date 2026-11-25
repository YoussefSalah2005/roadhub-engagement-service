#!/usr/bin/env bash
# Kept for roadhub-frontend/scripts/setup-local.sh: the tables are now made by infra/services/01-dynamodb.sh
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/services/01-dynamodb.sh"
