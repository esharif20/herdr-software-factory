#!/bin/sh
# No tokens. Before the Lead plans: build a local Graphify code graph and turn it into .tsf/codemap.md
# (each file's functions with line numbers, grouped by community, plus the hub files), so the Lead copies
# the plan's code map instead of reading whole files (measured on bench11: 27-52k tokens of file reads).
# Prints one line: `graph: built (<n> KB of source), .tsf/codemap.md`, or `graph: skipped (<reason>)`.
#   auto.sh <project dir> [<min KB, default 50>]   (under that, reading the files is as cheap)
# Never runs `graphify install` or `hook install`; graphify-out/ is excluded locally via .git/info/exclude.
set -u
here=$(cd "$(dirname "$0")" && pwd)
p=${1:?usage: auto.sh <project dir> [min KB]}; min=${2:-50}
cd "$p" || exit 2
kb=$(( $(git ls-files -z -- '*.js' '*.mjs' '*.cjs' '*.ts' '*.tsx' '*.jsx' '*.py' '*.go' '*.rs' '*.java' '*.kt' '*.swift' '*.rb' '*.php' '*.cs' '*.c' '*.h' '*.cpp' '*.vue' '*.svelte' \
  | xargs -0 cat 2>/dev/null | wc -c) / 1024 ))
command -v graphify >/dev/null 2>&1 || { echo "graph: skipped (graphify not installed)"; exit 0; }
[ "$kb" -ge "$min" ] || { echo "graph: skipped ($kb KB of source, under $min KB)"; exit 0; }
ex="$(git rev-parse --git-common-dir)/info/exclude"; grep -qx 'graphify-out/' "$ex" 2>/dev/null || echo 'graphify-out/' >> "$ex"
export GRAPHIFY_BACKEND=none GRAPHIFY_QUERY_LOG_DISABLE=1
graphify extract . --code-only >/dev/null 2>&1 || { echo "graph: skipped (graphify extract failed)"; exit 0; }
[ -f graphify-out/graph.json ] || { echo "graph: skipped (no graph.json)"; exit 0; }
mkdir -p .tsf && node "$here/codemap.mjs" . > .tsf/codemap.md && echo "graph: built ($kb KB of source), .tsf/codemap.md" || echo "graph: built ($kb KB of source), codemap failed"
