import { describe, expect, it } from "vitest";
import {
  AUTO_DECIDERS,
  DecidedBy,
  ENVIRONMENT_NOTICE_TYPES,
  EVENT_TYPES,
  EnvironmentNotice,
  KNOWN_ITEM_KINDS,
  PROMPT_KINDS,
  PromptAnsweredPayload,
  PromptOpenedPayload,
  SummaryPatch,
  TranscriptItem,
  isListEvent,
  promptAnswerMisfits,
  registry,
} from "./index.js";

/**
 * The prompt vocabulary (#130; permissions spec, "Prompts, parked prompts and
 * the TTL", "Events", "Methods on the wire"): the permissions names win over
 * the adapter spec's (conflict X1).
 */

const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const opened = {
  runId,
  promptId: "toolu_1",
  kind: "permission",
  toolName: "Bash",
  toolCallId: "toolu_1",
  input: { command: "rm -rf build" },
  summary: "Bash: rm -rf build",
  blockedPath: null,
  reason: "rm is not allowed without asking",
  questions: null,
  plan: null,
  suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }],
  agentId: null,
  denylist: null,
  mode: "acceptEdits",
  ceiling: "bypassPermissions",
  ttlExpiresAt: null,
};

const answered = {
  runId,
  promptId: "toolu_1",
  decision: "allow",
  message: null,
  answers: null,
  updatedInput: null,
  mode: null,
  remember: "session",
  decidedBy: "cs-1",
  delivery: "live",
};

describe("the prompt vocabulary", () => {
  it("has the permissions kinds and never the adapter spec's tool", () => {
    expect(PROMPT_KINDS).toEqual(["permission", "denylist", "question", "plan"]);
  });

  it("puts prompt.opened and prompt.answered on the session stream, list-flagged with the summary patch", () => {
    for (const type of ["prompt.opened", "prompt.answered"]) {
      expect(isListEvent("session", type), type).toBe(true);
      expect(EVENT_TYPES.session[type as "prompt.opened"]).toMatchObject({ list: true, patch: SummaryPatch });
    }
    expect(EVENT_TYPES.session["prompt.opened"].payload).toBe(PromptOpenedPayload);
    expect(EVENT_TYPES.session["prompt.answered"].payload).toBe(PromptAnsweredPayload);
    expect(Object.hasOwn(EVENT_TYPES.session, "prompt.raised")).toBe(false);
  });

  it("carries a prompt's fields: tool, input, summary, blocked path, reason, questions, plan, remember-suggestions", () => {
    expect(PromptOpenedPayload.parse(opened)).toEqual(opened);
    const question = {
      ...opened,
      kind: "question",
      toolName: "AskUserQuestion",
      summary: "Which library?",
      questions: [{ header: "Library", question: "Which library?", options: [{ label: "date-fns", description: "Small" }, { label: "luxon", description: "" }], multiSelect: false }],
    };
    expect(PromptOpenedPayload.safeParse(question).success).toBe(true);
    expect(PromptOpenedPayload.safeParse({ ...opened, kind: "plan", plan: "1. Read\n2. Write" }).success).toBe(true);
    expect(PromptOpenedPayload.safeParse({ ...opened, kind: "tool" }).success).toBe(false);
    expect(PromptOpenedPayload.safeParse({ ...opened, summary: "" }).success).toBe(false);
  });

  it("says who answered: a client session's id, or {auto} with one of the rules", () => {
    expect(AUTO_DECIDERS).toEqual(["unattended", "bypass", "ttl", "run_ended", "reviewer", "cancelled"]);
    expect(DecidedBy.safeParse("cs-1").success).toBe(true);
    for (const auto of AUTO_DECIDERS) expect(DecidedBy.safeParse({ auto }).success, auto).toBe(true);
    expect(DecidedBy.safeParse({ auto: "timeout" }).success).toBe(false);
    expect(DecidedBy.safeParse("").success).toBe(false);
    expect(PromptAnsweredPayload.parse(answered)).toEqual(answered);
    expect(PromptAnsweredPayload.safeParse({ ...answered, decidedBy: { auto: "run_ended" }, remember: null, delivery: null }).success).toBe(true);
  });

  it("raises prompt.parked and prompt.resolved on the environment stream", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toEqual(expect.arrayContaining(["prompt.parked", "prompt.resolved"]));
    expect(
      EnvironmentNotice.safeParse({
        type: "prompt.parked",
        payload: { sessionId, runId, promptId: "toolu_1", kind: "permission", title: "Fix the receipts", summary: "Bash: rm -rf build" },
      }).success,
    ).toBe(true);
    expect(
      EnvironmentNotice.safeParse({ type: "prompt.resolved", payload: { sessionId, runId, promptId: "toolu_1", decision: "deny", decidedBy: { auto: "run_ended" } } }).success,
    ).toBe(true);
  });

  it("keeps a prompt in the transcript where it was asked, with its answer once it has one", () => {
    expect(KNOWN_ITEM_KINDS).toContain("prompt");
    const item = { kind: "prompt", sequence: 7, runId, promptId: "toolu_1", prompt: opened, answer: null };
    expect(TranscriptItem.parse(item)).toEqual(item);
    expect(TranscriptItem.safeParse({ ...item, answer: answered }).success).toBe(true);
    // A known kind is held to its own schema: a malformed prompt item is never kept opaque.
    expect(TranscriptItem.safeParse({ kind: "prompt", sequence: 7 }).success).toBe(false);
  });

  it("names the parts of an answer that do not fit its prompt's kind or its decision, a null part absent", () => {
    const allow = { decision: "allow", answers: null, updatedInput: null, mode: null, remember: null } as const;
    expect(promptAnswerMisfits("permission", { ...allow, updatedInput: { command: "ls" }, remember: "session" })).toEqual([]);
    expect(promptAnswerMisfits("question", { ...allow, answers: { "Which library?": "luxon" } })).toEqual([]);
    expect(promptAnswerMisfits("plan", { ...allow, mode: "auto" })).toEqual([]);
    expect(promptAnswerMisfits("denylist", { decision: "deny" })).toEqual([]);
    const paths = (...args: Parameters<typeof promptAnswerMisfits>) => promptAnswerMisfits(...args).map((misfit) => misfit.path);
    expect(paths("permission", { ...allow, decision: "deny", remember: "session" })).toEqual(["remember"]);
    expect(paths("denylist", { ...allow, remember: "session", updatedInput: {} })).toEqual(["remember", "updatedInput"]);
    expect(paths("permission", { ...allow, answers: {}, mode: "plan" })).toEqual(["answers", "mode"]);
    expect(paths("plan", { decision: "deny", mode: "acceptEdits" })).toEqual(["mode"]);
  });

  it("lists parked prompts at read and answers them at runs:drive, a command", () => {
    expect(registry["permissions.prompts.list"]).toMatchObject({ scope: "read", kind: "query" });
    expect(registry["permissions.prompts.answer"]).toMatchObject({ scope: "runs:drive", kind: "command" });
    const params = registry["permissions.prompts.answer"].params;
    const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(params.safeParse({ commandId, promptId: "toolu_1", decision: "allow", remember: "session" }).success).toBe(true);
    expect(params.safeParse({ commandId, promptId: "toolu_1", decision: "maybe" }).success).toBe(false);
    expect(params.safeParse({ promptId: "toolu_1", decision: "allow" }).success).toBe(false);
    expect(Object.hasOwn(registry, "runs.answerPrompt")).toBe(false);
  });
});
