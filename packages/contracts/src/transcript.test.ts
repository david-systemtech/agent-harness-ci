import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { capabilities } from "../test/run-fixtures.js";
import {
  AdapterCapabilities,
  AttachmentInput,
  AuthStatus,
  CAPABILITY_FLAGS,
  CredentialSpec,
  DelegatedWorkRow,
  EVENT_TYPES,
  KNOWN_ITEM_KINDS,
  MAX_ATTACHMENT_BYTES,
  PromptAnsweredPayload,
  PromptOpenedPayload,
  RunSuggestion,
  SendResponse,
  SessionEventType,
  SessionSnapshot,
  SessionForkedPayload,
  StandingRewind,
  SummaryPatch,
  TRANSCRIPT_EVENT_TYPES,
  TRANSCRIPT_EVENT_TYPE_NAMES,
  TranscriptItem,
  UPDATE_INTERRUPT_OUTCOMES,
  UPDATE_INTERRUPT_REASONS,
  eventTypeEntry,
  exportedSchemas,
  isListEvent,
  jsonSchemaFiles,
  listEventTypes,
  publishedEventPayloads,
  registry,
} from "./index.js";

/**
 * The contract tests of the claude-adapter spec ("Testing Decisions",
 * contract tests): the transcript vocabulary on the `session` stream with
 * its flags and payloads, the snapshot with unknown item kinds kept opaque,
 * the transport-neutral adapter schemas, and every one of them in the JSON
 * Schema export (whose own test round-trips every exported schema through
 * its fixtures).
 */

const at = "2026-09-24T01:02:03.456Z";
const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const messageId = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

/** The vocabulary the ticket names, in the spec's order. */
const VOCABULARY = [
  "run.started",
  "message.sent",
  "message.delivered",
  "assistant.delta",
  "assistant.text",
  "assistant.thinking",
  "tool.started",
  "tool.updated",
  "tool.ended",
  "command.ran",
  "tasks.changed",
  "usage.reported",
  "context.reported",
  "plan.limit",
  "session.provider-linked",
  "session.forked",
  "session.rewound",
  "session.rewind-undone",
  "run.suggested",
  "run.ended",
];

