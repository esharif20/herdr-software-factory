# Skill packs

The team's prompts and the skill groups in `herdr-team` name these skills. `fetch.sh` downloads each one from its author's repo at the commit listed in `skills.tsv`, into `~/.claude/skills/<name>`. Nothing here is a copy of their code, except `design-md/SKILL.md`, which is ours.

```sh
sh packages/skill-packs/fetch.sh              # all of them
sh packages/skill-packs/fetch.sh tdd unslop   # just these
```

An existing skill with the same name moves to `~/.herdr-software-factory/backups/<time>/` first. Downloads are cached in `~/.herdr-software-factory/cache/`.

## What gets fetched

| Skills | Source | Licence | Used for |
|---|---|---|---|
| unslop, greploop | [michaelshimeles/rstack](https://github.com/michaelshimeles/rstack) | MIT (per skill) | `prose:` rules in every plan; review loop on a PR lane |
| new-feature, code-structure, evidence-driven-testing | [michaelshimeles/rstack](https://github.com/michaelshimeles/rstack) | none stated upstream | worktree isolation; `structure:` rules; capture the failure before a UI or bug fix |
| grilling, domain-modeling, codebase-design, tdd, diagnosing-bugs, code-review | [mattpocock/skills](https://github.com/mattpocock/skills) | MIT | the Lead's planning talk with you, the `backend` and `bugs` groups, review subagents |
| emil-design-eng, apple-design, animate, choreograph, gestures, mobile-native, write-swift, animate-expo, break-ui | [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT | `polish`, `motion`, `mobile` and `ui-proof` groups |
| shadcn | [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | MIT | `frontend` group |
| impeccable | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Apache-2.0 | `frontend` group |
| ui-ux-pro-max | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | MIT | `frontend` group |
| stripe-best-practices, upgrade-stripe | [stripe/ai](https://github.com/stripe/ai) | MIT | `money` group |
| design-md (library) | [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | MIT | `frontend` group: 84 DESIGN.md files to take tokens from |

The three rstack skills with no licence are downloaded by your install from the author's public repo. Check the repo's terms before you use them in commercial work.

## Not fetched

- **before-and-after** (rstack): PolyForm Shield licence. Its upload step defaults to the public host 0x0.st, which keeps screenshots for up to a year. If you install it yourself, set `IMAGE_ADAPTER` to your own storage.
- **design-taste-frontend**: source not found. The Lead and Researcher read it for frontend reviews when it is installed and skip it otherwise.
- **frontend-design**: a Claude Code plugin. Run `claude plugin install frontend-design@claude-plugins-official`.
- **vercel-plugin:ai-sdk**: part of the Vercel plugin, used by the `ai` group.

Missing skills show dimmed in the Factory Skills tab, and builders skip them.
