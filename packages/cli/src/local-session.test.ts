import { registry } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startTestEnvironment, type TestEnvironment } from "../../environment/test/helper.js";
import { LocalFailure, withLocalSession, type Net } from "./local-session.js";

/**
 * The route to the local environment (`local-session.ts`) against the
 * in-process environment, for what its verbs do not reach one call at a
 * time: calls in flight together, and an environment that goes silent.
 */

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const start = async (): Promise<TestEnvironment> => {
  const t = await startTestEnvironment();
  cleanups.push(() => t.close());
  return t;
};

const net: Net = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };

/** The labels of the client sessions still live on `t`. */
const liveLabels = async (t: TestEnvironment): Promise<string[]> => {
  const admin = await t.client();
  const labels = (await admin.request("access.sessions.list", { live: true })).sessions.map((session) => session.label);
  await admin.close();
  return labels;
};

describe("the local session route", () => {
  it("answers calls in flight together, each with its own answer, and revokes its client session after", async () => {
    const t = await start();
    const [status, updates] = await withLocalSession({ dataDir: t.dataDir }, net, "two calls", (call) =>
      Promise.all([call("environment.status", {}), call("updates.status", {})]),
    );
    expect(status).toMatchObject({ readiness: "ready" });
    expect(updates).toMatchObject({ manager: { kind: "none" } });
    expect(await liveLabels(t)).not.toContain("two calls");
  });

  it("fails the verb when a call goes unanswered for the timeout, even after another call in flight with it was answered", async () => {
    const t = await start();
    t.env.methods.register(registry["updates.status"], () => new Promise<never>(() => undefined));
    const verb = withLocalSession({ dataDir: t.dataDir }, net, "one silent call", (call) => Promise.all([call("updates.status", {}), call("environment.status", {})]), {
      timeoutMs: 300,
    });
    await expect(verb).rejects.toThrow(LocalFailure);
    await expect(verb).rejects.toThrow(/did not answer within/);
  });
});