describe("the transcript vocabulary", () => {
  it("is on the session stream: every type the spec lists, message.requeued for ADR 0022's interrupt and message.withdrawn for its withdraw, run.update-interrupted for a run an update cut (#335), and session.history-imported for an imported session's first open (#579)", () => {
    for (const type of VOCABULARY) expect(eventTypeEntry("session", type), type).toBeDefined();
    expect([...TRANSCRIPT_EVENT_TYPE_NAMES].sort()).toEqual([...VOCABULARY, "message.requeued", "message.withdrawn", "run.update-interrupted", "session.history-imported"].sort());
    for (const type of TRANSCRIPT_EVENT_TYPE_NAMES) {
      expect(SessionEventType.safeParse(type).success, type).toBe(true);
      expect(eventTypeEntry("group", type), type).toBeUndefined();
    }
  });

  it("flags run.started and run.ended list, with the summary patch, and no other transcript type", () => {
    const flagged = TRANSCRIPT_EVENT_TYPE_NAMES.filter((type) => isListEvent("session", type));
    expect(flagged).toEqual(["run.started", "run.ended"]);
    for (const type of flagged) expect(EVENT_TYPES.session[type]).toMatchObject({ list: true, patch: SummaryPatch });
    expect(listEventTypes(["session"])).toEqual(expect.arrayContaining(["run.started", "run.ended", "prompt.opened", "prompt.answered"]));
  });

  it("gives every list-flagged session type a patch schema, the prompt types included", () => {
    for (const [type, entry] of Object.entries(EVENT_TYPES.session)) {
      if (entry.list) expect(entry.patch, type).toBeInstanceOf(z.ZodType);
    }
    expect(isListEvent("session", "prompt.opened")).toBe(true);
    expect(isListEvent("session", "prompt.answered")).toBe(true);
  });

  it("fixes every transcript payload, each carrying the run's id but for the fork, the rewind and its undo, which are the session's", () => {
    for (const [type, entry] of Object.entries(TRANSCRIPT_EVENT_TYPES)) {
      expect("reservedFor" in entry, type).toBe(false);
      // A payload that is a union of shapes carries the run's id in every one.
      const payload: z.ZodType = entry.payload;
      const shapes = payload instanceof z.ZodDiscriminatedUnion ? (payload.options as z.ZodObject[]).map((option) => option.shape) : [(payload as z.ZodObject).shape];
      for (const shape of shapes) expect("runId" in shape, type).toBe(!["session.forked", "session.rewound", "session.rewind-undone"].includes(type));
    }
  });

  it("records a run's start with its account, identity, model, effort, clamped mode, workspace, origin and prompt", () => {
    const started = {
      runId,
      accountId: "claude-max",
      identity: { provider: "claude", email: "david@example.com", organisation: null },
      model: "opus",
      effort: "high",
      mode: { requested: "bypassPermissions", effective: "acceptEdits", clamped: true },
      workspace: { kind: "directory", path: "/work/agent-harness" },
      origin: "client",
      promptMessageId: messageId,
      queuedMessageIds: [],
      resumedFrom: null,
      forkedFrom: null,
    };
    const payload = TRANSCRIPT_EVENT_TYPES["run.started"].payload;
    expect(payload.safeParse(started).success).toBe(true);
    expect(payload.safeParse({ ...started, origin: "phone" }).success).toBe(false);
    expect(payload.safeParse({ ...started, mode: "plan" }).success).toBe(false);
  });

  it("ends a run with a reason, a cause on interrupted, and read-now among the causes", () => {
    const ended = TRANSCRIPT_EVENT_TYPES["run.ended"].payload;
    const base = { runId, reason: "interrupted", cause: "user", error: null, usage: null, durationMs: 1200, turnCount: 1, resultText: null };
    expect(ended.safeParse(base).success).toBe(true);
    expect(ended.safeParse({ ...base, cause: "read-now" }).success).toBe(true);
    expect(ended.safeParse({ ...base, reason: "cancelled" }).success).toBe(false);
  });

  it("marks a run an update cut, unflagged, with its update, the version it went to, and what became of the run: continued by a run it names, waiting on a parked prompt, or left for the next message with the reason", () => {
    expect(isListEvent("session", "run.update-interrupted")).toBe(false);
    expect(UPDATE_INTERRUPT_OUTCOMES).toEqual(["continued", "waiting-on-prompt", "next-message"]);
    expect(UPDATE_INTERRUPT_REASONS).toEqual(["no-resume", "account", "mode", "workspace", "deleted", "completions"]);
    const interrupted = TRANSCRIPT_EVENT_TYPES["run.update-interrupted"].payload;
    const cut = { runId, updateId: "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20", toVersion: "0.5.0" };
    const continuationRunId = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
    expect(interrupted.safeParse({ ...cut, outcome: "continued", reason: null, continuationRunId }).success).toBe(true);
    expect(interrupted.safeParse({ ...cut, outcome: "waiting-on-prompt", reason: null, continuationRunId: null }).success).toBe(true);
    for (const reason of UPDATE_INTERRUPT_REASONS) {
      expect(interrupted.safeParse({ ...cut, outcome: "next-message", reason, continuationRunId: null }).success, reason).toBe(true);
    }
    // Continued names its run and no reason; the others name no run, and only the next message gives a reason.
    expect(interrupted.safeParse({ ...cut, outcome: "continued", reason: null, continuationRunId: null }).success).toBe(false);
    expect(interrupted.safeParse({ ...cut, outcome: "continued", reason: "no-resume", continuationRunId }).success).toBe(false);
    expect(interrupted.safeParse({ ...cut, outcome: "waiting-on-prompt", reason: "account", continuationRunId: null }).success).toBe(false);
    expect(interrupted.safeParse({ ...cut, outcome: "next-message", reason: null, continuationRunId: null }).success).toBe(false);
    expect(interrupted.safeParse({ ...cut, outcome: "next-message", reason: "no-resume", continuationRunId }).success).toBe(false);
    expect(interrupted.safeParse({ ...cut, outcome: "dropped", reason: null, continuationRunId: null }).success).toBe(false);
  });

  it("sends a message as a prompt or queued, and delivers a queued one steered or as a prompt", () => {
    const sent = TRANSCRIPT_EVENT_TYPES["message.sent"].payload;
    const message = { runId, messageId, text: "Now the tests", attachments: [], delivery: "queued", heldBy: "provider", ceiling: "acceptEdits" };
    expect(sent.safeParse(message).success).toBe(true);
    expect(sent.safeParse({ ...message, delivery: "steered" }).success).toBe(false);
    expect(sent.parse({ ...message, text: "/tdd feature", skill: { name: "tdd", origin: null } })).toMatchObject({
      text: "/tdd feature", skill: { name: "tdd", origin: null },
    });
    expect(sent.parse(message)).not.toHaveProperty("skill");
    expect(sent.safeParse({ ...message, skill: { name: "tdd" } }).success).toBe(false);
    const delivered = TRANSCRIPT_EVENT_TYPES["message.delivered"].payload;
    expect(delivered.safeParse({ runId, messageId, delivery: "steered" }).success).toBe(true);
    expect(delivered.safeParse({ runId, messageId, delivery: "queued" }).success).toBe(false);
  });
});

