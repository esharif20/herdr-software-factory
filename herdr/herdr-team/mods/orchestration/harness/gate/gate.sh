#!/bin/sh
# The stop condition for a gated ticket: hidden tests, written from the spec before the build.
#   gate.sh <board> <ticket> --path       # creates and prints the tests' folder, for the Test writer
#   gate.sh <board> <ticket> [build-dir]  # runs them; exit 0 means the ticket passes
# <board> is the Herdr space id the team's prompts name. Tests written under a project path key are found too (bench10).
# The Test writer creates run.sh last. It is run as `BUILD=<absolute build dir> sh run.sh` from that folder.
# shortcut: hidden by instruction only, a Worker could read the folder; move it out of reach if one ever does.
set -u

die() { echo "gate: $1" >&2; exit 2; }
safe() { printf %s "$1" | tr -c 'A-Za-z0-9._-' '_'; }

[ $# -ge 2 ] || die 'usage: gate.sh <board> <ticket> [--path | build-dir]'
dir="$HOME/.config/herdr-app/tickets/gates/$(safe "$1")/$(safe "$2")"

if [ "${3:-}" = --path ]; then
  mkdir -p "$dir" && echo "$dir"
  exit
fi

build=$(cd "${3:-.}" 2>/dev/null && pwd) || die "no build folder: ${3:-.}"
[ -f "$dir/run.sh" ] || { alt="$HOME/.config/herdr-app/tickets/gates/$(safe "$build")/$(safe "$2")"; [ -d "$alt" ] && dir=$alt; }
# Workers build while the tests are written, so waiting here costs no tokens. Bounded to fit a default tool timeout.
waited=0
while [ ! -f "$dir/run.sh" ] && [ "$waited" -lt "${GATE_WAIT:-100}" ]; do
  sleep 1
  waited=$((waited + 1))
done
[ -f "$dir/run.sh" ] || { echo "gate: tests not ready yet, run this again"; exit 3; }

# A hung test must not hold the Worker: a file, not a pipe, so stray children can't block us, and a hard time limit.
out=$(mktemp)
(cd "$dir" && BUILD="$build" perl -e 'my $limit = shift; my $pid = fork; if (!$pid) { setpgrp(0, 0); exec @ARGV } $SIG{ALRM} = sub { kill "KILL", -$pid; exit 124 }; alarm $limit; waitpid $pid, 0; exit $? >> 8' "${GATE_LIMIT:-240}" sh run.sh) > "$out" 2>&1
code=$?
tail -40 "$out" | cut -c1-200
rm -f "$out"
[ "$code" -eq 124 ] && echo "gate: tests hung, killed after ${GATE_LIMIT:-240}s. Fix the hang, or tell the Lead if the test is wrong."
exit "$code"
