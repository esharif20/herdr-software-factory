# /tsf plan
1. Read `.tsf/factory.md` and the user's goal. Read only the code needed to split the work.
2. Copy `.tsf/spec.md` to `.tsf/<name>.md` and fill it: one section per ticket, each with depends, parallel, writes (globs, no overlap between parallel tickets), gated, done-when.
3. Route by shape: independent tickets go parallel; a feature split at a written contract gets two Workers; an indivisible ticket gets one; under ~30 lines the lead does it.
4. Add tickets to the board: `sh ~/.config/herdr-app/mods/orchestration/harness/tickets/ticket.sh <project> add "<title>"`.
5. Print the ticket table (id, depends, parallel, writes, gated) and wait for approval.
