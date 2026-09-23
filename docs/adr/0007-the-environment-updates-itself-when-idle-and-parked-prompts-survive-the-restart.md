---
status: accepted
---

# The environment updates itself when idle; parked prompts survive the restart; interrupted runs continue

Decided 2026-09-23 on the map ticket "Decision: auto-update policy for server and clients: default on, idle detection, rollback" (david/agent-harness issue 21). Artemis's server never updated itself; the host-side tracker David wrote waits for a fully idle moment and never forces, so one parked prompt or one abandoned run can hold an update indefinitely, and a restart loses every live run. Every peer studied either drains with a short cap or cuts runs off, and none keeps a waiting prompt across a restart. The harness updates each environment on its own, on by default, under these rules. **Idle** means no run is starting or running and no run has started or ended in the last ten minutes. A run parked on a question or approval blocks an update for ten minutes only; after that the update may proceed, and because the prompt is an event in the environment's log it is re-presented after the restart exactly where it was, so a person who left for half an hour comes back to an updated environment and their question still waiting. Actively running work defers an update up to a cap of 24 hours; then the environment **drains** (accepts no new runs, waits up to 30 minutes for running ones) and updates. Runs interrupted by the update are marked in the log and continued automatically with one continuation turn where the provider can resume them under the same account, mode and workspace; otherwise the transcript says so and the run resumes on the next message.

## Considered options

- Idle only, never force (the MNL tracker): rejected; a busy environment can stay months behind.
- Drain with a short grace always (Codex, 60 to 300 s): rejected; a long run is cut off for a routine update.
- A container that replaces its own binary: rejected; fragile and lost on the next recreate.

## Consequences

- Channels: `stable` (the newest release that is not a prerelease, the preset) and `beta` (the newest release including prereleases). Releases are published on the project's own Forgejo (`git.systemtech.dev`) for now, read through its releases API with a read token the environment holds; a move to GitHub releases later changes the source, not the channel model. Pinning an exact version turns auto-update off for that environment until unpinned.
- Rollback, T3's shape: a stable launcher owns the versions directory and a durable pending-update record; the SQLite database (main file, WAL and shm) is snapshotted once per update id; the new version starts as a trial that must pass its activation gate (migrations, dependencies, bind, ready) within 120 seconds; the launcher then commits, or restores the snapshot and restarts the previous version under a durable restore marker. A crash loop within ten minutes of commit triggers the same restore. The last three versions are kept.
- The environment emits an "updated to X" event on the session-list stream; clients show a small notice and refresh capability flags (ADR 0001). A client newer than an environment offers one action, update this environment to my exact version, which runs under the same idle and drain rules. An environment newer than a client raises nothing beyond absent-with-reason flags.
- The desktop app updates itself with a native updater on the same channel as its local environment, and installs the server artefact it bundles into the local service's versions directory, asking the launcher to switch under the same rules, so desktop and local environment move together.
- Native installs are the supported self-update path. A containerised environment never updates itself; the harness ships a host-side updater (the MNL tracker generalised: watch the channel, ask the environment over its own API whether it is idle under these rules, recreate, verify health, roll the tag back on failure) as a script and compose snippet, and the in-container server reports that updates are managed outside.
- The setting lives in the wizard's server step and in Settings under the environment: version, channel, auto-update on, and the idle window and deferral cap as advanced values.
