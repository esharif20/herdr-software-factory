#!/bin/sh
# No tokens. Lands one lane on main in the project: merge --no-ff, then the test command. Prints one
# line. On a conflict it aborts the merge and names the conflicting files; on red tests it undoes
# the merge (main is back where it was) and names the log. It lands only the commit ready.sh last
# passed (<git common dir>/tsf-handoff/<lane>.json), never a sha from chat alone.
#   land.sh <project dir> <lane> "<test command>" [<sha>]   (a sha must match the handoff)
set -u
p=${1:?usage: land.sh <project dir> <lane> "<test command>" [<sha>]}; l=${2:?lane}; cmd=${3:?test command}; cd "$p" || exit 2
hf="$(cd "$(git rev-parse --git-common-dir)" && pwd)/tsf-handoff/$l.json"
hs=$(sed -n 's/.*"sha":"\([0-9a-f]*\)".*/\1/p' "$hf" 2>/dev/null)
[ -n "$hs" ] || { echo "NO HANDOFF lane $l: run ready.sh in the lane first"; exit 1; }
rev=${4:-$hs}
[ "$(git rev-parse -q --verify "$rev^{commit}")" = "$hs" ] || { echo "BAD SHA lane $l: $rev is not the commit ready.sh passed ($hs)"; exit 1; }
before=$(git rev-parse HEAD)
git merge-base --is-ancestor "$rev" "lane/$l" 2>/dev/null || { echo "BAD SHA lane $l: $rev is not on lane/$l"; exit 1; }
if ! git merge -q --no-ff "$rev" -m "Merge lane/$l" >/dev/null 2>&1; then
  files=$(git diff --name-only --diff-filter=U | tr '\n' ' '); git merge --abort
  echo "CONFLICT lane $l: $files"; exit 1
fi
log="$(git rev-parse --git-dir)/land-$l.log"
if sh -c "$cmd" > "$log" 2>&1; then rm -f "$hf"; echo "LANDED lane $l at $(git rev-parse --short HEAD): tests pass"; exit 0; fi
git reset -q --merge "$before" # undoes only the merge just made; uncommitted edits on main stay
echo "RED lane $l: tests fail after the merge, merge undone, log $log"; exit 1
