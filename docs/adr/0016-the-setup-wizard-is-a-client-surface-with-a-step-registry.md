---
status: accepted
---

# The setup wizard is a client surface with per-environment health; every feature registers its step

Decided 2026-09-23 on the map ticket "Decision: the setup wizard as a first-class feature and which wizard-map decisions still stand" (david/agent-harness issue 30), re-examining the nine decisions of the 2026-09-22 wizard map under the server-first architecture. Those decisions made the wizard desktop-only, carried remote servers as a hand-pasted connection bundle, and generated standing prompts whose facts could go stale. The harness keeps their shape and moves their home: the wizard is a **client surface**, rendered by the GUI and later the browser tab from the client runtime, in which every step reads and writes environment state through commands, so a step's health is **per environment**: the rail shows which environment a step is checking, the local one by default, with a picker to run the checklist against any other. A headless environment is set up by the install script, paired from any client, then checked the same way; there is no wizard on the server, and the terminal UI shows the checklist summary with a pointer. **Every feature registers its step**: the harness keeps a step registry (step id, the settings it writes, the health check it runs, the settings pane it links to), a feature's ADR or specification names its step and check, and a feature that adds a setting without a registry entry fails a contract test.

## What stands, changes and falls from the 2026-09-22 decisions

- Stands: deterministic forms with the model used only for authored content; a re-runnable checklist with a health check per step (done, needs attention, skipped); first launch as the whole window, afterwards a Set up row in Settings with every pane linking to its step; the rail layout of prototype A; the target user; carry-over that points at `~/.claude` and `~/.codex` and moves nothing; the model step as a normal conversation the wizard mints and whose artefact it detects; the settings bands, renamed for the glossary (Set up, Accounts, Knowledge, Access, Routines and bots, Environments, Appearance, About); the browser step (ADR 0014); banks, forge and key manager as re-decided in ADRs 0010 to 0013.
- Changes: hosts (above); the carry-over note now says repository instructions and hooks load once the repository is trusted (ADR 0009); the suggestions catalogue lives in this repository, a ticked skill repository becomes an environment skill source, suggested instructions become owned copies in the user layer, and the generated Setup prompts become the orientation block the harness renders (ADR 0011) with the wizard's editable prose around it; CLI update checks become the Managed tools registry.
- Falls: the one-paste connection bundle and its prototype, superseded by pairing links, QR and codes (ADR 0001) and an install script for another machine; the ship order, superseded by the map's milestones; the note about pull requests to the old GitHub repository.

## Consequences

- Milestone 1 steps, in order: Account; Carry over; Your machines; Memory bank; Skills; Key manager; Instructions; Browser (skippable); Permissions; Appearance. Codex and local-model parts of Account and Carry over arrive with their adapters.
- A wizard step never holds a fact the orientation block renders: it writes the setting, and the block says what is true.
- A shortened "what's new" checklist offered after a feature update is on the roadmap; the full checklist, re-runnable, serves until then.
