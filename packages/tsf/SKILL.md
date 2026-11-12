---
name: tsf
description: Planning playbook for the Lead of a Herdr lane team (tiny software factory). Read it right before writing .tsf/plan.md, whenever you split work across builder sessions, choose how many lanes or which seat each lane gets, decide which of the person's skills each lane should load, write the plan's structure:/prose: lines, or plan from a Graphify report. Also the entry point for the /tsf commands (init, plan, batch, status).
---

# Planning a lane team

You are the Lead. Your duty prompt already holds the loop (discuss first, start lanes, wait, land, review, finish), so this file only covers the judgment that goes into `.tsf/plan.md`. A good plan is why a team beats one Opus session. A bad split costs more than it saves, so the person would rather have one lane that finishes than five that collide.

If the person typed `/tsf <subcommand>`, read `references/commands.md` instead.

## 1. Look before you split

- **With `.tsf/codemap.md`** (built from a Graphify graph before you start, for repos over about 50 KB of source): it lists each file's functions with line numbers, grouped by community (files that call each other), and the hub files many others use. Copy the plan's code map from it. Communities are your first draft of lanes; each hub file gets one owner lane or a scaffold commit. Open a file only for an exact signature or contract line the map lacks. On bench11 a Lead that had the graph but still read whole files used 119k tokens before starting builders, against 77k without the graph: rebuilding what the map already says is the cost it exists to save.
- **Without it:** read the layout and the files the issues name.

Then read every issue once: its acceptance and the files it implies. Write down, for each issue, the files it will create or change. Every later decision comes from that list.

## 2. Split into lanes

A lane is a file-disjoint code area that one builder carries through every milestone, in issue order. Lanes are never milestone waves: a wave makes everyone wait on the slowest issue, while a lane keeps its builder warm in one area.

**Grouping:** put issues together when they touch the same files. A file wanted by two lanes goes to one of them. The other lane builds against the contract (signatures, schema, error codes) you write in the plan.

**How many lanes:**
- **1** when the work is serial (each issue needs the last) or about 10 minutes of work in total. A team only pays when there is real parallel work.
- **2–4** by default. Measured on bench11: 3 lanes finished 40% faster than solo, while 5 lanes finished only 35% faster and had a merge slip and 7 files touched by two lanes. bench10, whose areas were cleanly separate, did well with 5.
- **More than 4** only when each lane owns a truly separate area (different folders, no shared entry file) and has at least 2 issues or about 5 minutes of work.
- **Ceiling:** never more than `sh ~/.config/herdr-app/mods/orchestration/harness/capacity/capacity.sh builder` prints (free RAM).
- **Balance:** balance by work, not by issue count. One hard issue can be a lane on its own.

**Don't split one issue across lanes** (no `GH-7-ui` halves). Give the issue to the lane that owns most of its files, and have it call the other lane's contract. Split halves have to land in order and double the handoffs.

**Scaffold first, about 2 minutes, only when needed:** if several lanes need a new shared schema, helper, route table or CLI entry, write it yourself as one commit on main before starting the lanes. Then each lane adds to it in its own files. Without a scaffold, the shared file goes to one lane, and the others build against its contract.

**Shared entry points** (cli.py, app.mjs, routes index, README): give each one to exactly one lane. Other lanes write their parts in their own files and leave a one-line wiring note. The owner, or you at the end, wires them in. This is where merge conflicts come from, so decide it explicitly.

**Docs, seed data, README:** these go in the lane with the least work, from the start.

## 3. Pick each lane's skills

Run `node ~/.config/herdr-app/mods/orchestration/harness/skills/skills.mjs groups` to see the person's map. Each group has an id, a title and a `when`. Write a line only for lanes that need one:

```
skills web: frontend motion
skills fixes: bugs
```

Every skill a builder reads is re-sent on each of its ~100 turns, so give only what changes how the lane works:
- **frontend** for any lane that touches UI.
- **polish, motion, landing, mobile** only when an issue asks for that kind of work: new interactive components, animation or drag, a public page, a phone layout.
- **bugs** for bug-fix issues: capture the failure first.
- **backend** (test-first) only for a parser, an algorithm or rules with many edge cases. Not for CRUD, routes, exports or wiring.
- **money** for payment work.
- **ai** for LLM features.
- **None** otherwise. No line is the default and the cheapest choice. A bench12 run that gave every lane `backend` cost 58% more than solo for no quality gain.
- You may name a single skill instead of a group (`skills web: frontend gestures`).
- **The person decides last.** If they add or drop a skill, run `node .../skills.mjs lane <dir> <lane> add|rm <group-or-skill>`, then `hc send` that lane's builder: "skills changed for lane <l>: re-read skills.mjs paths".

The `always` group (code-structure, unslop) is not a lane line. You apply it once, in section 4.

## 4. structure: and prose:

Read the skills in group `always` once (their SKILL.md paths come from `skills.mjs installed`). Write what they mean for this repo, at most 5 lines each, as rules a builder can follow without opening the skill.
- `structure:` comes from code-structure. The repo's existing architecture wins. Its actions-and-services pattern is the default only when the repo has none.
- `prose:` comes from unslop. It covers everything a person reads: commit messages, PR titles and bodies, README, docs and code comments. Name real files and helpers from the code map: generic lines like "write clean code" change nothing a builder does. See `references/examples.md` for good ones.

## 5. Seats and reviews

- **Seat:** `lane-builder-standard` (Sonnet) by default. Use `lane-builder` (Opus) only for a lane that holds money, security, data deletion or genuinely hard logic (a scheduler, a solver, concurrency). Opus costs about 5× more per turn, so name the reason in the plan.
- **`review:`:** at most 3 issue ids, the riskiest by consequence if wrong: money, auth or permissions, data deletion, then the most intricate logic. A review starts only after its issue lands, so pick issues whose bugs tests would miss. A bug batch or a tiny change may need none.

## 6. Other seats' skills

When you start the UI Polisher or the Researcher, list SKILL.md paths in their brief (from `skills.mjs installed`).
- **UI Polisher:** groups `ui-proof` and `polish`, plus `frontend`.
- **Researcher:** usually none. Add the stack's group when the question is about that stack, and `design-taste-frontend` for a frontend review.
- **You, while discussing with the person:** group `lead` (grilling, domain-modeling, codebase-design, new-feature) shapes the questions, GLOSSARY.md and ADRs.
- **Research:** domain knowledge, ADRs, prior art and frontend reviews go to a research subagent (Sonnet) or the Researcher seat, with findings in `.tsf/research/<topic>.md`. Your context stays for planning.
- **Reviews:** the review subagent applies the Standards and Spec axes of `code-review`, without starting its own sub-agents.

## 7. The plan, in order

```
lane <l>: GH-a GH-b              one line per lane, issues in build order
skills <l>: <groups or skills>   only for lanes that need any
seat <l>: lane-builder (reason)  only for Opus lanes
review: GH-x GH-y GH-z           at most 3
```

Then:
- per issue: acceptance and one verify command (its targeted tests);
- per lane: the files it owns, as globs;
- the shared contract;
- the code map: file, role, key exports with line numbers;
- `structure:` and `prose:`.

See `references/examples.md` for four worked plans: a UI-heavy feature, a backend milestone, a bug batch and a tiny serial change.

## Before you start the lanes, check

- Every issue is in exactly one lane, and no glob is shared between lanes.
- Each lane has at least 2 issues or about 5 minutes of work, or a reason to stand alone.
- Every UI lane has `frontend`, and no lane has a group it doesn't need.
- The shared entry files each have one owner.
- At most 3 review ids, and an Opus seat only with a reason.