describe("the per-session snapshot", () => {
  const summary = {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    createdAt: at,
    updatedAt: at,
    lastActivityAt: at,
    title: "New session",
    titleSource: "default",
    archivedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    tags: [],
    groupId: null,
    settledAt: null,
    settledOverride: null,
    settledBy: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    workspace: { kind: "directory", path: "/work" },
    repositoryIdentity: null,
    workspaceMissingSince: null,
    activity: { state: "idle", since: at },
    parkedPromptCount: 0,
    accountId: "claude-max",
    model: "opus",
    runChoice: { model: "opus", effort: null },
    mode: "acceptEdits",
    browser: null,
    pullRequests: [],
    draft: null,
  };
  const item = { kind: "assistant-text", sequence: 4, runId, itemId: "i-1", text: "Done.", aborted: false };

  it("is the summary, the runs, the items, the parked prompts, the rewinds standing and the session's own instructions at a sequence", () => {
    expect(Object.keys(SessionSnapshot.shape)).toEqual(["sequence", "summary", "suggestion", "runs", "items", "parkedPrompts", "rewinds", "instructions"]);
    expect(registry["sessions.subscribeSession"].result).toBe(SessionSnapshot);
    expect(SessionSnapshot.safeParse({ sequence: 9, summary, runs: [], items: [item], parkedPrompts: [], rewinds: [] }).success).toBe(true);
  });

  it("carries a fork's source and nullable anchor as a known item, while an older snapshot still has only its original items", () => {
    const forked = { kind: "forked", sequence: 2, fromSessionId: summary.id, atMessageId: messageId };
    const snapshot = { sequence: 9, summary, runs: [], items: [forked, item], parkedPrompts: [] };
    expect(SessionSnapshot.parse(snapshot).items).toEqual([forked, item]);
    expect(TranscriptItem.parse({ ...forked, atMessageId: null })).toEqual({ ...forked, atMessageId: null });
    expect(TranscriptItem.safeParse({ ...forked, fromSessionId: "missing-session" }).success).toBe(false);
    expect(TranscriptItem.safeParse({ kind: "forked", sequence: 2, fromSessionId: summary.id }).success).toBe(false);
    expect(SessionSnapshot.parse({ ...snapshot, items: [item] }).items).toEqual([item]);
  });

  it("reads a snapshot without rewinds, an environment's from before #260, as one with no rewind standing, and one without instructions as none", () => {
    expect(SessionSnapshot.parse({ sequence: 9, summary, runs: [], items: [item], parkedPrompts: [] }).rewinds).toEqual([]);
    // An environment from before #506 sends no instructions: the session has none.
    expect(SessionSnapshot.parse({ sequence: 9, summary, runs: [], items: [item], parkedPrompts: [] }).instructions).toBe("");
    // Not in the export's required list either: a client in another language reads the older environment's too.
    const exported = JSON.parse(jsonSchemaFiles().get("transcript/session-snapshot.json") ?? "{}") as { required?: string[]; properties?: Record<string, { default?: unknown }> };
    expect(exported.required).toEqual(["sequence", "summary", "runs", "items", "parkedPrompts"]);
    expect(exported.properties?.["rewinds"]?.default).toEqual([]);
    expect(exported.properties?.["instructions"]?.default).toBe("");
    // A rewind's own fields are all required: only the older environment's missing field is defaulted.
    expect(StandingRewind.safeParse({ sequence: 8, toMessageId: messageId, text: "Two", undoable: true, items: [] }).success).toBe(false);
  });

  it("carries each rewind standing with what it hid, a rewind stacked before it nested in the one that cut it (#260)", () => {
    const message = { kind: "user-message", sequence: 5, runId, messageId: "2c4e6a8b-1d3f-4b5a-9c7e-0a2b4c6d8e0f", text: "Two", attachments: [], delivery: "prompt", heldBy: null, sentAt: at };
    const inner = { sequence: 8, toMessageId: "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", text: "Three", undoable: true, items: [{ ...item, sequence: 7 }], rewinds: [] };
    const outer = { sequence: 9, toMessageId: message.messageId, text: "Two", undoable: true, items: [message], rewinds: [inner] };
    expect(Object.keys(StandingRewind.shape)).toEqual(["sequence", "toMessageId", "text", "undoable", "items", "rewinds"]);
    const parsed = SessionSnapshot.parse({ sequence: 9, summary, runs: [], items: [], parkedPrompts: [], rewinds: [outer] });
    expect(parsed.rewinds).toEqual([outer]);
    expect(StandingRewind.safeParse({ ...outer, rewinds: [{ ...inner, undoable: "yes" }] }).success).toBe(false);
    expect(StandingRewind.safeParse({ ...outer, items: [{ sequence: 7 }] }).success).toBe(false);
    // The export describes the nesting: the snapshot's rewinds, and a rewind's own, are the one named rewind definition.
    const snapshot = JSON.parse(jsonSchemaFiles().get("transcript/session-snapshot.json") ?? "{}") as {
      properties: { rewinds: { items: { $ref: string } } };
      $defs: { StandingRewind: { properties: { rewinds: { items: { $ref: string } } } } };
    };
    expect(snapshot.properties.rewinds.items.$ref).toBe("#/$defs/StandingRewind");
    expect(snapshot.$defs.StandingRewind.properties.rewinds.items.$ref).toBe("#/$defs/StandingRewind");
    // The hand-written interface the recursion needs is the schema's own type.
    expectTypeOf<z.infer<typeof StandingRewind>>().toEqualTypeOf<StandingRewind>();
  });

  it("retains a fork seed in event payloads and snapshots and validates the copied items", () => {
    const history = { title: "Receipts", anchor: "Add the tests", items: [item], runs: [] };
    const payload = { fromSessionId: summary.id, atMessageId: null, fromProviderSessionId: null, history };
    expect(SessionForkedPayload.parse(payload)).toEqual(payload);
    const forked = { kind: "forked", sequence: 8, fromSessionId: summary.id, atMessageId: null, history };
    expect(SessionSnapshot.parse({ sequence: 9, summary, runs: [], items: [forked], parkedPrompts: [], rewinds: [] }).items).toEqual([forked]);
    expect(SessionForkedPayload.safeParse({ ...payload, history: { ...history, items: [{ kind: "assistant-text", sequence: 4 }] } }).success).toBe(false);
    expect(TranscriptItem.safeParse({ ...forked, history: { ...history, anchor: 3 } }).success).toBe(false);
  });

  it("keeps an update cut's outcome, reason and continuation as a known item, refusing inconsistent outcomes", () => {
    const cut = { kind: "update-interrupted", sequence: 7, runId, updateId: messageId, toVersion: "0.5.0" };
    for (const outcome of [
      { outcome: "continued", reason: null, continuationRunId: runId },
      { outcome: "waiting-on-prompt", reason: null, continuationRunId: null },
      { outcome: "next-message", reason: "account", continuationRunId: null },
    ]) expect(TranscriptItem.parse({ ...cut, ...outcome })).toEqual({ ...cut, ...outcome });
    expect(TranscriptItem.safeParse({ ...cut, outcome: "continued", reason: null, continuationRunId: null }).success).toBe(false);
    expect(TranscriptItem.safeParse({ ...cut, outcome: "next-message", reason: null, continuationRunId: null }).success).toBe(false);
    expect(TranscriptItem.safeParse({ ...cut, outcome: "waiting-on-prompt", reason: "account", continuationRunId: runId }).success).toBe(false);
  });

  it("keeps an item of a kind it does not know opaque, every field of it kept, rather than failing", () => {
    const unknown = { kind: "plan-card", sequence: 7, plan: "Step one", steps: [1, 2] };
    expect(TranscriptItem.parse(unknown)).toEqual(unknown);
    const parsed = SessionSnapshot.parse({ sequence: 9, summary, runs: [], items: [item, unknown], parkedPrompts: [], rewinds: [] });
    expect(parsed.items[1]).toEqual(unknown);
    // An item still needs a kind and its place.
    expect(TranscriptItem.safeParse({ sequence: 7 }).success).toBe(false);
    expect(TranscriptItem.safeParse({ kind: "plan-card" }).success).toBe(false);
    // A known kind is never opaque: a malformed one fails, in zod and in the exported JSON Schema's pattern.
    expect(TranscriptItem.safeParse({ kind: "assistant-text", sequence: 7 }).success).toBe(false);
    expect(KNOWN_ITEM_KINDS).toEqual([...new Set(TranscriptItem.options.slice(0, -1).map((option) => (option.shape.kind as z.ZodLiteral<string>).value))]);
    const exported = exportedSchemas().find((entry) => entry.path === "transcript/transcript-item.json");
    expect(JSON.stringify(exported && z.toJSONSchema(exported.schema))).toContain("(?!(?:user-message|");
  });
});

