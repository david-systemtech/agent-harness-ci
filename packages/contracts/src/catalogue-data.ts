import type { Catalogue, CatalogueLicence, CatalogueSkillMember } from "./catalogue.js";

/**
 * The catalogue's entries (skills spec, "The catalogue"; ADR 0029, ADR
 * 0030), as the 2026-09-22 catalogue research and its prototype chose them:
 * the Pocock set at its real folders two levels down (engineering and
 * productivity, the two its own plugin manifest publishes), unslop at its
 * repository's root with the caution its licence calls for, and the two
 * other entries the research supports, the Cursor team kit and Superpowers.
 * The instructions are the prototype's Coding and Working with me entries
 * and the Setup group's one seed, "About my setup" (ADR 0030).
 *
 * The members were read on 2026-09-30 through the environment's reader, the
 * root-skill rule included, at mattpocock/skills d81f3a1, theclaymethod/
 * unslop 17ed39c, cursor/plugins fae2c6e and obra/superpowers 8ca22db; the
 * always-on hint's characters are the reader's measure of the body. Their
 * descriptions are written for the card. The catalogue job (#512) checks
 * the counts and names against each repository.
 *
 * A changed instruction text is a new version: raise `version` and move the
 * old text, with its number, to the end of `earlierVersions`.
 */

/** A licence a file states, naming its holder. */
const licenceFile = (path: string, holder: string, link: string): CatalogueLicence => ({ spdx: "MIT", where: { kind: "file", path }, holder, link, note: null });

/** A model-invocable member, which the model may choose and a person may type. */
const model = (name: string, description: string): CatalogueSkillMember => ({ name, description, invocation: "model+slash" });

/** A slash-only member, which only a person typing its name invokes. */
const slash = (name: string, description: string): CatalogueSkillMember => ({ name, description, invocation: "slash-only" });

const POCOCK_LICENCE = licenceFile("LICENSE", "Matt Pocock", "https://github.com/mattpocock/skills/blob/main/LICENSE");

const POCOCK_ENGINEERING = [
  slash("ask-matt", "Ask which skill or flow fits your situation: a router over the skills in this repository."),
  model("code-review", "Review the changes since a fixed point along two axes: the repository's standards and the spec."),
  model("codebase-design", "Shared vocabulary for designing deep modules, their interfaces and their seams."),
  model("diagnosing-bugs", "A diagnosis loop for hard bugs and performance regressions."),
  model("domain-modeling", "Build and sharpen a project's domain model: its glossary and its ADRs."),
  slash("grill-with-docs", "A relentless interview to sharpen a plan, writing ADRs and the glossary as it goes."),
  slash("implement", "Implement a piece of work from a spec or a set of tickets."),
  slash("implement-spec", "Implement in code what /to-spec and /to-tickets produced."),
  slash("improve-codebase-architecture", "Scan a codebase for deepening opportunities and grill through the one you pick."),
  model("pr", "Write a pull request's body."),
  model("prototype", "Build a throwaway prototype to answer a design question."),
  model("research", "Investigate a question against primary sources and capture the findings in the repository."),
  slash("retro", "Hold a retrospective on a coding session."),
  slash("setup-matt-pocock-skills", "Configure a repository for the engineering skills: its issue tracker, triage labels and domain docs."),
  model("tdd", "Test-driven development: red, green, refactor."),
  slash("to-spec", "Turn the current conversation into a spec on the issue tracker."),
  slash("to-tickets", "Break a plan or spec into tracer-bullet tickets with blocking edges."),
  slash("triage", "Move issues through triage roles and write agent-ready briefs."),
  slash("wayfinder", "Plan a huge chunk of work as a shared map of decision tickets."),
  model("wizard", "Generate an interactive bash wizard for steps only a person can perform."),
];

const POCOCK_PRODUCTIVITY = [
  slash("grill-me", "A relentless interview to sharpen a plan or design."),
  model("grilling", "Grill the user relentlessly about a plan, decision or idea."),
  slash("handoff", "Compact the conversation into a handoff document for another agent."),
  slash("teach", "Teach the user a new skill or concept, within this workspace."),
  slash("to-questionnaire", "Turn a decision you cannot fully answer into a questionnaire for someone else."),
  slash("wait-what", "Stop. That last message did not land: re-pitch it."),
  model("writing-for-agents", "Writing documents for agents: skills, AGENTS.md and CLAUDE.md."),
];

