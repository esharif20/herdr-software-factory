# /tsf commands (init, plan, batch, status)

The older batch-mode commands. Use them only when the person types `/tsf <subcommand>`.


# /tsf

Print this table and wait for the user's choice. Read nothing else until a subcommand runs; then read only its cookbook.

| Subcommand | Does | Read |
|---|---|---|
| `init` | Installs `.tsf/` into the current repo: `sh ~/.claude/skills/tsf/init.sh [dir]` | none |
| `plan` | Turns a goal into a spec with tickets, dependencies and parallel markers | `~/.claude/skills/tsf/cookbooks/plan.md` |
| `batch` | Writes a batch TSV and runs it with `batch.mjs` | `~/.claude/skills/tsf/cookbooks/batch.md` |
| `status` | Shows board, batch summary and cost | `~/.claude/skills/tsf/cookbooks/status.md` |

Tools: `~/.config/herdr-app/mods/orchestration/harness/` (tickets, gate, capacity, batch, pulse, summaries, metrics).
Rule: models never wait, code waits. Every action here is a command; never poll, never sleep.
