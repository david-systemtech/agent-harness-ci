import { randomUUID } from "node:crypto";
import type { Frame } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { workspace } from "../../environment/test/sessions.js";
import type { TestEnvironment } from "../../environment/test/helper.js";
import { failingFetch, until, useHarness } from "../test/harness.js";
import { DRAFT_DEBOUNCE_MS } from "./outbox/drafts.js";
import type { PlatformSocket, WebSocketFactory } from "./platform.js";
import type { Runtime } from "./runtime.js";
import { globalWebSocket, inMemoryPlatform, manualClock } from "./testing/in-memory-platform.js";

/**
 * The outbox against the in-process environment (docs/specs/client-runtime.md,
 * "Testing Decisions", the primary seam): real sockets, real receipts, a
 * real event log. Known regressions as tests: an edit made with the network
 * off shows pending and applies once when the environment is back; a
 * command whose answer the link lost is sent again with its command id and
 * applies once; a draft typed through one runtime is in another's.
 */

const harness = useHarness();

const row = (runtime: Runtime, id: string) => runtime.projections.sessionList.read().rows.find((r) => r.summary.id === id);
const phase = (runtime: Runtime) => runtime.connections.list.read()[0]?.phase;

/** How often `type` is on the session's own stream in the environment's log: how many times the command applied. */
const applied = (t: TestEnvironment, sessionId: string, type: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((e) => e.type === type).length;

/**
 * A link the test can take down: while `down`, discovery fails and no socket
 * opens; `cut` closes every open socket as a dropped link does. `loseAnswerTo`
 * swallows the response to the next request for a method and closes that
 * socket instead, so the command reached the environment and its answer
 * did not: a drop mid-flight. Every command id sent is recorded.
 */
const link = () => {
  let down = false;
  const open = new Set<PlatformSocket>();
  const sent: { readonly method: string; readonly commandId: unknown }[] = [];
  let losing: { readonly method: string; id?: string } | undefined;
  const base = globalWebSocket();
  const webSocket: WebSocketFactory = (url, handlers) => {
    if (down) {
      void Promise.resolve().then(() => handlers.onClose(1006, "The link is down."));
      return { send: () => undefined, close: () => undefined };
    }
    const socket: PlatformSocket = base(url, {
      ...handlers,
      onMessage(text) {
        const frame = JSON.parse(text) as Frame;
        if (losing?.id !== undefined && frame.type === "response" && frame.id === losing.id) {
          losing = undefined;
          return socket.close(4000, "The answer was lost.");
        }
        handlers.onMessage(text);
      },
      onClose(code, reason) {
        open.delete(socket);
        handlers.onClose(code, reason);
      },
    });
    open.add(socket);
    return {
      send(text) {
        const frame = JSON.parse(text) as Frame;
        if (frame.type === "request" && typeof frame.params["commandId"] === "string") {
          sent.push({ method: frame.method, commandId: frame.params["commandId"] });
          if (losing?.method === frame.method && losing.id === undefined) losing.id = frame.id;
        }
        socket.send(text);
      },
      close: (code, reason) => socket.close(code, reason),
    };
  };
  return {
    webSocket,
    fetch: failingFetch(() => down),
    sent,
    setDown(value: boolean) {
      down = value;
    },
    cut() {
      for (const socket of open) socket.close(4001, "The link dropped.");
    },
    loseAnswerTo(method: string) {
      losing = { method };
    },
  };
};

/** A runtime on its own link, paired with `t`, with a session titled `title` listed. */
const pairedWithSession = async (t: TestEnvironment, title: string) => {
  const clock = manualClock();
  const wire = link();
  const platform = inMemoryPlatform({ clock, webSocket: wire.webSocket, fetch: wire.fetch });
  const runtime = harness.runtime(platform);
  await runtime.start();
  await runtime.connections.add({ link: (await t.createPairing()).link });
  const sessionId = randomUUID();
  expect(await runtime.commands.dispatch(t.env.id, "sessions.create", { id: sessionId, workspace, title })).toMatchObject({ ok: true });
  await until(() => row(runtime, sessionId) !== undefined, "the new session to be listed");
  return { clock, wire, platform, runtime, sessionId };
};

describe("the outbox against an environment", () => {
  it("shows a command dispatched with the network off as pending, and applies it once when the environment is back", async () => {
    const t = await harness.environment({ name: "desk" });
    const { wire, platform, runtime, sessionId } = await pairedWithSession(t, "Invoices");

    platform.network.setOnline(false);
    wire.setDown(true);
    wire.cut();
    await until(() => phase(runtime) === "backoff", "the connection to be lost");

    const answer = runtime.commands.dispatch(t.env.id, "sessions.archive", { sessionId });
    await until(() => row(runtime, sessionId)?.pending === true, "the row to show pending");
    expect(row(runtime, sessionId)?.summary.archivedAt).not.toBeNull();
    expect(runtime.projections.sessionList.read().archived.map((r) => r.summary.id)).toEqual([sessionId]);
    expect(runtime.projections.environments.read()[0]).toMatchObject({ phase: "backoff", pendingCommands: 1 });
    expect(applied(t, sessionId, "session.archived")).toBe(0);

    wire.setDown(false);
    platform.network.setOnline(true);
    expect(await answer).toMatchObject({ ok: true, receipt: { status: "accepted", changed: true } });
    await until(() => row(runtime, sessionId)?.pending === false && runtime.projections.environments.read()[0]?.pendingCommands === 0, "the command to be answered");
    expect(row(runtime, sessionId)?.summary.archivedAt).not.toBeNull();
    expect(applied(t, sessionId, "session.archived")).toBe(1);
  });

  it("sends a command whose answer the dropped link lost again with the same command id, and it applies once", async () => {
    const t = await harness.environment({ name: "desk" });
    const { clock, wire, runtime, sessionId } = await pairedWithSession(t, "Invoices");

    wire.loseAnswerTo("sessions.pin");
    const answer = runtime.commands.dispatch(t.env.id, "sessions.pin", { sessionId });
    await until(() => phase(runtime) === "backoff", "the link to drop with the answer lost");
    // The environment applied it; this client does not know that yet.
    expect(applied(t, sessionId, "session.pinned")).toBe(1);
    expect(runtime.projections.environments.read()[0]?.pendingCommands).toBe(1);

    clock.advance(1250);
    const settled = await answer;
    // A retry is answered from the stored receipt, which carries no result.
    expect(settled).toMatchObject({ ok: true, receipt: { status: "accepted", changed: true } });
    expect(settled.ok && settled.result).toBeUndefined();
    const pins = wire.sent.filter((s) => s.method === "sessions.pin");
    expect(pins).toHaveLength(2);
    expect(pins[1]?.commandId).toBe(pins[0]?.commandId);
    expect(pins[0]?.commandId).toBe(settled.commandId);
    expect(applied(t, sessionId, "session.pinned")).toBe(1);
    await until(() => runtime.projections.sessionList.read().pinned.length === 1, "the pin to be listed");
  });

  it("rejects a command queued offline whose session another client deleted meanwhile not_found, reverting it with one notice", async () => {
    const t = await harness.environment({ name: "desk" });
    const one = await pairedWithSession(t, "Invoices");
    const two = harness.runtime(inMemoryPlatform());
    await two.start();
    await two.connections.add({ link: (await t.createPairing()).link });

    one.platform.network.setOnline(false);
    one.wire.setDown(true);
    one.wire.cut();
    await until(() => phase(one.runtime) === "backoff", "the connection to be lost");
    const answer = one.runtime.commands.dispatch(t.env.id, "sessions.archive", { sessionId: one.sessionId });
    await until(() => row(one.runtime, one.sessionId)?.pending === true, "the row to show pending");
    expect(await two.commands.dispatch(t.env.id, "sessions.delete", { sessionId: one.sessionId })).toMatchObject({ ok: true });

    one.wire.setDown(false);
    one.platform.network.setOnline(true);
    expect(await answer).toMatchObject({ ok: false, error: { code: "not_found", receipt: { status: "rejected", reason: "not_found" } } });
    await until(() => row(one.runtime, one.sessionId) === undefined, "the deletion to reach the first runtime");
    expect(one.runtime.projections.notices.read().filter((n) => n.kind === "command-rejected").map((n) => n.message)).toEqual([
      "Archive on Invoices was rejected: it no longer exists.",
    ]);
    expect(one.runtime.projections.environments.read()[0]?.pendingCommands).toBe(0);
    expect(applied(t, one.sessionId, "session.archived")).toBe(0);
  });

  it("carries a draft typed in one runtime to another on the same environment", async () => {
    const t = await harness.environment({ name: "desk" });
    const one = await pairedWithSession(t, "Invoices");
    const two = harness.runtime(inMemoryPlatform());
    await two.start();
    await two.connections.add({ link: (await t.createPairing()).link });
    await until(() => row(two, one.sessionId) !== undefined, "the second runtime to list the session");

    one.runtime.drafts.set(t.env.id, one.sessionId, "Half a");
    one.runtime.drafts.set(t.env.id, one.sessionId, "Half a thought");
    expect(row(one.runtime, one.sessionId)?.summary.draft).toBe("Half a thought");
    one.clock.advance(DRAFT_DEBOUNCE_MS);
    await until(() => row(two, one.sessionId)?.summary.draft === "Half a thought", "the draft to reach the second runtime");
    expect(applied(t, one.sessionId, "session.draft-set")).toBe(1);
  });

  it("creates a group offline with a client-minted id and moves a session into it, both applied once back online", async () => {
    const t = await harness.environment({ name: "desk" });
    const { wire, platform, runtime, sessionId } = await pairedWithSession(t, "Invoices");
    platform.network.setOnline(false);
    wire.setDown(true);
    wire.cut();
    await until(() => phase(runtime) === "backoff", "the connection to be lost");

    const moved = runtime.commands.moveToGroup(t.env.id, sessionId, "Brandsolidate");
    await until(() => runtime.projections.sessionList.read().groups.length === 1, "the new heading to show");
    expect(runtime.projections.sessionList.read().groups[0]).toMatchObject({ name: "Brandsolidate", pending: true });

    wire.setDown(false);
    platform.network.setOnline(true);
    expect(await moved).toMatchObject({ ok: true });
    await until(() => runtime.projections.sessionList.read().groups[0]?.pending === false, "the heading to be confirmed");
    const groupId = row(runtime, sessionId)?.summary.groupId as string;
    expect(t.env.log.readStream({ kind: "group", id: groupId }).map((e) => e.type)).toEqual(["group.created"]);
    expect(applied(t, sessionId, "session.group-set")).toBe(1);
  });
});
