---
status: accepted
---

# One forge account per host, environment-owned; one ForgeService; harness-managed git credentials; one primary forge

Decided 2026-09-23 on the map ticket "Decision: forge integration: GitHub, Gitea, Forgejo" (david/agent-harness issue 26). In Artemis every bank carried its own token, skill sources and the tracker had none, the server landed bank changes with whatever ambient git credential it found, and a machine's accumulated git credential helpers could hang an agent's push for a day on an expired browser token. The harness has **one forge account per host**, owned by the environment: host, kind (GitHub, Forgejo, Gitea; GitLab later), identity, credential source (a signed-in `gh` session, a key-manager reference, a stored token in the environment's vault, OAuth later), known scopes and a primary flag. **One ForgeService** on the environment, with a provider per kind, is the only path to a forge: issues, pull requests, repository creation, releases and git credentials for clone and push; the tracker the skills use, bank landing, private skill sources, the release channel, repository creation, and pull-request links with status on sessions all go through it. Inside a run the environment writes a **per-host git credential configuration** that resets the inherited helper chain and points at a harness-owned store, and injects the forge's API token as an environment variable under the same approve or deny setting as key-manager injection. Exactly **one forge host is primary** per user: a user-level choice, set once and written as the primary flag onto that host's account on every environment by the bulk edit, so each environment's account for the primary host carries the flag and no other does; new repositories and the release channel use it, and the model creates a repository there unless the user names another forge.

## Considered options

- Per-feature tokens (banks, skill sources, tracker each with their own): rejected as the source of today's drift and of the forge-token hunt every session began with.
- The harness generating `docs/agents/issue-tracker.md` for the detected forge: not chosen; the setup skill keeps writing it and the harness only supplies the token and the account.
- Leaving git credentials to whatever the machine has: rejected after the credential-helper-chain hang.

## Consequences

- Acquisition order: GitHub reuses a signed-in `gh` (through the Managed tools registry), else a pasted fine-grained token with the permissions preselected in a deep link, with the OAuth device flow in milestone 2; Forgejo and Gitea use a pasted token with a walkthrough to the instance's token page, since their OAuth applications are per instance. A key-manager reference is offered everywhere as the credential source, with a stored token as the fallback.
- Pull-request links and status sync on sessions are in milestone 1 so that settle-on-merge (ADR 0003) works; viewed-file marks and review panes are milestone 2.
- The wizard-map forge decisions of 2026-09-22 stand; the forge-account model ticket (david/agent-harness issue 41) is re-scoped to this environment-owned model and the migration of per-bank tokens; GitHub device flow is milestone 2 and GitLab is late and minimal.
- The orientation block (ADR 0011) names every connected forge, says which one is primary, and states whether each token is verified.
