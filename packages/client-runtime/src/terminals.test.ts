import { randomUUID } from "node:crypto";
import {
  TERMINAL_EXITED_TYPE,
  TERMINAL_OUTPUT_TYPE,
  TERMINAL_STREAM_KIND,
  type EventEnvelope,
  type TerminalExitedPayload,
  type TerminalSnapshot,
} from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { subscription } from "../test/scripted.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { TerminalOutput } from "./streams/terminals.js";
import { SUBSCRIBE_TIMEOUT_MS } from "./streams/attach.js";
import { fakeWire, flush } from "./testing/fake-wire.js";
import { inMemoryPlatform, manualClock, MANUAL_CLOCK_START } from "./testing/in-memory-platform.js";

/**
 * A terminal's output through the fake wire (docs/specs/tui.md, "The
 * terminal pane"; #148): `subscriptions.terminal` subscribes
 * `terminals.subscribe` while its environment is ready, hands the renderer
 * the retained scrollback as a reset and then each chunk once, in order,
 * and after a reconnect resubscribes from its cursor so the environment
 * replays what was missed. Nothing of it is cached: a terminal's output
 * never leaves memory (tui spec, "Terminals, files and diffs").
 */

const TERMINAL = "8a7e0c52-43c5-4a4e-9a55-8f0f0e3c0a11";
const SESSION = "0199aa00-0000-4000-8000-000000000001";

const terminalEvent = (sequence: number, type: string, payload: Record<string, unknown>): EventEnvelope => ({
  sequence,
  eventId: randomUUID(),
  streamKind: TERMINAL_STREAM_KIND,
  streamId: TERMINAL,
  streamVersion: sequence,
  type,
  occurredAt: MANUAL_CLOCK_START,
  commandId: null,
  causationId: null,
  correlationId: null,
  actor: { kind: "system", id: "environment" },
  payload,
  metadata: {},
});

const output = (sequence: number, data: string) => terminalEvent(sequence, TERMINAL_OUTPUT_TYPE, { data });
const exited = (sequence: number, payload: TerminalExitedPayload) => terminalEvent(sequence, TERMINAL_EXITED_TYPE, payload);

/**
 * A snapshot as the environment's scrollback builds one: `firstSequence` the
 * oldest chunk retained (0 while there is none), so a truncated one names
 * where its retained tail begins, past the chunks that were dropped.
 */
const snapshot = (lastSequence: number, scrollback: string, retained: { readonly from: number; readonly truncated: boolean } = { from: 1, truncated: false }): TerminalSnapshot => ({
  terminal: { id: TERMINAL, sessionId: SESSION, openedAt: MANUAL_CLOCK_START, cols: 80, rows: 24, exitCode: null, signal: null },
  scrollback,
  firstSequence: lastSequence === 0 ? 0 : retained.from,
  lastSequence,
  truncated: retained.truncated,
});

/** A runtime paired with the fake environment, its session list synchronized, so the connection is ready. */
const ready = async () => {
  const clock = manualClock();
  const wire = fakeWire({ clock, name: "desk" });
  for (const method of ["sessions.subscribe", "environment.subscribe", "terminals.subscribe"]) wire.answer(method, () => undefined);
  const platform = inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket });
  const { runtime } = createRuntimeWithSeams(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept();
  (await subscription(wire, "sessions.subscribe")).synchronized(0);
  await adding;
  const heard: TerminalOutput[] = [];
  const open = () => runtime.subscriptions.terminal(wire.environmentId, TERMINAL, (message) => void heard.push(message));
  return { clock, wire, runtime, heard, open };
};

