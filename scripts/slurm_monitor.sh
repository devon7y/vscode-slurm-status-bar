#!/bin/bash
# Save as ~/slurm_status_bar_emojis.sh

# Usage: ./slurm_status_bar_emojis.sh fir

REMOTE="$1"
STATUS_FILE="$HOME/.slurm_status_bar.txt"

# Convert time format (HH:MM:SS or MM:SS or D-HH:MM:SS) to seconds
time_to_seconds() {
  local time_str="$1"
  local total_seconds=0

  # Handle days (e.g., "1-12:00:00")
  if [[ "$time_str" =~ ^([0-9]+)-(.+)$ ]]; then
    local days="${BASH_REMATCH[1]}"
    time_str="${BASH_REMATCH[2]}"
    ((total_seconds += days * 86400))
  fi

  # Split by colons
  IFS=':' read -ra parts <<< "$time_str"
  local len=${#parts[@]}

  if [[ $len -eq 3 ]]; then
    # HH:MM:SS
    ((total_seconds += parts[0] * 3600 + parts[1] * 60 + parts[2]))
  elif [[ $len -eq 2 ]]; then
    # MM:SS
    ((total_seconds += parts[0] * 60 + parts[1]))
  elif [[ $len -eq 1 ]]; then
    # Just seconds
    ((total_seconds += parts[0]))
  fi

  echo "$total_seconds"
}

# Convert seconds to time format (HH:MM:SS or MM:SS)
seconds_to_time() {
  local seconds=$1

  if [[ $seconds -le 0 ]]; then
    echo "0:00"
    return
  fi

  local days=$((seconds / 86400))
  local hours=$(((seconds % 86400) / 3600))
  local mins=$(((seconds % 3600) / 60))
  local secs=$((seconds % 60))

  if [[ $days -gt 0 ]]; then
    printf "%d-%02d:%02d:%02d" "$days" "$hours" "$mins" "$secs"
  elif [[ $hours -gt 0 ]]; then
    printf "%d:%02d:%02d" "$hours" "$mins" "$secs"
  else
    printf "%d:%02d" "$mins" "$secs"
  fi
}

# Associative arrays to store job data
declare -A JOB_NAMES
declare -A JOB_STATES
declare -A JOB_TIMES_SEC
declare -A JOB_PENDING_START  # Track when pending jobs were first seen

REFRESH_INTERVAL=60
COUNTER=0

# Main loop
while true; do
  # Refresh from server every 60 seconds
  if [[ $COUNTER -eq 0 ]]; then
    # Get job data from remote server (using | as delimiter to handle spaces in job names)
    JOBS=$(ssh "$REMOTE" "squeue -u \$USER --noheader -o '%i|%j|%t|%L' 2>/dev/null")

    # Track which jobs we see in this refresh (clear previous data)
    unset SEEN_JOBS
    declare -A SEEN_JOBS

    # Parse jobs
    if [[ -n "$JOBS" ]]; then
      while IFS='|' read -r JOBID NAME STATE TIME_LEFT; do
        [[ -z "$JOBID" ]] && continue

        SEEN_JOBS[$JOBID]=1

        # Update job info
        JOB_NAMES[$JOBID]="$NAME"
        JOB_STATES[$JOBID]="$STATE"
        JOB_TIMES_SEC[$JOBID]=$(time_to_seconds "$TIME_LEFT")

        # If job is pending and we haven't seen it before, mark start time
        if [[ "$STATE" == "PD" && -z "${JOB_PENDING_START[$JOBID]}" ]]; then
          JOB_PENDING_START[$JOBID]=0
        fi

        # If job is no longer pending, clear pending start time
        if [[ "$STATE" != "PD" ]]; then
          unset JOB_PENDING_START[$JOBID]
        fi
      done <<< "$JOBS"
    fi

    # Remove jobs that no longer exist in squeue
    for JOBID in "${!JOB_NAMES[@]}"; do
      if [[ -z "${SEEN_JOBS[$JOBID]}" ]]; then
        unset JOB_NAMES[$JOBID]
        unset JOB_STATES[$JOBID]
        unset JOB_TIMES_SEC[$JOBID]
        unset JOB_PENDING_START[$JOBID]
      fi
    done

    COUNTER=$REFRESH_INTERVAL
  fi

  # Build output string from current job data
  OUTPUT=""
  for JOBID in "${!JOB_NAMES[@]}"; do
    NAME="${JOB_NAMES[$JOBID]}"
    STATE="${JOB_STATES[$JOBID]}"

    if [[ "$STATE" == "PD" ]]; then
      # For pending jobs, count UP from 0
      TIME_SEC="${JOB_PENDING_START[$JOBID]}"
      TIME_STR=$(seconds_to_time "$TIME_SEC")
      JOB_INFO="${NAME} (${STATE}) ${TIME_STR}"

      # Increment pending timer
      ((JOB_PENDING_START[$JOBID]++))
    else
      # For running/other jobs, count DOWN
      TIME_SEC="${JOB_TIMES_SEC[$JOBID]}"
      TIME_STR=$(seconds_to_time "$TIME_SEC")
      JOB_INFO="${NAME} (${STATE}) ${TIME_STR}"

      # Decrement time for next iteration
      ((JOB_TIMES_SEC[$JOBID]--))
    fi

    if [[ -z "$OUTPUT" ]]; then
      OUTPUT="$JOB_INFO"
    else
      OUTPUT="${OUTPUT} | ${JOB_INFO}"
    fi
  done

  # If no jobs, show a message
  if [[ -z "$OUTPUT" ]]; then
    OUTPUT="No active jobs"
  fi

  # Atomic write: write to temp file then rename (prevents race conditions)
  echo "$OUTPUT" > "${STATUS_FILE}.tmp"
  mv "${STATUS_FILE}.tmp" "$STATUS_FILE"

  # Decrement counter and sleep
  ((COUNTER--))
  sleep 1
done