const CURSOR_TEAM_KIT = [
  model("check-compiler-errors", "Run the compile and type-check commands and report failures."),
  model("control-cli", "Build a local harness to drive, inspect and profile an interactive CLI or TUI."),
  model("control-ui", "Build a local browser harness to drive and inspect a web, IDE or Electron UI."),
  model("deslop", "Remove generated code slop and clean up code style."),
  model("fix-ci", "Find a pull request's failing checks, read their logs and apply focused fixes."),
  model("fix-merge-conflicts", "Resolve merge conflicts without prompting, then validate the build and tests."),
  model("get-pr-comments", "Fetch and summarise the review comments on the active pull request."),
  model("loop-on-ci", "Watch a pull request's checks and fix failures until they pass."),
  model("make-pr-easy-to-review", "Tidy a pull request for review: its history, its description and notes for reviewers."),
  model("new-branch-and-pr", "Create a fresh branch, complete the work and open a pull request."),
  slash("pr-review-canvas", "Generate an interactive walkthrough of a pull request as an HTML page."),
  model("review-and-ship", "Review the branch, run or write tests, commit, and open or update a pull request."),
  model("run-smoke-tests", "Run Playwright smoke tests, debug failures and verify fixes."),
  slash("thermo-nuclear-code-quality-review", "An extremely strict maintainability review of abstractions, large files and tangled conditions."),
  model("verify-this", "Verify a claim with fresh local evidence: verified, not verified or inconclusive."),
  model("weekly-review", "A weekly synthesis of your commits: bug fixes, tech debt and new work."),
  model("what-did-i-get-done", "Summarise your commits over a period into a short update."),
  model("workflow-from-chats", "Turn the working preferences in recent Cursor chats into skills, rules or workflow docs."),
];

const SUPERPOWERS = [
  model("brainstorming", "Explore intent, requirements and design before any creative work."),
  model("diagnosing-superpowers", "Find out why a Superpowers session went wrong, and write a bug report for its maintainers."),
  model("dispatching-parallel-agents", "Hand two or more independent tasks to agents working in parallel."),
  model("executing-plans", "Carry out an implementation plan in the current session yourself."),
  model("finishing-a-development-branch", "Decide how to integrate finished work once the tests pass."),
  model("receiving-code-review", "Take review feedback with technical rigour: verify it before implementing it."),
  model("requesting-code-review", "Ask for a review before merging, to check the work meets its requirements."),
  model("subagent-driven-development", "Carry out a plan's independent tasks through subagents in the current session."),
  model("systematic-debugging", "Debug a bug or a failing test systematically before proposing a fix."),
  model("test-driven-development", "Write the test first, for any feature or fix."),
  model("using-git-worktrees", "Start feature work in an isolated workspace, a git worktree where needed."),
  model("using-superpowers", "How to find and use skills, from the start of every conversation."),
  model("verification-before-completion", "Run the verification and read its output before claiming work is done."),
  model("writing-plans", "Turn the spec of a multi-step task into a plan before touching code."),
  model("writing-skills", "Create, edit and test skills before deploying them."),
];

