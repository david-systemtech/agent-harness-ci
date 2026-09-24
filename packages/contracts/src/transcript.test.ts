import { describe, expect, it } from "vitest";
import { z } from "zod";
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
  RunSuggestion,
  SendResponse,
  SessionEventType,
  SessionSnapshot,
  SummaryPatch,
  TRANSCRIPT_EVENT_TYPES,
  TRANSCRIPT_EVENT_TYPE_NAMES,
  TranscriptItem,
  eventTypeEntry,
  exportedSchemas,
  isListEvent,
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
  "plan.limit",
  "session.provider-linked",
  "session.forked",
  "session.rewound",
  "run.ended",
];

describe("the transcript vocabulary", () => {
  it("is on the session stream: every type the spec lists, and message.requeued for ADR 0022's interrupt", () => {
    for (const type of VOCABULARY) expect(eventTypeEntry("session", type), type).toBeDefined();
    expect([...TRANSCRIPT_EVENT_TYPE_NAMES].sort()).toEqual([...VOCABULARY, "message.requeued"].sort());
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

  it("gives every list-flagged session type a patch schema, the reserved prompt types included", () => {
    for (const [type, entry] of Object.entries(EVENT_TYPES.session)) {
      if (entry.list) expect(entry.patch, type).toBeInstanceOf(z.ZodType);
    }
    expect(isListEvent("session", "prompt.opened")).toBe(true);
    expect(isListEvent("session", "prompt.answered")).toBe(true);
  });

  it("fixes every transcript payload, each carrying the run's id but for the fork and the rewind, which are the session's", () => {
    for (const [type, entry] of Object.entries(TRANSCRIPT_EVENT_TYPES)) {
      expect("reservedFor" in entry, type).toBe(false);
      const shape = (entry.payload as z.ZodObject).shape;
      expect("runId" in shape, type).toBe(!["session.forked", "session.rewound"].includes(type));
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

  it("sends a message as a prompt or queued, and delivers a queued one steered or as a prompt", () => {
    const sent = TRANSCRIPT_EVENT_TYPES["message.sent"].payload;
    const message = { runId, messageId, text: "Now the tests", attachments: [], delivery: "queued", heldBy: "provider", ceiling: "acceptEdits" };
    expect(sent.safeParse(message).success).toBe(true);
    expect(sent.safeParse({ ...message, delivery: "steered" }).success).toBe(false);
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
    activity: { state: "idle", since: at },
    parkedPromptCount: 0,
    accountId: "claude-max",
    model: "opus",
    mode: "acceptEdits",
    pullRequests: [],
    draft: null,
  };
  const item = { kind: "assistant-text", sequence: 4, runId, itemId: "i-1", text: "Done.", aborted: false };

  it("is the summary, the runs, the items and the parked prompts at a sequence", () => {
    expect(Object.keys(SessionSnapshot.shape)).toEqual(["sequence", "summary", "runs", "items", "parkedPrompts"]);
    expect(registry["sessions.subscribeSession"].result).toBe(SessionSnapshot);
    expect(SessionSnapshot.safeParse({ sequence: 9, summary, runs: [], items: [item], parkedPrompts: [] }).success).toBe(true);
  });

  it("keeps an item of a kind it does not know opaque, every field of it kept, rather than failing", () => {
    const unknown = { kind: "plan-card", sequence: 7, plan: "Step one", steps: [1, 2] };
    expect(TranscriptItem.parse(unknown)).toEqual(unknown);
    const parsed = SessionSnapshot.parse({ sequence: 9, summary, runs: [], items: [item, unknown], parkedPrompts: [] });
    expect(parsed.items[1]).toEqual(unknown);
    // An item still needs a kind and its place.
    expect(TranscriptItem.safeParse({ sequence: 7 }).success).toBe(false);
    expect(TranscriptItem.safeParse({ kind: "plan-card" }).success).toBe(false);
    // A known kind is never opaque: a malformed one fails, in zod and in the exported JSON Schema's pattern.
    expect(TranscriptItem.safeParse({ kind: "assistant-text", sequence: 7 }).success).toBe(false);
    expect(KNOWN_ITEM_KINDS).toEqual(TranscriptItem.options.slice(0, -1).map((option) => (option.shape.kind as z.ZodLiteral<string>).value));
    const exported = exportedSchemas().find((entry) => entry.path === "transcript/transcript-item.json");
    expect(JSON.stringify(exported && z.toJSONSchema(exported.schema))).toContain("(?!(?:user-message|");
  });
});

describe("the adapter's transport-neutral schemas", () => {
  it("describe the capabilities descriptor with a flag per optional power, the instruction channel and the modes", () => {
    for (const name of CAPABILITY_FLAGS) expect(AdapterCapabilities.shape[name], name).toBeDefined();
    expect(Object.keys(AdapterCapabilities.shape)).toEqual(["provider", "displayName", ...CAPABILITY_FLAGS, "instructionChannel", "modes"]);
  });

  it("describe the credential spec and the status it parses, the run suggestion, the send response and the delegated-work row", () => {
    expect(Object.keys(CredentialSpec.shape)).toEqual(["configDirVariable", "strippedVariables", "signIn", "status", "logout"]);
    expect(Object.keys(AuthStatus.shape)).toEqual(["signedIn", "authMethod", "email", "orgName", "subscriptionType", "error"]);
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
    for (const schema of [AdapterCapabilities, CredentialSpec, AuthStatus, RunSuggestion, SendResponse, DelegatedWorkRow, SessionSnapshot, TranscriptItem]) {
      expect(exported.has(schema)).toBe(true);
    }
    const published = new Map(publishedEventPayloads());
    for (const [type, entry] of Object.entries(TRANSCRIPT_EVENT_TYPES)) expect(published.get(type), type).toBe(entry.payload);
    // The reserved prompt types are not published until #130 fixes their payloads.
    expect(published.has("prompt.opened")).toBe(false);
  });
});
