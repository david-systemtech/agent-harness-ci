import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manualClock } from "../../../test/clock.js";
import { FakeSdk, sdk, type FakeQuery } from "../../../test/fake-claude-sdk.js";
import type { ContainmentLevel, ContainmentReport, PromptAnsweredPayload, PromptOpenedPayload } from "@agent-harness/contracts";
import type { PermissionUpdate, SDKPromptSuggestionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PolicySeam, PromptAutoAnswer, ToolGateRule, ToolServerFactory } from "../../adapter/seams.js";
import type { RunDenylist } from "../../adapter/contract.js";
import type { RunActor } from "../../permissions/resolver.js";

/**
 * The Claude adapter through #119's adapter host (claude-adapter spec,
 * "Testing Decisions"): the host consumes the run's stream through the
 * scoped append, and what is asserted is what lands on the session's
 * stream. The SDK is scripted as in `adapter.test.ts`; a run starts as
 * `runs.start` starts one, outside the wire.
 */

const hooks = vi.hoisted(() => ({ sdk: undefined as undefined | { query: (params: never) => unknown; getSessionMessages: (id: string, options: unknown) => unknown } }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: never) => {
    if (hooks.sdk === undefined) throw new Error("The test installed no fake SDK.");
    return hooks.sdk.query(params);
  },
  getSessionMessages: (id: string, options: unknown) => hooks.sdk?.getSessionMessages(id, options),
}));

const { createClaudeAdapter } = await import("./index.js");
const { openEventLog } = await import("../../event-log/event-log.js");
const { createAdapterHost } = await import("../../adapter/host.js");
const { decideSend, decideStart } = await import("../../runs/run-decider.js");
const { runsProjector } = await import("../../runs/runs-projector.js");
const { sessionListProjector } = await import("../../sessions/session-list.js");
const { permissionsProjector } = await import("../../permissions/permissions-store.js");
const { accountsProjector } = await import("../../accounts/account-store.js");
const { storeAccounts } = await import("../../../test/accounts.js");
const { resolvePolicy } = await import("../../permissions/resolver.js");
const { createProviderTranscriptStore } = await import("../../provider-transcripts/store.js");
const { answerEvents } = await import("../../permissions/tool-decisions.js");
const { autoAnswer } = await import("../../permissions/auto-answer.js");

/** A person's allow, as `permissions.prompts.answer` records it, for the prompt a test names. */
const personAllows = { decision: "allow", message: null, answers: null, updatedInput: null, mode: null, remember: null, decidedBy: "cs-1", delivery: "live" } as const;
const { denylistRule } = await import("../../permissions/denylist-gate.js");
const { denylistPresets } = await import("@agent-harness/contracts");

/** The prompts the session's runs asked, as their `prompt.opened` recorded them. */
const openedOf = (t: { log: { readStream: (stream: { kind: string; id: string }) => { type: string; payload: unknown }[] }; sessionId: string }): PromptOpenedPayload[] =>
  t.log.readStream({ kind: "session", id: t.sessionId }).flatMap((event) => (event.type === "prompt.opened" ? [event.payload as PromptOpenedPayload] : []));

const PROVIDER_SESSION = "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a";

let fake: FakeSdk;
let closers: (() => void)[] = [];

beforeEach(() => {
  fake = new FakeSdk();
  hooks.sdk = fake;
});

afterEach(() => {
  for (const close of closers.reverse()) close();
  closers = [];
  hooks.sdk = undefined;
});

const created = {
  type: "session.created",
  payload: { title: null, tags: [], groupId: null, workspace: { kind: "directory", path: "/work/repo" }, repositoryIdentity: null, account: null, model: null, mode: null },
};

/** What an environment whose machine and adapter can enforce both workspace levels reports, the Claude adapter declaring its flag (#140). */
const ENFORCEABLE: ContainmentReport = {
  levels: [
    { level: "off", available: true, reason: null, cause: null },
    { level: "workspace", available: true, reason: null, cause: null },
    { level: "workspace-no-network", available: true, reason: null, cause: null },
  ],
  mechanism: "bubblewrap",
  container: { declared: false, detected: false },
};

/** The policy resolver giving every run `level`, whatever this machine's probe would find. */
const containedAt =
  (level: ContainmentLevel): PolicySeam =>
  ({ actor, requested, accountModes }) =>
    resolvePolicy({
      actor,
      requested,
      ceiling: actor.ceiling,
      accountModes,
      settings: { unattendedMode: "acceptEdits", containmentDefault: level },
      containment: null,
      enforceable: ENFORCEABLE,
    });