describe("a terminal's subscription", () => {
  it("subscribes from 0, hands the retained scrollback over as a reset, then each chunk once, and is live once synchronized", async () => {
    const { wire, heard, open } = await ready();
    const handle = open();
    const stream = await subscription(wire, "terminals.subscribe");
    expect(stream.params).toEqual({ id: TERMINAL, afterSequence: 0 });
    await flush();
    expect(handle.state.read()).toMatchObject({ status: "catching-up", cursor: null });

    stream.snapshot(2, snapshot(2, "$ ls\r\nREADME.md\r\n$ "));
    stream.synchronized(2);
    stream.event(output(3, "e"));
    // An event at or under the cursor was in the snapshot already. The environment never sends one (it drops what its
    // catch-up sent from what its live feed heard); one that came would be dropped rather than drawn twice.
    stream.event(output(2, "stale"));
    stream.event(output(4, "cho hi"));
    await flush();
    expect(heard).toEqual([
      { kind: "reset", data: "$ ls\r\nREADME.md\r\n$ ", sequence: 2, truncated: false, terminal: snapshot(2, "").terminal },
      { kind: "output", data: "e", sequence: 3, live: true },
      { kind: "output", data: "cho hi", sequence: 4, live: true },
    ]);
    expect(handle.state.read()).toMatchObject({ status: "live", cursor: 4, terminal: { cols: 80, rows: 24 }, exit: null, fault: null });
  });

  it("after the socket drops, resubscribes from its cursor, and the replay continues the output where it stopped", async () => {
    const { wire, clock, heard, open } = await ready();
    const handle = open();
    const first = await subscription(wire, "terminals.subscribe");
    first.snapshot(1, snapshot(1, "one\r\n"));
    first.synchronized(1);
    first.event(output(2, "two\r\n"));
    await flush();

    wire.server.drop();
    await flush();
    expect(handle.state.read()).toMatchObject({ status: "unreachable", cursor: 2 });
    clock.advance(1250);
    await wire.server.accept();
    const list = await subscription(wire, "sessions.subscribe");
    list.synchronized(0);

    const again = await subscription(wire, "terminals.subscribe");
    expect(again.params).toEqual({ id: TERMINAL, afterSequence: 2 });
    // Replayed, not live: what happened while this client was away.
    again.event(output(3, "three\r\n"));
    again.synchronized(3);
    again.event(output(4, "four\r\n"));
    await flush();
    expect(heard.map((m) => (m.kind === "output" ? [m.data, m.live] : m.kind))).toEqual(["reset", ["two\r\n", true], ["three\r\n", false], ["four\r\n", true]]);
    expect(handle.state.read()).toMatchObject({ status: "live", cursor: 4 });
  });

  it("takes a snapshot answering a cursor the scrollback no longer reaches as a reset, marked truncated", async () => {
    const { wire, clock, heard, open } = await ready();
    open();
    const first = await subscription(wire, "terminals.subscribe");
    first.snapshot(1, snapshot(1, "old\r\n"));
    first.synchronized(1);
    await flush();
    wire.server.drop();
    await flush();
    clock.advance(1250);
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    const again = await subscription(wire, "terminals.subscribe");
    // Chunks 1 to 849 were dropped at the cap: the tail retained begins at 850, past the cursor of 1.
    again.snapshot(900, snapshot(900, "the retained tail\r\n", { from: 850, truncated: true }));
    again.synchronized(900);
    await flush();
    expect(heard.at(-1)).toMatchObject({ kind: "reset", data: "the retained tail\r\n", sequence: 900, truncated: true });
  });

  it("hands over the exit and ends: a `closed` end after it is not resubscribed", async () => {
    const { wire, clock, heard, open } = await ready();
    const handle = open();
    const stream = await subscription(wire, "terminals.subscribe");
    stream.snapshot(1, snapshot(1, "$ exit\r\n"));
    stream.synchronized(1);
    stream.event(exited(2, { exitCode: 0, signal: null, cause: "exited" }));
    stream.end("closed");
    await flush();
    expect(heard.at(-1)).toEqual({ kind: "exited", exit: { exitCode: 0, signal: null, cause: "exited" } });
    expect(handle.state.read()).toMatchObject({ status: "ended", exit: { exitCode: 0 } });

    wire.server.drop();
    await flush();
    clock.advance(1250);
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    await flush();
    expect(wire.server.received().filter((f) => f.type === "request" && f.method === "terminals.subscribe")).toHaveLength(0);
    expect(handle.state.read().status).toBe("ended");
  });

  it("keeps the exit it heard through the end the environment sends after it, and through the environment being forgotten", async () => {
    // The environment ends a terminal's subscription on its exit event (`endOn`): `deleted` when the session went, else `closed`.
    const { wire, runtime, open } = await ready();
    const handle = open();
    const stream = await subscription(wire, "terminals.subscribe");
    stream.snapshot(1, snapshot(1, "$ "));
    stream.synchronized(1);
    stream.event(exited(2, { exitCode: 129, signal: 1, cause: "deleted" }));
    stream.end("deleted");
    await flush();
    expect(handle.state.read()).toMatchObject({ status: "ended", cursor: 2, exit: { exitCode: 129, signal: 1, cause: "deleted" } });

    await runtime.connections.remove(wire.environmentId);
    await flush();
    expect(handle.state.read()).toMatchObject({ status: "ended", exit: { exitCode: 129, signal: 1, cause: "deleted" }, fault: null });
  });

  it("resubscribes from its cursor at once on overflow", async () => {
    const { wire, open } = await ready();
    open();
    const stream = await subscription(wire, "terminals.subscribe");
    stream.snapshot(1, snapshot(1, "x"));
    stream.synchronized(1);
    stream.event(output(2, "y"));
    stream.end("overflow");
    expect((await subscription(wire, "terminals.subscribe")).params).toEqual({ id: TERMINAL, afterSequence: 2 });
  });

  it("is ended with the environment's reason when the terminal is not there", async () => {
    const { wire, runtime, heard } = await ready();
    wire.answer("terminals.subscribe", () => ({ error: { code: "not_found", message: `No terminal ${TERMINAL} is open on this environment.`, data: { kind: "terminal" } } }));
    const handle = runtime.subscriptions.terminal(wire.environmentId, TERMINAL, (m) => void heard.push(m));
    await flush();
    await flush();
    expect(handle.state.read()).toMatchObject({ status: "ended", fault: `No terminal ${TERMINAL} is open on this environment.` });
    expect(heard).toEqual([]);
  });

  it("is a fault, tried again on the next ready, when the environment leaves the subscription unanswered", async () => {
    const { wire, clock, open } = await ready();
    const handle = open();
    await wire.server.request("terminals.subscribe");
    clock.advance(SUBSCRIBE_TIMEOUT_MS);
    await flush();
    expect(handle.state.read()).toMatchObject({ status: "unreachable", fault: expect.stringMatching(/did not answer terminals.subscribe/) });

    wire.server.drop();
    await flush();
    clock.advance(1250);
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    const again = await subscription(wire, "terminals.subscribe");
    expect(again.params).toEqual({ id: TERMINAL, afterSequence: 0 });
    again.snapshot(1, snapshot(1, "x"));
    again.synchronized(1);
    await flush();
    expect(handle.state.read()).toMatchObject({ status: "live", fault: null });
  });

  it("lets go of a fault the next subscription recovered from, when the replay it answers with is the terminal's exit", async () => {
    // The pane says an ended terminal's fault as why it is gone; one the resubscription answered past is no reason.
    const { wire, clock, open } = await ready();
    const handle = open();
    await wire.server.request("terminals.subscribe");
    clock.advance(SUBSCRIBE_TIMEOUT_MS);
    await flush();
    expect(handle.state.read().fault).toMatch(/did not answer terminals.subscribe/);

    wire.server.drop();
    await flush();
    clock.advance(1250);
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    const again = await subscription(wire, "terminals.subscribe");
    again.snapshot(1, snapshot(1, "$ exit\r\n"));
    again.event(exited(2, { exitCode: 0, signal: null, cause: "exited" }));
    again.synchronized(2);
    await flush();
    expect(handle.state.read()).toMatchObject({ status: "ended", exit: { exitCode: 0 }, fault: null });
  });

  it("lets go of a fault when the environment is forgotten, which ends the handle for no failure of its own", async () => {
    const { wire, clock, runtime, open } = await ready();
    const handle = open();
    await wire.server.request("terminals.subscribe");
    clock.advance(SUBSCRIBE_TIMEOUT_MS);
    await flush();
    expect(handle.state.read().fault).toMatch(/did not answer terminals.subscribe/);

    await runtime.connections.remove(wire.environmentId);
    await flush();
    expect(handle.state.read()).toMatchObject({ status: "ended", fault: null });
  });

  it("waits for the environment to be ready before it subscribes", async () => {
    const { wire, clock, open } = await ready();
    wire.server.drop();
    await flush();
    const handle = open();
    expect(handle.state.read().status).toBe("unreachable");
    expect(wire.server.received().filter((f) => f.type === "request" && f.method === "terminals.subscribe")).toHaveLength(0);
    clock.advance(1250);
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    expect((await subscription(wire, "terminals.subscribe")).params).toEqual({ id: TERMINAL, afterSequence: 0 });
  });

  it("unsubscribes on release, and hands nothing over after it", async () => {
    const { wire, heard, open } = await ready();
    const handle = open();
    const stream = await subscription(wire, "terminals.subscribe");
    stream.snapshot(1, snapshot(1, "x"));
    await flush();
    handle.release();
    stream.event(output(2, "late"));
    await flush();
    expect(wire.server.received()).toContainEqual({ type: "unsubscribe", subscription: expect.any(String) });
    expect(heard.map((m) => m.kind)).toEqual(["reset"]);
  });

  it("takes a terminal id in any case, subscribing it lowercased", async () => {
    const { wire, runtime } = await ready();
    const handle = runtime.subscriptions.terminal(wire.environmentId, TERMINAL.toUpperCase(), () => undefined);
    expect(handle.terminalId).toBe(TERMINAL);
    expect((await subscription(wire, "terminals.subscribe")).params).toEqual({ id: TERMINAL, afterSequence: 0 });
  });
});
