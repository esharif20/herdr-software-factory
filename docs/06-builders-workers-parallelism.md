# 6. Builders, workers and parallelism

This post zooms in on the two layers that do the building, the **builders** and the **workers** inside them, and shows where the speed comes from.

## Two layers, two kinds of parallelism

```mermaid
flowchart TB
    L[Lead]
    L --> BA & BB & BC
    subgraph BA[Builder A · lane money · own worktree]
        direction LR
        A1[Worker 1<br/>T-1 → T-2 → T-3<br/>one warm chain]
        A2[Worker 2<br/>T-4]
    end
    subgraph BB[Builder B · lane invites · own worktree]
        direction LR
        B1[Worker 1<br/>T-5 → T-6]
        B2[Worker 2<br/>T-7]
    end
    subgraph BC[Builder C · lane chores · own worktree]
        direction LR
        C1[Worker 1<br/>T-8 → T-9]
    end
```

- **Across builders**: each builder owns one **lane**, an area of the product that barely touches the others (money, invites, chores). Lanes run at the same time, each in its own git worktree and branch, and build against the plan's agreed interfaces, so they don't wait for each other.
- **Inside a builder**: its **workers** do related work in the same area. Independent tickets run side by side; a chain of tickets on one module (T-1 → T-2 → T-3) goes to **one warm worker** that already knows the code.

## What a builder does

A builder is an Opus session that owns its lane from start to merge:

1. **Writes exact briefs.** It turns each of its tickets into a brief a Sonnet worker can build without guessing: which files, which function signatures from the contract, the edge cases, the tests to write. Every builder does this for its own lane at the same time, so brief-writing is parallel too.
2. **Picks tiers.** Sonnet by default; Opus only for a ticket it can't specify down (a hard algorithm, security, concurrency); Haiku for trivial ones.
3. **Starts its lane** as its own process, the batch loop, which runs the workers, checks and retries without spending tokens.
4. **Answers its workers.** A worker with an unclear brief asks its builder one line; the builder wrote the brief, so it answers.
5. **Reports "ready to merge"** after merging `main` into its branch and running the lane's tests.

## What a worker does

A worker is a Claude Code session on its ticket's model, in its own visible terminal:

1. Reads its brief and the shared notes board.
2. Reads only the files and contract sections the brief points to, by line range.
3. Writes the code and its own targeted tests.
4. Stops. The batch loop then checks scope, gate tests, review and UI polish, and sends any failures back to the **same** worker.

When it finishes, it either takes the next ticket in its chain (staying warm) or is closed at once, so nothing idle is paid for.

## Why warm workers matter

A fresh session spends its first minute and a good share of its cost reading the code. A warm worker skips that.

```mermaid
gantt
    title Three tickets on one module
    dateFormat mm:ss
    axisFormat %M:%S
    todayMarker off
    section Fresh worker each time
    read code      :f1, 00:00, 60s
    build T-1      :f2, after f1, 120s
    read code      :f3, after f2, 60s
    build T-2      :f4, after f3, 120s
    read code      :f5, after f4, 60s
    build T-3      :f6, after f5, 120s
    section One warm worker
    read code      :w1, 00:00, 60s
    build T-1      :w2, after w1, 120s
    build T-2      :w3, after w2, 120s
    build T-3      :w4, after w3, 120s
```

Same work, two fewer reads: about two minutes and two re-reads of cost saved on a three-ticket chain.

## Where the speed comes from

Wall time is set by the **longest chain** of dependent tickets, not by the total amount of work.

```mermaid
gantt
    title Solo vs team on the same 9 tickets (illustrative)
    dateFormat mm:ss
    axisFormat %M:%S
    todayMarker off
    section Solo
    plan           :s0, 00:00, 120s
    T-1 to T-9 one after another :s1, after s0, 1080s
    section Team · lead
    plan + briefs  :t0, 00:00, 180s
    section Team · builder A
    T-1 → T-2 → T-3 (warm) :a1, after t0, 360s
    section Team · builder B
    T-4 → T-5      :b1, after t0, 240s
    T-6            :b2, after t0, 120s
    section Team · builder C
    T-7 → T-8      :c1, after t0, 240s
    T-9            :c2, after c1, 120s
    section Team · merge
    merge lanes    :m1, after a1, 60s
```

The team pays a little more up front (planning, briefs) and a little at the end (merging), and saves everything in between by running chains side by side.

## How the lead decides the shape

More builders and workers are not always faster: each fresh session costs about a minute and some dollars of reading. So the lead adds one only where it shortens the longest chain.

| The job looks like | Shape |
|---|---|
| Small, or every ticket touches the same files | One builder, 1–2 warm workers |
| Milestones that don't depend on each other | One builder per milestone, in parallel |
| Milestone 2 needs milestone 1 merged | Milestone by milestone; parallel area builders inside each |
| One area holds most of the work | Fewer builders, more workers each |

**Cost rule:** the team may cost up to 15–20% more than one solo session, and only if that buys speed. Each 1% of extra cost must cut wall time by at least 2%, so a run costing 15% more must be at least 30% faster. A run near solo's cost must still be faster.

## How the swarm features fit in

The hierarchy stays: lead, builders, workers. Four swarm ideas make it adapt while it runs.

```mermaid
flowchart LR
    subgraph M1[Milestone 1]
        direction TB
        LA[Builder A<br/>nothing ready] -- "1 · steals T-7" --> LB[Builder B<br/>queue: T-6, T-7]
        FL[Floater worker<br/>optional] -. "1 · serves any lane" .-> LB
    end
    N[(2 · notes.md<br/>path:line facts)]
    N --- LA & LB
    E["3 · elastic: ready queue deep<br/>+ RAM free → start a worker"] --> LB
    R["4 · race: hard ticket on the<br/>longest chain → two attempts"] --> LB
```

1. **Work stealing.** A builder with nothing ready takes a ready, unclaimed ticket from another live builder in the same milestone. It builds it in its own worktree; the owner's later tickets merge that branch before they start. A ticket is claimed atomically, so two builders never build the same one. An optional **floater** worker serves any lane.
2. **Shared notes board.** Workers add one-line facts as they find them, such as `src/money.mjs:40 largest-remainder rounding lives here`. Everyone reads it before reading code, so the second worker in an area skips what the first one learned. Capped at about 50 lines.
3. **Elastic scaling.** When ready tickets pile up and memory is free, a lane starts another worker mid-run; when a worker has nothing next, it is closed at once.
4. **Racing a hard ticket.** Only for a hard ticket on the longest chain, and only when the lead marks it: two workers build it in separate scratch worktrees, the first to pass all checks wins, and the other is stopped. Both are paid for, which is why it is used rarely.

```mermaid
sequenceDiagram
    participant A as Builder A (idle)
    participant C as Claims board
    participant B as Builder B (busy)
    A->>C: claim T-7 (atomic)
    C-->>A: yours
    A->>A: build T-7 in worktree A
    A->>C: T-7 done (by lane A)
    B->>B: before T-8: merge lane A's branch
    B->>B: build T-8 on top of T-7
```

## What never changes

- Every builder and worker is a visible, steerable terminal.
- Every ticket is checked (scope, tests, review for logic that must be right, UI polish for new screens).
- Every problem reaches the lead as a held ticket or an alert, with options. Nothing stops silently.
