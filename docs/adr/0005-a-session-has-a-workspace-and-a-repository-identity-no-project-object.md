---
status: accepted
---

# A session has a workspace and a repository identity; there is no Project object

Decided 2026-09-23 on the map ticket "Decision: where code runs as a primary setting: the environment picker" (david/agent-harness issue 19). Where a session runs is chosen first: the composer shows environment, then account, then model, and each environment heading in the sidebar starts sessions of its own. Every session has exactly one **workspace** on its environment, one of three kinds: a directory the environment has, a git worktree the environment creates from a repository it has, or a scratch directory that lives and dies with the session; a fourth kind, "none", is gone; scratch is the minimum. A session whose workspace belongs to a repository also records its **repository identity**, the canonical remote URL of that repository; a scratch or directory workspace outside any repository records none, and a hand-off seeds the new session with the identity of the session it continues. That identity is how clients relate work on the same repository across environments: the "by repository" view, the default-environment rule (prefer the environment of the focused session or group, then the last used, then the local one), and hand-off eligibility. There is no Project object on the server; deliberate grouping is a Group (ADR 0003), and the rest is derived.

## Considered options

- An environment-owned Project object with settings and scripts: rejected for now; T3 Code keeps project settings per environment and derives the logical project client-side, and nothing decided so far needs a server-side Project.
- Moving a session's record to another environment: rejected. Provider stores are per machine and account, so resume ids do not travel; a "move" would be a fake. Hand-off is a linked fork: "continue on <environment>" starts a new session there in a workspace for the same repository (worktree with the branch pushed and fetched, or scratch), seeded with a summary, and links the two; the original stays. Milestone 2.
- Auto-balancing new sessions by machine load from the start: deferred as a later opt-in, never the default.

## Consequences

- An environment carries a user-set name, icon and colour, stored on the environment so every client agrees; the badge on each session row, the composer chip and the session header use them.
- The wizard's "your machines" step lists paired environments with health and version, pairs a new one by link, QR or code, sets name, icon and colour, and hands out an install script for another machine. Desktop-managed SSH launch of a remote server is on the roadmap after milestone 1.
- The same login on two environments appears under each; plan-usage windows are pooled by account identity (driver plus login) from milestone 1.
- Worktree setup scripts (T3's `t3.json` shape) are a later question.
