# agent-harness

Working name. This repo has no agreed name yet; rename it once the project has
an identity, and update the remotes of any clone.

## Agent skills

### Issue tracker

Issues live as Forgejo issues on the self-hosted instance at
`https://git.systemtech.dev:5526` (repo `david/agent-harness`), driven by the
Gitea-compatible REST API with `curl` — there is no CLI for this host.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name: `needs-triage`,
`needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. All five already
exist in the repo. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and one `docs/adr/` at the repo root.
See `docs/agents/domain.md`.

## Building

A pnpm workspace (`packages/`: `contracts`, `environment`, `client-runtime`,
`tui`, and `cli`, the `agent-harness` binary). Node 22.12 or later; pnpm comes
from the `packageManager` pin through `corepack enable`.

- `pnpm install`, then `pnpm typecheck` (`tsc -b`), `pnpm lint` and `pnpm test`
  (Vitest, every package's suite); CI runs the same three.
- Two local lint rules in `eslint-rules/` enforce ADR 0003 and 0004:
  `agent-harness/no-client-organisation-state` (its allowlisted modules and the
  enumerated presentation keys are constants at the top of the rule) and
  `agent-harness/no-session-types-in-shell`. `eslint.config.ts` scopes both.

## Merging

`main` is merged only when every check is green, and nothing is pushed to it
directly. CI and the AI pre-review run on the shared Forgejo runners from
`david/ci` (see its `README.md`). The review is a lead to check, not an
approval: prove a finding before acting on it.
