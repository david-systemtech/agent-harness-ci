// @vitest-environment jsdom
import { BYPASS_SENTENCE } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { createRuntime } from "../runtime.js";
import { inMemoryPlatform, manualClock } from "../testing/in-memory-platform.js";
import { scriptedWorld, type ScriptedEnvironment } from "../testing/scripted-environment.js";
import { setSessionMode } from "./actions.js";

/**
 * Setting a session's mode as both renderers do it (#147, #1823): a mode the
 * session got as asked is a transient notice, said once as it changes, since
 * the mode control shows the mode from then on; a clamp or a refusal is the
 * pane's line, which stands until another is said.
 */

/** A runtime over one local environment, `desk`, holding one session in acceptEdits. */
const launch = async (more: Partial<ScriptedEnvironment> = {}) => {
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts", mode: "acceptEdits" }], ...more }] });
  const platform = inMemoryPlatform({ clock, kind: "desktop", fetch: world.fetch, webSocket: world.webSocket, ...(world.grant && { grant: world.grant }) });
  const runtime = createRuntime(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  const desk = world.environment("desk");
  return { runtime, desk, set: (mode: Parameters<typeof setSessionMode>[3]) => setSessionMode(runtime, desk.environmentId, desk.sessionId(), mode, "Receipts") };
};

describe("setting a session's mode", () => {
  it("says a mode the session got as asked once, as a transient notice", async () => {
    const { set } = await launch();
    expect(await set("plan")).toEqual({ ok: true, mode: "plan", line: "Mode: plan.", transient: true });
  });

  it("says bypassPermissions with the permissions spec's sentence in the transient notice, and that the running turn has it too", async () => {
    const { desk, set } = await launch();
    desk.startRun(desk.sessionId(), "Check the receipts");
    expect(await set("bypassPermissions")).toEqual({
      ok: true,
      mode: "bypassPermissions",
      line: `Mode: bypassPermissions. ${BYPASS_SENTENCE} The running turn has it too.`,
      transient: true,
    });
  });

  it("says a clamp on the pane's line, since the mode control does not say why the session has less than was asked", async () => {
    const { set } = await launch({ hello: { ceiling: "auto" } });
    expect(await set("bypassPermissions")).toEqual({
      ok: true,
      mode: "auto",
      line: "Asked for bypassPermissions; Receipts has auto: clamped to this connection's ceiling (auto).",
      transient: false,
    });
  });

  it("says a refusal on the pane's line", async () => {
    const { set } = await launch({ receipts: { "permissions.mode.set": { rejected: "not_found", message: "No such session." } } });
    expect(await set("plan")).toMatchObject({ ok: false, transient: false });
  });
});
