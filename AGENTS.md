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
`tui`, and `cli`, the `agent-harness` binary). Node 22.16 or later, the first
release whose `node:sqlite` has the busy `timeout` option and `isTransaction`
the event log uses; pnpm comes from the `packageManager` pin through
`corepack enable`.

- `pnpm install`, then `pnpm typecheck` (`tsc -b`), `pnpm lint` and `pnpm test`
  (Vitest, every package's suite); CI runs the same three.
- One native dependency: `node-pty` (the environment's terminals), pinned
  exactly and allowed its install script in `pnpm-workspace.yaml`
  (`onlyBuiltDependencies`). On Linux it compiles with node-gyp, so
  `pnpm install` needs python3, make and g++ (CI's `node:24-bookworm` has
  them); macOS and Windows take its prebuilds. The environment loads it on the
  first terminal only, so a machine where it did not build still runs
  everything else.
- `packages/contracts/schema/` is the JSON Schema export of every contracts
  schema, committed as the release artefact for clients in other languages.
  After changing a schema run `pnpm --filter @agent-harness/contracts
  export-schemas` and commit the result; CI regenerates it and fails on drift.
- `agent-harness serve` refuses root (ADR 0006), and the agent box and possibly
  CI run as root: the environment's tests inject a non-privileged user check,
  and the CLI's end-to-end `serve` tests split on the runner's uid (the
  refusal as root, the launcher handshake otherwise), so one is always skipped.
- `agent-harness service install|uninstall|status|start` (`packages/cli/src/service/`)
  is tested with the service manager stubbed; `scripts/install.sh` is the
  headless installer, tested by `test/install-script.test.ts` against a fake
  `curl`. What only a real launchd, `systemd --user` or Task Scheduler can prove
  is the manual checklist in `docs/agents/service-install-checklist.md`, run (or listed as not run, per platform)
  when either changes.
- Two local lint rules in `eslint-rules/` enforce ADR 0003 and 0004:
  `agent-harness/no-client-organisation-state` (its allowlisted modules and the
  enumerated presentation keys are constants at the top of the rule) and
  `agent-harness/no-session-types-in-shell`. `eslint.config.ts` scopes both.

## Merging

`main` is merged only when every check is green, and nothing is pushed to it
directly. CI and the AI pre-review run on the shared Forgejo runners from
`david/ci` (see its `README.md`). The review is a lead to check, not an
approval: prove a finding before acting on it.
