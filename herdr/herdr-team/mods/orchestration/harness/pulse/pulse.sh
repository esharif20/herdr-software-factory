#!/bin/sh
# No tokens. Looks for news and wakes someone only then: new GitHub issues, a failing CI run, a stuck session.
#   pulse.sh <project dir> <lead address>
# News goes to the Lead with `hc send`, or, when PULSE_FIXER names an hc template, a CI failure goes to a fresh fixer that gets only the log path.
# Env: PULSE_STUCK_S (default 600) seconds a session may sit on one turn while working.
set -eu
project=${1:?usage: pulse.sh <project dir> <lead address>}
lead=${2:?usage: pulse.sh <project dir> <lead address>}
dir="$project/.tsf/pulse"; mkdir -p "$dir"
seen="$dir/seen"; touch "$seen"
now=$(date +%s)
stuck_s=${PULSE_STUCK_S:-600}
news=0

wake() { # $1 message, $2 optional log path
  news=1
  if [ -n "${PULSE_FIXER:-}" ] && [ -n "${2:-}" ]; then hc run --bg "$PULSE_FIXER" "Fix: $1. Log: $2" >/dev/null
  else hc send "$lead" "pulse: $1${2:+ log $2}"; fi
}
fresh() { grep -qxF "$1" "$seen" && return 1; echo "$1" >> "$seen"; }

if command -v gh >/dev/null 2>&1 && (cd "$project" && gh repo view >/dev/null 2>&1); then
  for n in $(cd "$project" && gh issue list --state open --json number --jq '.[].number' 2>/dev/null); do
    fresh "issue:$n" && wake "new issue #$n"
  done
  run=$(cd "$project" && gh run list --limit 1 --json databaseId,conclusion --jq '.[] | select(.conclusion == "failure") | .databaseId' 2>/dev/null || true)
  if [ -n "$run" ] && fresh "ci:$run"; then
    (cd "$project" && gh run view "$run" --log-failed > "$dir/ci-$run.log" 2>&1) || true
    wake "CI run $run failed" "$dir/ci-$run.log"
  fi
fi

# Stuck: working on the same turn since the last check for longer than stuck_s. State file: address turn since.
state="$dir/sessions"; touch "$state"
hc ls 2>/dev/null | node -e '
  const [state, now, limit] = process.argv.slice(1);
  const fs = require("fs");
  let ls; try { ls = JSON.parse(fs.readFileSync(0, "utf8")).terminals || []; } catch { process.exit(0); }
  const old = new Map(fs.readFileSync(state, "utf8").split("\n").filter(Boolean).map((l) => { const [a, t, s] = l.split(" "); return [a, [t, +s]]; }));
  const next = [];
  for (const t of ls) {
    if (t.status !== "working") continue;
    const p = old.get(t.address);
    const since = p && p[0] === String(t.turn) ? p[1] : +now;
    next.push(`${t.address} ${t.turn} ${since}`);
    if (now - since > limit) console.log(`${t.address} ${t.turn}@${since} ${now - since}`);
  }
  fs.writeFileSync(state, next.join("\n") + "\n");
' "$state" "$now" "$stuck_s" > "$dir/stuck.out" || true
while read -r addr key secs; do
  [ -n "$addr" ] || continue
  # one wake per stuck episode, keyed by the turn it is stuck on
  fresh "stuck:$addr:$key" && wake "$addr looks stuck, ${secs}s on one turn"
done < "$dir/stuck.out"

[ "$news" = 1 ] || echo "pulse: quiet"
