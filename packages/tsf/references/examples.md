# Four worked plans

Short versions: the lane, skills, seat and review lines, plus the reasoning. Real plans also carry acceptance and verify commands, globs, the contract, the code map, `structure:` and `prose:`.

## 1. UI-heavy feature (one PRD, about 12 issues, a Node app with a browser UI)

Issues touch: money maths (splits, transfers), people and invites, chores rotation, a new Home dashboard, CLI commands.

```
lane money: GH-1 GH-2                 src/money.mjs src/expenses.mjs src/transfers.mjs test/splits* test/balances*
lane people: GH-4 GH-5                src/members.mjs src/invites.mjs test/members* test/invites*
lane chores: GH-6 GH-3                src/chores.mjs src/rotation.mjs test/chores*
lane home: GH-7 GH-8 GH-9             public/** src/dashboard.mjs src/notices.mjs test/render*
skills home: frontend polish
seat money: lane-builder (money rounding and transfer plan)
review: GH-1 GH-5 GH-3
```

Why:
- 4 areas in separate files, so 4 lanes.
- CLI commands (GH-10..12) went to the people lane, which has the least work. It owns `src/cli.mjs`, and the others leave a one-line wiring note.
- Only the UI lane gets skills: `frontend`, plus `polish` because GH-8 is a new interactive picker.
- Money is Opus for rounding.
- Reviews cover money (GH-1), invite permissions (GH-5) and the rotation logic (GH-3).

structure (example):
```
- One module per domain; it owns its SQL, checks and row mapping; app.mjs and cli.mjs are thin callers.
- Splits, transfer plan and due dates are pure exported functions, tested without a db.
- Shared checks live in validate.mjs, time in clock.mjs; never duplicate them.
- public/render.mjs stays pure; DOM and fetch code only in public/app.mjs.
- Keep v1 style: small functions, one-line file header, no new dependencies.
```

## 2. Backend milestone (6 issues, Python service, no UI)

Issues: product import (CSV parser), stock counts, purchase orders, order allocation (reservation rules), API token roles, low-stock report.

```
lane catalogue: GH-1 GH-6            stockroom/io/** stockroom/reports/** tests/test_import* tests/test_low_stock*
lane stock: GH-2 GH-3                stockroom/domain/counts.py stockroom/domain/purchasing.py stockroom/db/repos/{counts,purchase_orders}.py tests/test_{counts,purchase_orders}*
lane orders: GH-4 GH-5               stockroom/domain/allocation.py stockroom/domain/orders.py stockroom/http/auth.py stockroom/config.py tests/test_{allocation,auth}*
skills catalogue: backend
seat orders: lane-builder (allocation rules and auth roles)
review: GH-4 GH-5 GH-3
```

Why:
- 3 lanes, not 6: pairs of issues share files.
- Only the CSV parser lane gets `backend` (test-first pays on malformed input). The others are CRUD and wiring, so they get none.
- Scaffold first: you add the migration table list in `db/migrate.py` (about 2 minutes), so no lane owns it.
- `cli.py` belongs to the catalogue lane, and the others leave wiring notes.

## 3. Bug-fix batch (5 small bugs reported by users)

```
lane fixes: GH-21 GH-22 GH-24        (export, dates, totals: all in src/report/**)
lane ui-fixes: GH-23 GH-25           (public/**)
skills fixes: bugs
skills ui-fixes: bugs frontend
review:
```

Why:
- The bugs fall in two file areas, so 2 lanes. Each builder captures the failure first (`bugs`), then fixes it.
- No review: each fix comes with a failing test that now passes, and none touch money or auth.

## 4. Tiny serial change (add a field end to end, about 10 minutes)

```
lane main: GH-31
```

Why:
- Schema, then API, then UI, each step needing the last. Splitting would only add waiting and merges.
- No skills line, no review, Sonnet seat.
- Consider doing it yourself if it is under about 30 lines.