const setup = async (
  policy?: PolicySeam,
  gateRules?: readonly ToolGateRule[],
  account: { readonly sessionStore?: boolean; readonly signedIn?: () => boolean } = {},
  hostOptions: { readonly autoAnswer?: PromptAutoAnswer; readonly providerDenylist?: () => RunDenylist; readonly toolServers?: ToolServerFactory } = {},
) => {
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", projectors: [sessionListProjector, runsProjector, permissionsProjector, accountsProjector], clock: () => clock.now() });
  const adapter = createClaudeAdapter({
    clock,
    executablePath: "/sdk/claude",
    hostEnv: { PATH: "/usr/bin" },
    diagnostic: () => undefined,
    runCommand: async () =>
      (account.signedIn?.() ?? true)
        ? { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "david@example.com" }), stderr: "" }
        : { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }), stderr: "" },
    ...(account.sessionStore === true && { sessionStore: createProviderTranscriptStore({ log, clock }) }),
  });
  // The account store holds the account, read once as startup reads it.
  const accounts = await storeAccounts({ log, clock, adapters: [adapter], accounts: [{ id: "acct", provider: "claude", directory: "/data/accounts/work" }] });
  const host = createAdapterHost({
    log,
    clock,
    adapters: [adapter],
    accounts,
    ceilingOf: () => undefined,
    ...(policy !== undefined && { resolvePolicy: policy }),
    ...(gateRules !== undefined && { gateRules }),
    ...hostOptions,
  });
  closers.push(() => log.close(), () => host.close("disposed"), () => accounts.close());
  const sessionId = randomUUID();
  log.append({ kind: "session", id: sessionId }, [created], { actor: "system:test" });
  return { log, host, clock, accounts, sessionId, controlQueries: fake.queries.length };
};

type Setup = Awaited<ReturnType<typeof setup>>;

/** A client with every mode below its ceiling, as the wire's own tests start runs. */
const clientActor: RunActor = { kind: "client", ceiling: "bypassPermissions", clientSessionId: null };

/** A routine's actor: nobody is present for its runs. */
const routineActor: RunActor = { kind: "routine", name: "nightly-keys", ceiling: "bypassPermissions", clientSessionId: null };

const startRun = (t: Setup, text = "Go", actor: RunActor = clientActor) => {
  const facts = t.host.startFacts(t.sessionId, actor);
  t.host.admit();
  const messageId = randomUUID();
  const decision = decideStart(facts, { origin: actor.kind === "client" ? "client" : "routine", message: { messageId, text, attachments: [] } });
  if (decision.rejected !== undefined) throw new Error(decision.rejected.message);
  t.log.append({ kind: "session", id: t.sessionId }, decision.events, { actor: "client_session:test", correlationId: decision.run.runId });
  t.host.launch(decision.run);
  return { runId: decision.run.runId, messageId };
};

const eventsOf = (t: Setup) => t.log.readStream({ kind: "session", id: t.sessionId }).filter((event) => event.type !== "session.created");

const runQuery = async (t: Setup, index: number): Promise<FakeQuery> => {
  const query = await fake.made(t.controlQueries + index);
  await query.promptsPushed(1);
  return query;
};

describe("prompt suggestions (#251)", () => {
  it("records the pinned SDK's suggestion after the result, stamped with the completed run", async () => {
    const t = await setup();
    const first = startRun(t);
    const query = await runQuery(t, 1);
    expect(query.options.promptSuggestions).toBe(true);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [first.messageId]), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(1));
    query.emit({ type: "prompt_suggestion", suggestion: "Add a regression test", session_id: PROVIDER_SESSION, uuid: randomUUID() } satisfies SDKPromptSuggestionMessage);
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.suggested")).toHaveLength(1));
    expect(eventsOf(t).at(-1)).toMatchObject({ type: "run.suggested", correlationId: first.runId, payload: { runId: first.runId, suggestion: "Add a regression test" } });
    expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(1);
  });
});

describe("a prompt suggestion delivered with the result", () => {
  it("records a suggestion in the same SDK burst as the result, but rejects an old turn's late suggestion after a new run starts", async () => {
    const t = await setup();
    const first = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [first.messageId]), sdk.result(PROVIDER_SESSION), { type: "prompt_suggestion", suggestion: "Run the tests", session_id: PROVIDER_SESSION, uuid: randomUUID() });
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.suggested")).toHaveLength(1));
    // The next turn's prompt has been accepted, but its init has not arrived yet.
    const next = startRun(t, "Different follow-up");
    await query.promptsPushed(2);
    query.emit({ type: "prompt_suggestion", suggestion: "Old offer", session_id: PROVIDER_SESSION, uuid: randomUUID() });
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [next.messageId]), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(2));
    expect(eventsOf(t).filter((event) => event.type === "run.suggested")).toHaveLength(1);
  });
});

