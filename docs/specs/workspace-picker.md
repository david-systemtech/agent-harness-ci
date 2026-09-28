# Spec: Workspace, repository identity and the environment picker

Milestone 1 (Switch-over), phase B (daily use). Written 2026-09-28 from map ticket 85 of `david/agent-harness`. Implements ADR 0005 (one workspace of three kinds and a repository identity per session, no Project object; the environment-first picker and default rule; name, icon and colour; pooled usage), ADR 0021 (an imported session's missing directory), ADR 0020 (ssh, scp, http and https forms are one identity; forge aliases), ADR 0025 (the Your machines card's name, icon and colour) and ADR 0019 (a minted session's workspace), with ADRs 0003, 0006, 0008, 0018, 0022, 0023, 0027 and 0017; decision ticket #19 and the ticket's two comments. It builds on the six phase-A specs and the code on `main` at 863ab8f, whose names it uses and does not re-decide. Peers read: T3 Code at 96c4bfa0 (repository identity resolver, `normalizeGitRemoteUrl`, worktree storage cleanup, project grouping), Claude Code's worktree documentation. The product name is the placeholder `agent-harness`.

## Problem Statement

David works in the same repositories from a laptop, SYSTEM-SERVER's agent box and the gaming PC, and nothing today treats them as the same repositories. A session's place is a working directory with a served kind beside it (directory, ephemeral scratch, or `none`, which could run nothing); nothing records which repository it holds, so no view can put the laptop's and SYSTEM-SERVER's sessions on one repository together (T3 inventory: no remote-URL identity). The served host never sweeps its scratch directories, since only the desktop host calls the sweep (surfaces audit, section 4). Where code runs is a "run location" inside the account menu. Worktrees exist only behind a suggested-task chip, under the checkout's `.worktrees/`, and nothing removes them. Recent folders are ten per window on the window's machine, not the session's. A conversation whose directory moved has no way back but a new session. Machines have no name, icon or colour of their own, so rows from two machines look alike.

## Solution

Every session has one workspace on its environment: a directory the environment has, a worktree it makes from a repository it has, or a scratch directory that lives with the session. The environment checks or makes it at creation and records the repository identity, one canonical form that every spelling of the remote comes down to. It removes the worktrees and scratch directories it made once their last session is purged, keeping any worktree with uncommitted work and saying where. A workspace that disappears is flagged missing: the session reads as ever and runs nothing until given a new workspace. Starting a session begins with where: environment, account and model chips in that order, then the workspace; each environment heading has its own new-session action; the preset is the focused session's or group's environment, else the last used, else this machine, and switching keeps the login, model and repository where the new environment has them. Each environment stores its own name, icon and colour, so every client draws the same badge, and plan usage is one gauge per account identity.

## User Stories

1. As David, I want the new-session composer to ask where first, then account and model, so that where code runs is never buried in a model menu.
2. As David, I want a new-session action on each environment heading, so that starting work on SYSTEM-SERVER is one click from its heading.
3. As David, I want a new session to default to the environment of the session or group I am looking at, else the last used, else this machine, so that the preset is usually right.
4. As David, I want a session started from a repository heading to default to an environment that has that repository, so that I am never offered a machine without the code.
5. As David, I want switching the environment chip to keep my login, model and repository where the new environment has them, so that moving a new session between machines is one change.
6. As David, I want to pick a directory from those the environment's sessions use, type one, or browse the environment's directories, so that I can reach code on a machine I am not at.
7. As David, I want a session in a fresh worktree on a new branch, so that two agents on one repository never edit one checkout.
8. As David, I want a worktree on an existing branch, so that I can review or continue it without disturbing my main checkout.
9. As David, I want a scratch workspace for a conversation about no code, so that a question never lands in my home directory.
10. As David, I want the ignored files `.worktreeinclude` names (such as `.env`) copied into a new worktree, so that the agent can run the project there.
11. As David, I want worktrees and scratch directories the harness made removed after their session's purge, keeping any worktree with uncommitted work and telling me where, so that disk stays bounded and no work is lost.
12. As David, I want sessions in one repository on two machines under one heading whether each clone used ssh, https, a custom port or a tailnet address, and a monorepo's packages under their repository, so that the by-repository view means what it says.
13. As David, I want a credential embedded in a clone URL never recorded, so that no token reaches the log.
14. As David, I want a session whose directory has gone to show missing, open normally, and ask me for a workspace when I continue it, so that an imported or moved conversation is never lost.
15. As David, I want sessions made before this workstream to gain their identity on their own, so that phase-A sessions join the by-repository view.
16. As David, I want each environment to start with a sensible name, icon and colour that I can change once for every client, so that MNL looks the same everywhere without my setting anything.
17. As David, I want one Claude login on two environments to show one plan gauge, so that I see one budget.
18. As David, I want to hide a directory I opened by mistake from the picker, so that the list stays the directories I use.
19. As David, I want the environment's own git to run no hook or repository filter when it makes or checks a worktree, and the worktree locked while its session exists, so that neither an agent's config nor my own tidying can do harm through it.
20. As David, I want a run contained to a worktree to be able to commit, so that containment and worktrees work together.
21. As Seth, I want the terminal UI's new-session card and `/cwd` to offer a directory, a worktree and scratch and to browse the environment, so that I can start work anywhere from the terminal.
22. As Seth, I want each environment's name and colour on the rail and status line, and `/environment` to set them, so that I tell machines apart without the desktop window.
23. As the setup checklist, I want the Your machines step to write name, icon and colour through registered methods and find the environment named, so that the step registry's contract holds.
24. As the setup checklist, I want a minted session's workspace made by the same resolver, scratch or a bank checkout, so that the step's check finds the artefact.
25. As the Carry over step, I want to flag an imported session's gone directory missing, so that ADR 0021's read-only rule has a field.
26. As a routine, I want my workspace resolved from a request per firing and re-resolved by identity when I move, so that I run in the right checkout.
27. As a provider adapter, I want one absolute path whatever the kind, with containment's writable set computed, so that I know nothing of kinds.
28. As the completions surface, I want fresh sessions in scratch workspaces the purge removes, so that programs leave nothing behind.
29. As a client developer in another language, I want the identity rule to be a documented pure function with published cases, and every kind to carry a path, so that my client agrees with the environment and survives new kinds.
30. As a build session, I want every behaviour a test through an in-process environment with real git repositories in its temporary directory, so that no test needs a network or a forge.

## Implementation Decisions

### Modules

- **contracts**: the recorded workspace union, the workspace request, `workspaceMissingSince`, the new methods and events, the icon and colour sets, `environmentIcon` and `environmentColour` in discovery and `hello`, `environment` in `environment.subscribe`'s snapshot, and the **repository identity rule** as one pure function with its table of cases.
- **environment**: the **resolver** (request to recorded workspace and identity, or a refusal), the **worktree maker**, the **reaper**, the **availability watcher**, the **identity pass**, the **checkout index**, and the environment's name, icon and colour. All git goes through the hardened git runner (#124).
- **client runtime**: `projections.newSession`, `projections.knownDirectories`, `commands.startSession`, the descriptor fed by the new notices, and the presentation key `hiddenDirectories`, enumerated in the ADR 0003 lint rule's presentation keys.

### Workspace kinds, as the summary records them

The summary's `workspace` (session-state spec) becomes a union on `kind`; every member has `path`, absolute as the environment's operating system writes it:

- `directory {path}`: a directory the environment has; never made or moved by the harness, and never removed unless it lies inside a workspace root (the reaper's rule below).
- `worktree {path, repository, branch}`: a worktree the environment made; `repository` is the main checkout (or bare repository), `branch` the branch it was made on (not re-read if a run switches).
- `scratch {path}`: a directory under the data directory's scratch root, made for the session that asked.

A client meeting an unknown kind shows `path` and treats it as a directory, as it keeps an unknown event opaque (ADR 0001). The `none` kind is gone (ADR 0005).

### Workspace requests

`sessions.create`'s `workspace` becomes a request, since a worktree's path and a scratch directory are the environment's to choose. A `directory` request is also a recorded workspace, so phase-A clients keep working.

- `directory {path}`: absolute, or starting `~` (expanded to the environment's home); `.` and `..` resolved lexically; symlinks kept as written.
- `worktree {repository, branch?, newBranch?}`: `repository` is any path inside a repository; `branch` checks out an existing local branch; `newBranch {name?, base?}` makes one, named `agent-harness/` plus the session id's first eight characters unless named, from `base` (any ref), preset the main checkout's `HEAD`. Both is `invalid_params`; neither is a new branch with its presets.
- `scratch {}`.
- `session {sessionId}`: another session's recorded workspace on this environment, shared (kind, path, identity). A fork does this implicitly (ADR 0022); clients send it for "a new session here" and for the new session a rewind's `use_new_session` starts, which today sends the summary's workspace back.

### The resolver

`sessions.create` becomes a prepared command (env spec, as `runs.withdraw` is): the resolver runs in `prepare`, outside the transaction and only when no receipt answers, and the handler appends `session.created`, whose payload already holds `workspace` and `repositoryIdentity`. `prepare` first checks the decider's cheap refusals (id used, group absent) so nothing is made for a doomed command; if the transaction still rejects, what `prepare` made is removed. Refusals are rejected receipts (`conflict`, a `reason` in `data`), so an outbox's replay retires on them. The same resolver serves `sessions.setWorkspace`, completions, minted sessions (ADR 0019), routines (92), the Carry over import (88) and later hand-off.

- **Directory**: `workspace_unusable` with `problem` `does_not_exist`, `not_a_directory`, `not_readable` (kept apart so a client can say which) or `reserved` (the data directory outside a workspace root). Phase A's acceptance of any full path (#145's notes) ends.
- **Worktree**: made from the repository's main checkout, never from a worktree. Refused `not_a_repository`, `git_unavailable`, `no_commits`, `git_filters_refused` (the checkout would run them, #212), `branch_exists`, `branch_not_found`, `branch_checked_out` (naming the worktree and, when the harness's, its session) or `git_failed` with git's `fatal:` line. Placed under the data directory's worktrees root, in a directory per repository named from the checkout's directory name and a short hash of its path (as #121 names auto-memory directories), then one per branch, suffixed `-2`, `-3` when taken. Added locked with a reason naming the session, so `git worktree prune` leaves it alone. Then the main checkout's `.worktreeinclude` (Claude Code's format: `.gitignore` patterns matching only ignored files) is copied in: regular files, no symlinks, at most 1,000.
- **Scratch**: `<data dir>/scratch/<session id>`, 0700, where completions already makes it.
- **Session**: the named session here and not deleted (`not_found`, kind `session`), its workspace present (`workspace_missing`).
- **The environment's git**: hooks pointed at nothing, fsmonitor off, scrubbed environment, no prompts, 15 seconds (#124); a call that checks out or compares contents first reads the repository's own filters and refuses as `diffs.workingTree` does (#212). No `post-checkout` hook runs; setup scripts are fog (ADR 0005).
- **Workspace roots**: the data directory's `scratch` and `worktrees`, and roots later workstreams declare (bank checkouts, 90). A directory request inside one is allowed. The roots are exempt from the denylist's data-directory preset, as `scratch` and `containment` already are (#132, #140).

### Repository identity

ADR 0020 requires one identity for every spelling. An ssh remote carries sshd's port, never the web server's, so no rule that keeps ports can unify `ssh://git@git.systemtech.dev:2222/david/agent-harness.git` with `https://git.systemtech.dev:5526/david/agent-harness`; the identity drops the port. The rule, a pure function in the contracts package (after T3's `normalizeGitRemoteUrl`):

1. **Repository**: the innermost git repository holding the workspace path (a subdirectory's checkout, a monorepo root, a submodule's own). A worktree shares its checkout's remotes.
2. **Remote**: `origin`, else the only remote, else the first by name, as git expands it (`insteadOf` applied). None, no identity.
3. **Parse** `https://` and `http://` (userinfo dropped: an embedded token never reaches the log), `ssh://[user@]host[:port]/path`, scp `[user@]host:path` (host with a dot, or `localhost`), `git://`. Local paths, `file://` and the rest give none.
4. **Host**: lower-cased, port dropped; a verified alias of a forge account on this environment (ADR 0020) becomes that account's canonical host.
5. **Path**: empty segments dropped, one trailing `.git` removed, lower-cased (the forge kinds the harness knows ignore case); under two segments, none.
6. **Identity**: `https://` + host + `/` + path. All three spellings above give `https://git.systemtech.dev/david/agent-harness`. It is an identity, not a link.

A workspace outside any repository has none (ADR 0005).

**Changes.** Set at creation; copied by a fork, a `session` request and later hand-off; resolved afresh by `sessions.setWorkspace`. Auto memory and the trust gate key on it, so only two passes change it otherwise, each appending `session.repository-identified {repositoryIdentity, reason}` (`list`, actor `system:workspaces`):

- **resolved**: after each start, once the wire is open, four git processes at a time, every non-deleted session with no identity whose workspace is a present directory or worktree is resolved again; one that now has an identity appends. Phase-A sessions, a timed-out git and a directory that gained a remote join; scratch workspaces, which completions makes by the thousand, are skipped.
- **alias**: when a forge account is added or gains a verified alias (87), identities on that alias's host take the canonical host: a string rewrite, needing no git. It matters because Carry over (step 2) imports before Forges (step 4) exists.

**Auto memory** keys on the identity, else the repository's main checkout path (worktrees of a remote-less repository share one directory, as Claude Code keys memory by repository), else one directory shared by all scratch workspaces, else the workspace path, refining #121. When a session's key changes, the old key's directory is copied into the new one by ADR 0021's carry-over rule (nothing overwritten; a second source under `carried/` with a pointer line in `MEMORY.md`); the old stays.

### Missing workspaces

The summary gains `workspaceMissingSince` (timestamp or null), owned by `session.workspace-status-changed {status: missing | present}` (`list`). The availability watcher (`system:workspaces`) appends it only on a change: in a pass after each start, hourly, and whenever a method needing the workspace finds it gone or back (`runs.start`, `runs.send`, `runs.readNow`, `terminals.open`, `files.*`, `diffs.workingTree`). The Carry over import appends it after `session.created` for a gone directory. Neither it nor `session.repository-identified` moves `updatedAt` (as `session.mode.set`).

While missing, `runs.start`, `runs.send` and `runs.readNow` are rejected in the receipt (`conflict`, reason `workspace_missing`, the path), as terminals, files and the working-tree diff already are (#124). The transcript, `diffs.session` and organisation commands work: it lists and opens read-only (ADR 0021).

`sessions.setWorkspace` (`sessions:write`, prepared): `sessionId` and a request, resolved as for a create; refused `workspace_present` unless missing (a moved session's transcript paths would lie) and `run_active` during a run. It appends `session.workspace-set {workspace, repositoryIdentity}` (`list`; clears the mark, moves `updatedAt`) and stops the kept provider process. A Claude resume survives the move, since the adapter keys the provider's stored session by the harness session id, not the working directory. A client continuing a missing session asks for a workspace first (ADR 0021).

### The reaper

- **At purge** (the sweep past `purgeAt`, or `sessions.purge`), after the commit and off the log's path: a workspace inside a root that no other session names (a deleted session in grace still names it) is removed. The root decides, not the kind, so a completions session recorded as `directory` in the scratch root is removed too, paying the claude-adapter spec's owed item.
- **Scratch** goes whatever it holds, once its real path is inside the root.
- **Worktree**: unlocked and removed with git's non-forcing remove when no tracked file is changed and no untracked, unignored file remains, nested repositories included (Claude Code's clean check); ignored files go with it; the branch is never deleted. Otherwise it stays, unlocked, and `workspace.kept {path, branch, title, reason}` (`uncommitted_changes`, `git_filters_refused`, `git_failed`) goes on the environment stream as a notice.
- **Startup sweep**, before the wire opens: the same rules for anything in the roots no session names (a crash between `prepare` and commit). A kept worktree is logged, not noticed.
- A directory outside the workspace roots is never touched; settled and archived sessions keep their workspaces.

### Containment's workspace level

`writable` (workspace, the session's containment scratch directory, its temporary directory) gains the repository's git directory when outside the workspace: a worktree's common git directory, which the permissions spec owes this workstream ("or no commit can be made at `workspace`"), and the enclosing repository's for a directory below its root. The environment computes it at run start and hands it through `RunContainment` as shaped today.

### Name, icon and colour

- **Commands** at `admin`, each with a `commandId`, on the `environment` stream: `environment.rename {name}` (event `environment.renamed`), `environment.setIcon {icon}` (`environment.icon-set`), `environment.setColour {colour}` (`environment.colour-set`). A value already held is `changed: false`. One command per field, as for sessions (ADR 0003).
- **Values**: a name trimmed to 1 to 40 code points without control or format characters (the `GroupName` rule); an icon of `laptop`, `desktop`, `server`, `nas`, `cloud`, `container`, `board`, `home`, `office`, `lab` (ADR 0025's fixed set); a colour of `red`, `orange`, `amber`, `yellow`, `lime`, `green`, `teal`, `cyan`, `blue`, `indigo`, `violet`, `pink`, never a literal. The theme package derives a light and a dark token per name within its contrast rules (ADR 0023); the terminal UI maps the twelve, in order, onto red, bright red, yellow, bright yellow, bright green, green, cyan, bright cyan, blue, bright blue, magenta, bright magenta, or the token's value under truecolour.
- **Defaults** until set: the record's name, from now on the hostname's first label (existing records keep theirs); icon `container` in a container (the env spec's rule), else `laptop` on macOS, `desktop` on Windows, `server` on Linux; colour by a hash of the environment id.
- **Reading**: a projection over the three events starting from the record's name. Discovery and `hello` gain optional `environmentIcon` and `environmentColour` (no protocol bump); `environment.subscribe`'s snapshot gains `environment {name, icon, colour}`; the three events join the environment notices, and the client runtime updates the connection descriptor from them without a user-facing notice. The record file keeps id, creation time and first name; renaming stays a command (as built).
- **Your machines**: the step's registry entry gains `writesState` for the three methods (parts `name`, `icon`, `colour`) and the state check `your-machines.named`, holding from the first start (ADR 0025's "named"); the rest of its check is Set up's (88). A client whose two environments share a name says so on the card.

### The picker in the client runtime

A pure projection (ADR 0003) of the registry, the session lists, the request cache, the client-local `environments.lastUsed` (built) and a context the renderer passes in.

- **`projections.newSession(context)`**: the context names the focus (a session, a group heading, a repository heading, an environment heading, or none) and any chip already set; the answer gives each chip's preset, the reason, and the options.
- **Environment** (ADR 0005): an environment heading's action or `--environment`; else the focused session's; else a focused group's (for a merged heading, the primary environment if it holds a member group, else that of the heading's most recently active session); else, with a repository in focus, one that holds it (the focused session's, else the last used among holders, else the one with its most recent session); else the last used; else the local; else the first enabled. Every step passes over an environment that is unreachable, disabled or not ready, since runs cannot start there; such an environment is offered greyed with its reason, and when every step passes over all of them there is no preset and the chip asks. Holding a repository means having a non-deleted session with that identity. Auto-balance stays a later opt-in.
- **Account**: the chosen environment's account with the focused session's account identity if it has one (the login keeps its place, ADR 0018), else `accounts.defaultAccount`, else its first signed-in account; the chip's gauge is `projections.usage`'s for that identity, pooled across environments (#136).
- **Model**: the focused session's if the account offers it, else the account's default.
- **Workspace**: a focused session on the chosen environment, its workspace present, gives `session {sessionId}` (the terminal UI's `/new`); else a repository in focus, or the focused session's when the chip moved environment, gives the most recently used known directory with that identity there; else that environment's most recent known directory; else `scratch`.
- **Changing a chip** re-runs the presets after it, keeping account identity, model and repository where the new environment has them: ADR 0005's re-filtering, with the workspace following.
- **`projections.knownDirectories(environmentId)`**: the directories its sessions use (a directory's path, a worktree's `repository`) with identity, last use and missing mark, most recent first, at most 20. Recent folders, which ADR 0027 moves to the Your machines row, become this derived list; hiding one is client-local presentation (`hiddenDirectories`, on the ADR 0003 lint's allowlist), undone when a session uses it again.
- **`commands.startSession(environmentId, choice)`**: `groups.create` first when a focused merged heading lacks a group there (as `commands.moveToGroup`), then `sessions.create`, then `connections.setLastUsed`; the renderer sends the first message once accepted.
- **By repository**: the built headings gain a label (the identity's path, with the host when two share a path) and a last per-environment heading for sessions with none; a repository heading's new-session action focuses that repository.

### Browsing an environment's directories

A client's own file dialog cannot see another machine. Two queries at `terminal`, the scope of `files.*` (a client with a terminal can list any directory anyway):

- `workspaces.browse {path?, hidden?}`: subdirectory names of `path` (preset home) in code-unit order, each marked when a repository root; dot-directories only with `hidden`; at most 1,000 with `truncated`; `parent`, null at a root. `not_found` (kind `directory`), `invalid_params` for a relative path.
- `workspaces.inspect {path}`: whether it would be a usable directory (the resolver's `problem`) and, in a repository: root, main checkout, bare or not, the identity a session would get, current branch and `HEAD` with its date, cached `origin/HEAD`, and up to 200 local branches by latest commit, each with the worktree holding it and, if the harness's, its session.

On the local environment the GUI may offer the desktop shell's directory dialog instead; the resolver checks its answer like any path.

### Renderers

- **Composer**: a new session shows environment, account and model chips (ADR 0005), then the workspace chip (kind, directory name, a worktree's branch, the path on hover). An existing session's environment badge and workspace chip are read-only; a missing workspace replaces the composer with the gone path and a Choose a workspace action (`sessions.setWorkspace`).
- **Sidebar and header**: each environment heading has a new-session action; a row's badge is the icon in the environment's colour (GUI) or its two letters in that colour (terminal UI, which draws no icon, #19); the header shows name, icon and colour.
- **Terminal UI**: the workspace step offers known directories, a typed path, browsing, a worktree (a repository, then a new branch with its presets or an existing one from `workspaces.inspect`) and scratch; `/cwd` opens it and, on a missing session, sets the workspace; `/environment` gains `rename`, `icon` and `colour` with `admin`; `-c` matches any kind by path.

### Completions, minted sessions, routines, hand-off

- **Completions**: no named directory gives a `scratch` request; a named one a `directory` request, whose refusal is a 400 naming the workspace.
- **Minted sessions**: `scratch` for an instruction, `directory` for a bank checkout, whose root the banks workstream declares.
- **Routines** (ADR 0008): a routine keeps a request resolved per firing (a worktree request gives each firing its own). A move re-resolves through the **checkout index**, the target's most recently used present known directory with that identity, else `scratch`.
- **Hand-off** (milestone 2): eligible when both environments hold the identity; the target gets a `worktree` request on the pushed branch, or `scratch`.

### Events and the field table

- Session stream, all `list`: `session.workspace-set`, `session.repository-identified`, `session.workspace-status-changed`. None is a transcript type, so compaction keeps them (#123). `session.created`'s payload is unchanged, its `workspace` the recorded union.
- Environment stream, all notices: `environment.renamed`, `environment.icon-set`, `environment.colour-set`, `workspace.kept`.
- The sessions read model gains the field, so its projector rebuilds from the log on registering (env spec). ADR 0003's field table keeps `workspace` and `repositoryIdentity` on `sessions.create` and gives `workspaceMissingSince` to `session.workspace-status-changed`.

### What this workstream does not decide

- **78 env**: the wire, receipts, prepared commands, notices, the rest of the data directory. **79 session-state**: the other summary fields, grace and purge. **80 client-runtime**: the registry, `environments.lastUsed`, the request cache, the outbox, pooled usage.
- **81 tui**, **84 gui**: drawing; the GUI's per-pane Settings environment picker (ADR 0027), a different control. **82 claude-adapter**: how a run uses the path and `projectConfigRoot`; the auto-memory key is built there. **83 permissions**: levels and the sandbox; only `writable` grows here.
- **86 launcher-update**: nothing. **87 forge**: accounts, aliases and their events, which the identity rule reads. **88 setup**: the Your machines card's other checks, the Carry over import, minted sessions. **89 skills-instructions**: the trust gate's key, which reads the identity (else the main checkout path). **90 banks**: bank checkouts as a root; relevance by identity (ADR 0013). **91 key-managers**: environments in the orientation block. **92 routines**: a routine's request and move. **93 browser**: nothing. **94 switch-over**: imported workspaces (`directory` to directory, `ephemeral` and `none` to scratch).

## Testing Decisions

A good test issues a request through a real client and asserts what a client sees: a receipt and reason, a summary's workspace, identity and missing mark, an event and patch, a notice, a directory a client can list. Never a table or private structure.

- **Primary seam: an in-process environment and a real client** (the env spec's helper): temporary data directory, loopback port 0, the scripted fake provider, the typed client over a real WebSocket, and real git repositories made in the temporary directory with `git init`, commits and `git remote add` in every spelling; no network, no forge. Cases: every kind and refusal of a create; `.worktreeinclude` copying only ignored files; the lock; the identity for each remote spelling, ports, userinfo, `insteadOf`, a subdirectory, a submodule, a local remote; a fork and a `session` request sharing a workspace; a removed directory refusing a run, the status patch, `sessions.setWorkspace` refused while present or running then accepted, the process stopped; the resolve pass across a restart on one data directory; the alias rewrite against a scripted forge service until 87 lands; the auto-memory copy; purge removing scratch and a clean worktree, keeping a dirty one with `workspace.kept`, sparing directories and branches; the startup sweep; the three environment commands, notices, `changed: false`, `hello` and discovery, refusal below `admin`; browse and inspect caps and scope. Prior art: T3 Code's `apps/server/src/server.test.ts` (`buildAppUnderTest`, `withWsRpcClient`) and `RepositoryIdentityResolver.test.ts`.
- **Contract tests in the contracts package**: the identity rule as a case table (one identity per repository across spellings; port, userinfo and `.git` dropped; case folded; alias mapped; local and one-segment paths none), after T3's `packages/shared/src/git.test.ts`; the field table covers `workspaceMissingSince`; one scope per new method; `path` on every kind; closed icon and colour sets; the Your machines entry writes the three methods.
- **Client runtime** against two in-process environments: each branch of the environment rule, the login kept across a switch, the workspace preset, a greyed unreachable environment, a hidden directory returning; against the scripted fake wire, the descriptor updated by the notices. Prior art: T3's `projectGrouping.test.ts`.
- **Terminal UI**: the runtime against a scripted fake environment rendered by Ink's test renderer: the workspace step, browsing, branches, `/cwd` on a missing session, `/environment rename`, the coloured badge.
- Vitest, serial where a listener is bound. **Not here**: GUI drawing (84), sandboxed writes to a git directory (permissions suite), forge alias verification (87).

## Out of Scope

- Hand-off (milestone 2), auto-balance (a later opt-in), SSH-launched environments (after milestone 1), all ADR 0005.
- Worktree setup scripts (fog in ADR 0005 and 0027), fetching before branching, removing worktrees of settled or merged sessions after a while (T3's cleanup rules), moving a session whose workspace is present.
- The Your machines card's other lines and the install script (88, 86); bank checkouts (90); routine definitions (92).

## Further Notes

Chosen defaults not decided on a ticket, for review:

- **Identity**: port dropped; path lower-cased; `https`; `origin`, else the only remote, else the first by name (T3 prefers `upstream`, grouping a fork with its parent but splitting two clones of one fork by whether `upstream` was added); `insteadOf` expanded; userinfo dropped; local remotes none.
- **Worktrees** in the data directory, as T3 Code and Codex keep theirs; inside the checkout (Claude Code's `.claude/worktrees/`) a test runner or compiler in the main checkout picks their files up. Branch `agent-harness/` plus eight characters of the session id, from the main checkout's `HEAD` (Claude Code's `head` base, as no fetch is made); locked; `.worktreeinclude` honoured, 1,000 regular files; hooks never run.
- **Removal**: scratch at the last purge whatever it holds; a worktree only when clean, ignored files going with it, the branch kept; `workspace.kept` once.
- **Missing**: the watcher after each start, hourly and on use; `sessions.setWorkspace` only while missing and idle, at `sessions:write`.
- **Browsing** at `terminal`; 1,000 entries; 200 branches; home preset. **Known directories**: 20; hiding client-local.
- **Look**: 40 code points; the hostname's first label; ten icons, twelve colours; icon by container and platform; colour by id hash; `named` always holds.
- **Picker**: an unreachable, disabled or starting environment never preset, and no preset when none is usable; a focused session presets `session`.
- **Auto memory**: the main checkout path without an identity; one shared scratch directory.

Owed by this workstream's build to built code:

- **Client runtime**: `commands.rewind`'s new session sends `session {sessionId}`; the summary decoder takes an unknown kind as a directory by path; the descriptor reads icon and colour from `hello`, discovery and the notices; `workspace.kept` raises a notice naming the path and why.
- **Terminal UI**: the environment's refusals replace the workspace step's own path check; `/new` sends `session`; the badge takes the environment's colour, not its list place (#145).
- **Claude adapter**: the auto-memory key; completions' scratch request; `sessions.fork` records its source's identity, where `decideCreate` writes null today. `commands.list` keeps taking a recorded workspace and reads only its path, so a client asks it about a worktree not yet made by passing the repository as a `directory`.
- **Permissions**: `writable` gains the git directory; the denylist exemption gains the worktrees root.
- **Contracts**: the fixture `https://git.systemtech.dev:5526/david/agent-harness` becomes the port-less identity; `repositoryIdentity`'s description drops "until it is resolved"; the discovery document, the `hello` frame and `environment.subscribe`'s snapshot gain their optional fields.
- **Lint**: `hiddenDirectories` joins the presentation keys the `no-client-organisation-state` rule enumerates.

Verify first in the build session:

- `git worktree add --lock --reason` on the oldest supported git (the box has 2.39.5); else `git worktree lock --reason` straight after.
- Whether Claude's sandbox can deny writes to a git directory's `hooks` and `config` while allowing the rest. A contained run can plant a hook wherever `.git` is writable (a checkout-root workspace holds its own), which the user's git later runs outside containment; if it can, the permissions workstream should carve them out for every repository workspace.
- That a prepared `sessions.create` answers within a client's patience for a large checkout, since the client runtime sends one command at a time per environment.
- That the forge service (87) exposes verified aliases and appends an event when one is added.
- That a `stat` on a dead network mount cannot stall the watcher or a run's start; if it can, the check needs its own bound.

Flagged for domain-modeling: the containment scratch directory every contained session has (permissions spec) is not a scratch workspace though both say scratch; "workspace root", "known directory" and "environment badge" are not glossary terms; the glossary's "canonical remote URL" should say the identity is a port-less `https` form, not a link. Raised for David: per-session read-only additional directories have no decision in any ADR and are not carried.
