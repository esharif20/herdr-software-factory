#!/bin/sh
# No tokens. A lane's ready check: runs the verify command in the lane worktree and lists files the
# lane changed (vs. main) outside its own globs. Prints three short lines; exits 0 only on PASS.
#   ready.sh <worktree> "<verify command>" [<glob> ...]     (no globs: scope is not checked)
# On PASS it records the handoff land.sh trusts: <git common dir>/tsf-handoff/<lane>.json (lane, sha, files).
# The full verify output goes to ready.log inside the worktree's git dir, so it never shows in a commit.
set -u
w=${1:?usage: ready.sh <worktree> "<verify command>" [<glob> ...]}; cmd=${2:?verify command}; shift 2
log="$w/.git-ready.log"; [ -f "$w/.git" ] && log="$(git -C "$w" rev-parse --git-dir)/ready.log"
(cd "$w" && sh -c "$cmd") > "$log" 2>&1; code=$?
out=""
if [ $# -gt 0 ]; then
  for f in $(git -C "$w" diff --name-only "$(git -C "$w" merge-base main HEAD)" HEAD; git -C "$w" status --porcelain | awk '{print $2}'); do
    ok=""; for g in "$@"; do case "$f" in $g) ok=1 ;; esac; done
    [ -n "$ok" ] || out="$out $f"
  done
fi
dirty=$(git -C "$w" status --porcelain --untracked-files=no | awk '{print $2}' | tr '\n' ' ')
echo "verify: $([ $code = 0 ] && echo pass || echo "FAIL (exit $code), log $log")"
echo "scope: ${out:+outside lane files:}${out:-ok}"
[ -z "$dirty" ] || echo "commit: uncommitted $dirty"
if [ $code = 0 ] && [ -z "$out" ] && [ -z "$dirty" ]; then
  l=$(git -C "$w" rev-parse --abbrev-ref HEAD); l=${l#lane/}
  h="$(cd "$w" && cd "$(git rev-parse --git-common-dir)" && pwd)/tsf-handoff"; mkdir -p "$h"
  files=$(git -C "$w" diff --name-only "$(git -C "$w" merge-base main HEAD)" HEAD | tr '\n' ' ')
  printf '{"lane":"%s","sha":"%s","verify":"pass","files":"%s","at":%s}\n' "$l" "$(git -C "$w" rev-parse HEAD)" "${files% }" "$(date +%s)" > "$h/$l.json"
  echo "PASS"; exit 0
fi
echo "FAIL"; exit 1
