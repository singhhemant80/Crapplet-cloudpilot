#!/usr/bin/env bash
# Starts the API and worker in the background for local development.
# Logs: /tmp/cloudpilot-api.log and /tmp/cloudpilot-worker.log
set -euo pipefail
cd "$(dirname "$0")/../../apps/api"
nohup npx tsx src/main.ts > /tmp/cloudpilot-api.log 2>&1 &
echo $! > /tmp/cloudpilot-api.pid
nohup npx tsx src/worker.ts > /tmp/cloudpilot-worker.log 2>&1 &
echo $! > /tmp/cloudpilot-worker.pid
for i in $(seq 1 30); do
  if curl -fs localhost:${API_PORT:-4000}/ready >/dev/null 2>&1; then echo "API ready on :${API_PORT:-4000}"; exit 0; fi
  sleep 1
done
echo "API did not become ready; see /tmp/cloudpilot-api.log" >&2
exit 1
