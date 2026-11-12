#!/bin/sh
# Team tickets, one log per project. Each change is one appended line, so teammates can't overwrite each other.
#   ticket.sh <project> add "<title>" [owner]
#   ticket.sh <project> issue "<title>" [owner]   # opens a GitHub issue and its GH-n ticket
#   ticket.sh <project> move <id> <todo|doing|review|blocked|done> [owner] [--force]   # --force: reopen a done ticket
#   ticket.sh <project> sync                      # run in the project's folder: GitHub issues become GH-n tickets
#   ticket.sh <project> ls      # id, stage, owner, updated, title (tab-separated)
set -eu

die() { echo "ticket: $1" >&2; exit 1; }
clean() { printf %s "$1" | tr '\t\r\n' '   ' | cut -c1-200; }
now() { date +%s; }
log() { mkdir -p "$dir"; printf '%s\t%s\t%s\t%s\t%s\n' "$(now)" "$1" "$2" "$(clean "${3:-}")" "$(clean "${4:-}")" >> "$file"; }
stage_of() { sh "$0" "$project" ls | ID="$1" awk -F'\t' '$1 == ENVIRON["ID"] { print $2 }'; }

# A board stays tied to the first repo it syncs, so a session in another folder can't touch the wrong issues.
repo() {
  [ -s "$file.repo" ] && { cat "$file.repo"; return; }
  command -v gh >/dev/null || return 1
  found=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) && [ -n "$found" ] || return 1
  mkdir -p "$dir"; printf %s "$found" > "$file.repo"; echo "$found"
}
github() { gh issue "$1" "$2" -R "$(cat "$file.repo")" >/dev/null 2>&1 || echo "ticket: could not $1 issue #$2 on GitHub" >&2; }

[ $# -ge 2 ] || die 'usage: ticket.sh <project> add|issue|open|move|sync|ls ...'
project=$1
dir="$HOME/.config/herdr-app/tickets"
file="$dir/$(printf %s "$1" | tr -c 'A-Za-z0-9._-' '_').tsv"
command=$2
shift 2

case $command in
  add)
    [ $# -ge 1 ] && [ -n "$1" ] || die 'add needs a title'
    # shortcut: two adds in the same instant could share a number; only the Lead adds, so a lock isn't worth it.
    id="T-$(awk -F'\t' '$2 ~ /^T-/ { n = substr($2, 3) + 0; if (n > m) m = n } END { print m + 1 }' "$file" 2>/dev/null || echo 1)"
    log "$id" todo "${2:-}" "$1"
    echo "$id"
    ;;
  issue)
    [ $# -ge 1 ] && [ -n "$1" ] || die 'issue needs a title'
    where=$(repo) || die 'not in a GitHub repo'
    url=$(gh issue create -R "$where" --title "$1" --body "")
    log "GH-${url##*/}" todo "${2:-}" "$1"
    echo "GH-${url##*/}"
    ;;
  open)
    # open <id> [owner] [title]: put a ticket with a given id on the board, unless it is there already (batch.mjs, per row)
    [ $# -ge 1 ] && [ -n "$1" ] || die 'open needs a ticket id'
    [ -f "$file" ] && ID="$1" awk -F'\t' '$2 == ENVIRON["ID"] { found = 1 } END { exit !found }' "$file" && exit 0
    log "$1" todo "${2:-}" "${3:-}"
    ;;
  move)
    [ $# -ge 2 ] || die 'move needs a ticket and a stage'
    case $2 in todo|doing|review|blocked|done) ;; *) die "unknown stage: $2" ;; esac
    [ -f "$file" ] && ID="$1" awk -F'\t' '$2 == ENVIRON["ID"] { found = 1 } END { exit !found }' "$file" || die "no ticket $1"
    before=$(stage_of "$1")
    # A stale session's move must not reopen closed work (bench10: a dead lane's Worker moved T-1 off done and stalled two lanes).
    [ "$before" != done ] || [ "$2" = done ] || [ "${3:-}" = --force ] || [ "${4:-}" = --force ] || die "$1 is done; only the Lead reopens it, with --force"
    [ "${3:-}" = --force ] && set -- "$1" "$2"
    log "$1" "$2" "${3:-}"
    case $1:$2 in
      GH-*:done) [ "$before" = done ] || github close "${1#GH-}" ;;
      GH-*:*) [ "$before" != done ] || github reopen "${1#GH-}" ;;
    esac
    ;;
  sync)
    where=$(repo) || exit 0 # no GitHub here: the board stays local
    tab=$(printf '\t')
    # shortcut: only the newest 200 issues, and titles are fixed at import; raise the limit or compare titles if that bites.
    gh issue list -R "$where" --state all --limit 200 --json number,state,title --jq '.[] | [.number, .state, .title] | @tsv' |
      while IFS=$tab read -r n state title; do
        stage=$(stage_of "GH-$n")
        case $state:$stage in
          OPEN:) log "GH-$n" todo "" "$title" ;;
          OPEN:done) log "GH-$n" todo ;;
          CLOSED:|CLOSED:done) ;;
          CLOSED:*) log "GH-$n" done ;;
        esac
      done
    ;;
  ls)
    [ -f "$file" ] || exit 0
    awk -F'\t' -v OFS='\t' '
      !($2 in stage) { order[++n] = $2 }
      { stage[$2] = $3; at[$2] = $1; if ($4 != "") owner[$2] = $4; if ($5 != "") title[$2] = $5 }
      END { for (i = 1; i <= n; i++) { k = order[i]; print k, stage[k], owner[k], at[k], title[k] } }' "$file"
    ;;
  *) die "unknown command: $command" ;;
esac
