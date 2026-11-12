#!/bin/sh
# No tokens. Before the Lead plans: build a local Graphify code graph when the repo is big enough to pay for it (measured: at 161 KB the report cost the Lead 54% more context than reading files).
# Prints one line: `graph: built (<n> KB of source)`, `graph: skipped (<n> KB of source, under <min> KB)` or
# `graph: skipped (graphify not installed)`. The Lead plans from graphify-out/GRAPH_REPORT.md when it exists.
#   auto.sh <project dir> [<min KB, default 400>]
# Never runs `graphify install` or `hook install`; graphify-out/ is excluded locally via .git/info/exclude.
set -u
p=${1:?usage: auto.sh <project dir> [min KB]}; min=${2:-400}
cd "$p" || exit 2
kb=$(( $(git ls-files -z -- '*.js' '*.mjs' '*.cjs' '*.ts' '*.tsx' '*.jsx' '*.py' '*.go' '*.rs' '*.java' '*.kt' '*.swift' '*.rb' '*.php' '*.cs' '*.c' '*.h' '*.cpp' '*.vue' '*.svelte' \
  | xargs -0 cat 2>/dev/null | wc -c) / 1024 ))
command -v graphify >/dev/null 2>&1 || { echo "graph: skipped (graphify not installed)"; exit 0; }
[ "$kb" -ge "$min" ] || { echo "graph: skipped ($kb KB of source, under $min KB)"; exit 0; }
ex="$(git rev-parse --git-common-dir)/info/exclude"; grep -qx 'graphify-out/' "$ex" 2>/dev/null || echo 'graphify-out/' >> "$ex"
export GRAPHIFY_BACKEND=none GRAPHIFY_QUERY_LOG_DISABLE=1
graphify extract . --code-only >/dev/null 2>&1 || { echo "graph: skipped (graphify extract failed)"; exit 0; }
[ -f graphify-out/GRAPH_REPORT.md ] || graphify cluster-only . >/dev/null 2>&1
[ -f graphify-out/GRAPH_REPORT.md ] && echo "graph: built ($kb KB of source)" || echo "graph: skipped (no report)"
