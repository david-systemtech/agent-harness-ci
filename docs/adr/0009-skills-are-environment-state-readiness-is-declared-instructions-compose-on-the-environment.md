---
status: accepted
---

# Skills are environment state with declared readiness; standing instructions compose on the environment

Decided 2026-09-23 on the map ticket "Decision: skills and standing instructions as first-class, and skills in a planning mode" (david/agent-harness issue 23). The skill set was a per-machine file, repository skills never reached a Claude run, always-on never reached Codex, local models got no skills at all, nothing declared what a skill needs before it can help, and standing instructions lived only in the desktop so every run the server started went without them. The harness makes the **skill set** environment state: tracked sources (a git URL and folder, tracking a branch or pinned to a commit), the environment's own skills directory, and repository skills from `.agents/skills` and `.claude/skills` once the repository has passed a **trust gate**, remembered per repository; a change across environments is an explicit bulk edit, never an implicit global. Each environment materialises one merged set per account and each adapter maps it: Claude through a plugin directory, Codex through its non-deprecated user root, local models through the harness's own loop, which discloses skills natively in the spec's three tiers. Disclosure is otherwise the provider's; always-on skills ride each provider's instruction channel, including Codex's `developerInstructions`. **Readiness** is declared, not guessed: a sidecar file beside `SKILL.md`, or a harness overlay keyed by origin for skills the harness does not own, lists checks of seven kinds (file, tool, secret, git, skill, mcp, provider) that resolve to ready, setup needed or unsupported; the model is never asked. **Standing instructions** have four layers, user, team bank, project and session, plus a bot's persona, composed in that order on the run's environment and appended through the provider's instruction channel, so routines, bots, turns on the completions surface and remote clients all receive them.

## Considered options

- A client-local skill list pushed on connect, or the existing per-machine file: rejected; two clients disagree and servers drift.
- A harness-built catalogue injected into every provider's prompt: rejected; Claude and Codex already build theirs from the same files.
- Readiness keys in `SKILL.md` frontmatter: rejected; claude.ai upload rejects unknown keys today. Readiness only in the harness catalogue: rejected as the sole home, since a skill author should be able to declare it.
- The project layer injected as text by the harness: not chosen; for Claude the harness enables the `project` settings source once the repository passes the trust gate, which also admits the repository's hooks, and Codex reads `AGENTS.md` natively.

## Consequences

- A user types `/name` in any client and the harness resolves it to the provider's own invocation; slash-only skills are offered in the composer and never described to the model. Skills can be disabled per environment and per account, and always-on is set per account; both are events.
- The later planning mode is harness-side: it evaluates readiness on the session's environment and matches a skill's description and triggers against the conversation, and offers ready skills as suggestions in the composer, naming the failing check when setup is needed. Its details stay in the fog.
- The Pocock skills get a harness overlay declaring their `docs/agents/*.md` and tracker prerequisites, with an upstream contribution as a nice-to-have.
