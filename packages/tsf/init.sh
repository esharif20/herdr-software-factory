#!/bin/sh
# Installs .tsf/ into a repo. Never overwrites an existing file.
#   init.sh [project dir]     (default: current directory)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
project=${1:-.}
[ -d "$project" ] || { echo "init: no such folder: $project" >&2; exit 1; }
mkdir -p "$project/.tsf/batches"
for f in factory.md settings.json spec.md; do
  [ -e "$project/.tsf/$f" ] || cp "$here/templates/$f" "$project/.tsf/$f"
done
echo "installed $(cd "$project" && pwd)/.tsf: factory.md settings.json spec.md batches/"
echo "next: fill in the test command and protected paths in .tsf/factory.md"
