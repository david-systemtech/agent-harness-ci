import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { ContractError, registry } from "@agent-harness/contracts";
import { systemClock, type Clock, type Timer } from "@agent-harness/environment";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "../../environment/test/clock.js";
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

/**
 * A clock for the route's timeout whose timers wait for `start` and then run
 * in real time: a test starts it at the step it is about, so the timeout
 * bounds that step alone, however long a loaded runner takes over the grant
 * exchange and the steps before it (#457).
 */
const heldClock = (): { readonly clock: Pick<Clock, "setTimeout">; start(): void } => {
  let started = false;
  const held = new Set<() => void>();
  return {
    clock: {
      setTimeout(callback, ms) {
        if (started) return systemClock.setTimeout(callback, ms);
        let timer: Timer | undefined;
        const arm = () => void (timer = systemClock.setTimeout(callback, ms));
        held.add(arm);
        return {
          cancel: () => {
            held.delete(arm);
            timer?.cancel();
          },
        };
      },
    },
    start() {
      started = true;
      for (const arm of held) arm();
      held.clear();
    },
  };
};

/** A listener on loopback that accepts each connection, tells `accepted`, and never answers; its port. */
const blackHole = async (accepted: () => void): Promise<number> => {
  const held: Socket[] = [];
  const server = createServer((socket) => {
    held.push(socket);
    accepted();
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  cleanups.push(() => {
    for (const socket of held) socket.destroy();
    server.close();
  });
  return port;
};

/**
 * A WebSocket that holds the answer to a call of the verb's until the next
 * frame comes, then hands both on in one task: two frames read from the
 * socket at once, as a loaded machine reads them (#1765). `held` is told
 * when it holds an answer.
 */
const readTogether = (held: () => void): typeof WebSocket =>
  class extends globalThis.WebSocket {
    #answer: Event | undefined;

    override dispatchEvent(event: Event): boolean {
      if (event.type !== "message") return super.dispatchEvent(event);
      const frame = JSON.parse(String((event as MessageEvent).data)) as { readonly type: string; readonly id?: string };
      if (this.#answer === undefined && frame.type === "response" && frame.id?.startsWith("call-")) {
        this.#answer = event;
        held();
        return true;
      }
      const answer = this.#answer;
      this.#answer = undefined;
      if (answer !== undefined) super.dispatchEvent(answer);
      return super.dispatchEvent(event);
    }
  };

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

  it("hears the notices raised once it follows them and none the catch-up replays, and revokes its client session after", async () => {
    const t = await start();
    const admin = await t.client();
    cleanups.push(() => admin.close());
    await admin.apply("environment.rename", { commandId: randomUUID(), name: "Before" });

    const heard = await withLocalSession({ dataDir: t.dataDir }, net, "notices", async (call, notices) => {
      const names: string[] = [];
      let both!: () => void;
      const heardBoth = new Promise<void>((resolve) => (both = resolve));
      await notices((notice) => {
        if (notice.type !== "environment.renamed") return;
        names.push(notice.payload.name);
        if (names.length === 2) both();
      });
      await call("environment.rename", { commandId: randomUUID(), name: "After" });
      await call("environment.rename", { commandId: randomUUID(), name: "Again" });
      await heardBoth;
      return names;
    });

    expect(heard).toEqual(["After", "Again"]);
    expect(await liveLabels(t)).not.toContain("notices");
  });

  it("fails the verb when a call goes unanswered for the timeout, even after another call in flight with it was answered", async () => {
    const t = await start();
    const { clock, start: silence } = heldClock();
    // The silence is timed from the call that goes unanswered.
    t.env.methods.register(registry["updates.status"], () => {
      silence();
      return new Promise<never>(() => undefined);
    });
    const verb = withLocalSession({ dataDir: t.dataDir }, net, "one silent call", (call) => Promise.all([call("updates.status", {}), call("environment.status", {})]), {
      timeoutMs: 300,
      clock,
    });
    await expect(verb).rejects.toThrow(LocalFailure);
    await expect(verb).rejects.toThrow(/did not answer within/);
  });

  it("waits on a call given a longer wait than the route's for as long as that call's wait, and fails it past that", async () => {
    const t = await start();
    const clock = manualClock();
    // Keep setup's clock still, then answer past the route's deadline but within the call's.
    t.env.methods.register(registry["banks.list"], () => {
      clock.advance(1000);
      return { banks: [] };
    });
    const answered = await withLocalSession({ dataDir: t.dataDir }, net, "one slow call", (call) => call("banks.list", {}, { timeoutMs: 60_000 }), { timeoutMs: 300, clock });
    expect(answered).toEqual({ banks: [] });

    let asked!: () => void;
    const callReceived = new Promise<void>((resolve) => (asked = resolve));
    t.env.methods.register(registry["banks.list"], () => {
      asked();
      return new Promise<never>(() => undefined);
    });
    const verb = withLocalSession({ dataDir: t.dataDir }, net, "one silent slow call", (call) => call("banks.list", {}, { timeoutMs: 600 }), { timeoutMs: 300, clock });
    let settled = false;
    void verb.then(
      () => (settled = true),
      () => (settled = true),
    );
    await callReceived;
    clock.advance(599);
    await setImmediate();
    expect(settled).toBe(false);
    clock.advance(1);
    await setImmediate();
    expect(settled).toBe(true);
    await expect(verb).rejects.toThrow(/did not answer within 0\.6 seconds/);
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
    // The revoke is never answered: its prepare lets the straggler go, and waits for ever. The silence is timed from here.
    const { clock, start: silence } = heldClock();
    const silentRevoke = {
      prepare: () => {
        silence();
        release();
        return new Promise<never>(() => undefined);
      },
    };
    t.env.methods.register(registry["access.sessions.revoke"], silentRevoke as never);
    const verb = withLocalSession({ dataDir: t.dataDir }, net, "a straggler", (call) => Promise.all([call("updates.status", {}), call("environment.status", {})]), {
      timeoutMs: 300,
      clock,
    });
    // What the verb reports is its work's own failure, the refusal that ended it.
    await expect(verb).rejects.toThrow(LocalRefusal);
    await expect(verb).rejects.toThrow(/refused environment.status: Not now/);
  });

  it("settles with its work when the environment's going-away bye comes in the same read as the answer that made it go (#1765)", async () => {
    const t = await start();
    // The drain ends a turn of the environment's clock after it begins: turned once the answer is held, so the bye follows it.
    const together = { fetch: globalThis.fetch, WebSocket: readTogether(() => t.clock.advance(0)) };
    const drained = await withLocalSession({ dataDir: t.dataDir }, together, "a drain", (call) => call("environment.drain", { commandId: randomUUID() }));
    expect(drained.receipt.status).toBe("accepted");
    expect(await t.env.drained).toMatchObject({ trigger: "command" });
  });

  it("fails the verb with the going-away bye when a call is unanswered as it comes, or made after it", async () => {
    const t = await start();
    t.env.methods.register(registry["updates.status"], () => new Promise<never>(() => undefined));
    const together = { fetch: globalThis.fetch, WebSocket: readTogether(() => t.clock.advance(0)) };
    const leftBehind = withLocalSession({ dataDir: t.dataDir }, together, "a call left behind", (call) =>
      Promise.all([call("updates.status", {}), call("environment.drain", { commandId: randomUUID() })]),
    );
    await expect(leftBehind).rejects.toThrow("The environment closed the socket (draining): The environment is stopping.");

    const u = await start();
    const after = { fetch: globalThis.fetch, WebSocket: readTogether(() => u.clock.advance(0)) };
    const tooLate = withLocalSession({ dataDir: u.dataDir }, after, "a call after the bye", async (call) => {
      await call("environment.drain", { commandId: randomUUID() });
      return call("environment.status", {});
    });
    await expect(tooLate).rejects.toThrow(LocalFailure);
    await expect(tooLate).rejects.toThrow("The environment closed the socket (draining): The environment is stopping.");

    const v = await start();
    const followed = { fetch: globalThis.fetch, WebSocket: readTogether(() => v.clock.advance(0)) };
    const noticesTooLate = withLocalSession({ dataDir: v.dataDir }, followed, "notices after the bye", async (call, notices) => {
      await call("environment.drain", { commandId: randomUUID() });
      await notices(() => undefined);
    });
    await expect(noticesTooLate).rejects.toThrow("The environment closed the socket (draining): The environment is stopping.");
  });

  it("fails the verb with the going-away bye at once when it comes before the hello", async () => {
    const t = await start();
    const { clock, start: silence } = heldClock();
    // The environment stops before it greets: the bye takes the hello's place, and the silence is timed from it.
    class ByeFirst extends globalThis.WebSocket {
      override dispatchEvent(event: Event): boolean {
        if (event.type !== "message" || (JSON.parse(String((event as MessageEvent).data)) as { readonly type: string }).type !== "hello") return super.dispatchEvent(event);
        silence();
        return super.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "bye", reason: "draining", message: "The environment is stopping." }) }));
      }
    }
    const verb = withLocalSession({ dataDir: t.dataDir }, { fetch: globalThis.fetch, WebSocket: ByeFirst }, "a bye before the hello", (call) => call("environment.status", {}), {
      timeoutMs: 300,
      clock,
    });
    await expect(verb).rejects.toThrow("The environment closed the socket (draining): The environment is stopping.");
  });

  it("fails the verb when the wire's connection never opens", async () => {
    const t = await start();
    const { clock, start: silence } = heldClock();
    // The silence is timed from the accept.
    const port = await blackHole(silence);
    const Native = globalThis.WebSocket;
    class BlackHoleWebSocket extends Native {
      constructor() {
        super(`ws://127.0.0.1:${port}/ws`);
      }
    }
    const verb = withLocalSession({ dataDir: t.dataDir }, { fetch: globalThis.fetch, WebSocket: BlackHoleWebSocket }, "a black hole", (call) => call("environment.status", {}), {
      timeoutMs: 300,
      clock,
    });
    await expect(verb).rejects.toThrow(/did not answer within/);
  });

  it("fails the verb when the grant exchange goes unanswered", async () => {
    const t = await start();
    const { clock, start: silence } = heldClock();
    const port = await blackHole(silence);
    const verb = withLocalSession({ dataDir: t.dataDir, port }, net, "an exchange into a black hole", (call) => call("environment.status", {}), { timeoutMs: 300, clock });
    await expect(verb).rejects.toThrow(LocalFailure);
    await expect(verb).rejects.toThrow(`The environment at http://127.0.0.1:${port} did not answer: The operation was aborted due to timeout`);
  });
});
