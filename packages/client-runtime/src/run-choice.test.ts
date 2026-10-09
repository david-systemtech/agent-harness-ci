import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { end, fakeAdapter, gate, say } from "../../environment/test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../environment/test/helper.js";
import { workspace } from "../../environment/test/sessions.js";
import { useHarness } from "../test/harness.js";
import { sendMessage } from "./composer/send.js";
import type { Runtime } from "./runtime.js";
import { setSessionModel } from "./status/actions.js";
import { statusOf } from "./status/line.js";
import { fakeShell, inMemoryPlatform } from "./testing/in-memory-platform.js";

/**
 * A model and effort chosen from a session's status line belong to the
 * session (#1961): end to end, a real runtime paired with the in-process
 * environment over a real WebSocket, the scripted fake adapter playing the
 * runs. The client that chose is closed and the environment restarted on
 * its data directory before the next run, which a new client sends: the
 * status line it draws and the run it sends go out on the same model and
 * effort.
 */

const harness = useHarness();

/** How long a test waits for the environment to do what it was asked, on a loaded runner: a ceiling, never a pace. */
const EVENTUALLY = { timeout: 20_000, interval: 5 };

/** A runtime paired with `t`, as a client launched afresh is: it holds nothing of the session but what the environment says. */
const paired = async (t: TestEnvironment): Promise<Runtime> => {
  const runtime = harness.runtime(inMemoryPlatform({ shell: fakeShell() }));
  await runtime.start();
  await runtime.connections.add({ link: (await t.createPairing()).link });
  return runtime;
};

/** The session as `runtime` follows it, once its stream is live. */
const followed = async (runtime: Runtime, environmentId: string, sessionId: string) => {
  const session = runtime.projections.session(environmentId, sessionId);
  onTestFinished(session.subscribe(() => undefined));
  await vi.waitFor(() => expect(session.read().freshness).toBe("live"), EVENTUALLY);
  return session;
};

/** What the session's status line names for the next run. */
const nextRunOn = (session: Awaited<ReturnType<typeof followed>>) =>
  statusOf({
    projection: session.read(),
    runState: "idle",
    liveRunId: undefined,
    ceiling: null,
    forkedOnto: undefined,
    containmentDefault: undefined,
    recommendation: undefined,
    now: () => 0,
  }).model;

describe("a model chosen from a session's status line", () => {
  it("outlives the client that chose it and an environment restart: the line names it, and the next run goes out on it", async () => {
    const dataDir = join(harness.tempDir(), "data");
    const before = await startTestEnvironment({ adapter: fakeAdapter(), dataDir });
    const env = before.env.id;
    const sessionId = randomUUID();
    const chooser = await paired(before);
    expect(await chooser.commands.dispatch(env, "sessions.create", { id: sessionId, workspace, title: "Receipts" })).toMatchObject({ ok: true });
    expect(await setSessionModel(chooser, env, sessionId, { model: "sonnet", effort: "low" }, { session: "Receipts" })).toMatch(/^The next run of Receipts goes out on .+ - Low\.$/);
    await chooser.close();
    await before.close();

    const after = await harness.environment({ adapter: fakeAdapter(), dataDir });
    const relaunched = await paired(after);
    const session = await followed(relaunched, env, sessionId);
    expect(nextRunOn(session)).toEqual({ model: "sonnet", effort: "low" });
    expect(await sendMessage(relaunched, env, sessionId, { text: "Reply with exactly done", attachments: [] }, false)).toMatchObject({ ok: true });
    const { input } = await after.adapter.reached(1);
    expect({ model: input.model, effort: input.effort }).toEqual({ model: "sonnet", effort: "low" });
    await vi.waitFor(() => expect(session.read().runs.at(-1)).toMatchObject({ model: "sonnet", effort: "low" }), EVENTUALLY);
    expect(nextRunOn(session)).toEqual({ model: "sonnet", effort: "low" });
  });

  it("is refused while a run is live, said in one line, and the line still names the live run's model", async () => {
    const held = gate();
    onTestFinished(() => held.open());
    const t = await harness.environment({
      adapter: fakeAdapter({
        script: async function* () {
          yield say("Working");
          await held.opened;
          yield end();
        },
      }),
    });
    const env = t.env.id;
    const sessionId = randomUUID();
    const runtime = await paired(t);
    expect(await runtime.commands.dispatch(env, "sessions.create", { id: sessionId, workspace, title: "Receipts" })).toMatchObject({ ok: true });
    const session = await followed(runtime, env, sessionId);
    await sendMessage(runtime, env, sessionId, { text: "Go", attachments: [] }, false);
    await t.adapter.reached(1);
    expect(await setSessionModel(runtime, env, sessionId, { model: "sonnet", effort: null }, { session: "Receipts" })).toMatch(/^The model was not chosen: /);
    await vi.waitFor(() => expect(nextRunOn(session)).toEqual({ model: "opus", effort: null }), EVENTUALLY);
  });
});
