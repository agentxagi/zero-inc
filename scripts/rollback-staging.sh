#!/usr/bin/env bash
set -euo pipefail

# Rollback staging to the previous Docker image
# Usage: ./scripts/rollback-staging.sh [COMPOSE_PATH]
#
# Reads .previous-image from the staging directory to determine
# the last-known-good image tag.

COMPOSE_PATH="${1:-/opt/zeroinc-staging}"
PREV_FILE="$COMPOSE_PATH/.previous-image"

if [ ! -f "$PREV_FILE" ]; then
  echo "ERROR: No previous image found at $PREV_FILE"
  echo "Cannot rollback — no known-good image recorded."
  exit 1
fi

PREV_IMAGE=$(cat "$PREV_FILE")

if [ -z "$PREV_IMAGE" ]; then
  echo "ERROR: Previous image file is empty"
  exit 1
fi

echo "==> Rolling back to: $PREV_IMAGE"
cd "$COMPOSE_PATH"

export STAGING_IMAGE="$PREV_IMAGE"
docker compose -f docker-compose.staging.yml up -d server

echo "==> Waiting for server to start..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3100/api/health > /dev/null 2>&1; then
    echo "==> Rollback complete — server is healthy"
    exit 0
  fi
  sleep 2
done

echo "ERROR: Server did not become healthy after rollback"
exit 1
