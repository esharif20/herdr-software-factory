# /tsf batch
1. Write `.tsf/batches/<id>.tsv`, tab-separated, one row per ticket: ticket, depends-on, role, writes (globs), gated yes/no, brief path. Briefs are complete; a Worker reads nothing else.
2. For gated tickets, a Test writer creates the hidden tests first (`harness/gate/gate.sh <project> <ticket> --path`).
3. Run in the background, then stop and wait for its one wake message:
   `node ~/.config/herdr-app/mods/orchestration/harness/batch/batch.mjs <id> --project <dir> --starter $HC_TERMINAL_ID`
4. Rerun the same command after a crash; it resumes.
5. On the wake, read `.tsf/batches/<id>.summary.md` only. Do not re-review done tickets.
Budgets: `budgets` in `.tsf/settings.json`, else the role's seat in `team.js`. Board: the starter's Herdr space, unless `board` is set in `.tsf/settings.json`.
