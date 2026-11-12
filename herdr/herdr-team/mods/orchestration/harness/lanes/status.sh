#!/bin/sh
# No tokens. One line per lane worktree under <project>/.tsf/lanes: builder state, commits ahead of
# main, the last commit and its age, uncommitted files, STALL when nothing landed for a while, and FREE
# when its builder is idle with everything merged. From .tsf/plan.md lines `lane <l>: GH-1 GH-4 ...` it
# adds each lane's issues with no `GH-n:` commit yet, and from `review: GH-2 GH-3` a REVIEW DUE line once that issue's newest commit is on main
# for each such issue that has a commit but no .tsf/review/GH-n.md.
#   status.sh <project dir>        Env: LANE_STALL_S (default 480) seconds without a commit or edit.
#   status.sh --json <project dir> the same facts plus issue stages, events and cost as one JSON object (status.mjs).
set -u
json=""; [ "${1:-}" = --json ] && { json=1; shift; }
project=${1:?usage: status.sh [--json] <project dir>}
stall=${LANE_STALL_S:-480}
now=$(date +%s)
plan="$project/.tsf/plan.md"
subjects=$(git -C "$project" log --all --format='%h %s' 2>/dev/null)
commit_of() { printf '%s\n' "$subjects" | awk -v id="$1:" '$2==id {print $1; exit}'; } # newest GH-n: commit
states=$(hc ls 2>/dev/null | node -e 'let d;try{d=JSON.parse(require("fs").readFileSync(0,"utf8")).terminals||[]}catch{d=[]}for(const t of d)if(t.name)console.log(t.name,t.address,t.status||"-",t.template||"-")' 2>/dev/null)
lanes() {
for w in "$project"/.tsf/lanes/*/; do
  [ -d "$w" ] || continue
  lane=$(basename "$w")
  who=$(printf '%s\n' "$states" | awk -v n="builder-$lane" '$1==n {print $2" "$3; exit}')
  ahead=$(git -C "$w" rev-list --count main..HEAD 2>/dev/null || echo 0)
  last=$(git -C "$w" log -1 --format='%ct %s' main..HEAD 2>/dev/null)
  dirty=$(git -C "$w" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  touched=$(git -C "$w" status --porcelain 2>/dev/null | awk '{print $2}' | (cd "$w" && xargs stat -f %m 2>/dev/null) | sort -n | tail -1)
  at=${last%% *}; [ -n "$at" ] || at=$(git -C "$w" log -1 --format=%ct 2>/dev/null || echo "$now")
  [ -n "$touched" ] && [ "$touched" -gt "$at" ] && at=$touched
  age=$(( now - at ))
  flag=""; case "$who" in *" idle"|*" done") [ "$ahead" = 0 ] && [ "$dirty" = 0 ] && flag=" FREE" ;; esac # merged and waiting: give it the next job
  [ "$age" -gt "$stall" ] && { [ "$ahead" -gt 0 ] || [ "$dirty" -gt 0 ]; } && flag=" STALL" # a merged, idle lane is not stalled
  left=""; for id in $(sed -n "s/^lane $lane: *//p" "$plan" 2>/dev/null | head -1); do [ -n "$(commit_of "$id")" ] || left="$left $id"; done
  if [ -n "$json" ]; then
    tpl=$(printf '%s\n' "$states" | awk -v n="builder-$lane" '$1==n {print $4; exit}')
    printf 'lane\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$lane" "${who:--}" "${tpl:--}" "$ahead" "$dirty" "$age" "${left# }" "${flag# }" "${last#* }"; continue
  fi
  echo "$lane: ${who:-no builder} | ${ahead} ahead, last: ${last#* } | ${dirty} uncommitted | ${age}s since a commit or edit | left:${left:- none}${flag}"
done
for id in $(sed -n 's/^review: *//p' "$plan" 2>/dev/null | head -1); do
  c=$(commit_of "$id"); [ -n "$c" ] && [ ! -f "$project/.tsf/review/$id.md" ] && git -C "$project" merge-base --is-ancestor "$c" main 2>/dev/null && { [ -n "$json" ] && printf 'due\t%s\t%s\n' "$id" "$c" || echo "REVIEW DUE $id at $c"; } # landed only, so a review never sees half an issue
done
}
if [ -n "$json" ]; then lanes | node --no-warnings "$(dirname "$0")/status.mjs" "$project" "$now"; else lanes; fi
exit 0
