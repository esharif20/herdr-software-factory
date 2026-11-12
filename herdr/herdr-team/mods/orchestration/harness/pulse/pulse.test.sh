#!/bin/sh
# Stub hc and gh on PATH; no network, no tokens.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d); mkdir "$t/bin" "$t/proj"
cat > "$t/bin/gh" <<'S'
#!/bin/sh
case "$*" in
  "repo view") exit 0 ;;
  "issue list"*) echo 7 ;;
  "run list"*) echo 99 ;;
  "run view"*) echo "boom: test failed" ;;
esac
S
cat > "$t/bin/hc" <<'S'
#!/bin/sh
case "$1" in
  ls) echo '{"terminals":[{"address":"t9","status":"working","turn":3},{"address":"t8","status":"idle","turn":1}]}' ;;
  *) echo "$@" >> "$T/hc.log" ;;
esac
S
chmod +x "$t/bin/gh" "$t/bin/hc"
export T="$t" PATH="$t/bin:$PATH" PULSE_STUCK_S=0

sh "$here/pulse.sh" "$t/proj" tLEAD >/dev/null
grep -q 'send tLEAD pulse: new issue #7' "$t/hc.log"
grep -q 'CI run 99 failed log .*ci-99.log' "$t/hc.log"
grep -q boom "$t/proj/.tsf/pulse/ci-99.log"
[ "$(wc -l < "$t/hc.log")" -eq 2 ] # first sight of t9 only records it

sleep 1; sh "$here/pulse.sh" "$t/proj" tLEAD >/dev/null
grep -q 'tLEAD pulse: t9 looks stuck' "$t/hc.log"
n=$(wc -l < "$t/hc.log")
sh "$here/pulse.sh" "$t/proj" tLEAD | grep -q 'pulse: quiet' # same news is not repeated
[ "$(wc -l < "$t/hc.log")" -eq "$n" ]

: > "$t/proj/.tsf/pulse/seen"; : > "$t/hc.log"
PULSE_FIXER=fixer sh "$here/pulse.sh" "$t/proj" tLEAD >/dev/null
grep -q 'run --bg fixer Fix: CI run 99 failed. Log: ' "$t/hc.log"
echo "pulse tests ok"
