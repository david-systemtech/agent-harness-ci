# agent-harness

Working name. This repo has no agreed name yet; rename it once the project has
an identity, and update the remotes of any clone.

## Naming

This repository, its pull requests, issues and commits name no predecessor
product. Describe behaviour, rules and facts directly; never compare them to
a predecessor, and never point at one through a stand-in name such as "the
previous app" or "the legacy app". Before pushing or posting, `grep -i` what
you wrote for the predecessor product's name: it must find nothing.

One exception: the state import's source reader,
`packages/environment/src/state-import/source/`, may contain the source
product's folder names and environment variables, because detecting its data
folder needs them (ADR 0036). The name grep before a push skips that directory's
files and nothing else; posts on the tracker get no exemption.

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
`theme` (the seed-to-token maths, on contracts alone), `tui`, `gui` (the
desktop window's renderer, a React app whose bundle runs in a browser tab
too), `desktop` (the Electron shell that carries the `gui` build), and `cli`,
the `agent-harness` binary). Node 24 or later: the LTS
line, whose `node:sqlite` has the busy `timeout` option and `isTransaction` the
event log uses. The floor was 22.16, the first 22 release with both, until
2026-09-28, when David raised it because Node 22 ends its life in April 2027.
pnpm comes from the `packageManager` pin through `corepack enable`.

- `pnpm install`, then `pnpm typecheck` (`tsc -b`), `pnpm lint` and `pnpm test`
  (Vitest, every package's suite); CI runs the same three.
- One native dependency: `node-pty` (the environment's terminals), an
  optional dependency of the environment pinned exactly and allowed its
  install script in `pnpm-workspace.yaml` (`onlyBuiltDependencies`). On Linux
  it compiles with node-gyp, which needs python3, make and g++ (CI's
  `node:24-bookworm` has them); macOS and Windows take its prebuilds. Where it
  cannot build, `pnpm install` still succeeds and leaves it unbuilt; the
  environment loads it on the first terminal only, so such a machine runs
  everything else and `terminals.open` answers `pty_unavailable` (and the
  real-pty terminal tests fail there).
- The GUI's tests run in jsdom through its harness (`packages/gui/test/harness.tsx`:
  the app over the runtime on the desktop platform, over the recording fake
  shell answering `http`, `localGrant` and `secrets` for the scripted
  environment, driven by user-event), and are type-checked by
  `packages/gui/tsconfig.test.json`, which has the DOM's types. IndexedDB,
  which jsdom lacks, is `fake-indexeddb` in the tests that need it. `pnpm --filter @agent-harness/gui build` writes its static bundle to
  `packages/gui/dist/` with Vite; never serve it or open it in a browser on
  the shared agent box.
- The desktop shell (`packages/desktop`) takes Electron as a dev dependency
  whose package downloads its binary the first time Node requires it, never
  on install, so CI and the agent box hold none. Its tests drive the main
  process's modules with Electron's modules faked and the platform injected
  (`packages/desktop/test/fake-electron.ts` and `harness.ts`), the shell's
  `service` over a fake server artefact whose CLI answers the `service` verbs
  from a file (`test/fake-artefact.ts`; no service manager is touched), and
  build the preload bundle with Vite and evaluate it as the sandbox would; no
  test may import `electron` or `src/main.ts`. What only a real window can prove is the
  manual checklist in `docs/agents/desktop-checklist.md`, run (or listed as
  not run, per platform) when the shell changes. Never run Electron on the
  shared agent box.
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
  when either changes. The container image (`Dockerfile`) and its compose file
  (`scripts/compose.yaml`) run the environment as a non-root user and are read
  as text by `test/container.test.ts`; building and running them is the
  checklist's Container section. Never build or run an image on the shared agent box.
- Four local lint rules live in `eslint-rules/`. Two enforce ADR 0003 and 0004:
  `agent-harness/no-client-organisation-state` (its allowlisted modules and the
  enumerated presentation keys are constants at the top of the rule) and
  `agent-harness/no-session-types-in-shell` (the shell interface module and
  the whole `desktop` package, whose imports are Electron's too). The third,
  `agent-harness/no-relative-import-into`, refuses a relative import that
  resolves into a named workspace package however it is spelled (the
  environment reaching into a client's or the CLI's folder). The fourth,
  `agent-harness/no-literal-colour` (ADR 0023), refuses a literal colour in
  the packages that paint with the theme's tokens (`gui`, `desktop`, `web`),
  their stylesheets included through ESLint's CSS language (`@eslint/css`);
  its two allowlisted modules are named in the configuration.
  `eslint.config.ts` scopes all four, and keeps the JavaScript rules to scripts.

## Merging

`main` is merged only when every check is green, and nothing is pushed to it
directly. CI and the AI pre-review run on the shared Forgejo runners from
`david/ci` (see its `README.md`). The review is a lead to check, not an
approval: prove a finding before acting on it.

Push a pull request once per round, not once per fix. Every push runs the
whole suite on the shared runners, which the other repositories wait behind,
and a review covers only the head it read, so a new head needs the
`ai-review` label again. Before pushing, run `pnpm typecheck`, `pnpm lint`
and the test files you touched, and push everything that round's work (or
that review's answers) needs together. Between 2026-09-28 and 2026-09-29, 69
pull requests took 189 CI runs, one of them 12, and each run occupies a slot
for 3 to 14 minutes.
