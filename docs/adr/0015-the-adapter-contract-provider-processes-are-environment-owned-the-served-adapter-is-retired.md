---
status: accepted
---

# The adapter contract; provider processes are environment-owned; the served adapter is retired

Decided 2026-09-23 on the map ticket "Decision: provider adapter carry-over verdicts, adapter by adapter" (david/agent-harness issue 28), accepting the core audit's verdicts. Artemis's adapter seam is Electron-free and worth keeping, but each adapter owned its provider process for the life of one run, one boolean stood in for every provider's instruction channel, three of its data types lived in the desktop IPC file, and one adapter existed only to make another Artemis server look like an account. The harness keeps the seam and fixes it: an **adapter** provides a capabilities descriptor; a credential spec (config-dir scoping, environment keys to strip, sign-in argv); `createRun` producing the agent event stream; sessions with resume, fork and rewind where the provider supports them, and titles; plan usage carrying an account identity for pooling; models; commands and skills listing; a **per-provider instruction channel** (Claude's system-prompt append, Codex's `developerInstructions`, the local loop's prompt) in place of the boolean, carrying both standing instructions and always-on skills as ADR 0009 decided; tool servers through a per-run factory; permission prompts through a broker any attached client can answer; and the environment's event log as its only event sink. **Provider processes are owned by the environment**, not by a run or a client: Claude's per-conversation process and Codex's per-`CODEX_HOME` daemon are started, reused and stopped by the environment, survive client disconnects, drain for updates and stop after thirty idle minutes. The **Artemis-served adapter is retired**: the client runtime (ADR 0004) is how one machine reaches another environment.

## Verdicts

- **Claude**: port after fixes. The `project` settings source loads behind the repository trust gate (ADR 0009); the 6,136-line file is split along the seams it names (options, process, turn, history, titles, config-dir queue); the three IPC-file types move into transport-neutral protocol modules; the plan-usage read stays tolerant and is re-checked against the pinned SDK.
- **Codex**: keep the mapper and the JSON-RPC codec; rewrite the adapter and its protocol slice: connect to Codex's shared daemon instead of one process per run; generate the protocol types from the pinned CLI instead of transcribing them; map the four modes as ADR 0006 records and never send the retired `untrusted`; send standing instructions and always-on skills through `developerInstructions`; pass the harness's tool servers; answer the agent's questions through the same question UI Claude uses; extend the mapper for subagents, plans and rate-limit pushes.
- **Local (LM Studio, Ollama, llama.cpp)**: port after fixes: a generic OpenAI-compatible flavour with its own endpoint field (Olla, OpenRouter, vLLM and any compatible server), `bwrap` confinement verified on Linux in and out of a container before any unattended local run, otherwise the shell is refused as on Windows.
- **OpenCode over ACP**: kept as a thin adapter behind a capability flag.
- **Artemis-served**: retired.

## Considered options

- One process per run, as today: rejected; Codex now expects a shared daemon and Claude pays a cold start per turn.
- Automatic account rotation as an opt-in: rejected again; Artemis ADR 0003 stands. The threshold, recommendation and usage-merge functions port as pure modules, and the hand-off picker is a command on the environment so every client shows the same recommendation.
- Keeping the boolean instruction flag: rejected; Codex has an additive channel the flag cannot express.

## Consequences

- Milestone 1 ships the Claude adapter alone. Milestone 2 opens with the generic OpenAI-compatible adapter, then the Codex rewrite. OpenCode follows on request.
- The OpenAI-compatible completions surface for programs is kept with the `artemis` extension namespace, `permissionMode` under the connection's ceiling, and **client-tool passthrough from milestone 1**: a caller's `tools` become tool-call round trips, so a program such as Hermes runs its own tools instead of having them silently ignored.
