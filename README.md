# Herdr Software Factory

A team of AI coding agents, run inside Herdr, that takes a software problem, plans it into milestones and tickets, and builds it **faster than one top-tier model working alone, at the same or better quality, for about the same money**.

This repo is a public build log: what we are trying, why, how it works, what the measurements say, and what broke along the way. The code will follow once the design settles.

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'-apple-system, Segoe UI, Helvetica, sans-serif','fontSize':'15px','lineColor':'#94A3B8','primaryColor':'#EDE9FE','primaryBorderColor':'#7C3AED','primaryTextColor':'#2E1065','secondaryColor':'#F1F5F9','tertiaryColor':'#DCFCE7','clusterBkg':'#FAFAFA','clusterBorder':'#CBD5E1','noteBkgColor':'#FEF3C7','noteBorderColor':'#D97706','actorBkg':'#EDE9FE','actorBorder':'#7C3AED','git0':'#7C3AED','git1':'#0EA5E9','git2':'#16A34A','git3':'#D97706'}}}%%
flowchart LR
    P([Person]) <--> PL[Planner<br/>Opus]
    PL -- plan.md --> L[Lead<br/>Opus]
    L --> F1[Builder factory<br/>Opus · lane A]
    L --> F2[Builder factory<br/>Opus · lane B]
    L --> F3[Builder factory<br/>Opus · lane C]
    F1 --> W1[Workers<br/>Sonnet]
    F2 --> W2[Workers<br/>Sonnet]
    F3 --> W3[Workers<br/>Sonnet / Opus]
    W1 & W2 & W3 --> Q{{Checks<br/>tests · review · UI polish}}
    Q -- held --> L
    Q -- green --> M[(main)]
    class P person
    class PL,L,F1,F2,F3,W1,W2,W3 ai
    class Q check
    class M code
    classDef ai fill:#EDE9FE,stroke:#7C3AED,color:#2E1065,stroke-width:2px
    classDef code fill:#F1F5F9,stroke:#64748B,color:#0F172A,stroke-width:2px,stroke-dasharray:5 4
    classDef check fill:#DCFCE7,stroke:#16A34A,color:#052E16,stroke-width:2px
    classDef person fill:#FEF3C7,stroke:#D97706,color:#451A03,stroke-width:2px
```

## The goal in one line

> Same problem, same brief: the team finishes sooner than a solo Opus session (which may use its own subagents), matches or beats it on hidden tests, and any extra cost buys proportionally more speed.

Speed and quality rank equally first. Cost comes second: at most 15–20% above solo, and each 1% of extra cost must cut wall time by at least 2%.

## Read the posts

| # | Post | What it covers |
|---|---|---|
| 1 | [Why build a software factory](docs/01-why.md) | The problem, the aims, why a team instead of one agent |
| 2 | [How it works](docs/02-how-it-works.md) | Roles, models, lanes, worktrees, the batch loop, checks, holds |
| 3 | [What we have done so far](docs/03-progress.md) | Ten benchmarks, the numbers, what each one taught us |
| 4 | [Post-mortem: the run that stalled](docs/04-bench10-postmortem.md) | A real-world run that lost 30 minutes to the harness, and why |
| 5 | [Where it goes next](docs/05-roadmap.md) | The harness rebuild, swarm ideas, making it reproducible |
| 6 | [Builders, workers and parallelism](docs/06-builders-workers-parallelism.md) | How builders and their workers split the work, why warm workers are cheaper, where the speed comes from, and how the swarm features fit in |

## Status

| | |
|---|---|
| Benchmarks run | 10 (bench1–bench10) |
| Best result so far | bench9: team 19–64% faster than solo across four runs, 89/89 hidden tests on both sides |
| Latest | bench10, the first real-world-style run (existing repo, product brief, mid-run change request): solo won; the team stalled on harness faults |
| Now | Harness rebuilt so no check can silently stop work, plus swarm features (64 harness tests); next, a bench10 rerun |

## Built on

- **Herdr**: a desktop app for running many terminal agents side by side, with mods (UI panels) and layouts.
- **hc** (herdr-core): the command-line tool agents use to start, message, read and wait on each other's terminals.
- **Claude Code** sessions as every agent on the team, on Opus, Sonnet or Haiku depending on the job.

## Licence

MIT. See [LICENSE](LICENSE).
