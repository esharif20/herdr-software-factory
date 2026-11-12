#!/bin/sh
# Runs init against a fresh temp folder and checks the .tsf tree; a second run must not overwrite.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
sh "$here/init.sh" "$t" >/dev/null
for f in factory.md settings.json spec.md; do [ -s "$t/.tsf/$f" ] || { echo "FAIL missing $f"; exit 1; }; done
[ -d "$t/.tsf/batches" ] || { echo "FAIL missing batches/"; exit 1; }
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$t/.tsf/settings.json" || { echo "FAIL settings.json"; exit 1; }
grep -q 'Protected paths' "$t/.tsf/factory.md" && grep -q 'depends' "$t/.tsf/spec.md" || { echo "FAIL contents"; exit 1; }
echo keep > "$t/.tsf/factory.md"; sh "$here/init.sh" "$t" >/dev/null
[ "$(cat "$t/.tsf/factory.md")" = keep ] || { echo "FAIL overwrote"; exit 1; }
echo "PASS"
