#!/bin/sh
# Test stand-in for capacity.sh: $STUB_DIR/capacity if a test wrote one (capacity that changes mid-run), else $STUB_CAPACITY (default 8),
# minus the Workers the stub hc has started and not yet killed.
log="$STUB_DIR/calls.log"
runs=$(grep -c ' run ' "$log" 2>/dev/null); kills=$(grep -c ' kill ' "$log" 2>/dev/null)
base=$(cat "$STUB_DIR/capacity" 2>/dev/null || echo "${STUB_CAPACITY:-8}")
n=$(( base - ${runs:-0} + ${kills:-0} ))
[ "$n" -lt 0 ] && n=0
echo "$n"
