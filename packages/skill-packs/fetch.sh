#!/bin/sh
# Fetch each skill in skills.tsv from its upstream repo at the pinned commit into ~/.claude/skills.
# Only the listed folder is downloaded (partial clone). An existing skill moves to
# ~/.herdr-software-factory/backups/<time>/ first.   fetch.sh [name ...]  (no name: all)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
dest="$HOME/.claude/skills"; cache="$HOME/.herdr-software-factory/cache"
backup="$HOME/.herdr-software-factory/backups/$(date +%s)"
mkdir -p "$dest" "$cache"
grep -v '^#' "$here/skills.tsv" | while IFS="$(printf '\t')" read -r name repo sha path; do
  [ -n "$name" ] || continue
  if [ $# -gt 0 ]; then case " $* " in *" $name "*) ;; *) continue;; esac; fi
  c="$cache/$(echo "$repo" | tr / -)-$sha"
  if [ ! -d "$c/.git" ]; then
    git init -q "$c"
    git -C "$c" remote add origin "https://github.com/$repo"
    git -C "$c" fetch -q --depth 1 --filter=blob:none origin "$sha"
  fi
  if [ "$path" = . ]; then git -C "$c" checkout -q "$sha" -- . ; else git -C "$c" checkout -q "$sha" -- "$path"; fi
  t="$dest/$name"
  if [ -e "$t" ] || [ -L "$t" ]; then mkdir -p "$backup/$(dirname "$name")"; mv "$t" "$backup/$name"; fi
  mkdir -p "$(dirname "$t")"; cp -R "$c/$path" "$t"; rm -rf "$t/.git"
  echo "fetched $name from $repo@$(echo "$sha" | cut -c1-7)"
done
# Our own wrapper around the DESIGN.md library.
if [ -d "$dest/design-md/library" ]; then cp "$here/design-md/SKILL.md" "$dest/design-md/SKILL.md"; fi
cat <<'N'
Not fetched (see packages/skill-packs/README.md): before-and-after, design-taste-frontend.
Plugins: claude plugin install frontend-design@claude-plugins-official
N
