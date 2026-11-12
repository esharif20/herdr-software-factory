# 8. The MVP: lane teams, skills, and the packages

Three benches, three wins over solo Opus, inside the cost cap. This post covers the team shape that got there, what cost too much on the way, how skills reach each builder, and what you can install today.

## The numbers

Solo is one Opus session with full settings: every skill, plugin and subagent it wants. The team gets the same brief, the same mid-run arrivals and the same hidden tests.

| Bench | The work | Solo | Team | Time | Cost | Hidden tests (team / solo) |
|---|---|---|---|---|---|---|
| bench10 | One feature in an existing app, a change mid-run | 25:36, $7.64 | 9:59, $6.61 | −61% | −14% | 203 / 203 of 205 |
| bench11 | Three milestones of issues, an urgent bug and a change mid-run | 26:23, $15.99 | 16:47, $12.15 | −36% | −24% | 172 / 171 of 172 |
| bench12 | Two milestones on a Python service, an urgent bug mid-run | 18:09, $6.33 | 10:27, $6.85 | −42% | +8% | 140 / 140 of 140 |

The goal was at least 30% faster on three benches, quality as good, and extra cost only where speed pays for it (speed-up minus 25 points, never above +15%). All three pass.

## The team that won

Five seats, down from nineteen.

- **Lead** (Opus). Plans with you, writes `.tsf/plan.md`, starts every lane in one turn, lands lanes, starts reviews. It never builds a lane.
- **Lane builders**. Sonnet by default, Opus only for a lane holding money, security, data deletion or hard logic, with the reason written in the plan. One builder per lane, in its own worktree, carrying its files from the first milestone to the last.
- **Researcher** and **UI Polisher**, on demand.

Reviews are not a seat. When one of the three riskiest issues lands, the Lead starts a read-only Opus subagent on that commit. It reports defects with file, line and a failing case. The builder turns each into a failing test, then fixes it.

Everything that can be a script is one, so it costs no tokens and never gets skipped. `ready.sh` checks that a lane touched only its own files and that its tests pass, then records the exact commit. `land.sh` merges that commit, not the branch, runs the tests and undoes the merge on red. `status.sh` tells the Lead which lanes are free, stalled or due a review. `capacity.sh` caps lanes by free RAM. `finish.sh` runs the full suite and prunes branches and worktrees.

## What cost too much

Two runs went over the cap, and both taught us something we then wrote down.

- **A full-settings Lead.** Giving the Lead every plugin and skill raised its start-up context from about 14k to 31k tokens, re-sent on every turn. With every builder also reading every skill file, bench12 cost 58% more than solo for the same tests. The Lead now runs bare and distils the always-on skills (code-structure, unslop) into five-line `structure:` and `prose:` rules in the plan.
- **Opus everywhere and a split issue.** One bench12 plan put three of five lanes on Opus and split an issue across two lanes: 48% faster, but 25% dearer. The planning skill below fixed it. The rerun had three lanes, one Opus seat, and came in at +8%.

## Skills, per lane

You have skills; the team should use them, but a skill a builder reads is re-sent on each of its ~100 turns. So skills come in groups (frontend, polish, motion, mobile, backend, bugs, money, ai and more), and the plan names only what each lane needs:

```
skills web: frontend motion
skills fixes: bugs
```

Builders run `skills.mjs paths` and read exactly those. You can change a group or one lane's skills from the Factory view's Skills tab, and the Lead tells the builder.

The Lead has its own: grilling, domain-modeling and codebase-design while it plans with you, and `tsf` right before it writes the plan. We built `tsf` with skill-creator and tested it on four planning tasks. Plans written with it passed 96.5% of the checks, against 88.5% without, mostly by giving fewer lanes skills they did not need and fewer seats Opus.

## Graphify

Graphify turns a repo into a code graph and a short report, so the Lead could take its code map from the report instead of reading files. We build it before the Lead starts, with no tokens spent, so the Lead can't skip the step.

On bench11 (161 KB of source), having the graph did not make planning lighter. The Lead had 119k tokens of context when it started the builders, against 77k without the graph, and cost $4.56 against $3.10. The report itself is only about 1k tokens. The extra came from the Lead reading whole source files anyway, about 50k characters of them, on top of the graph. The run was faster (−45% against −36%), but that plan also put all four lanes on Opus, so the graph doesn't get the credit.

So the graph now does the job the Lead was spending those tokens on. `codemap.mjs` turns `graph.json` into `.tsf/codemap.md`: each file's functions with line numbers, grouped by community, and the hub files that several communities use. On bench11 that is 7 KB, about 1.8k tokens, for 77 files. The Lead copies its code map from it, takes the communities as a first draft of lanes, and gives each hub file one owner. Builders read it instead of exploring. It is built before the Lead starts, for repos over 50 KB of source.

CODEMAP_RESULT

## Install

See the [README](../README.md#install): one curl line, or clone and run `./install.sh`. The two Herdr mods are also in [`herdr/`](../herdr) in the layout Herdr uses to share mods.

## Next

- Run it on real projects, not benches, and keep the posts coming.
- A preview image of a demo team for the herdr.dev listing.
- Match a trailing `(GH-n)` in commit subjects, so lanes that name the issue last still count as done.