/** The catalogue the harness ships. */
export const CATALOGUE: Catalogue = {
  skills: [
    {
      id: "mattpocock-engineering",
      url: "https://github.com/mattpocock/skills",
      folder: "skills/engineering",
      title: "Matt Pocock — engineering",
      pitch: "Test-driven development, code review, diagnosing bugs, domain modelling, prototypes, research and spec-to-tickets flows, from the author's own agents directory.",
      licence: POCOCK_LICENCE,
      skillCount: POCOCK_ENGINEERING.length,
      members: POCOCK_ENGINEERING,
      alwaysOnHints: [],
      fastMoving: true,
      tags: ["engineering", "tdd", "code-review", "planning"],
    },
    {
      id: "mattpocock-productivity",
      url: "https://github.com/mattpocock/skills",
      folder: "skills/productivity",
      title: "Matt Pocock — productivity",
      pitch: "Grilling a plan until it holds, writing for agents, handoffs and questionnaires: the working habits around the engineering set.",
      licence: POCOCK_LICENCE,
      skillCount: POCOCK_PRODUCTIVITY.length,
      members: POCOCK_PRODUCTIVITY,
      alwaysOnHints: [],
      fastMoving: true,
      tags: ["productivity", "planning", "writing"],
    },
    {
      id: "unslop",
      url: "https://github.com/theclaymethod/unslop",
      folder: ".",
      title: "Unslop",
      pitch: "Removes the tells of machine-written prose: audits or rewrites text so it reads as a person wrote it.",
      licence: {
        spdx: "MIT",
        where: { kind: "frontmatter" },
        holder: null,
        link: "https://github.com/theclaymethod/unslop/blob/main/SKILL.md",
        note: "MIT is declared in SKILL.md's frontmatter and in the README only: the repository has no LICENSE file and names no copyright holder, whose notice MIT asks a copy to keep. Upstream issue 9 asks for one.",
      },
      skillCount: 1,
      members: [model("unslop", "Remove the patterns of machine-written prose: an audit, or a two-pass rewrite.")],
      alwaysOnHints: [{ name: "unslop", characters: 5924 }],
      fastMoving: false,
      tags: ["writing", "prose"],
    },
    {
      id: "cursor-team-kit",
      url: "https://github.com/cursor/plugins",
      folder: "cursor-team-kit/skills",
      title: "Cursor team kit",
      pitch: "Ship-it plumbing: fix CI, resolve merge conflicts, open a reviewable pull request and chase its comments.",
      licence: licenceFile("cursor-team-kit/LICENSE", "Cursor", "https://github.com/cursor/plugins/blob/main/cursor-team-kit/LICENSE"),
      skillCount: CURSOR_TEAM_KIT.length,
      members: CURSOR_TEAM_KIT,
      alwaysOnHints: [],
      fastMoving: true,
      tags: ["engineering", "ci", "pull-requests"],
    },
    {
      id: "superpowers",
      url: "https://github.com/obra/superpowers",
      folder: "skills",
      title: "Superpowers",
      pitch: "A development methodology as skills: brainstorming, writing plans, executing them and finishing a branch.",
      licence: licenceFile("LICENSE", "Jesse Vincent", "https://github.com/obra/superpowers/blob/main/LICENSE"),
      skillCount: SUPERPOWERS.length,
      members: SUPERPOWERS,
      alwaysOnHints: [],
      fastMoving: false,
      tags: ["engineering", "planning", "methodology"],
    },
  ],
  instructions: {
    groups: [
      { id: "setup", title: "Setup" },
      { id: "coding", title: "Coding" },
      { id: "working", title: "Working with me" },
      { id: "custom", title: "Custom" },
    ],
    entries: [
      {
        id: "setup.about-my-setup",
        group: "setup",
        title: "About my setup",
        summary: "Read the orientation block before looking for a machine, a forge, a key or a bank, and ask when it names none.",
        version: 1,
        text: [
          "The orientation block at the start of these instructions describes my setup as it is now: the environment this run is on, its key managers, forges and memory banks, and the other environments I use. Read it before you go looking for any of them, and trust it over what you remember from an earlier session or find in an old file.",
          "When a task needs something the block does not name, say so and ask me, and tell me what you checked. Never guess a host, a path or a credential.",
        ].join("\n\n"),
        earlierVersions: [],
      },
      {
        id: "coding.fresh-checkout",
        group: "coding",
        title: "Read code from a fresh checkout",
        summary: "Pull or clone before you reference code, and say which commit you read.",
        version: 1,
        text: "Before you reference, quote or change code in a repository, make sure you are reading the current default branch: pull the latest from its remote, or clone it fresh into a scratch directory. Say which commit you read from. A stale checkout produces confident answers about code that no longer exists.",
        earlierVersions: [],
      },
      {
        id: "coding.pr-still-open",
        group: "coding",
        title: "Check a pull request is still open before pushing to it",
        summary: "A merged or closed PR gets a new branch and a new PR, not more commits.",
        version: 1,
        text: "Before pushing further commits to a branch that has a pull request, check that the pull request is still open. If it has been merged or closed, do not push to that branch: start a new branch from the default branch and open a new pull request that links the old one.",
        earlierVersions: [],
      },
      {
        id: "coding.read-bot-reviews",
        group: "coding",
        title: "Read automated reviews after pushing",
        summary: "Wait for CI and any review bots, then answer or fix every comment before asking a person.",
        version: 1,
        text: "After you push a pull request, wait for continuous integration and for any automated reviewers the repository runs (AI review bots, linters that comment). Read every comment they leave and either fix it or reply with why not, before you ask a person to review or before you merge. If the repository runs no automated reviewers, skip this. Never merge a pull request you were allowed to merge without checking for new automated review comments first.",
        earlierVersions: [],
      },
      {
        id: "coding.no-attribution",
        group: "coding",
        title: "No attribution lines",
        summary: "No co-author trailers, no generated-by footers, no signature in PR descriptions.",
        version: 1,
        text: "Do not add yourself as an author or co-author of commits, and do not append any generated-by, signed-off or attribution line to commit messages or pull request descriptions. The person you work for is the author of record.",
        earlierVersions: [],
      },
      {
        id: "working.ask-with-a-recommendation",
        group: "working",
        title: "Ask with a recommended answer",
        summary: "Interactive question prompts, researched first, best option first.",
        version: 1,
        text: "When you need a decision from me, ask through an interactive question prompt rather than in prose. Do enough research first to have a recommended answer, put that option first and mark it as recommended, and give each option a one-line consequence. Ask only what you cannot settle yourself.",
        earlierVersions: [],
      },
    ],
  },
};
