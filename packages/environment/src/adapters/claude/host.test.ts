import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manualClock } from "../../../test/clock.js";
import { FakeSdk, sdk, type FakeQuery } from "../../../test/fake-claude-sdk.js";
import type { PermissionBroker, PromptDecision } from "../../adapter/contract.js";

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
const { decideStart } = await import("../../runs/run-decider.js");
const { runsProjector } = await import("../../runs/runs-projector.js");
const { sessionListProjector } = await import("../../sessions/session-list.js");
const { autoDenyBroker } = await import("../../adapter/seams.js");

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

const setup = async (broker?: PermissionBroker) => {
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", projectors: [sessionListProjector, runsProjector], clock: () => clock.now() });
  const adapter = createClaudeAdapter({
    clock,
    executablePath: "/sdk/claude",
    hostEnv: { PATH: "/usr/bin" },
    diagnostic: () => undefined,
    runCommand: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "david@example.com" }), stderr: "" }),
  });
  const host = createAdapterHost({
    log,
    clock,
    adapters: [adapter],
    accounts: [{ id: "acct", provider: "claude", directory: "/data/accounts/work" }],
    ...(broker !== undefined && { broker }),
  });
  closers.push(() => log.close(), () => host.close("disposed"));
  await host.refresh();
  const sessionId = randomUUID();
  log.append({ kind: "session", id: sessionId }, [created], { actor: "system:test" });
  return { log, host, sessionId, controlQueries: fake.queries.length };
};

type Setup = Awaited<ReturnType<typeof setup>>;

const startRun = (t: Setup, text = "Go") => {
  const facts = t.host.startFacts(t.sessionId, "bypassPermissions");
  t.host.admit();
  const messageId = randomUUID();
  const decision = decideStart(facts, { origin: "client", message: { messageId, text, attachments: [] } });
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
      "message.sent",
      "session.provider-linked",
      "assistant.delta",
      "assistant.text",
      "usage.reported",
      "run.ended",
    ]);
    for (const event of events) expect(event.correlationId, event.type).toBe(runId);
    expect(events.slice(2).map((event) => event.actor)).toEqual(Array(5).fill("adapter:claude"));
    expect(events.at(-1)?.payload).toMatchObject({ reason: "completed", resultText: "Done.", turnCount: 1, usage: [expect.objectContaining({ model: "claude-fable-5", costUsd: 0.01 })] });
    // Released with nothing holding it, the process is let go.
    await vi.waitFor(() => expect(query.closed).toBe(true));
  });

  it("resumes the provider session its first run linked, on the session's next run", async () => {
    const t = await setup();
    const first = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [first.messageId]), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(1));
    startRun(t, "Again");
    const next = await runQuery(t, 2);
    expect(next.options.resume).toBe(PROVIDER_SESSION);
  });

  it("adopts the turn the provider opens with a message it held, as the session's next run", async () => {
    const t = await setup();
    const first = startRun(t, "First");
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [first.messageId]));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
    const queued = randomUUID();
    t.log.append(
      { kind: "session", id: t.sessionId },
      [{ type: "message.sent", payload: { runId: first.runId, messageId: queued, text: "Also this", attachments: [], delivery: "queued", heldBy: "provider" } }],
      { actor: "client_session:test" },
    );
    t.host.queue({ runId: first.runId, heldBy: "provider", message: { messageId: queued, text: "Also this", attachments: [] } });
    await query.promptsPushed(2);
    // The turn ends without folding it in; the CLI opens its queued turn with it.
    query.emit(sdk.text("msg_1", "First turn done."), sdk.result(PROVIDER_SESSION));
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_2", [queued]), sdk.text("msg_2", "Read the queued message."), sdk.result(PROVIDER_SESSION));
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(2));
    const events = eventsOf(t);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.sent",
      "session.provider-linked",
      "message.sent",
      "assistant.text",
      "run.ended",
      "run.started",
      "message.delivered",
      "session.provider-linked",
      "assistant.text",
      "run.ended",
    ]);
    const adopted = events[6];
    expect(adopted?.payload).toMatchObject({ origin: "provider", promptMessageId: null, queuedMessageIds: [queued] });
    expect(events[7]?.payload).toEqual({ runId: adopted?.payload["runId"], messageId: queued, delivery: "prompt" });
    expect(events.filter((event) => event.type === "run.ended").map((event) => event.payload["reason"])).toEqual(["completed", "completed"]);
    expect(fake.queries).toHaveLength(t.controlQueries + 1);
  });

  it("hands canUseTool to the auto-deny placeholder, which denies at once and records nothing", async () => {
    const t = await setup(autoDenyBroker);
    const { messageId } = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
    expect(await query.canUseTool("Bash", { command: "ls" }, { toolUseID: "toolu_ls" })).toEqual({
      behavior: "deny",
      message: "This environment cannot ask anyone yet, so the request was denied; carry on without it.",
      toolUseID: "toolu_ls",
    });
    expect(eventsOf(t).map((event) => event.type)).toEqual(["run.started", "message.sent", "session.provider-linked"]);
  });

  it("parks canUseTool on the broker seam until the broker answers", async () => {
    let answer!: (decision: PromptDecision) => void;
    const requests: unknown[] = [];
    const broker: PermissionBroker = {
      request: (request) => {
        requests.push(request);
        return new Promise((resolve) => (answer = resolve));
      },
    };
    const t = await setup(broker);
    const { runId, messageId } = startRun(t);
    const query = await runQuery(t, 1);
    query.emit(sdk.init(PROVIDER_SESSION), sdk.replyStart("msg_1", [messageId]));
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("session.provider-linked"));
    let settled = false;
    const asked = query.canUseTool("Edit", { file_path: "/work/repo/a.ts" }, { toolUseID: "toolu_edit" }).then((result) => ((settled = true), result));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ sessionId: t.sessionId, runId, kind: "permission" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    answer({ decision: "allow" });
    expect(await asked).toEqual({ behavior: "allow", updatedInput: { file_path: "/work/repo/a.ts" }, toolUseID: "toolu_edit" });
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
