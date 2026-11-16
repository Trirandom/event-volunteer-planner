# AGENTS.md

Instructions for coding agents working in this repository, whatever the tool.
It points at the sources rather than repeating them, so it can't drift from
them. On any disagreement the docs win (`docs/`, `docs/adr/`, then
`CONTRIBUTING.md`).

## Read first

1. **[CLAUDE.md](CLAUDE.md)**: the map of the repository. It isn't specific to
   Claude, whatever the name says: what is built, the commands, the
   architecture and the non-negotiables. Read it whole before the first change.
2. **[.claude/skills/dev/SKILL.md](.claude/skills/dev/SKILL.md)**: the working
   loop, which is one worktree and Compose project per change, red → green →
   refactor, micro commits, when an ADR is needed, which docs move with the
   code, and the gates before a PR. Claude Code loads it as the `dev` skill.
   Any other agent reads it as plain Markdown before starting a change.
3. The numbered doc and the ADRs for the area you are changing
   (`docs/README.md` has the map).

## The harness

| Piece | What it does | Applies to |
| --- | --- | --- |
| `CLAUDE.md` | Repository guide and non-negotiables | every agent |
| `.claude/skills/dev/` | The development loop | every agent (Claude Code loads it on demand) |
| `.claude/settings.json` | Registers the hooks below, committed | Claude Code |
| `.claude/hooks/commit-message.ts` | Refuses a `git commit` whose message breaks the convention | Claude Code (PreToolUse on Bash and PowerShell) |
| `just check`, `just test`, CI | The project's gates (`docs/11 §7`) | everyone, people included |

`.claude/settings.local.json` is personal and gitignored. Shared behaviour
goes in `settings.json`.

The hook's tests run in `just test` (the `harness` Vitest project), so a
change to it is held to the same suite as the applications.

## Rules for every agent

- **One worktree and branch per change**, never `main`, never someone else's
  checkout (dev skill §1). Commit, push and open PRs only when asked.
- **Commit messages explain why, not what.** The diff shows what changed. The
  body says why it was needed, why the obvious approach was wrong, and what
  was rejected. Format and example: [CONTRIBUTING.md](CONTRIBUTING.md#commit-messages).
  Claude Code is held to the checkable parts by the hook. Other tools aren't
  hooked and follow the same convention by hand. Always commit with `-s`.
- **Never route around a gate.** No `--no-verify`, no disabled lint, no
  skipped or retried test. A suppression carries its reason
  (`#[expect(…, reason)]`, a described `eslint-disable`). When a hook or gate
  refuses, fix the cause.
- **Decisions are recorded, not made silently.** A change that contradicts an
  accepted ADR needs a new ADR first (dev skill §5).
- **Never commit real volunteer data**, `.env`, or anything under
  `docs/googleSheets/example_data/`. Stage paths explicitly.
