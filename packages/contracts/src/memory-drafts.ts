import { z } from "zod";
import { BankId } from "./bank-registry.js";
import { BankName, MEMORY_TYPES } from "./banks.js";
import { defineMethod } from "./method.js";
import { BankReadOnlyError, BankRequiredError, ValidationFailedError } from "./methods/banks.js";
import { RepositoryIdentity } from "./repository-identity.js";
import { SessionId } from "./sessions.js";

/** Safe folder segments, never paths: org, project, optional area and topic. */
export const MemoryScopeSegment = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(80).meta({ description: "A lower-case folder segment of letters, digits and hyphens, never a filesystem path." });
export const MemoryDraftScope = z.strictObject({ org: MemoryScopeSegment, project: MemoryScopeSegment, area: MemoryScopeSegment.optional() });
/** Content limits are judged by the common validator, so refusals carry rule ids. */
export const MemoryDraftInput = z.object({
  bank: BankName.optional(), scope: MemoryDraftScope, topic: MemoryScopeSegment.optional(),
  name: z.string().min(1).max(200), description: z.string(), body: z.string(),
  type: z.enum(MEMORY_TYPES).meta({ description: "A memory is a user, feedback, project or reference fact." }), appliesTo: z.array(RepositoryIdentity).optional(),
});
export type MemoryDraftInput = z.infer<typeof MemoryDraftInput>;
export const MemoryRetireInput = z.object({ bank: BankName, name: z.string().min(1), reason: z.string().min(1) });
export type MemoryRetireInput = z.infer<typeof MemoryRetireInput>;
/** One queued change; a later draft or retirement of its name replaces it. */
export const BankDraft = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("draft"), name: z.string().min(1), path: z.string().min(1), removePaths: z.array(z.string().min(1)).optional().meta({ description: "Prior paths of this name removed when the draft moves to a different scope or topic." }), content: z.string() }),
  z.object({ kind: z.literal("retire"), name: z.string().min(1), path: z.string().min(1), removePaths: z.array(z.string().min(1)).optional().meta({ description: "Prior paths removed by queued moves of this name." }), reason: z.string().min(1) }),
]);
export type BankDraft = z.infer<typeof BankDraft>;
export const BankDraftQueuedPayload = z.object({ sessionId: SessionId, bankId: BankId, change: BankDraft });
export type BankDraftQueuedPayload = z.infer<typeof BankDraftQueuedPayload>;
export const banksDraftsList = defineMethod({
  name: "banks.drafts.list", scope: "read", kind: "query",
  params: z.object({ sessionId: SessionId, bankId: BankId.optional() }),
  result: z.object({ queues: z.array(z.object({ bankId: BankId, drafts: z.array(BankDraft) })) }), errors: [],
});

/** Promotion lands this session's queue in the named bank, or the sole writable bank. */
export const MemoryPromoteInput = z.object({ bank: BankName.optional() });
export type MemoryPromoteInput = z.infer<typeof MemoryPromoteInput>;
export const MemoryPromoteResult = z.discriminatedUnion("state", [
  z.object({ state: z.literal("landed"), bank: BankName, pullRequest: z.string().nullable(), files: z.array(z.object({ path: z.string(), state: z.enum(["present", "removed"]).meta({ description: "Verified main state: the written file is present with its exact content, or the retired file is removed." }) })) }),
  z.object({ state: z.literal("awaiting-review"), bank: BankName, pullRequest: z.string(), files: z.array(z.object({ path: z.string(), state: z.literal("pending") })) }),
  z.object({ state: z.literal("failed"), bank: BankName, step: z.string(), reason: z.string() }),
]);
export type MemoryPromoteResult = z.infer<typeof MemoryPromoteResult>;

/** Consume exactly the landed queue snapshot; a later replacement of a name stays queued. */
export const BankDraftsConsumedPayload = z.object({ sessionId: SessionId, bankId: BankId, changes: z.array(BankDraft) });
export type BankDraftsConsumedPayload = z.infer<typeof BankDraftsConsumedPayload>;

/** Search uses the draft's scope labels, allowing an org prefix before a project is named. */
export const MemorySearchInput = z.object({
  query: z.string().min(1), bank: BankName.optional(),
  scope: z.union([z.strictObject({ org: MemoryScopeSegment }), MemoryDraftScope]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type MemorySearchInput = z.infer<typeof MemorySearchInput>;
/** A read follows a bank, folder/topic or memory pointer; absent, it reads all bank lines. */
export const MemoryReadInput = z.object({ pointer: z.string().min(1).meta({ description: "A bank pointer: bank, bank:org/project[/area]/, bank:org/project[/area]/memories/topic/, or bank:name. Parsed by parseBankPointer, never a filesystem path." }).optional() });
export type MemoryReadInput = z.infer<typeof MemoryReadInput>;

/*
 * The memory tools for a caller outside the harness (banks spec, "CLI"; #1044): the CLI's `bank` verbs, run by a
 * Claude Code session on the environment's machine, ask what a run's `memory` tools ask, and are answered by the same
 * operations. Only a local client session (the bootstrap grant's) may call them: any other is `forbidden` with reason
 * `local`. The caller's banks are those in scope for the environment's default account, the account a session with
 * none of its own runs on (ADR 0018), and the repository it works in; its drafts join the queue it names, its own
 * session's, which a later promote lands. Queries, as the tools' calls are: a draft of a queued name replaces it,
 * and a promote lands the queue as it is then, so asking again changes nothing twice.
 */

/** The repository the outside caller works in, which scopes its banks as a session's workspace does. */
const CallerRepository = RepositoryIdentity.nullable().meta({ description: "The repository identity of the directory the caller works in (workspaces.inspect's); null for none, under which only banks scoped to every repository are in scope." });
/**
 * The outside caller's own draft queue, named by its own session's id: not a harness session's, so the param is
 * `queue` and never `sessionId`, which names a harness session throughout the protocol.
 */
const CallerQueue = SessionId.meta({ description: "The caller's own draft queue: its own session's id, a version 4 UUID (a Claude Code session's), not a harness session's. Drafts join the queue per bank and promote lands it." });

export const banksMemorySearch = defineMethod({
  name: "banks.memory.search", scope: "read", kind: "query",
  params: MemorySearchInput.extend({ repositoryIdentity: CallerRepository }),
  result: z.object({ text: z.string().meta({ description: "The memory tool's answer: each hit as its pointer and line, then n of N." }) }), errors: [],
});
export const banksMemoryRead = defineMethod({
  name: "banks.memory.read", scope: "read", kind: "query",
  params: MemoryReadInput.extend({ repositoryIdentity: CallerRepository }),
  result: z.object({ text: z.string().meta({ description: "The memory tool's answer: the pointer's exact index or file, ending with its folder and count." }) }), errors: [],
});
export const banksMemoryDraft = defineMethod({
  name: "banks.memory.draft", scope: "admin", kind: "query",
  params: MemoryDraftInput.extend({ queue: CallerQueue, repositoryIdentity: CallerRepository }),
  result: z.object({ bank: BankName, change: BankDraft }), errors: [BankRequiredError, BankReadOnlyError, ValidationFailedError],
});
export const banksMemoryPromote = defineMethod({
  name: "banks.memory.promote", scope: "admin", kind: "query",
  params: MemoryPromoteInput.extend({ queue: CallerQueue, repositoryIdentity: CallerRepository }),
  result: z.object({ promotion: MemoryPromoteResult }), errors: [BankRequiredError, BankReadOnlyError],
});
