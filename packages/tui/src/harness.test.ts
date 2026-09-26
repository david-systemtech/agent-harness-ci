import { WIRE_PATH, type Frame, type ResponseFrame } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp, type RenderedApp } from "../test/harness.js";

/**
 * The scripted fake environment every terminal UI ticket uses
 * (docs/specs/tui.md, "Testing Decisions"): sessions and groups on one or two
 * environments, receipts with chosen outcomes, `bye` reasons, and discovery
 * answering `starting` or nothing. Asserted through the runtime's public
 * surface, since the rail that renders sessions is a later ticket's.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});
const launch = async (...args: Parameters<typeof renderApp>) => {
  const app = await renderApp(...args);
  apps.push(app);
  return app;
};

const phaseOf = (app: RenderedApp, name: string) => app.runtime().projections.environments.read().find((v) => v.name === name)?.phase;

describe("the scripted environment", () => {
  it("scripts sessions and groups on two environments", async () => {
    const app = await launch({
      script: {
        environments: [
          { name: "desk", reach: "local", sessions: [{ title: "Fix the rail" }, { title: "Pairing" }], groups: [{ name: "Brandsolidate" }] },
          { name: "laptop", reach: "paired", sessions: [{ title: "Train tidy-up" }], groups: [{ name: "brandsolidate" }] },
        ],
      },
    });
    const runtime = app.runtime();
    const [desk, laptop] = app.world.environments.map((e) => e.environmentId) as [string, string];
    const deskSessions = await runtime.requests.call(desk, "sessions.list", {});
    const laptopGroups = await runtime.requests.call(laptop, "groups.list", {});
    expect(deskSessions).toMatchObject({ ok: true, result: { sessions: [{ title: "Fix the rail" }, { title: "Pairing" }] } });
    expect(laptopGroups).toMatchObject({ ok: true, result: { groups: [{ name: "brandsolidate" }] } });
  });

  it("answers commands with the receipts the script chose", async () => {
    const app = await launch({
      script: {
        environments: [
          {
            name: "desk",
            reach: "local",
            sessions: [{ title: "Gone" }],
            receipts: {
              "sessions.archive": { rejected: "not_found", message: "No such session." },
              "sessions.pin": "accepted",
              "access.sessions.setCeiling": { rejected: "forbidden", message: "Not that one." },
            },
          },
        ],
      },
    });
    // A command is the outbox's (#128) to send; the script is checked here as a client sees it, on a socket of the test's own.
    const answers: ResponseFrame[] = [];
    const socket = app.world.webSocket(`${app.environment("desk").wire.origin.replace(/^http/, "ws")}${WIRE_PATH}`, {
      onOpen: () => undefined,
      onMessage: (text) => answers.push(JSON.parse(text) as ResponseFrame),
      onClose: () => undefined,
    });
    const send = async (id: string, method: string, params: Record<string, unknown>) => {
      socket.send(JSON.stringify({ type: "request", id, method, params }));
      await app.waitUntil(() => answers.some((a) => a.id === id), `an answer to ${method}`);
      return answers.find((a) => a.id === id) as ResponseFrame;
    };
    const sessionId = "0199aa00-0000-4000-8000-000000000001";
    const archive = await send("r1", "sessions.archive", { commandId: "0199aa00-0000-7000-8000-0000000000a1", sessionId });
    const pin = await send("r2", "sessions.pin", { commandId: "0199aa00-0000-7000-8000-0000000000a2", sessionId });
    const ceiling = await send("r3", "access.sessions.setCeiling", {
      commandId: "0199aa00-0000-7000-8000-0000000000a3",
      clientSessionId: "0199cc00-0000-7000-8000-000000000001",
      ceiling: "plan",
    });
    socket.close();
    expect(archive.result).toMatchObject({ receipt: { status: "rejected", reason: "not_found", error: { message: "No such session." } } });
    expect(pin.result).toMatchObject({ receipt: { status: "accepted" } });
    expect(ceiling.result).toMatchObject({ receipt: { status: "rejected", reason: "forbidden", error: { message: "Not that one." } } });
  });

  it("refuses a terminal command the script rejects before acting on it: nothing written, resized or closed", async () => {
    const terminalId = "8a7e0c52-43c5-4a4e-9a55-8f0f0e3c0a11";
    const app = await launch({
      script: {
        environments: [
          {
            name: "desk",
            reach: "local",
            sessions: [{ title: "Receipts" }],
            terminals: [{ id: terminalId }],
            receipts: {
              "terminals.write": { rejected: "forbidden", message: "Not written." },
              "terminals.resize": { rejected: "forbidden", message: "Not resized." },
              "terminals.close": { rejected: "forbidden", message: "Not closed." },
            },
          },
        ],
      },
    });
    const desk = app.environment("desk");
    const runtime = app.runtime();
    const write = await runtime.requests.call(desk.environmentId, "terminals.write", { commandId: "0199aa00-0000-7000-8000-0000000000c1", id: terminalId, data: "ls\r" });
    const resize = await runtime.requests.call(desk.environmentId, "terminals.resize", { commandId: "0199aa00-0000-7000-8000-0000000000c2", id: terminalId, cols: 100, rows: 30 });
    const close = await runtime.requests.call(desk.environmentId, "terminals.close", { commandId: "0199aa00-0000-7000-8000-0000000000c3", id: terminalId });
    expect([write, resize, close].map((answer) => (answer.ok ? answer.result.receipt.status : answer.error.code))).toEqual(["rejected", "rejected", "rejected"]);
    expect(desk.terminal(terminalId)).toMatchObject({ writes: [], resizes: [], closed: false });
    const listed = await runtime.requests.call(desk.environmentId, "terminals.list", { sessionId: desk.sessionId() });
    expect(listed).toMatchObject({ ok: true, result: { terminals: [{ id: terminalId }] } });
  });

  it("says bye with any reason", async () => {
    const app = await launch({ script: { environments: [{ name: "laptop", reach: "paired" }] } });
    app.environment("laptop").bye("draining");
    await app.waitUntil(() => phaseOf(app, "laptop") === "draining", "draining");
  });

  it("answers discovery with starting, or with nothing", async () => {
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", discovery: "starting" }, { name: "laptop", reach: "paired" }] } });
    expect(app.runtime().local.read()).toMatchObject({ state: "failed", reason: "starting" });
    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    await app.waitUntil(() => phaseOf(app, "laptop") === "backoff", "laptop backing off");
    laptop.discovery("starting");
    await app.advance(2000);
    await app.waitUntil(() => phaseOf(app, "laptop") === "starting", "laptop starting");
  });

  it("stamps a message sent, a prompt or a queued one, with the connection's ceiling, as the environment does", async () => {
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }], hello: { ceiling: "auto" } }] } });
    const desk = app.environment("desk");
    const sessionId = desk.sessionId();
    desk.startRun(sessionId, "first");
    const frames: Frame[] = [];
    const socket = app.world.webSocket(`${desk.wire.origin.replace(/^http/, "ws")}${WIRE_PATH}`, {
      onOpen: () => undefined,
      onMessage: (text) => frames.push(JSON.parse(text) as Frame),
      onClose: () => undefined,
    });
    socket.send(JSON.stringify({ type: "request", id: "q1", method: "runs.send", params: { commandId: "0199aa00-0000-7000-8000-0000000000b1", sessionId, text: "second" } }));
    socket.send(JSON.stringify({ type: "request", id: "s1", method: "sessions.subscribeSession", params: { sessionId } }));
    await app.waitUntil(() => frames.some((f) => f.type === "synchronized"), "the session's catch-up");
    socket.close();
    const sent = frames.flatMap((f) => (f.type === "event" && f.event.type === "message.sent" ? [f.event.payload] : []));
    expect(sent).toEqual([expect.objectContaining({ delivery: "prompt", ceiling: "auto" }), expect.objectContaining({ delivery: "queued", ceiling: "auto" })]);
  });
});

describe("the scripted environment's queue, as ADR 0022 has it (#231)", () => {
  /** A desk with one session whose queue `queue` holds, and a way to dispatch through the runtime as a client does. */
  const desk = async (queue: "provider" | "environment") => {
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }], queue }] } });
    const env = app.environment("desk");
    const sessionId = env.sessionId();
    const dispatch = (method: "runs.send" | "runs.interrupt" | "runs.readNow" | "runs.withdraw", params: Record<string, unknown>) =>
      app.runtime().commands.dispatch(env.environmentId, method, params as never);
    const queueNow = (text: string) => dispatch("runs.send", { sessionId, text });
    return { env, sessionId, dispatch, queueNow };
  };
  /** The environment's refusal of a withdraw, as it words a message it has no queued message for. */
  const gone = (messageId: string, why: string) => ({
    ok: false,
    error: { code: "not_found", message: `No queued message ${messageId} is on this environment: ${why}.`, data: { kind: "message", messageId } },
  });

  it("hands what the provider held back to the environment at an end other than completed", async () => {
    const { env, sessionId, dispatch, queueNow } = await desk("provider");
    const { runId } = env.startRun(sessionId, "Fix the receipts");
    await queueNow("and the tests");
    expect(env.queued(sessionId)).toMatchObject([{ text: "and the tests", heldBy: "provider" }]);
    await dispatch("runs.interrupt", { runId });
    expect(env.queued(sessionId)).toMatchObject([{ text: "and the tests", heldBy: "environment" }]);
    expect(env.liveRun(sessionId)).toBeUndefined();
  });

  it("starts the run of the environment's queue after a turn that completed, and leaves what the provider holds to the provider", async () => {
    const held = await desk("environment");
    const first = held.env.startRun(held.sessionId, "Fix the receipts");
    await held.queueNow("and the tests");
    held.env.endRun(held.sessionId, first.runId);
    expect(held.env.queued(held.sessionId)).toEqual([]);
    expect(held.env.liveRun(held.sessionId)).not.toBeUndefined();
    expect(held.env.liveRun(held.sessionId)).not.toBe(first.runId);

    const provider = await desk("provider");
    const run = provider.env.startRun(provider.sessionId, "Fix the receipts");
    await provider.queueNow("and the docs");
    provider.env.endRun(provider.sessionId, run.runId);
    expect(provider.env.queued(provider.sessionId)).toMatchObject([{ text: "and the docs", heldBy: "provider" }]);
    expect(provider.env.liveRun(provider.sessionId)).toBeUndefined();
  });

  it("reads only what the environment holds when a read-now finds no run live, and refuses a withdraw of what the provider holds then", async () => {
    const { env, sessionId, dispatch, queueNow } = await desk("provider");
    const { runId } = env.startRun(sessionId, "Fix the receipts");
    await queueNow("and the tests");
    env.endRun(sessionId, runId);
    const [providers] = env.queued(sessionId);
    env.emit(sessionId, "message.sent", {
      runId,
      messageId: "0199a200-0000-4000-8000-00000000aaaa",
      text: "and the docs",
      attachments: [],
      delivery: "queued",
      heldBy: "environment",
      ceiling: "bypassPermissions",
    });
    await dispatch("runs.readNow", { sessionId });
    expect(env.queued(sessionId)).toMatchObject([{ text: "and the tests", heldBy: "provider" }]);
    expect(env.liveRun(sessionId)).not.toBeUndefined();
    env.endRun(sessionId, env.liveRun(sessionId) ?? "");
    expect(await dispatch("runs.withdraw", { messageId: providers?.messageId })).toMatchObject(gone(providers?.messageId ?? "", "the provider has read it"));
    expect(env.queued(sessionId)).toHaveLength(1);
  });

  it("refuses a withdraw of a message withdrawn already, or read by a run, with the environment's words and the message's id", async () => {
    const { env, sessionId, dispatch, queueNow } = await desk("environment");
    const { runId } = env.startRun(sessionId, "Fix the receipts");
    await queueNow("and the tests");
    await queueNow("and the docs");
    const [tests, docs] = env.queued(sessionId);
    expect(await dispatch("runs.withdraw", { messageId: tests?.messageId })).toMatchObject({ ok: true });
    expect(await dispatch("runs.withdraw", { messageId: tests?.messageId })).toMatchObject(gone(tests?.messageId ?? "", "it was withdrawn already"));
    env.endRun(sessionId, runId);
    expect(await dispatch("runs.withdraw", { messageId: docs?.messageId })).toMatchObject(gone(docs?.messageId ?? "", "a run has read it"));
  });
});
