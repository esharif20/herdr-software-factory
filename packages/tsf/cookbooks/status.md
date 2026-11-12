# /tsf status
Run, print and stop:
- Board: `sh ~/.config/herdr-app/mods/orchestration/harness/tickets/ticket.sh <project> ls`
- Last batch: `ls -t <project>/.tsf/batches/*.summary.md | head -1`, then read it.
- Cost and time: `node ~/.config/herdr-app/mods/orchestration/harness/metrics/meter.mjs --dir <folder regex>`
- Per-ticket one-liners: `<project>/.tsf/traces/<ticket>.json`
Print one table: ticket, stage, owner, summary, cost.
