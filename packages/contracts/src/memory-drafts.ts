import { z } from "zod";
import { BankId } from "./bank-registry.js";
import { BankName, MEMORY_TYPES } from "./banks.js";
import { defineMethod } from "./method.js";
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
