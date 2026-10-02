---
status: accepted
---

# Banks declare their kind, purpose, entities and orientation facts; the environment owns the registry; the index is a breadcrumb trail

Decided 2026-09-23 on the map ticket "Decision: memory banks: several banks per purpose, personal and team, setup" (david/agent-harness issue 24). Banks v2 already lets several banks reach one run, but nothing says what a bank is for, the registry is a per-machine file scoped by profile id with one default per machine, the index is a flat list capped per session and split evenly so lines are dropped, bank management exists only in the desktop, and bank checkouts are attached writable to Codex runs. The harness adds to `BANK.md` (which already names memory globs, scope template, schema, docs, index and landing) a **kind** (personal or team), a one-line **purpose**, the **entities** with aliases that route facts, and an **orientation** tier: a handful of memories the bank marks as always loaded (how to reach the key vault, which forge is primary, which banks exist), under a small cap the bank must respect at authoring time. The **registry is environment state**: per bank a role, enabled, an account scope and a repository scope by repository identity, with the default write target per account; a change across environments is an explicit bulk edit. The **index is a breadcrumb trail**: banks and scope folders appear as pointers with a description and a count, a folder's memory lines are expanded inline only when relevant (repository identity, recent use, a pin), and nothing is ever dropped. Bank checkouts are attached **read-only** on every provider; the only write path is draft then promote, which lands on the run's environment through the forge. The exact tiers, budgets, relevance rules and authoring contract are a dedicated effort (research then decision) that must land before the feature is built or shared.

## Considered options

- An even split of a flat allowance (today's approach), a larger flat cap, or priority order: all rejected, because each still drops lines past the cap. David: the index must be pointers, never a compressed copy of the memories.
- Auto-routing a draft by entity match when the model names no bank: rejected; the tool keeps refusing and the rendered kind and entity lines make the model name it, so a fact never lands in the wrong bank unseen.
- Forge credentials only from the key manager: softened; the key manager is preferred, and an environment may store a per-bank token as a fallback for people who use none.

## Consequences

- The team-bank instruction layer is rendered on the run's environment from the banks in scope: name, kind, purpose, role, entity lines, the duplicate-to-personal switch line, and the memory tools contract; the tools are offered to every provider, Codex included.
- One `BankService` on the environment (create a repository on the forge, join by URL, describe, verify, re-scope, forget) that the wizard and every client drive over the wire.
- The wizard-map bank decisions of 2026-09-22 stand with environment substitutions: everyone is offered a bank, personal by default as a private repository named for the user with a local-only fallback; team banks one per team or client with an owner picker, membership on the forge, join by pasted URL; two shipped templates, which gain kind, purpose and orientation; GitHub and Forgejo or Gitea.
- The two existing banks, `notebook` (David's) and `meadowstudios` (the Meadowstudios brands' shared bank), gain kind, purpose and an orientation set in their `BANK.md` once the structure contract lands.