describe("a Claude run through the adapter host", () => {
  it("starts, streams onto the session's stream stamped with its run, and ends once", async () => {
    const t = await setup();
    const { runId, messageId } = startRun(t);
    const query = await runQuery(t, 1);
    expect(query.prompts[0]).toMatchObject({ uuid: messageId, message: { content: "Go" } });
    query.emit(
      sdk.init(PROVIDER_SESSION),
      sdk.replyStart("msg_1", [messageId]),
      sdk.blockStart(0),
      sdk.textDelta(0, "Hello"),
      sdk.text("msg_1", "Hello."),
      sdk.result(PROVIDER_SESSION, { modelUsage: { "claude-fable-5": { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01, contextWindow: 1000000 } } }),
    );
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(1));
    const events = eventsOf(t);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.policy.resolved",
      "run.browser.resolved",
      "message.sent",
      "run.instructions.composed",
      "session.provider-linked",
      "assistant.delta",
      "assistant.text",
      "usage.reported",
      "run.ended",
    ]);
    for (const event of events) expect(event.correlationId, event.type).toBe(runId);
    expect(events[4]?.actor).toBe("system:adapter-host");
    expect(events.slice(5).map((event) => event.actor)).toEqual(Array(5).fill("adapter:claude"));
    expect(events.at(-1)?.payload).toMatchObject({ reason: "completed", resultText: "Done.", turnCount: 1, usage: [expect.objectContaining({ model: "claude-fable-5", costUsd: 0.01 })] });
    // Released, the process is kept for the next run until the pool's idle stop.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(query.closed).toBe(false);
  });

  it("serves the session's next run on the kept process, resuming the provider session its first run linked", async () => {
    const t = await setup();
    const first = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [first.messageId]), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(1));
    const again = startRun(t, "Again");
    await query.promptsPushed(2);
    expect(query.prompts[1]).toMatchObject({ uuid: again.messageId });
    expect(fake.queries).toHaveLength(t.controlQueries + 1);
  });

  it("logs a cross-check of the run's identity that throws, and the run ends and the next one runs as ever", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const t = await setup();
      // As when the log has closed under a run that reports late: the check appends, and its throw reaches the host.
      const crossCheck = vi.spyOn(t.accounts, "crossCheck").mockImplementation(() => {
        throw new Error("The event log is closed.");
      });
      const first = startRun(t);
      const query = await runQuery(t, 1);
      query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [first.messageId]), sdk.text("msg_1", "Hi."), sdk.result(PROVIDER_SESSION));
      await vi.waitFor(() => expect(crossCheck).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended").map((event) => event.payload["reason"])).toEqual(["completed"]));
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`Cross-checking the identity run ${first.runId} reported failed`)), expect.objectContaining({ message: "The event log is closed." }));
      const again = startRun(t, "Again");
      await query.promptsPushed(2);
      query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [again.messageId]), sdk.text("msg_2", "Again."), sdk.result(PROVIDER_SESSION));
      await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended").map((event) => event.payload["reason"])).toEqual(["completed", "completed"]));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(unhandled).toEqual([]);
    } finally {
      logged.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("starts the next run cold on a fresh process, resuming, once the pool has stopped the kept one", async () => {
    const t = await setup();
    const first = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [first.messageId]), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(1));
    t.clock.advance(30 * 60 * 1000);
    await vi.waitFor(() => expect(query.closed).toBe(true));
    startRun(t, "Again");
    const next = await runQuery(t, 2);
    expect(next.options.resume).toBe(PROVIDER_SESSION);
  });

  it("ends a cold resume whose account's login cannot be refreshed error, naming the account by its label, and the store reads the account expired, after one refresh (#229)", async () => {
    let refreshes = 0;
    let signedIn = true;
    fake.controls = {
      usage: {
        name: "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET",
        // As 2.1.281 answers when the provider refuses the refresh: no plan limits, and the login cleared.
        answer: async () => {
          refreshes += 1;
          signedIn = false;
          return { rate_limits_available: true, rate_limits: null };
        },
      },
    };
    const t = await setup(undefined, undefined, { sessionStore: true, signedIn: () => signedIn });
    const label = t.accounts.list()[0]?.label as string;
    const first = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [first.messageId]), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(1));
    // A fresh run needs no refresh: its CLI runs in the account's own directory.
    expect(refreshes).toBe(0);
    t.clock.advance(30 * 60 * 1000);
    await vi.waitFor(() => expect(query.closed).toBe(true));
    expect(t.accounts.list()[0]?.status.state).toBe("signed-in");
    const made = fake.queries.length;
    const again = startRun(t, "Again");
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(2));
    const ended = eventsOf(t).filter((event) => event.type === "run.ended").at(-1);
    expect(ended?.correlationId).toBe(again.runId);
    expect(ended?.payload).toMatchObject({ reason: "error", error: { code: "login_expired", message: expect.stringContaining(`The Claude account ${label} has an expired login`) } });
    // No run was started: only the refresh's unsampled query was made, none resuming the session.
    expect(fake.queries.slice(made).filter((made) => made.options.resume !== undefined)).toEqual([]);
    await vi.waitFor(() => expect(t.accounts.list()[0]?.status.state).toBe("expired"));
    // The status read the failure asked for asks the binary only: one refresh in all.
    expect(refreshes).toBe(1);
  });

  it("adopts the turn the provider opens with a message it held, as the session's next run", async () => {
    const t = await setup();
    const first = startRun(t, "First");
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [first.messageId]));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
    const send = decideSend(t.host.startFacts(t.sessionId, clientActor), { messageId: randomUUID(), text: "Also this", attachments: [] });
    if (send.rejected !== undefined || send.queued === undefined) throw new Error("The message was not queued.");
    t.log.append({ kind: "session", id: t.sessionId }, send.events, { actor: "client_session:test", correlationId: send.result.runId });
    t.host.queue(send.queued);
    const queued = send.result.messageId;
    await query.promptsPushed(2);
    // The turn ends without folding it in; the CLI opens its queued turn with it.
    query.emit(sdk.text("msg_1", "First turn done."), sdk.result(PROVIDER_SESSION));
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [queued]), sdk.text("msg_2", "Read the queued message."), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(2));
    const events = eventsOf(t);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.policy.resolved",
      "run.browser.resolved",
      "message.sent",
      "run.instructions.composed",
      "session.provider-linked",
      "message.sent",
      "assistant.text",
      "run.ended",
      "run.started",
      "run.policy.resolved",
      "run.browser.resolved",
      "message.delivered",
      "session.provider-linked",
      "assistant.text",
      "run.ended",
    ]);
    const adopted = events[9];
    expect(adopted?.payload).toMatchObject({ origin: "provider", promptMessageId: null, queuedMessageIds: [queued] });
    expect(events[12]?.payload).toEqual({ runId: adopted?.payload["runId"], messageId: queued, delivery: "prompt" });
    expect(events.filter((event) => event.type === "run.ended").map((event) => event.payload["reason"])).toEqual(["completed", "completed"]);
    expect(fake.queries).toHaveLength(t.controlQueries + 1);
  });

  it("changes a live run's mode through the SDK's mode setter when the host is asked (permissions.mode.set)", async () => {
    const t = await setup();
    const { runId, messageId } = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
    t.host.setMode(runId, "plan");
    await vi.waitFor(() => expect(query.modes).toEqual(["plan"]));
  });

  it("records canUseTool's request as prompt.opened on the harness's fields, the permission table's id its prompt id, and parks the tool until a person's answer is delivered", async () => {
    const t = await setup();
    const { runId, messageId } = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
    const suggestion: PermissionUpdate = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }], behavior: "allow", destination: "localSettings" };
    let settled = false;
    const asked = query
      .canUseTool("Bash", { command: "rm -rf build" }, {
        toolUseID: "toolu_rm",
        title: "Claude wants to run rm -rf build",
        decisionReason: "rm needs approval",
        blockedPath: "/work/repo/build",
        suggestions: [suggestion],
      })
      .then((result) => ((settled = true), result));
    await vi.waitFor(() => expect(openedOf(t)).toHaveLength(1));
    expect(openedOf(t)[0]).toEqual({
      runId,
      promptId: "toolu_rm",
      kind: "permission",
      toolName: "Bash",
      toolCallId: "toolu_rm",
      input: { command: "rm -rf build" },
      summary: "Claude wants to run rm -rf build",
      blockedPath: "/work/repo/build",
      reason: "rm needs approval",
      questions: null,
      plan: null,
      suggestions: [suggestion],
      agentId: null,
      denylist: null,
      mode: "acceptEdits",
      ceiling: "bypassPermissions",
      ttlExpiresAt: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    // Remembered for the session: the CLI's own suggestions, for the session only, never a settings file.
    t.host.deliverAnswer(runId, "toolu_rm", { decision: "allow", updatedInput: { command: "rm -rf build/cache" }, remember: "session" });
    expect(await asked).toEqual({
      behavior: "allow",
      updatedInput: { command: "rm -rf build/cache" },
      updatedPermissions: [{ ...suggestion, destination: "session" }],
      toolUseID: "toolu_rm",
    });
    expect([...t.host.runs.runs()].find((run) => run.id === runId)?.state).toBe("running");
  });

  it("asks the tool gate before the broker: a write outside the workspace is denied with the gate's reason and recorded, and no prompt is opened", async () => {
    const t = await setup(containedAt("workspace"));
    const { runId, messageId } = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
    const denied = await query.canUseTool("Write", { file_path: "/etc/hosts", content: "x" }, { toolUseID: "toolu_write" });
    expect(denied).toMatchObject({ behavior: "deny", toolUseID: "toolu_write" });
    const message = (denied as { message: string }).message;
    expect(message).toMatch(/^Denied by containment \(workspace\)/);
    expect(message).toContain("/etc/hosts");
    expect(openedOf(t)).toEqual([]);
    const decisions = eventsOf(t).filter((event) => event.type === "tool.decision");
    expect(decisions.map((event) => event.payload)).toEqual([
      { runId, toolCallId: "toolu_write", tool: "Write", summary: "Write /etc/hosts", decision: "denied", decidedBy: "containment", promptId: null, reason: message },
    ]);
    // A write inside the workspace, and a shell command (the sandbox's), go on to the broker, which opens a prompt for each.
    void query.canUseTool("Edit", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_edit" });
    void query.canUseTool("Bash", { command: "curl https://example.com/" }, { toolUseID: "toolu_bash" });
    await vi.waitFor(() => expect(openedOf(t)).toHaveLength(2));
    expect(openedOf(t).map((opened) => opened.toolCallId)).toEqual(["toolu_edit", "toolu_bash"]);
    expect(eventsOf(t).filter((event) => event.type === "tool.decision")).toHaveLength(1);
  });

  it("asks the tool gate for WebFetch and WebSearch at workspace-no-network, which denies both", async () => {
    const closed = await setup(containedAt("workspace-no-network"));
    const first = startRun(closed);
    const query = await runQuery(closed, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [first.messageId]));
    await vi.waitFor(() => expect(eventsOf(closed).map((event) => event.type)).toContain("session.provider-linked"));
    for (const [tool, input] of [
      ["WebFetch", { url: "https://example.com/", prompt: "?" }],
      ["WebSearch", { query: "bubblewrap" }],
    ] as const) {
      const answer = await query.canUseTool(tool, input, { toolUseID: `toolu_${tool}` });
      expect(answer, tool).toMatchObject({ behavior: "deny", message: expect.stringMatching(/no network/) as unknown as string });
    }
    expect(openedOf(closed)).toEqual([]);
    expect(eventsOf(closed).filter((event) => event.type === "tool.decision").map((event) => event.payload["tool"])).toEqual(["WebFetch", "WebSearch"]);
  });

  it("asks a question with its question set and a plan with its text, and hands back a question's answers and a plan's mode", async () => {
    const t = await setup();
    const { runId, messageId } = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
    const questions = [{ header: "Library", question: "Which date library?", options: [{ label: "date-fns", description: "Small" }, { label: "luxon" }], multiSelect: false }];
    const question = query.canUseTool("AskUserQuestion", { questions }, { toolUseID: "toolu_q" });
    await vi.waitFor(() => expect(openedOf(t)).toHaveLength(1));
    expect(openedOf(t)[0]).toMatchObject({
      kind: "question",
      summary: "Which date library?",
      questions: [{ header: "Library", question: "Which date library?", options: [{ label: "date-fns", description: "Small" }, { label: "luxon", description: "" }], multiSelect: false }],
    });
    t.host.deliverAnswer(runId, "toolu_q", { decision: "allow", answers: { "Which date library?": "luxon" } });
    expect(await question).toEqual({ behavior: "allow", updatedInput: { questions, answers: { "Which date library?": "luxon" } }, toolUseID: "toolu_q" });

    const plan = query.canUseTool("ExitPlanMode", { plan: "1. Read\n2. Write" }, { toolUseID: "toolu_plan" });
    await vi.waitFor(() => expect(openedOf(t)).toHaveLength(2));
    expect(openedOf(t)[1]).toMatchObject({ kind: "plan", plan: "1. Read\n2. Write", summary: "1. Read" });
    t.host.deliverAnswer(runId, "toolu_plan", { decision: "allow", mode: "acceptEdits" });
    expect(await plan).toEqual({
      behavior: "allow",
      updatedInput: { plan: "1. Read\n2. Write" },
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      toolUseID: "toolu_plan",
    });
  });

  it("closes the run's open prompts run_ended when its turn ends on its own, and denies the tool call", async () => {
    const t = await setup();
    const { runId, messageId } = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
    const asked = query.canUseTool("Edit", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_edit" });
    await vi.waitFor(() => expect(openedOf(t)).toHaveLength(1));
    query.emit(sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("run.ended"));
    expect(await asked).toMatchObject({ behavior: "deny" });
    // The call's decision rides with its answer (#131).
    expect(eventsOf(t).map((event) => event.type).slice(-3)).toEqual(["prompt.answered", "tool.decision", "run.ended"]);
    expect(eventsOf(t).find((event) => event.type === "prompt.answered")?.payload as PromptAnsweredPayload).toMatchObject({
      runId,
      promptId: "toolu_edit",
      decision: "deny",
      decidedBy: { auto: "run_ended" },
    });
  });

  it("parks the run under the permission table's id, and an answer through the host's deliverAnswer settles the tool call and unparks it", async () => {
    const t = await setup();
    const { runId, messageId } = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
    const asked = query.canUseTool("Edit", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_edit" });
    const state = () => [...t.host.runs.runs()].find((run) => run.id === runId)?.state;
    await vi.waitFor(() => expect(state()).toBe("parked"));
    t.host.deliverAnswer(runId, "toolu_edit", { decision: "allow" });
    expect(await asked).toEqual({ behavior: "allow", updatedInput: { file_path: "/work/repo/a.ts" }, toolUseID: "toolu_edit" });
    expect(state()).toBe("running");
  });

  it("refuses an answer conflict when the prompt is not open, so the caller can say so, and hands a run that has ended nothing", async () => {
    const t = await setup();
    const { runId, messageId } = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
    expect(() => t.host.deliverAnswer(runId, "toolu_unknown", { decision: "allow" })).toThrow(expect.objectContaining({ code: "conflict", data: expect.objectContaining({ reason: "prompt_not_open" }) }));
    query.emit(sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("run.ended"));
    expect(t.host.deliverAnswer(runId, "toolu_edit", { decision: "allow" })).toBeUndefined();
  });

  it("unparks the run when the provider aborts the request it parked on", async () => {
    const t = await setup();
    const { runId, messageId } = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
    const abort = new AbortController();
    const asked = query.canUseTool("Bash", { command: "sleep 1" }, { toolUseID: "toolu_sleep", signal: abort.signal });
    const state = () => [...t.host.runs.runs()].find((run) => run.id === runId)?.state;
    await vi.waitFor(() => expect(state()).toBe("parked"));
    abort.abort();
    expect(await asked).toMatchObject({ behavior: "deny", message: "The provider aborted this tool call." });
    expect(state()).toBe("running");
  });

  describe("with the denylist's rule on the gate (#132)", () => {
    const denylisted = () => [denylistRule({ denylist: () => denylistPresets("/data/agent-harness"), home: "/home/test", exempt: [], resolve: (path) => path })];
    const decisionsOf = (t: Setup) => eventsOf(t).filter((event) => event.type === "tool.decision").map((event) => event.payload as Record<string, unknown>);

    it("puts a denylisted call to the person from inside canUseTool first; allowed, the provider's own prompt follows, and the call keeps the first decision", async () => {
      const t = await setup(undefined, denylisted());
      const { runId, messageId } = startRun(t);
      const query = await runQuery(t, 1);
      query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]));
      await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
      const asked = query.canUseTool("Read", { file_path: "~/.ssh/id_rsa" }, { toolUseID: "toolu_key" });
      await vi.waitFor(() => expect(openedOf(t)).toHaveLength(1));
      const [denylistPrompt] = openedOf(t);
      expect(denylistPrompt).toMatchObject({ kind: "denylist", toolCallId: "toolu_key", input: { file_path: "~/.ssh/id_rsa" } });
      expect(denylistPrompt?.denylist?.[0]?.entry.pattern).toBe("~/.ssh");
      t.log.atomically((tx) =>
        t.log.append(
          { kind: "session", id: t.sessionId },
          answerEvents({ all: (sql, ...params) => t.log.read(sql, ...params) }, denylistPrompt!, { ...personAllows, runId, promptId: denylistPrompt!.promptId }),
          { tx, actor: "client_session:cs-1", correlationId: runId },
        ),
      );
      t.host.deliverAnswer(runId, denylistPrompt!.promptId, { decision: "allow" });
      // Allowed past the denylist, the provider's own prompt opens under the tool use's id.
      await vi.waitFor(() => expect(openedOf(t)).toHaveLength(2));
      expect(openedOf(t)[1]).toMatchObject({ kind: "permission", promptId: "toolu_key" });
      t.log.atomically((tx) =>
        t.log.append(
          { kind: "session", id: t.sessionId },
          answerEvents({ all: (sql, ...params) => t.log.read(sql, ...params) }, openedOf(t)[1]!, { ...personAllows, runId, promptId: "toolu_key", decision: "deny" }),
          { tx, actor: "client_session:cs-1", correlationId: runId },
        ),
      );
      t.host.deliverAnswer(runId, "toolu_key", { decision: "deny", message: "Not now." });
      expect(await asked).toMatchObject({ behavior: "deny", message: "Not now." });
      expect(decisionsOf(t)).toEqual([expect.objectContaining({ toolCallId: "toolu_key", decision: "allowed", decidedBy: "person", promptId: denylistPrompt?.promptId })]);
    });

    it("closes the denylist prompt when the CLI withdraws the request (the SDK's abort signal), and denies the call", async () => {
      const t = await setup(undefined, denylisted());
      const { runId, messageId } = startRun(t);
      const query = await runQuery(t, 1);
      query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]));
      await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
      const abort = new AbortController();
      const asked = query.canUseTool("Read", { file_path: "~/.ssh/id_rsa" }, { toolUseID: "toolu_key", signal: abort.signal });
      await vi.waitFor(() => expect(openedOf(t)).toHaveLength(1));
      abort.abort();
      expect(await asked).toMatchObject({ behavior: "deny" });
      const answered = eventsOf(t).filter((event) => event.type === "prompt.answered").map((event) => event.payload as PromptAnsweredPayload);
      expect(answered).toEqual([expect.objectContaining({ promptId: openedOf(t)[0]?.promptId, decidedBy: { auto: "cancelled" } })]);
      expect(openedOf(t)).toHaveLength(1);
      expect([...t.host.runs.runs()].find((run) => run.id === runId)?.state).toBe("running");
    });
  });

  describe("with the gate asked from the PreToolUse hook (#140)", () => {
    const denylisted = () => [denylistRule({ denylist: () => denylistPresets("/data/agent-harness"), home: "/home/test", exempt: [], resolve: (path) => path })];
    const decisionsOf = (t: Setup) => eventsOf(t).filter((event) => event.type === "tool.decision").map((event) => event.payload as Record<string, unknown>);
    const answeredOf = (t: Setup) => eventsOf(t).filter((event) => event.type === "prompt.answered").map((event) => event.payload as PromptAnsweredPayload);
    /** The client's mode and the ceiling it runs under, as `runs.start` asked for bypassPermissions. */
    const inBypass: PolicySeam = ({ actor, accountModes }) =>
      resolvePolicy({ actor, requested: "bypassPermissions", ceiling: actor.ceiling, accountModes, settings: { unattendedMode: "bypassPermissions", containmentDefault: "off" }, containment: null, enforceable: ENFORCEABLE });

    const opened = async (t: Setup, actor: RunActor = clientActor) => {
      const { runId, messageId } = startRun(t, "Go", actor);
      const query = await runQuery(t, 1);
      query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]));
      await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
      return { runId, query };
    };

    it("puts an attended denylist match to the person in bypassPermissions, and their allow lets the call on to the provider, which asks nothing more", async () => {
      const t = await setup(inBypass, denylisted());
      const { runId, query } = await opened(t);
      expect(query.options).toMatchObject({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, permissionPrompts: "host" });
      const hooked = query.preToolUse("Read", { file_path: "~/.ssh/id_rsa" }, { toolUseID: "toolu_key" });
      await vi.waitFor(() => expect(openedOf(t)).toHaveLength(1));
      const [prompt] = openedOf(t);
      expect(prompt).toMatchObject({ kind: "denylist", toolCallId: "toolu_key", mode: "bypassPermissions", reason: expect.stringContaining("~/.ssh") as unknown as string });
      expect([...t.host.runs.runs()].find((run) => run.id === runId)?.state).toBe("parked");
      t.log.atomically((tx) =>
        t.log.append(
          { kind: "session", id: t.sessionId },
          answerEvents({ all: (sql, ...params) => t.log.read(sql, ...params) }, prompt!, { ...personAllows, runId, promptId: prompt!.promptId }),
          { tx, actor: "client_session:cs-1", correlationId: runId },
        ),
      );
      t.host.deliverAnswer(runId, prompt!.promptId, { decision: "allow" });
      // The hook passes the call on: bypass lets it run, and nothing asks again.
      expect(await hooked).toEqual({});
      query.emit(sdk.toolUse("toolu_key", "Read", { file_path: "~/.ssh/id_rsa" }), sdk.toolResult("toolu_key", "ssh-rsa AAAA"), sdk.result(PROVIDER_SESSION));
      await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("run.ended"));
      expect(openedOf(t)).toHaveLength(1);
      expect(decisionsOf(t)).toEqual([expect.objectContaining({ toolCallId: "toolu_key", decision: "allowed", decidedBy: "person", promptId: prompt?.promptId })]);
    });

    it("denies an unattended match from the hook once the broker has recorded the opened and answered pair, and the run goes on", async () => {
      const t = await setup(undefined, denylisted(), {}, { autoAnswer });
      const { runId, query } = await opened(t, routineActor);
      const answer = await query.preToolUse("Bash", { command: "sudo apt install jq" }, { toolUseID: "toolu_sudo" });
      const [prompt] = openedOf(t);
      expect(prompt).toMatchObject({ runId, kind: "denylist", toolCallId: "toolu_sudo", ttlExpiresAt: null });
      expect(answeredOf(t)).toEqual([expect.objectContaining({ promptId: prompt?.promptId, decision: "deny", decidedBy: { auto: "unattended" } })]);
      expect(answer).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Denied: nobody is present to approve this. Continue without it and say what you could not do." },
      });
      expect(decisionsOf(t)).toEqual([expect.objectContaining({ toolCallId: "toolu_sudo", decision: "denied", decidedBy: "denylist", promptId: prompt?.promptId })]);
      expect([...t.host.runs.runs()].find((run) => run.id === runId)?.state).toBe("running");
    });

    it.each(["configured", "in-process"])("a %s environment server named client is denied at the hook (#281)", async (kind) => {
      const t = await setup(undefined, denylisted(), {}, {
        autoAnswer,
        toolServers: () => kind === "configured"
          ? [{ name: "client", config: {} }]
          : [{ name: "client", external: false, tools: [{ name: "read_file", description: "Read", inputSchema: {}, call: async () => ({ text: "", isError: false }) }] }],
      });
      const { query } = await opened(t, routineActor);
      const denied = await query.preToolUse("mcp__client__read_file", { path: "~/.ssh/id_rsa" }, { toolUseID: "toolu_local_client" });
      expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      expect(openedOf(t)).toEqual([expect.objectContaining({ kind: "denylist", toolName: "mcp__client__read_file", toolCallId: "toolu_local_client" })]);
    });

    it("lets a client tool's denylisted arguments past the hook while still denying the environment tool (#281)", async () => {
      const t = await setup(undefined, denylisted(), {}, {
        autoAnswer,
        toolServers: () => [{ name: "client", external: true, tools: [{ name: "read_file", description: "Read", inputSchema: {}, call: async () => ({ text: "", isError: false }) }] }],
      });
      const { query } = await opened(t, routineActor);
      const input = { path: "~/.ssh/id_rsa" };
      const allowed = await query.preToolUse("mcp__client__read_file", input, { toolUseID: "toolu_client" });
      expect(allowed).toEqual({});
      expect(openedOf(t)).toEqual([]);
      const denied = await query.preToolUse("mcp__memory__read_file", input, { toolUseID: "toolu_memory" });
      expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      expect(openedOf(t)).toEqual([expect.objectContaining({ kind: "denylist", toolName: "mcp__memory__read_file", toolCallId: "toolu_memory" })]);
    });

    it("denies a write outside the workspace from the hook at workspace, recorded by containment, asking nobody, in bypassPermissions too", async () => {
      const t = await setup(containedAt("workspace"));
      const { query } = await opened(t);
      expect(await query.preToolUse("Write", { file_path: "/etc/hosts", content: "x" }, { toolUseID: "toolu_hosts" })).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/Denied by containment \(workspace\)/) as unknown as string },
      });
      expect(openedOf(t)).toEqual([]);
      expect(decisionsOf(t)).toEqual([expect.objectContaining({ toolCallId: "toolu_hosts", decision: "denied", decidedBy: "containment" })]);
      expect(query.options.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true });
    });

    it("answers the sandbox's ask for a host at once when the gate lets it through, and puts a denylisted host to the person as a denylist prompt", async () => {
      const metadata = { id: "metadata", pattern: "169.254.169.254", note: "", preset: false, enabled: true };
      const hosts = () => [denylistRule({ denylist: () => ({ ...denylistPresets("/data/agent-harness"), hosts: [metadata] }), home: "/home/test", exempt: [], resolve: (path) => path })];
      const t = await setup(containedAt("workspace"), hosts());
      const { runId, query } = await opened(t);
      expect(await query.canUseTool("SandboxNetworkAccess", { host: "registry.npmjs.org" }, { toolUseID: "net_npm" })).toEqual({
        behavior: "allow",
        updatedInput: { host: "registry.npmjs.org" },
        toolUseID: "net_npm",
      });
      expect(openedOf(t)).toEqual([]);
      const asked = query.canUseTool("SandboxNetworkAccess", { host: "169.254.169.254" }, { toolUseID: "net_metadata" });
      await vi.waitFor(() => expect(openedOf(t)).toHaveLength(1));
      const [prompt] = openedOf(t);
      expect(prompt).toMatchObject({ runId, kind: "denylist", toolName: "SandboxNetworkAccess", toolCallId: "net_metadata" });
      expect(prompt?.denylist?.[0]?.entry.pattern).toBe("169.254.169.254");
      t.log.atomically((tx) =>
        t.log.append(
          { kind: "session", id: t.sessionId },
          answerEvents({ all: (sql, ...params) => t.log.read(sql, ...params) }, prompt!, { ...personAllows, runId, promptId: prompt!.promptId, decision: "deny", message: "Not the metadata service." }),
          { tx, actor: "client_session:cs-1", correlationId: runId },
        ),
      );
      t.host.deliverAnswer(runId, prompt!.promptId, { decision: "deny", message: "Not the metadata service." });
      expect(await asked).toEqual({ behavior: "deny", message: "Not the metadata service.", toolUseID: "net_metadata" });
      // Neither ask opened a turn of the provider's own.
      expect(eventsOf(t).filter((event) => event.type === "run.started")).toHaveLength(1);
    });

    it("hands an unattended run the denylist to project, and an attended one none", async () => {
      const projection: RunDenylist = { paths: ["/home/test/.ssh"], exempt: ["/data/agent-harness/containment"], commandPatterns: ["sudo *"] };
      const unattended = await setup(containedAt("workspace"), undefined, {}, { providerDenylist: () => projection });
      await opened(unattended, routineActor);
      const [routineRun] = fake.queries.slice(unattended.controlQueries);
      expect(routineRun?.options).toMatchObject({ disallowedTools: ["Bash(sudo *)"], sandbox: { filesystem: { denyRead: ["/home/test/.ssh"], allowRead: ["/data/agent-harness/containment"] } } });
      const attended = await setup(containedAt("workspace"), undefined, {}, { providerDenylist: () => projection });
      await opened(attended);
      const clientRun = fake.queries.at(-1);
      expect(clientRun?.options).not.toHaveProperty("disallowedTools");
      expect(clientRun?.options.sandbox?.filesystem).not.toHaveProperty("denyRead");
    });
  });

  it("stops a process kept for a background task when its session is deleted, so no later turn lands on the deleted stream", async () => {
    const t = await setup();
    const { messageId } = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]), sdk.tasks({ task_id: "task_1" }), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(1));
    expect(query.closed).toBe(false);
    t.log.append({ kind: "session", id: t.sessionId }, [{ type: "session.deleted", payload: { deletedAt: "2026-09-24T00:00:00.000Z", purgeAt: "2026-10-24T00:00:00.000Z", deleteProviderTranscript: false } }], { actor: "client_session:test" });
    expect(query.closed).toBe(true);
    // A turn the CLI would have opened about the task finds no process to open it on.
    query.emit(sdk.taskNotification("task_1"), sdk.tasks(), sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", []), sdk.text("msg_2", "Done."), sdk.result(PROVIDER_SESSION));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(eventsOf(t).filter((event) => event.type === "run.started")).toHaveLength(1);
  });

  it("ends the run once, disposed, and stops the process when the environment closes mid-run", async () => {
    const t = await setup();
    startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION));
    t.host.close("disposed");
    expect(eventsOf(t).filter((event) => event.type === "run.ended").map((event) => event.payload["reason"])).toEqual(["disposed"]);
    await vi.waitFor(() => expect(query.closed).toBe(true));
    query.emit(sdk.result(PROVIDER_SESSION));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(1);
  });
});
