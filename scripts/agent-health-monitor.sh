#!/usr/bin/env bash
# Agent Health Monitor — lightweight watchdog for ZeroInc agent execution quality
# Runs via cron every 5 minutes. Checks agent liveness, stale tasks, speed kills,
# fake completions, and failed runs. Escalates after 3 consecutive agent failures.
#
# Usage:
#   ./agent-health-monitor.sh              # Run once, log to file
#   ./agent-health-monitor.sh --dry-run    # Print findings without logging
#   ./agent-health-monitor.sh --once       # Run once with verbose output to stdout

set -euo pipefail

# --- Configuration ---
API_URL="${PAPERCLIP_API_URL:-http://localhost:3100}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:-e2ecd7ae-85e6-4114-9035-03ab83e24d6e}"
LOG_DIR="/var/log/paperclip"
LOG_FILE="$LOG_DIR/agent-health-monitor.log"
STATE_FILE="$LOG_DIR/agent-health-monitor.state.json"

# Thresholds (minutes for staleness, seconds for speed kills)
STALE_RUNNING_AGENT_MIN=20     # Running agent with stale heartbeat
STALE_TASK_MIN=30              # In-progress task with no update
SPEED_KILL_SEC=30              # Assignment run done suspiciously fast

# Escalation
MAX_CONSECUTIVE_FAILURES=3
LOCK_FILE="/tmp/paperclip-agent-health-monitor.lock"

# --- Flags ---
VERBOSE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) echo "Dry-run mode: would run checks but skip state changes" && exit 0 ;;
    --once)    VERBOSE=true ;;
    --help|-h)
      echo "Usage: $0 [--once] [--help]"
      echo "  --once     Run once with verbose output to stdout"
      exit 0 ;;
  esac
done

# --- Setup ---
mkdir -p "$LOG_DIR"
if [ ! -s "$STATE_FILE" ]; then echo '{}' > "$STATE_FILE"; fi
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  if $VERBOSE; then
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO] another agent-health-monitor run is active; exiting"
  fi
  exit 0
fi

now_utc() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
epoch_now() { date +%s; }
ts_to_epoch() { date -u -d "${1}" +%s 2>/dev/null || echo 0; }

log() {
  local level="$1"; shift
  local msg="[$(now_utc)] [$level] $*"
  if $VERBOSE; then
    echo "$msg"
  else
    echo "$msg" >> "$LOG_FILE"
  fi
}

# --- API helpers ---
api_get() {
  curl -s --connect-timeout 5 --max-time 15 "$API_URL$1"
}

# --- State management (consecutive failure tracking) ---
get_failures() {
  jq -r --arg id "$1" '.agents[$id] // 0' "$STATE_FILE" 2>/dev/null || echo 0
}

increment_failures() {
  local agent_id="$1" current next tmp
  current=$(get_failures "$agent_id")
  next=$((current + 1))
  tmp=$(mktemp)
  jq --arg id "$agent_id" --arg n "$next" '.agents[$id] = ($n | tonumber)' "$STATE_FILE" > "$tmp" 2>/dev/null || echo '{}' > "$tmp"
  mv "$tmp" "$STATE_FILE"
  echo "$next"
}

