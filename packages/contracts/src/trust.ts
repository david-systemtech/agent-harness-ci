import { z } from "zod";
import type { EventTypeEntry } from "./event-types.js";
import { ClientSessionId, Timestamp } from "./primitives.js";
import { RepositoryIdentity } from "./repository-identity.js";
import { AbsolutePath, SessionId } from "./sessions.js";
import { SkillSourceFolder } from "./skill-rules.js";
import { SKILL_REPOSITORY_ROOTS } from "./skills.js";

/**
 * The trust gate's shapes (skills spec, "The trust gate"; ADR 0009, ADR
 * 0029): a repository's own instructions, rules, settings, hooks and skills
 * load into runs once David trusts it on this environment. A decision is
 * keyed by the repository's trust key and recorded on the `trust` stream,
 * one stream whose id is the environment's. No record is undecided: a
 * revoke returns the key to undecided.
 */

/** The stream kind of the trust decisions; its one stream's id is the environment's. */
export const TRUST_STREAM_KIND = "trust";

/**
 * What a trust key is, the first of these a session has: its repository
 * identity; its repository's main checkout, so the worktrees of a
 * repository with no remote share one decision; its workspace path. A
 * scratch workspace has none.
 */
export const TRUST_KEY_KINDS = ["identity", "checkout", "directory"] as const;
export const TrustKeyKind = z.enum(TRUST_KEY_KINDS).meta({
  description:
    "What a trust key is: identity (the session's repository identity), checkout (its repository's main checkout, with no identity) or directory (its workspace path, in no repository).",
});
export type TrustKeyKind = z.infer<typeof TrustKeyKind>;

/** A trust key: a repository identity, or an absolute path (a main checkout, or a workspace). */
export const TrustKey = z.union([RepositoryIdentity, AbsolutePath]).meta({
  description:
    "A trust key: the repository identity a decision applies to, or the absolute path of a main checkout or a workspace for a repository with none. A key whose host later becomes a verified forge alias is read on the forge account's canonical host.",
});
export type TrustKey = z.infer<typeof TrustKey>;

/** A decision the gate records: trusted, or declined, which is remembered and never asked again. */
export const TRUST_DECISIONS = ["trusted", "declined"] as const;
export const TrustDecision = z.enum(TRUST_DECISIONS).meta({
  description: "A trust decision: trusted (the repository's own instructions, settings, hooks and skills load into its runs) or declined (they never do, and it is not asked again).",
});
export type TrustDecision = z.infer<typeof TrustDecision>;

/** A key's standing: a recorded decision, or undecided, which runs untrusted. */
export const TRUST_STATES = [...TRUST_DECISIONS, "undecided"] as const;
export const TrustState = z.enum(TRUST_STATES).meta({
  description: "A trust key's standing: trusted, declined, or undecided (no decision recorded: its runs go untrusted and a client may ask).",
});
export type TrustState = z.infer<typeof TrustState>;

/** Who recorded a decision: the client session and its label then, and the session it was asked in. */
const decidedByShape = {
  clientSessionId: ClientSessionId.meta({ description: "The client session that decided." }),
  clientLabel: z.string().meta({ description: "The client session's label when it decided." }),
  sessionId: SessionId.nullable().meta({ description: "The session it was asked in; null for a decision on a key named directly (the Skills step's list)." }),
};

/**
 * A trust record (ADR 0029: when and from which client): the key and its
 * kind, the decision, when it was made, the client session and its label
 * then, and the session it was asked in.
 */
export const TrustRecord = z
  .object({
    key: TrustKey,
    keyKind: TrustKeyKind,
    decision: TrustDecision,
    decidedAt: Timestamp.meta({ description: "When the decision was recorded." }),
    ...decidedByShape,
  })
  .meta({ description: "A recorded trust decision: the key and its kind, the decision, when, the client session and its label then, and the session it was asked in." });
export type TrustRecord = z.infer<typeof TrustRecord>;

/** `trust.granted` and `trust.declined`: the record's fields; the decision is the event's type and when is the event's time. */
export const TrustDecidedPayload = z
  .object({ key: TrustKey, keyKind: TrustKeyKind, ...decidedByShape })
  .meta({
    description:
      "trust.granted or trust.declined: a decision on a key, with the record's fields; the decision is the event's type, and when it was made is the event's occurredAt.",
  });
export type TrustDecidedPayload = z.infer<typeof TrustDecidedPayload>;

/** `trust.revoked`: a key returned to undecided. */
export const TrustRevokedPayload = z
  .object({ key: TrustKey.meta({ description: "The key as its record held it." }), keyKind: TrustKeyKind })
  .meta({ description: "trust.revoked: a key's decision was withdrawn, and the key is undecided again." });
export type TrustRevokedPayload = z.infer<typeof TrustRevokedPayload>;

/** The event types of the trust stream. */
export const TRUST_EVENT_TYPES = {
  "trust.granted": { list: false, payload: TrustDecidedPayload },
  "trust.declined": { list: false, payload: TrustDecidedPayload },
  "trust.revoked": { list: false, payload: TrustRevokedPayload },
} as const satisfies Record<string, EventTypeEntry>;