describe("the adapter's transport-neutral schemas", () => {
  it("publishes whether an adapter can withdraw a provider-held message independently of its queue", () => {
    const descriptor = AdapterCapabilities.parse({ ...capabilities, withdraw: false });
    expect(descriptor).toMatchObject({ providerQueue: true, withdraw: false });
  });

  it("describe the capabilities descriptor with a flag per optional power, the instruction channel, whether the provider loads a trusted repository's instructions (#500) and which of its skill roots (#495) itself, and the modes", () => {
    for (const name of CAPABILITY_FLAGS) expect(AdapterCapabilities.shape[name], name).toBeDefined();
    expect(Object.keys(AdapterCapabilities.shape)).toEqual(["provider", "displayName", ...CAPABILITY_FLAGS, "instructionChannel", "nativeProjectInstructions", "nativeSkillRoots", "modes"]);
  });

  it("describe the credential spec and the status it parses, the run suggestion, the send response and the delegated-work row", () => {
    expect(Object.keys(CredentialSpec.shape)).toEqual(["configDirVariable", "strippedVariables", "signIn", "status", "logout"]);
    expect(Object.keys(AuthStatus.shape)).toEqual(["signedIn", "authMethod", "email", "orgName", "subscriptionType", "error", "expired"]);
    // Only a provider that can tell says the login lapsed (#134); absent, the account store reads signed out.
    expect(AuthStatus.shape.expired.safeParse(undefined).success).toBe(true);
    expect(RunSuggestion.safeParse({ runId, suggestion: "Now run the tests" }).success).toBe(true);
    expect(SendResponse.safeParse({ runId, messageId, delivery: "queued", heldBy: "environment" }).success).toBe(true);
    expect(registry["runs.send"].result).toBe(SendResponse);
    expect(
      DelegatedWorkRow.safeParse({
        taskId: "t-1",
        kind: "local_agent",
        description: "Explore the tests",
        status: "running",
        startedAt: at,
        endedAt: null,
        subagentType: "Explore",
        toolCallId: null,
        error: null,
      }).success,
    ).toBe(true);
  });

  it("cap an attachment on its decoded bytes, padding included: the largest padded one is taken, one byte more is not", () => {
    const groups = Math.ceil(MAX_ATTACHMENT_BYTES / 3);
    const attachment = (data: string) => ({ kind: "file", name: "big.bin", mediaType: "application/octet-stream", data });
    // MAX_ATTACHMENT_BYTES leaves two bytes in its last group, so the largest attachment ends in one =.
    expect(MAX_ATTACHMENT_BYTES % 3).toBe(2);
    expect(AttachmentInput.safeParse(attachment(`${"A".repeat(groups * 4 - 1)}=`)).success).toBe(true);
    expect(AttachmentInput.safeParse(attachment("A".repeat(groups * 4))).success).toBe(false);
  });

  it("are all in the JSON Schema export, with the vocabulary's payloads and the snapshot", () => {
    const exported = new Set(exportedSchemas().map((entry) => entry.schema));
    for (const schema of [AdapterCapabilities, CredentialSpec, AuthStatus, RunSuggestion, SendResponse, DelegatedWorkRow, SessionSnapshot, StandingRewind, TranscriptItem]) {
      expect(exported.has(schema)).toBe(true);
    }
    const published = new Map(publishedEventPayloads());
    for (const [type, entry] of Object.entries(TRANSCRIPT_EVENT_TYPES)) expect(published.get(type), type).toBe(entry.payload);
    // The prompt types are published with the payloads #130 fixed.
    expect(published.get("prompt.opened")).toBe(PromptOpenedPayload);
    expect(published.get("prompt.answered")).toBe(PromptAnsweredPayload);
  });
});
