#!/bin/sh
# How many more Workers this machine can take right now. Prints one number; 0 means memory pressure is high.
# A lean Claude session held 130-200 MB idle in the benchmark; the budget leaves room for its test runs.
ROLE=${1:-} # read before `set --` below replaces the arguments
RESERVE_MB=1536
PER_WORKER_MB=400
MAX=8

line=$(mo status --json 2>/dev/null | python3 -I -c 'import json, sys
m = json.load(sys.stdin)["memory"]
print(int(m["available"] / 1048576), m.get("pressure") or "normal")' 2>/dev/null)
if [ -z "$line" ]; then # no mole: the kernel's free percentage of total RAM
  free=$(memory_pressure 2>/dev/null | awk '/free percentage/ { print $NF + 0 }')
  total=$(sysctl -n hw.memsize 2>/dev/null)
  [ -n "$free" ] && [ -n "$total" ] || { echo 1; exit 0; } # unknown: one at a time still makes progress
  line="$((total / 1048576 * free / 100)) normal"
fi

set -- $line
case $2 in warn|warning|critical) echo 0; exit 0 ;; esac
n=$((($1 - RESERVE_MB) / PER_WORKER_MB))
[ "$n" -gt "$MAX" ] && n=$MAX
# `capacity.sh builder`: lanes at once. Each lane owns its own worktree, so past 5 the start cost outweighs the parallel time saved.
[ "$ROLE" = builder ] && [ "$n" -gt 5 ] && n=5
[ "$n" -lt 0 ] && n=0
echo "$n"
