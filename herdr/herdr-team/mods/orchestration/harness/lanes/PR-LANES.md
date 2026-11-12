# Lanes as pull requests (the repo has a GitHub remote)

Read once, before starting lanes. Everything else in your duty still holds; only landing changes.

- Before starting lanes, run `gh pr list --json number,headRefName,files` and compare the changed files with each lane's globs. A lane that overlaps an open PR waits for it or takes other files (rstack new-feature).
- Each lane is one branch and one PR: tell each builder to `git push -u origin lane/<l>` after its first green commit and open the PR with `gh pr create --base main --head lane/<l>`. The body is exactly `## Why`, `## What`, `## Verification`, with the real check status, written with ~/.claude/skills/unslop/SKILL.md.
- Review: if the repo has the Greptile app, the builder runs ~/.claude/skills/greploop/SKILL.md on its PR (2 rounds at most) while it builds its next issue. Otherwise the review subagent in your duty applies.
- Landing replaces land.sh. On `lane <l> ready <sha>`, in one command: `gh pr checks <pr> --watch --fail-fast`, then `gh pr merge <pr> --merge --match-head-commit <sha>`. Missing checks are not passing checks: no checks reported means blocked, not green. When the PR is only behind main, `gh pr update-branch <pr>` and wait again. Merge one lane at a time, then `git pull --ff-only` on main and tell the other builders `git merge main`.
- Never force-push main. Builders may use `git push --force-with-lease` on their own lane branch only.
- After the last merge, run finish.sh on the updated main as usual.
