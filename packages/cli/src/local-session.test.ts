import { createServer, type AddressInfo, type Socket } from "node:net";
import { ContractError, registry } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startTestEnvironment, type TestEnvironment } from "../../environment/test/helper.js";
import { LocalFailure, LocalRefusal, withLocalSession, type Net } from "./local-session.js";

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

  it("fails the verb when the environment goes silent on the revoke, even after a call its work left behind is answered", async () => {
    const t = await start();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    // The straggler: answered only once the revoke has been asked for.
    t.env.methods.register(registry["updates.status"], async () => {
      await released;
      throw new ContractError({ code: "internal", message: "Too late.", data: {} });
    });
    t.env.methods.register(registry["environment.status"], () => {
      throw new ContractError({ code: "unavailable", message: "Not now.", data: { readiness: "draining" } });
    });
    // The revoke is never answered: its prepare lets the straggler go, and waits for ever.
    const silentRevoke = {
      prepare: () => {
        release();
        return new Promise<never>(() => undefined);
      },
    };
    t.env.methods.register(registry["access.sessions.revoke"], silentRevoke as never);
    const verb = withLocalSession({ dataDir: t.dataDir }, net, "a straggler", (call) => Promise.all([call("updates.status", {}), call("environment.status", {})]), {
      timeoutMs: 300,
    });
    // What the verb reports is its work's own failure, the refusal that ended it.
    await expect(verb).rejects.toThrow(LocalRefusal);
    await expect(verb).rejects.toThrow(/refused environment.status: Not now/);
  });

  it("fails the verb when the wire's connection never opens", async () => {
    const t = await start();
    const held: Socket[] = [];
    // Accepts the connection and never answers the WebSocket handshake.
    const blackHole = createServer((socket) => void held.push(socket));
    const port = await new Promise<number>((resolve) => blackHole.listen(0, "127.0.0.1", () => resolve((blackHole.address() as AddressInfo).port)));
    cleanups.push(() => {
      for (const socket of held) socket.destroy();
      blackHole.close();
    });
    const Native = globalThis.WebSocket;
    class BlackHoleWebSocket extends Native {
      constructor() {
        super(`ws://127.0.0.1:${port}/ws`);
      }
    }
    const verb = withLocalSession({ dataDir: t.dataDir }, { fetch: globalThis.fetch, WebSocket: BlackHoleWebSocket }, "a black hole", (call) => call("environment.status", {}), {
      timeoutMs: 300,
    });
    await expect(verb).rejects.toThrow(/did not answer within/);
  });
});
