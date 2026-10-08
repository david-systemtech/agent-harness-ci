import { FILE_UNDO_CONFLICT_REASONS } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const CHANGE = "0199aa00-0000-4000-8000-000000000002";
let apps: RenderedApp[] = [];
afterEach(async () => { for (const app of apps) await app.unmount(); apps = []; });
const launch = async (options: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({
    script: { environments: [{ name: "desk", reach: "local", sessions: [{ id: SESSION, title: "Undo", workspace: { kind: "directory", path: "/work/receipts" } }], capabilities: ["fileUndo"], ...options }] },
    flags: { session: SESSION },
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  return { app, env: app.environment("desk") };
};

describe("/undo", () => {
  it.each(["restored", "deleted"] as const)("answers typed undo once and renders the shared %s completion row", async (action) => {
    const { app, env } = await launch();
    env.wire.answer("files.undo", () => {
      const result = { changeId: CHANGE, path: "src/app.ts", action };
      const event = env.emit(SESSION, "files.undo-finished", result);
      return { result: { receipt: { status: "accepted", sequence: event.sequence, changed: true }, result } };
    });
    await app.type("/undo");
    await app.press(KEY.enter);
    await app.waitFor(`File undo: ${action} src/app.ts`);
    expect(env.requests("files.undo")).toHaveLength(1);
    expect(env.requests("files.undo")[0]?.params).toEqual({ sessionId: SESSION, commandId: expect.any(String) });
    expect(env.requests("runs.start")).toEqual([]);
    expect(env.requests("sessions.undoRewind")).toEqual([]);
    expect(app.frame()).toContain(CHANGE);
  });
  it.each(FILE_UNDO_CONFLICT_REASONS)("shows %s without changing the composer or sending a prompt", async (reason) => {
    const { app, env } = await launch();
    env.wire.answer("files.undo", () => ({ result: { receipt: { status: "rejected", sequence: 4, changed: false, reason: "conflict", error: { code: "conflict", message: `Undo refused: ${reason}.`, data: { reason } } } } }));
    await app.type("/undo");
    await app.press(KEY.enter);
    await app.waitFor(`Cannot undo file change: Undo refused: ${reason}.`);
    expect(app.frame()).toContain("› /undo");
    expect(env.requests("files.undo")).toHaveLength(1);
    expect(env.requests("runs.start")).toEqual([]);
    expect(app.frame()).not.toContain("File undo: restored");
    expect(app.frame()).not.toContain("File undo: deleted");
  });

  it("refuses offline from the composer without queuing undo or starting a prompt", async () => {
    const { app, env } = await launch();
    env.autoAccept(false);
    env.server.drop();
    await app.type("/undo");
    await app.press(KEY.enter);
    await app.waitFor("Cannot undo file change");
    expect(app.frame()).toContain("✕ /undo");
    expect(env.requests("files.undo")).toEqual([]);
    expect(env.requests("runs.start")).toEqual([]);
  });

  it.each([
    [{ capabilities: [] }, "runs an older agent-harness without this"],
    [{ scopes: ["read"] }, "cannot use terminals or files"],
  ] satisfies [Partial<ScriptedEnvironment>, string][])("keeps unavailable undo in the slash menu with its reason", async (options, reason) => {
    const { app, env } = await launch(options);
    await app.type("/undo");
    await app.waitFor(reason);
    expect(app.frame()).toContain("/undo");
    await app.press(KEY.enter);
    await app.waitFor("Cannot undo file change");
    expect(env.requests("files.undo")).toEqual([]);
    expect(env.requests("runs.start")).toEqual([]);
  });
});