reset_failures() {
  local tmp
  tmp=$(mktemp)
  jq --arg id "$1" 'del(.agents[$id])' "$STATE_FILE" > "$tmp" 2>/dev/null || echo '{}' > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

agent_name_for() {
  local aid="$1"
  echo "$AGENTS_JSON" | jq -r --arg aid "$aid" '.[] | select(.id == $aid) | .name // $aid'
}

# --- Checks ---
FINDINGS=0
CRITICAL=0

# 1. Server health
log INFO "=== Agent Health Monitor Run ==="
health=$(api_get "/api/health")
server_status=$(echo "$health" | jq -r '.status // "unknown"')
if [ "$server_status" != "ok" ]; then
  log CRITICAL "Server health check FAILED: status=$server_status"
  CRITICAL=$((CRITICAL + 1))
  FINDINGS=$((FINDINGS + 1))
else
  log INFO "Server health: OK"
fi

# 2. Agent liveness — only flag RUNNING agents with stale heartbeats
AGENTS_JSON=$(api_get "/api/companies/$COMPANY_ID/agents")
agent_count=$(echo "$AGENTS_JSON" | jq 'length')
log INFO "Checking liveness for $agent_count agents..."

now_epoch=$(epoch_now)
stale_agent_sec=$((STALE_RUNNING_AGENT_MIN * 60))

while IFS= read -r agent; do
  agent_id=$(echo "$agent" | jq -r '.id')
  agent_name=$(echo "$agent" | jq -r '.name')
  agent_status=$(echo "$agent" | jq -r '.status')
  last_hb=$(echo "$agent" | jq -r '.lastHeartbeatAt // empty')

  # Only check liveness for running agents (idle agents don't heartbeat)
  [ "$agent_status" != "running" ] && continue

  if [ -z "$last_hb" ]; then
    log WARN "Agent $agent_name: running but no heartbeat ever recorded"
    FINDINGS=$((FINDINGS + 1))
    increment_failures "$agent_id" > /dev/null
    continue
  fi

  last_epoch=$(ts_to_epoch "$last_hb")
  age=$((now_epoch - last_epoch))

  if [ "$age" -gt "$stale_agent_sec" ]; then
    age_min=$((age / 60))
    log WARN "Agent $agent_name: stale heartbeat (${age_min}min, threshold=${STALE_RUNNING_AGENT_MIN}min) while status=running"
    FINDINGS=$((FINDINGS + 1))
    failures=$(increment_failures "$agent_id")
    if [ "$failures" -ge "$MAX_CONSECUTIVE_FAILURES" ]; then
      log CRITICAL "Agent $agent_name: $failures consecutive stale checks — ESCALATION TRIGGERED"
      CRITICAL=$((CRITICAL + 1))
    fi
  else
    reset_failures "$agent_id"
  fi
done < <(echo "$AGENTS_JSON" | jq -c '.[]')

# 3. Stale tasks (in_progress with no recent activity)
active_issues=$(api_get "/api/companies/$COMPANY_ID/issues?status=in_progress&limit=50")
active_count=$(echo "$active_issues" | jq 'length')
log INFO "Checking $active_count in-progress tasks for staleness..."

stale_task_sec=$((STALE_TASK_MIN * 60))
while IFS= read -r issue; do
  identifier=$(echo "$issue" | jq -r '.identifier')
  title=$(echo "$issue" | jq -r '.title')
  assignee=$(echo "$issue" | jq -r '.assigneeAgentId // "none"')
  updated=$(echo "$issue" | jq -r '.updatedAt')
  started=$(echo "$issue" | jq -r '.startedAt')

  if [ -n "$updated" ] && [ "$updated" != "null" ]; then
    updated_epoch=$(ts_to_epoch "$updated")
    age=$((now_epoch - updated_epoch))
    if [ "$age" -gt "$stale_task_sec" ]; then
      age_min=$((age / 60))
      log WARN "Stale task [$identifier] \"$title\": no update in ${age_min}min"
      FINDINGS=$((FINDINGS + 1))
    fi
  fi

  if [ -n "$started" ] && [ "$started" != "null" ]; then
    started_epoch=$(ts_to_epoch "$started")
    run_time=$((now_epoch - started_epoch))
    if [ "$run_time" -gt 3600 ]; then
      run_hours=$((run_time / 3600))
      log WARN "Long-running task [$identifier] \"$title\": in_progress for ${run_hours}h (may be stuck)"
      FINDINGS=$((FINDINGS + 1))
    fi
  fi
done < <(echo "$active_issues" | jq -c '.[]')

# 4. Speed kills — assignment-triggered runs completed in <30s (timer runs are normal)
recent_runs=$(api_get "/api/companies/$COMPANY_ID/heartbeat-runs?limit=30&status=succeeded")
log INFO "Checking recent assignment runs for speed kills (<${SPEED_KILL_SEC}s)..."

speed_count=0
while IFS= read -r run; do
  run_id=$(echo "$run" | jq -r '.id')
  agent_id=$(echo "$run" | jq -r '.agentId')
  started=$(echo "$run" | jq -r '.startedAt // empty')
  finished=$(echo "$run" | jq -r '.finishedAt // empty')
  source=$(echo "$run" | jq -r '.invocationSource')

  # Only flag assignment/on_demand runs — timer runs completing fast is normal
  [ "$source" = "timer" ] && continue

  if [ -z "$started" ] || [ -z "$finished" ]; then continue; fi

  started_epoch=$(ts_to_epoch "$started")
  finished_epoch=$(ts_to_epoch "$finished")
  duration=$((finished_epoch - started_epoch))

  if [ "$duration" -lt "$SPEED_KILL_SEC" ] && [ "$duration" -ge 0 ]; then
    agent_name=$(agent_name_for "$agent_id")
    log WARN "Speed kill: $agent_name completed $source run in ${duration}s (run=$run_id)"
    FINDINGS=$((FINDINGS + 1))
    speed_count=$((speed_count + 1))
  fi
done < <(echo "$recent_runs" | jq -c '.[]')

if [ "$speed_count" -eq 0 ]; then
  log INFO "No speed kills detected"
fi

# 5. Fake completions — recent done issues (last 24h) with suspicious timing
done_issues=$(api_get "/api/companies/$COMPANY_ID/issues?status=done&limit=50")
# Filter to issues completed in the last 24 hours to avoid false positives on old data
recent_cutoff=$((now_epoch - 86400))
done_issues=$(echo "$done_issues" | jq -c --arg cutoff "$recent_cutoff" \
  '[.[] | select((.completedAt // "" | sub("\\.[0-9]+Z$"; "Z") | sub("\\.[0-9]+Z$"; "")) != "" and (.completedAt | split("T")[0] | . as $d | $d != "null"))]')

done_count=$(echo "$done_issues" | jq 'length')
log INFO "Checking $done_count recent completions (last 24h) for anomalies..."

while IFS= read -r issue; do
  identifier=$(echo "$issue" | jq -r '.identifier')
  assignee=$(echo "$issue" | jq -r '.assigneeAgentId // "none"')
  started=$(echo "$issue" | jq -r '.startedAt')
  completed=$(echo "$issue" | jq -r '.completedAt')

  # Skip if completed too long ago (filter by epoch)
  if [ -n "$completed" ] && [ "$completed" != "null" ]; then
    c_epoch=$(ts_to_epoch "$completed")
    if [ "$((now_epoch - c_epoch))" -gt 86400 ]; then
      continue
    fi
  else
    continue
  fi

  # No-start completions by agents (marked done without starting) — skip if no assignee (manual board action)
  if { [ -z "$started" ] || [ "$started" = "null" ]; } && [ "$assignee" != "none" ] && [ -n "$assignee" ]; then
    agent_name=$(agent_name_for "$assignee")
    log WARN "No-start completion: [$identifier] done without being started (assignee=$agent_name)"
    FINDINGS=$((FINDINGS + 1))
    continue
  fi

  # Instant completions (started and completed within 10 seconds)
  if [ -n "$started" ] && [ "$started" != "null" ]; then
    s_epoch=$(ts_to_epoch "$started")
    dur=$((c_epoch - s_epoch))
    if [ "$dur" -lt 10 ] && [ "$dur" -ge 0 ]; then
      agent_name=$(agent_name_for "$assignee")
      log WARN "Instant completion: [$identifier] done in ${dur}s (assignee=$agent_name)"
      FINDINGS=$((FINDINGS + 1))
    fi
  fi
done < <(echo "$done_issues" | jq -c '.[]')

# 6. Failed runs (filter client-side — API doesn't support status param)
all_runs=$(api_get "/api/companies/$COMPANY_ID/heartbeat-runs?limit=30")
failed_runs=$(echo "$all_runs" | jq -c '[.[] | select(.status == "failed" or .status == "timed_out" or .status == "failed_timed_out")]')
failed_count=$(echo "$failed_runs" | jq 'length')
if [ "$failed_count" -gt 0 ]; then
  log WARN "Found $failed_count recent failed/timed-out runs"
  while IFS= read -r run; do
    agent_id=$(echo "$run" | jq -r '.agentId')
    error=$(echo "$run" | jq -r '.error // "no error message"')
    status=$(echo "$run" | jq -r '.status')
    agent_name=$(agent_name_for "$agent_id")
    log WARN "Failed run: $agent_name ($status): ${error:0:120}"
    FINDINGS=$((FINDINGS + 1))
  done < <(echo "$failed_runs" | jq -c '.[]')
else
  log INFO "No failed runs"
fi

# --- Summary ---
log INFO "Run complete: $FINDINGS findings, $CRITICAL critical"
log INFO "---"

# Rotate log: keep last 5000 lines
if [ -f "$LOG_FILE" ] && ! $VERBOSE; then
  tmp_log=$(mktemp "${LOG_FILE}.XXXXXX")
  if tail -5000 "$LOG_FILE" > "$tmp_log" 2>/dev/null; then
    mv "$tmp_log" "$LOG_FILE"
  else
    rm -f "$tmp_log"
  fi
fi

# Exit codes: 0=clean, 1=warnings, 2=critical
if [ "$CRITICAL" -gt 0 ]; then
  exit 2
elif [ "$FINDINGS" -gt 0 ]; then
  exit 1
fi
exit 0
