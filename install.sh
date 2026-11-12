#!/bin/sh
# Install the herdr software factory. From a clone:   ./install.sh [--team] [--tsf] [--ui] [--skills]
# Without one:  curl -fsSL https://raw.githubusercontent.com/esharif20/herdr-software-factory/main/install.sh | sh -s -- [flags]
# (no flag installs all four). Anything replaced moves to ~/.herdr-software-factory/backups/<time>/
# first, never beside the new copy: Herdr would load a second mod, and Claude would see two skills.
set -eu
REPO=https://github.com/esharif20/herdr-software-factory
root=$(cd "$(dirname "$0")" 2>/dev/null && pwd || pwd)
if [ ! -d "$root/packages" ] || [ ! -d "$root/herdr" ]; then
  # Run through curl: fetch the repo, then run its own copy of this script.
  src="$HOME/.herdr-software-factory/src"
  if [ -d "$src/.git" ]; then git -C "$src" pull -q --ff-only; else git clone -q --depth 1 "$REPO" "$src"; fi
  exec sh "$src/install.sh" "$@"
fi

team=0; tsf=0; ui=0; skills=0
for a in "$@"; do case $a in
  --team) team=1;; --tsf) tsf=1;; --ui) ui=1;; --skills) skills=1;;
  *) echo "usage: $0 [--team] [--tsf] [--ui] [--skills]" >&2; exit 2;; esac; done
[ $((team + tsf + ui + skills)) -eq 0 ] && team=1 tsf=1 ui=1 skills=1

have() { command -v "$1" >/dev/null 2>&1; }
for c in git claude; do have $c || echo "missing: $c"; done
if have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then :; else echo "missing: node >= 20"; fi
if [ $((team + ui)) -gt 0 ]; then
  for c in herdr-app hc; do have $c || { echo "missing: $c (needed for --team and --ui)" >&2; exit 1; }; done
fi

backup="$HOME/.herdr-software-factory/backups/$(date +%s)"
save() { if [ -e "$1" ] || [ -L "$1" ]; then mkdir -p "$backup"; cp -R "$1" "$backup/"; echo "backed up $1 to $backup/"; fi; }
# put <source dir> <dest>: back up any existing dest, then replace it with the source
put() { save "$2"; rm -rf "$2"; mkdir -p "$(dirname "$2")"; cp -R "$1" "$2"; echo "installed $2"; }

mods="$HOME/.config/herdr-app/mods"
if [ $team -eq 1 ]; then put "$root/herdr/herdr-team/mods/orchestration" "$mods/orchestration"; herdr-app check "$mods/orchestration"; fi
if [ $tsf -eq 1 ]; then put "$root/packages/tsf" "$HOME/.claude/skills/tsf"; fi
if [ $ui -eq 1 ]; then
  # Our Team and Skills tabs are files laid over munza's Factory mod, which must be there first.
  ov="$root/herdr/factory-team-view"
  if [ -f "$mods/factory/main.js" ]; then
    if patch -p1 --forward --dry-run -s -d "$mods/factory" < "$ov/factory.patch" >/dev/null; then
      save "$mods/factory"; cp -R "$ov/mods/factory/." "$mods/factory/"
      patch -p1 --forward -s -d "$mods/factory" < "$ov/factory.patch"
      herdr-app check "$mods/factory"; echo "installed the Team and Skills tabs into $mods/factory"
    else echo "ui: your Factory differs from the version this patch targets (munza/herdr-mods 6e2ffe0); skipped, nothing changed"; fi
  else echo "ui: install the Factory mod first (github.com/munza/herdr-mods), then rerun with --ui"; fi
fi
if [ $skills -eq 1 ]; then sh "$root/packages/skill-packs/fetch.sh"; fi

cat <<'N'
Next: 1) restart Herdr  2) open the team layout from the Herdr command bar
      3) in your project, start the Lead and describe the work (or run /tsf init)
N
