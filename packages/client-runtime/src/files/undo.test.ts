import { FILE_UNDO_CONFLICT_REASONS } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { subscription } from "../../test/scripted.js";
import { sessionStreamEvent } from "../../test/transcript.js";
import { summaryOf } from "../../test/events.js";
import { createRuntimeWithSeams } from "../internal.js";
import { fakeWire, flush } from "../testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "../testing/in-memory-platform.js";
import { undoFile } from "./undo.js";

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const CHANGE = "0199aa00-0000-4000-8000-000000000002";
const outcome = { changeId: CHANGE, path: "src/app.ts", action: "restored" } as const;
const paired = async (hello: Parameters<ReturnType<typeof fakeWire>["server"]["accept"]>[0] = {}) => {
  const clock = manualClock();
  const wire = fakeWire({ clock, name: "desk", capabilities: ["fileUndo"] });
  const { runtime } = createRuntimeWithSeams(inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket }));
  onTestFinished(() => runtime.close());
  await runtime.start();
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept(hello);
  await adding;
  return { clock, wire, runtime, id: wire.environmentId };
};
const undoRequests = (wire: ReturnType<typeof fakeWire>) => wire.server.received().filter((f) => f.type === "request" && f.method === "files.undo");

describe("shared file undo", () => {
  it("restores one change per invocation through a direct terminal request with a fresh command id", async () => {
    const { runtime, wire, clock, id } = await paired();
    wire.answer("files.undo", () => ({ result: { receipt: { status: "accepted", sequence: 4, changed: true }, result: outcome } }));
    expect(await undoFile(runtime, clock, id, SESSION)).toEqual({ ok: true, result: outcome, line: "File undo: restored src/app.ts." });
    expect(undoRequests(wire)).toEqual([expect.objectContaining({ params: { sessionId: SESSION, commandId: expect.any(String) } })]);
    await undoFile(runtime, clock, id, SESSION);
    const requests = undoRequests(wire);
    expect(requests).toHaveLength(2);
    if (requests[0]?.type !== "request" || requests[1]?.type !== "request") throw new Error("Missing undo requests");
    expect(requests[0].params["commandId"]).not.toBe(requests[1].params["commandId"]);
    expect(wire.server.received().filter((f) => f.type === "request" && f.method === "sessions.undoRewind")).toEqual([]);
    await flush();
  });
  it("refreshes both followed diff queries on success without needing a completion event", async () => {
    const { runtime, wire, clock, id } = await paired();
    let undone = false;
    wire.answer("diffs.session", () => ({ result: { files: [], truncated: undone } }));
    wire.answer("diffs.workingTree", () => ({ result: { repository: true, diff: undone ? "after undo" : "before undo", truncated: false } }));
    const session = runtime.requests.cached(id, "diffs.session", { sessionId: SESSION });
    const tree = runtime.requests.cached(id, "diffs.workingTree", { sessionId: SESSION });
    onTestFinished(session.subscribe(() => undefined));
    onTestFinished(tree.subscribe(() => undefined));
    await flush();
    expect(tree.read().result?.diff).toBe("before undo");
    wire.answer("files.undo", () => {
      undone = true;
      return { result: { receipt: { status: "accepted", sequence: 4, changed: true }, result: outcome } };
    });
    await undoFile(runtime, clock, id, SESSION);
    await flush();
    expect(session.read().result?.truncated).toBe(true);
    expect(tree.read().result?.diff).toBe("after undo");
  });

  it.each([false, true])("refreshes diffs for another Client's completion, replay=%s, once per event", async (replay) => {
    const { runtime, wire, id } = await paired();
    let reads = 0;
    wire.answer("diffs.session", () => ({ result: { files: [], truncated: ++reads > 1 } }));
    let treeReads = 0;
    wire.answer("diffs.workingTree", () => ({ result: { repository: true, diff: String(++treeReads), truncated: false } }));
    const diff = runtime.requests.cached(id, "diffs.session", { sessionId: SESSION });
    const tree = runtime.requests.cached(id, "diffs.workingTree", { sessionId: SESSION });
    onTestFinished(diff.subscribe(() => undefined));
    onTestFinished(tree.subscribe(() => undefined));
    wire.answer("sessions.subscribeSession", () => undefined);
    const session = runtime.projections.session(id, SESSION);
    onTestFinished(session.subscribe(() => undefined));
    const stream = await subscription(wire, "sessions.subscribeSession");
    stream.snapshot(1, { sequence: 1, summary: summaryOf(SESSION), runs: [], items: [], parkedPrompts: [], rewinds: [] });
    if (!replay) stream.synchronized(1);
    await flush();
    expect(reads).toBe(1);
    const event = { ...sessionStreamEvent(2, "files.undo-finished", outcome), streamId: SESSION, actor: { kind: "client_session", id: "another-client" } as const };
    stream.event(event);
    if (replay) stream.synchronized(2);
    await flush();
    expect(session.read()).toMatchObject({ fault: null, items: [{ kind: "file-undo", sequence: 2, ...outcome }] });
    expect(diff.read().result?.truncated).toBe(true);
    expect(tree.read().result?.diff).toBe("2");
    stream.event(event);
    await flush();
    expect(reads).toBe(2);
    expect(session.read().items).toEqual([{ kind: "file-undo", sequence: 2, ...outcome }]);
    expect(undoRequests(wire)).toEqual([]);
  });

  it.each([
    [{ capabilities: [] }, "unsupported"],
    [{ scopes: ["read"] }, "scope"],
  ] satisfies [Parameters<typeof paired>[0], string][])("refuses missing capability or scope without sending undo", async (hello, code) => {
    const { runtime, wire, clock, id } = await paired(hello);
    wire.answer("files.undo", () => ({ result: { receipt: { status: "accepted", sequence: 4, changed: true }, result: outcome } }));
    expect(await undoFile(runtime, clock, id, SESSION)).toMatchObject({ ok: false, error: { code }, line: expect.stringContaining("Cannot undo") });
    expect(undoRequests(wire)).toEqual([]);
  });

  it("refuses offline immediately and never queues undo for reconnection", async () => {
    const { runtime, wire, clock, id } = await paired();
    wire.server.drop();
    await flush();
    expect(await undoFile(runtime, clock, id, SESSION)).toMatchObject({ ok: false, error: { code: "unreachable" } });
    clock.advance(1250);
    await wire.server.accept();
    await flush();
    expect(undoRequests(wire)).toEqual([]);
  });

  it.each(FILE_UNDO_CONFLICT_REASONS)("displays the Environment's %s refusal without claiming success", async (reason) => {
    const { runtime, wire, clock, id } = await paired();
    wire.answer("files.undo", () => ({ result: { receipt: { status: "rejected", sequence: 4, changed: false, reason: "conflict", error: { code: "conflict", message: `Undo refused: ${reason}.`, data: { reason } } } } }));
    expect(await undoFile(runtime, clock, id, SESSION)).toEqual({ ok: false, error: { code: "conflict", message: `Undo refused: ${reason}.`, data: { reason } }, line: `Cannot undo file change: Undo refused: ${reason}.` });
  });
});
