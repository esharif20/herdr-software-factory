#!/bin/sh
# No tokens. The end-of-run check: the whole test command once, and every commit DONE.md names is on
# main. Prints one line per problem, then PASS or FAIL. On PASS it prunes dead worktrees and deletes
# merged lane/* branches (git refuses any still checked out).
#   finish.sh <project dir> "<test command>"
set -u
p=${1:?usage: finish.sh <project dir> "<test command>"}; cmd=${2:?test command}
cd "$p" || exit 2
bad=0; log="$(git rev-parse --git-dir)/finish.log"
sh -c "$cmd" > "$log" 2>&1 || { echo "tests: FAIL, log $log"; bad=1; }
[ -f DONE.md ] || { echo "DONE.md: missing"; bad=1; }
for h in $(grep -oE '\b[0-9a-f]{7,40}\b' DONE.md 2>/dev/null); do
  git merge-base --is-ancestor "$h" HEAD 2>/dev/null || { echo "not on main: $h"; bad=1; }
done
[ $bad = 0 ] && { git worktree prune; for b in $(git branch --merged HEAD --format='%(refname:short)' | grep '^lane/'); do git branch -dq "$b" 2>/dev/null; done; echo PASS; exit 0; }; echo FAIL; exit 1
