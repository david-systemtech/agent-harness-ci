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

A pnpm workspace (`packages/`: `contracts`, `filesystem` (owned-tree cleanup
shared by the environment and launcher, on Node built-ins alone), `environment`, `client-runtime`,
`theme` (the seed-to-token maths, on contracts alone), `browser` (what
runs in every browser, the extension's pages and a page's isolated world as
much as the environment's jsdom: on contracts alone, Mozilla Readability
vendored, with no Node built-in and no environment code), `extension` (the MV3
extension Chrome loads unpacked, its service worker and options page: on
contracts and the browser package alone, bundled by Vite into its `dist`,
where the environment finds the extension it unpacks), `tui`, `gui` (the
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
- The browser package's tests run under Node and parse their pages with jsdom
  (`packages/browser/test/pages.ts`; the fixtures in `test/fixtures/` are
  served pages, trimmed, their values faked), and are type-checked by
  `packages/browser/tsconfig.test.json`, which has the DOM's types. The CDP
  page driver is tested over the scripted CDP peer, the package's testing
  export (`@agent-harness/browser/testing`, its own project
  `tsconfig.testing.json`, the one part of the package that imports Node), on
  a loopback WebSocket and a pipe. Its fixture-page suite against a real
  Chromium skips unless `AGENT_HARNESS_CHROMIUM` names one; running it is the
  manual checklist in `docs/agents/browser-checklist.md`. Never launch a
  browser on the shared agent box.
- Code copied from another project, rather than taken as a dependency, lives
  in a `vendor/` folder beside what uses it, with that project's licence and
  notice files; each copied file keeps its own notice and names the
  repository, the commit and what was changed (Playwright's aria snapshot,
  `packages/browser/src/snapshot/vendor/`, #544; Mozilla Readability,
  `packages/browser/src/vendor/`, #545, kept as Mozilla wrote it and so
  neither type-checked nor linted here).
- The extension's tests run under Node: the service worker against the fake
  `chrome` API (`packages/extension/test/fake-chrome.ts`, whose tabs and
  debugger are the scripted CDP peer's) and a scripted environment speaking
  the bridge protocol on a loopback WebSocket (`test/scripted-environment.ts`),
  on a manual clock, and the options page in a jsdom window over its markup,
  type-checked by `packages/extension/tsconfig.test.json`. `pnpm --filter
  @agent-harness/extension build`, a step of `pnpm build`, bundles it into
  `packages/extension/dist`; the build's test bundles it into a scratch folder
  and runs the built worker on a thread with the fake `chrome`
  (`test/built-worker-thread.ts`), the environment's extension tests build
  `dist` and unpack it, and its end to end (`extension-pages.test.ts`) builds
  one of its own and runs the unpacked worker on such a thread. Never load it in a
  browser on the shared agent box: what only a real Chrome proves is the
  extension section of `docs/agents/browser-checklist.md`.
- The desktop shell (`packages/desktop`) takes Electron as a dev dependency
  whose package downloads its binary the first time Node requires it, never
  on install, so CI and the agent box hold none. Its tests drive the main
  process's modules with Electron's modules faked and the platform injected
  (`packages/desktop/test/fake-electron.ts` and `harness.ts`), the shell's
  `service` over a fake server artefact whose CLI answers the `service` verbs
  from a file (`test/fake-artefact.ts`; no service manager is touched), its
  `update` over the OS's commands faked and Node's file calls recorded on
  scratch folders (`test/fake-system.ts`; no `ditto`, `pkexec` or setup
  runs), and build the preload bundle with Vite and evaluate it as the sandbox would; no
  test may import `electron` or `src/main.ts`. What only a real window can prove is the
  manual checklist in `docs/agents/desktop-checklist.md`, run (or listed as
  not run, per platform) when the shell changes. Never run Electron on the
  shared agent box.
- The release build, `pnpm --filter agent-harness build-artefacts` (`packages/cli/scripts/release/`, #356),
  assembles the three server artefacts (each with its own Node, `bin/agent-harness`, the CLI
  and the packages it runs with their production dependencies for that platform), their
  `.sha256` sidecars and `release.json`. It runs on a linux-x64 runner, where `node-pty`
  compiles for the Linux artefact; the macOS and Windows artefacts take `node-pty`'s
  prebuilds and the SDK's Claude package for their platform. Its tests run it over a fixture
  workspace (`packages/cli/test/release-fixtures.ts`), downloading and installing nothing; a
  real run downloads Node's archives and packs three artefacts of about 160 MB each, which
  the release workflow does. What only a machine of each platform proves is the Server
  artefacts section of `docs/agents/service-install-checklist.md`. The release workflow
  (`public/.github-workflows/release.yml`, #1258) builds public `v*` tags on hosted GitHub
  runners, publishes the complete GitHub release and pushes its versioned image to GHCR.
  The snapshot publisher (#1275, PR #1277) installs this overlay as `.github/workflows/release.yml`
  in the public repository using a push token with `workflow` scope; the private root holds no workflows.
  Manual dispatch builds all assets with a synthetic version without publishing; Forgejo's
  release workflow is manual recovery only. For tagging, snapshot checks, dry runs and public
  visibility, read `docs/agents/releases.md`. Its publish step uses `pnpm --filter
  agent-harness publish-release` (`scripts/release/publish.ts`, notes from `notes.ts`),
  tested against the fake release API in `packages/cli/test/fake-forgejo-releases.ts`.
  `test/github-release-workflow.test.ts` checks the hosted workflow; a real tag run is
  the service-install checklist's Release section.
- The desktop build, `pnpm --filter @agent-harness/desktop build-desktop --platform <p>
  --tag v<version> --server <that platform's server artefact> --out <folder>`
  (`packages/desktop/scripts/desktop-build/`, #423), builds one platform's desktop on
  that platform (the Windows setup on an x86_64 Linux with Wine too): the macOS zip
  (darwin-arm64), the Windows NSIS setup (win32-x64) or the Arch package (linux-x64). It bundles the main process and the preload, builds the `gui`
  stamped with the version, checks that the server artefact is that platform's and
  version's, and has electron-builder (a dev dependency of the desktop) pack them, the
  artefact into the app's resources. Its tests fake electron-builder and the compile and
  read what they are handed; `bundle.test.ts` bundles the main process and the `gui`
  build with Vite, running neither. Never run electron-builder's packaging on the shared
  agent box. The `desktop` workflow (`.forgejo/workflows/desktop.yml`) runs it by hand:
  the Arch package on `ci-x64`, the zip on the Mac's `macos` runner, and the Windows
  setup on `ci-x64` in electron-builder's Wine image (#359), since no runner has Windows
  and electron-builder on Linux runs the setup under Wine to write its uninstaller. A
  tag's GitHub release builds each on hosted runners (arm64 macOS, Ubuntu for Arch and
  Windows with Wine) and hands it to the release job through workflow artifacts.
  Forgejo's manual recovery uses the generic package registry
  (`.forgejo/scripts/desktop-builds.sh`, tested by `test/desktop-builds-script.test.ts`).
  Building and installing each is the desktop checklist's
  "Building a desktop" and "The packaged desktop".
- `packages/contracts/schema/` is the JSON Schema export of every contracts
  schema, committed as the release artefact for clients in other languages.
  After changing a schema run `pnpm --filter @agent-harness/contracts
  export-schemas` and commit the result; CI regenerates it and fails on drift.
  A merge conflict in the export is settled by regenerating it, never by hand:
  resolve the TypeScript sources, run `export-schemas` (it rewrites the whole
  directory, conflict markers included) and `git add -A packages/contracts/schema`.
  Run it after any merge that changed `packages/contracts/src` as well, since a
  clean merge can still leave the export stale. Each environment notice type is
  an `anyOf` entry of its own beside its gloss, so two changes that add notices
  in different places merge there without a conflict (#817,
  `schema-export-merge.test.ts`); two that append at the same place conflict in
  `notices.ts` too. Keep merge settings for the export out of `.gitattributes`:
  Forgejo decides mergeability with `git merge-tree`, which runs no custom merge
  driver and does apply the built-in `union`, which joins both sides' lines into
  invalid JSON and reports no conflict.
- The bank validator is the contracts' `./bank-validator` entry (pure functions,
  kept out of the index so no client bundles the YAML library). `pnpm --filter
  @agent-harness/contracts build-validator` bundles it with Vite into the one
  Node file each bank vendors, `packages/contracts/dist/bank-validator/validate.mjs`,
  whose first line is the stamp `// bank-validator <version>` (`BANK_VALIDATOR`).
  Its test (`scripts/bank-validator/build.test.ts`) builds it into a scratch
  folder and runs it with Node inside every fixture bank of
  `test/fixture-banks.ts`, which has one bank per rule; a new rule needs its
  fixture there.
- The IndexRenderer (`packages/environment/src/banks/index-renderer.ts`) is the
  one source of the bank trail, of a bank's fixed-tier bytes (the registry's
  8 KB admission) and of what a pointer reads (`memory_read`): admission,
  placement and the memory tools call it rather than render a bank themselves.
  It reads a bank through `bank-files.ts` (`BANK.md` and `projects/**/*.md` as
  committed at the checkout's head) and `indexBank`, which uses the validator's
  own tree, so the index and the verdict agree on what a memory and a topic are.
- `agent-harness serve` refuses root (ADR 0006), and the agent box and CI's
  test shards run as root: the environment's tests inject a non-privileged
  user check, and the CLI's end-to-end `serve` tests split on the runner's uid
  (the refusal as root, the launcher handshake otherwise), so one is skipped
  there. CI's `ordinary-user` job (agent-harness-ci's `ci.yml`) runs every
  test file that reads `process.getuid` or `process.geteuid` as an ordinary
  user, so a test that splits on the uid reads it that way. To run that side
  on the agent box, copy the worktree, `chown -R` the copy to an unprivileged
  user and run vitest there as that user (`runuser -u nobody`).
- `agent-harness service install|uninstall|status|start|stop` (`packages/cli/src/service/`)
  is tested with the service manager stubbed; `scripts/install.sh` is the
  headless installer, tested by `test/install-script.test.ts` against a fake
  `curl`, and `scripts/install.ps1` its Windows twin, tested by
  `test/install-ps1-script.test.ts` under PowerShell 7 against a fake
  `curl.exe` and `whoami.exe` (CI puts `pwsh` on the job's PATH with
  `.forgejo/scripts/pwsh.sh`; elsewhere those tests skip without one). What
  only a real launchd, `systemd --user` or Task Scheduler can prove
  is the manual checklist in `docs/agents/service-install-checklist.md`, run (or listed as not run, per platform)
  when either changes. The container image (`Dockerfile`) and its compose file
  (`scripts/compose.yaml`) run the environment as a non-root user and are read
  as text by `test/container.test.ts`; building and running them is the
  checklist's Container section. `scripts/host-updater.sh`, the host-side
  updater, is tested by `test/host-updater-script.test.ts` against a fake
  `docker`, `curl` and `flock` and a held clock (a fake `date` and `sleep`);
  running it against a real Docker host is the checklist's Host-side updater
  section. The image's job, `.forgejo/scripts/image.sh` (a pull request's
  build in `.forgejo/workflows/image.yml`, manual recovery in Forgejo's release workflow),
  is tested by `test/image-script.test.ts` against a fake `docker`. Public `v` tags
  build and push to GHCR through `public/.github-workflows/release.yml`; a pull from the registry
  is the checklist's Release image section. Never build or run an image on
  the shared agent box, nor run the updater there.
- Five local lint rules live in `eslint-rules/`. Two enforce ADR 0003 and 0004:
  `agent-harness/no-client-organisation-state` (its allowlisted modules and the
  enumerated presentation keys are constants at the top of the rule) and
  `agent-harness/no-session-types-in-shell` (the shell interface module and
  the whole `desktop` package, whose imports are Electron's too). The third,
  `agent-harness/no-relative-import-into`, refuses a relative import that
  resolves into a named workspace package however it is spelled (the
  environment reaching into a client's or the CLI's folder). The fourth,
  `agent-harness/no-literal-colour` (ADR 0023), refuses a literal colour in
  the packages that paint with the theme's tokens (`gui`, `desktop`, `web`),
  their stylesheets included through ESLint's CSS language (`@eslint/css`)
  and their SVG assets and HTML documents through html-eslint's HTML language
  (`@html-eslint/eslint-plugin`); its two allowlisted modules are named in the
  configuration. The fifth, `agent-harness/no-unmapped-colour-class`,
  refuses a colour utility whose name the GUI stylesheet maps to no token,
  in those same packages' strings, CSS `@apply` and HTML/SVG classes; it
  preserves non-colour overloads such as widths and font sizes.
  `eslint.config.ts` scopes all five, and keeps the JavaScript rules to scripts.

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