export type TrustEventType = keyof typeof TRUST_EVENT_TYPES;
export const TrustEventType = z
  .enum(Object.keys(TRUST_EVENT_TYPES) as [TrustEventType, ...TrustEventType[]])
  .meta({ description: "The event types of the trust stream: trust.granted, trust.declined and trust.revoked." });

/** The `trust.updated` notice's payload: nothing beyond the notice. */
export const TrustUpdatedPayload = z.object({}).meta({
  description: "trust.updated: a trust decision was recorded or revoked and has committed; a client reads trust.get and trust.list again.",
});
export type TrustUpdatedPayload = z.infer<typeof TrustUpdatedPayload>;

// The offer ---------------------------------------------------------------------------

/** A skill root the repository holds, and how many members it offers. */
export const TrustOfferSkillRoot = z
  .object({
    root: z.enum(SKILL_REPOSITORY_ROOTS).meta({ description: "The root: .claude/skills or .agents/skills." }),
    directory: SkillSourceFolder.meta({ description: "The directory holding the root, from the repository's root: the workspace directory or one of its parents, . for the root." }),
    members: z.int().positive().meta({ description: "The skill folders it holds." }),
  })
  .meta({ description: "A .claude/skills or .agents/skills in the workspace directory or a parent up to the repository's root, and the skills in it." });
export type TrustOfferSkillRoot = z.infer<typeof TrustOfferSkillRoot>;

/** The hooks the repository's settings declare for one event. */
export const TrustOfferHooks = z
  .object({
    event: z.string().min(1).meta({ description: "The hook event, as the settings name it: PreToolUse, SessionStart." }),
    hooks: z.int().positive().meta({ description: "The hook commands declared for it, across its matchers." }),
  })
  .meta({ description: "The hooks the repository's shared settings declare for one event." });
export type TrustOfferHooks = z.infer<typeof TrustOfferHooks>;

const ruleCount = (list: string) => z.int().nonnegative().meta({ description: `The rules in the settings' permissions.${list}.` });

/** An MCP server the repository declares, which trust never loads. */
export const TrustOfferMcpServer = z
  .object({
    name: z.string().min(1).meta({ description: "Its name among the mcpServers of the repository's .mcp.json." }),
    loaded: z.literal(false).meta({ description: "Never loaded: a run's tool servers are the environment's alone (strictMcpConfig)." }),
  })
  .meta({ description: "One of the MCP servers the repository's .mcp.json declares, marked not loaded: trust never admits it." });
export type TrustOfferMcpServer = z.infer<typeof TrustOfferMcpServer>;

/**
 * What trusting a repository would load (skills spec, "Asking"), counted:
 * its instruction files, the members of each skill root, its commands, its
 * hooks by event, its permission rules and its subagents, with its MCP
 * servers marked not loaded. Its local files (`CLAUDE.local.md`,
 * `.claude/settings.local.json`) never load and are never read.
 */
export const TrustOffer = z
  .object({
    instructionFiles: z.array(z.string().min(1)).meta({
      description:
        "The instruction files, from the repository's root: CLAUDE.md, .claude/CLAUDE.md and AGENTS.md in the workspace directory and each parent up to the root, then each Markdown file under .claude/rules.",
    }),
    skillRoots: z.array(TrustOfferSkillRoot).meta({ description: "Each skill root holding a skill, nearest directory first, .claude/skills before .agents/skills." }),
    commands: z.int().nonnegative().meta({ description: "The Markdown files under .claude/commands." }),
    hooks: z.array(TrustOfferHooks).meta({ description: "The hooks .claude/settings.json declares, by event, in the order it names them." }),
    permissionRules: z
      .object({ allow: ruleCount("allow"), ask: ruleCount("ask"), deny: ruleCount("deny") })
      .meta({ description: "The permission rules .claude/settings.json declares, by list." }),
    subagents: z.int().nonnegative().meta({ description: "The Markdown files under .claude/agents." }),
    mcpServers: z.array(TrustOfferMcpServer).meta({ description: "The servers .mcp.json declares, in its order, each marked not loaded." }),
  })
  .meta({
    description:
      "What trusting a repository would load, counted: instruction files, members per skill root, commands, hooks by event, permission rules and subagents; its MCP servers are listed and marked not loaded. Read from the repository's root, and for a worktree its settings, commands, subagents, rules and MCP servers from the main checkout, where the provider takes them.",
  });
export type TrustOffer = z.infer<typeof TrustOffer>;

/**
 * Whether an offer holds nothing trust would load: no instruction file,
 * skill, command, hook, permission rule or subagent. MCP servers are never
 * loaded, so they alone leave it empty. A client asks the question only
 * while a key is undecided and its offer is not empty.
 */
export const trustOfferEmpty = (offer: TrustOffer): boolean =>
  offer.instructionFiles.length === 0 &&
  offer.skillRoots.length === 0 &&
  offer.commands === 0 &&
  offer.hooks.length === 0 &&
  offer.permissionRules.allow + offer.permissionRules.ask + offer.permissionRules.deny === 0 &&
  offer.subagents === 0;
