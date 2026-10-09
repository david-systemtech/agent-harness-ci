import { randomUUID } from "node:crypto";
import {
  BYPASS_SENTENCE,
  MODES,
  SCOPES,
  registry,
  type EventEnvelope,
  type EventFrame,
  type Mode,
  type ParamsOf,
  type ResponseOf,
  type Scope,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { end, fakeAdapter, gate, say, type FakeAdapter, type FakeAdapterOptions, type Gate } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, get, patchOf, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { toWireEnvelope } from "../wire/envelope.js";

/**
 * Modes, ceilings and the policy resolver through the primary seam
 * (permissions spec, "Testing Decisions"): an in-process environment with
 * the scripted fake adapter, driven by real clients over real WebSockets.
 * What is asserted is what a client sees: `hello`, receipts, the session's
 * stream with `run.policy.resolved` and `session.mode.set`, the access log,
 * and what the fake provider was handed.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (adapter: FakeAdapterOptions | FakeAdapter = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: "descriptor" in adapter ? adapter : fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

type Command = "runs.start" | "runs.send" | "permissions.mode.set" | "permissions.settings.set" | "access.sessions.setCeiling" | "access.pairings.create";

/** Sends a command with a fresh command id; resolves with its response, checked against its schema. */
const send = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** Starts a run; throws unless it was accepted. */
const startRun = async (client: WireClient, sessionId: string, extra: Partial<ParamsOf<"runs.start">> = {}) => {
  const answer = await send(client, "runs.start", { sessionId, text: "Go", ...extra });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result;
};

/** A client of a client session paired with `ceiling` (every scope unless `scopes` says otherwise). */
const pairedClient = async (t: TestEnvironment, ceiling: Mode, scopes: readonly Scope[] = SCOPES) => {
  const credential = await t.pair({ ceiling, scopes });
  return t.client({ token: credential.token });
};

/** The session's events, in log order, as a client receives them. */
const sessionEvents = (t: TestEnvironment, sessionId: string): EventEnvelope[] => t.env.log.readStream({ kind: "session", id: sessionId }).map(toWireEnvelope);

/** The run's events on its session's stream. */
const runEvents = (t: TestEnvironment, sessionId: string, runId: string): EventEnvelope[] =>
  sessionEvents(t, sessionId).filter((event) => event.payload["runId"] === runId);

/** Resolves once the run has ended. */
const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(runEvents(t, sessionId, runId).map((event) => event.type)).toContain("run.ended"));

/** The run's one `run.policy.resolved` payload; fails unless there is exactly one. */
const policyOf = (t: TestEnvironment, sessionId: string, runId: string) => {
  const resolved = runEvents(t, sessionId, runId).filter((event) => event.type === "run.policy.resolved");
  expect(resolved, `run.policy.resolved of ${runId}`).toHaveLength(1);
  return resolved[0]?.payload;
};

/** The access log's events of `types`, oldest first. */
const accessEvents = async (admin: WireClient, ...types: string[]) =>
  (await admin.request("access.log.list", { limit: 1000 })).events.filter((event) => types.includes(event.type));

/** A script held open until its gate opens. */
const heldScript = (held: Gate) =>
  async function* () {
    yield say("Working");
    await held.opened;
    yield end();
  };

describe("the ceiling at pairing", () => {
  it("presets a pairing's ceiling from permissions.defaultCeiling, acceptEdits until it is set, a chosen ceiling winning", async () => {
    const t = await start();
    expect((await t.createPairing()).ceiling).toBe("acceptEdits");
    const admin = await t.client();
    await send(admin, "permissions.settings.set", { values: { "permissions.defaultCeiling": "plan" } });
    expect((await t.createPairing()).ceiling).toBe("plan");
    expect((await t.createPairing({ ceiling: "auto" })).ceiling).toBe("auto");
    const [created] = (await accessEvents(admin, "pairing.created")).slice(-2);
    expect(created?.payload).toMatchObject({ ceiling: "plan" });
  });

  it("refuses a pairing above the caller's own ceiling, forbidden reason ceiling, whether chosen or the default; at or below it is minted (#180)", async () => {
    const t = await start();
    const phone = await pairedClient(t, "acceptEdits");
    const head = t.env.log.head();
    const above = await send(phone, "access.pairings.create", { ceiling: "bypassPermissions" });
    expect(above.receipt).toMatchObject({
      status: "rejected",
      reason: "forbidden",
      error: { code: "forbidden", data: { scope: "admin", reason: "ceiling", ceiling: "acceptEdits" } },
    });
    expect(t.env.log.head()).toBe(head);
    expect((await send(phone, "access.pairings.create", { ceiling: "acceptEdits" })).result?.ceiling).toBe("acceptEdits");
    expect((await send(phone, "access.pairings.create", { ceiling: "plan" })).result?.ceiling).toBe("plan");
    // The default stands in for a ceiling not chosen, and is held to the same rule.
    const admin = await t.client();
    await send(admin, "permissions.settings.set", { values: { "permissions.defaultCeiling": "auto" } });
    expect((await send(phone, "access.pairings.create", {})).receipt).toMatchObject({ status: "rejected", reason: "forbidden", error: { data: { reason: "ceiling" } } });
    // The bootstrap grant's local client session holds the top ceiling, so it mints any.
    expect((await send(admin, "access.pairings.create", { ceiling: "bypassPermissions" })).result?.ceiling).toBe("bypassPermissions");
  });

  it("refuses a ceiling that is not a mode: default and dontAsk never appear on the wire", async () => {
    const t = await start();
    const admin = await t.client();
    for (const ceiling of ["default", "dontAsk"]) {
      expect(await refusal(admin.request("access.pairings.create", { commandId: randomUUID(), ceiling } as never))).toMatchObject({ code: "invalid_params" });
    }
  });

  it("reports the ceiling in hello: the bootstrap grant's top ceiling, a paired client's own", async () => {
    const t = await start();
    const local = await t.client();
    expect(local.hello.ceiling).toBe("bypassPermissions");
    const paired = await t.client({ token: (await t.pair()).token });
    expect(paired.hello.ceiling).toBe("acceptEdits");
    const planned = await pairedClient(t, "plan");
    expect(planned.hello.ceiling).toBe("plan");
  });
});

describe("the clamp on every run", () => {
  it("resolves a requested mode above the ceiling to the ceiling, clamped, never an error, before the provider sees it", async () => {
    const t = await start();
    const client = await pairedClient(t, "acceptEdits");
    const { id } = await create(client);
    const answer = await send(client, "runs.start", { sessionId: id, text: "Go", mode: "bypassPermissions" });
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    const { runId } = answer.result as { runId: string };
    await untilEnded(t, id, runId);
    expect(policyOf(t, id, runId)).toEqual({
      runId,
      actorKind: "client",
      actorName: null,
      attended: true,
      mode: { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", clamped: true, clampReason: "ceiling" },
      // The helper's probe finds no bubblewrap, so the preset's workspace is lowered to off, saying why (containment.test.ts has the rest).
      containment: { requested: null, effective: "off", mechanism: null, reason: expect.stringMatching(/preset default is workspace/) as unknown as string },
      unattendedDefaultApplied: false,
    });
    expect(runEvents(t, id, runId).find((event) => event.type === "run.started")?.payload["mode"]).toEqual({
      requested: "bypassPermissions",
      effective: "acceptEdits",
      clamped: true,
    });
    expect(t.adapter.lastRun().input.mode).toBe("acceptEdits");
  });

  it("clamps a mode the account lists as unavailable to the next lower available one, reason unavailable", async () => {
    const t = await start({ modes: MODES.map((mode) => (mode === "auto" ? { mode, available: false, reason: "No classifier on this plan." } : { mode, available: true, reason: null })) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id, { mode: "auto" });
    await untilEnded(t, id, runId);
    expect(policyOf(t, id, runId)).toMatchObject({
      mode: { requested: "auto", effective: "acceptEdits", ceiling: "bypassPermissions", clamped: true, clampReason: "unavailable" },
    });
    expect(t.adapter.lastRun().input.mode).toBe("acceptEdits");
  });

  it("starts a run that names no mode, and whose session names none, in acceptEdits within the ceiling, not reported clamped", async () => {
    const t = await start();
    const client = await pairedClient(t, "plan");
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(policyOf(t, id, runId)).toMatchObject({ mode: { requested: null, effective: "plan", ceiling: "plan", clamped: false, clampReason: null } });
  });

  it("stores a session's mode as sessions.create's caller's ceiling allows, so a later run from a higher ceiling does not raise it", async () => {
    const t = await start();
    const low = await pairedClient(t, "plan");
    const { id } = await create(low, { mode: "bypassPermissions" });
    expect(sessionEvents(t, id).find((event) => event.type === "session.created")?.payload["mode"]).toBe("plan");
    expect((await get(low, id)).mode).toBe("plan");
    const desktop = await t.client();
    const { runId } = await startRun(desktop, id);
    await untilEnded(t, id, runId);
    expect(policyOf(t, id, runId)).toMatchObject({ mode: { requested: "plan", effective: "plan", ceiling: "bypassPermissions", clamped: false } });
  });

  it("refuses default and dontAsk as a run's or a session's mode, invalid_params", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    for (const mode of ["default", "dontAsk"]) {
      expect(await refusal(client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Go", mode } as never))).toMatchObject({ code: "invalid_params" });
      expect(await refusal(client.request("sessions.create", { commandId: randomUUID(), id: randomUUID(), workspace: { kind: "directory", path: "/work" }, mode } as never))).toMatchObject({
        code: "invalid_params",
      });
    }
  });
});

describe("run.policy.resolved", () => {
  it("appears exactly once per run, right after run.started and before the provider's first event, on every client's subscription", async () => {
    const held = gate();
    const t = await start({ script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client);
    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: t.env.log.head() });
    await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
    const { runId } = await startRun(client, id, { mode: "plan" });
    const seen: EventEnvelope[] = [];
    while (seen.at(-1)?.type !== "assistant.text") {
      seen.push((await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription)).event);
    }
    held.open();
    await untilEnded(t, id, runId);
    // The first message generates the session's title in the start's transaction (#122).
    expect(seen.map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.sent", "session.title-generated", "run.instructions.composed", "assistant.text"]);
    expect(seen[1]).toMatchObject({ correlationId: runId, actor: { kind: "client_session", id: client.hello.clientSessionId } });
    policyOf(t, id, runId);
  });

  it("appears once for a run the environment starts from its queue, under the ceiling of the client that queued it", async () => {
    const held = gate();
    const t = await start({ capabilities: { providerQueue: false, steering: false } });
    t.adapter.nextScripts.push(heldScript(held));
    const { id } = await create(await t.client(), { mode: "bypassPermissions" });
    const client = await pairedClient(t, "acceptEdits");
    const { runId: first } = await startRun(client, id);
    const queued = await send(client, "runs.send", { sessionId: id, text: "And then" });
    expect(queued.result).toMatchObject({ delivery: "queued", heldBy: "environment" });
    held.open();
    await vi.waitFor(() => expect(sessionEvents(t, id).filter((event) => event.type === "run.ended")).toHaveLength(2));
    const second = sessionEvents(t, id).filter((event) => event.type === "run.started").map((event) => event.payload["runId"] as string)[1] as string;
    policyOf(t, id, first);
    expect(policyOf(t, id, second)).toMatchObject({ mode: { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", clamped: true } });
  });

  it.each([
    ["cannot change a live run's mode", false],
    ["changes the live run's mode", true],
  ])("starts a run from the queue in the session's mode as it is then, when the adapter %s", async (_what, modeChange) => {
    const held = gate();
    const t = await start({ capabilities: { providerQueue: false, steering: false, modeChange } });
    t.adapter.nextScripts.push(heldScript(held));
    const client = await t.client();
    const { id } = await create(client);
    const { runId: first } = await startRun(client, id, { mode: "bypassPermissions" });
    await vi.waitFor(() => expect(runEvents(t, id, first).map((event) => event.type)).toContain("assistant.text"));
    await send(client, "runs.send", { sessionId: id, text: "And then" });
    const set = await send(client, "permissions.mode.set", { sessionId: id, mode: "plan" });
    expect(set.result?.live).toEqual(modeChange ? { runId: first, mode: "plan" } : null);
    held.open();
    await vi.waitFor(() => expect(sessionEvents(t, id).filter((event) => event.type === "run.ended")).toHaveLength(2));
    const second = sessionEvents(t, id).filter((event) => event.type === "run.started").map((event) => event.payload["runId"] as string)[1] as string;
    expect(policyOf(t, id, second)).toMatchObject({ mode: { requested: "plan", effective: "plan", clamped: false } });
    expect(t.adapter.lastRun().input.mode).toBe("plan");
  });

  it("does not start a run from the queue for a client session revoked since; the message stays queued for the next run", async () => {
    const held = gate();
    const t = await start({ capabilities: { providerQueue: false, steering: false } });
    t.adapter.nextScripts.push(heldScript(held));
    const credential = await t.pair({ ceiling: "bypassPermissions" });
    const client = await t.client({ token: credential.token });
    const { id } = await create(client);
    const { runId: first } = await startRun(client, id);
    const queued = await send(client, "runs.send", { sessionId: id, text: "And then" });
    const admin = await t.client();
    await admin.apply("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: credential.clientSessionId });
    held.open();
    await untilEnded(t, id, first);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessionEvents(t, id).filter((event) => event.type === "run.started")).toHaveLength(1);
    const { runId: next } = await startRun(admin, id);
    await untilEnded(t, id, next);
    expect(runEvents(t, id, next).find((event) => event.type === "run.started")?.payload["queuedMessageIds"]).toEqual([queued.result?.messageId]);
  });

  it("appears once for a turn the provider opened on its own, with the policy of the run it followed", async () => {
    const held = gate();
    const t = await start({ capabilities: { providerQueue: true, steering: false } });
    t.adapter.nextScripts.push(heldScript(held));
    const client = await t.client();
    const { id } = await create(client, { mode: "plan" });
    const { runId: first } = await startRun(client, id);
    // Held by the provider, which opens a turn for it: the send waits for the adapter to have the run.
    await t.adapter.reached(1);
    await send(client, "runs.send", { sessionId: id, text: "Also this" });
    held.open();
    await vi.waitFor(() => expect(sessionEvents(t, id).filter((event) => event.type === "run.ended")).toHaveLength(2));
    const started = sessionEvents(t, id).filter((event) => event.type === "run.started");
    expect(started[1]?.payload["origin"]).toBe("provider");
    const adopted = started[1]?.payload["runId"] as string;
    const types = runEvents(t, id, adopted).map((event) => event.type);
    expect(types.slice(0, 2)).toEqual(["run.started", "run.policy.resolved"]);
    expect(policyOf(t, id, adopted)).toEqual({ ...policyOf(t, id, first), runId: adopted });
  });

  it("re-resolves a turn the provider opened under the client's ceiling as it is then, and changes the turn's mode to it", async () => {
    const held = gate();
    const t = await start({ capabilities: { providerQueue: true, steering: false } });
    t.adapter.nextScripts.push(heldScript(held));
    const target = await t.pair({ ceiling: "bypassPermissions" });
    const client = await t.client({ token: target.token });
    const { id } = await create(client);
    const { runId: first } = await startRun(client, id, { mode: "bypassPermissions" });
    await vi.waitFor(() => expect(runEvents(t, id, first).map((event) => event.type)).toContain("assistant.text"));
    await send(client, "runs.send", { sessionId: id, text: "Also this" });
    await send(await t.client(), "access.sessions.setCeiling", { clientSessionId: target.clientSessionId, ceiling: "plan" });
    held.open();
    await vi.waitFor(() => expect(sessionEvents(t, id).filter((event) => event.type === "run.ended")).toHaveLength(2));
    const adopted = sessionEvents(t, id).filter((event) => event.type === "run.started")[1];
    expect(adopted?.payload["origin"]).toBe("provider");
    const runId = adopted?.payload["runId"] as string;
    expect(adopted?.payload["mode"]).toEqual({ requested: null, effective: "plan", clamped: false });
    expect(policyOf(t, id, runId)).toMatchObject({ mode: { requested: null, effective: "plan", ceiling: "plan", clamped: false } });
    expect(t.adapter.runs[1]).toMatchObject({ adopted: true, modeChanges: ["plan"] });
  });

  it("resolves a turn the provider opened under the lowest ceiling of whoever sent what it reads", async () => {
    const held = gate();
    const t = await start({ capabilities: { providerQueue: true, steering: false } });
    t.adapter.nextScripts.push(heldScript(held));
    const desktop = await t.client();
    const { id } = await create(desktop, { mode: "bypassPermissions" });
    const { runId: first } = await startRun(desktop, id);
    await vi.waitFor(() => expect(runEvents(t, id, first).map((event) => event.type)).toContain("assistant.text"));
    const planner = await pairedClient(t, "plan");
    await send(planner, "runs.send", { sessionId: id, text: "From a planner" });
    held.open();
    await vi.waitFor(() => expect(sessionEvents(t, id).filter((event) => event.type === "run.ended")).toHaveLength(2));
    const adopted = sessionEvents(t, id).filter((event) => event.type === "run.started")[1];
    expect(adopted?.payload["origin"]).toBe("provider");
    expect(policyOf(t, id, adopted?.payload["runId"] as string)).toMatchObject({
      mode: { requested: "bypassPermissions", effective: "plan", ceiling: "plan", clamped: true, clampReason: "ceiling" },
    });
    expect(t.adapter.runs[1]).toMatchObject({ adopted: true, modeChanges: ["plan"] });
  });

  describe("when changing the turn's mode", () => {
    /** The fake adapter, its provider-opened turns' `setMode` replaced by `setMode`. */
    const withTurnSetMode = (setMode: (mode: Mode) => void | Promise<void>): FakeAdapter => {
      const adapter = fakeAdapter({ capabilities: { providerQueue: true, steering: false } });
      const createRun = adapter.createRun;
      return { ...adapter, createRun: (input, context) => createRun(input, { ...context, adopt: (turn) => context.adopt({ ...turn, setMode }) }) };
    };

    /** A run the provider follows with a turn of its own, after its client's ceiling was lowered to plan while it ran. */
    const lowered = async (adapter: FakeAdapter) => {
      const held = gate();
      const t = await start(adapter);
      adapter.nextScripts.push(heldScript(held));
      const target = await t.pair({ ceiling: "bypassPermissions" });
      const client = await t.client({ token: target.token });
      const { id } = await create(client);
      const { runId: first } = await startRun(client, id, { mode: "bypassPermissions" });
      await vi.waitFor(() => expect(runEvents(t, id, first).map((event) => event.type)).toContain("assistant.text"));
      const sent = await send(client, "runs.send", { sessionId: id, text: "Also this" });
      await send(await t.client(), "access.sessions.setCeiling", { clientSessionId: target.clientSessionId, ceiling: "plan" });
      held.open();
      return { t, id, messageId: sent.result?.messageId };
    };

    it.each([
      ["throws", () => { throw new Error("The provider refused the mode."); }],
      ["rejects", () => Promise.reject(new Error("The provider refused the mode."))],
    ])("lets the turn go through the refusal path when the change %s: nothing records a mode it does not run in", async (_how, setMode) => {
      const adapter = withTurnSetMode(setMode);
      const { t, id, messageId } = await lowered(adapter);
      await vi.waitFor(() => expect(sessionEvents(t, id).filter((event) => event.type === "run.ended")).toHaveLength(2));
      expect(adapter.runs[1]).toMatchObject({ adopted: true, disposed: true });
      const started = sessionEvents(t, id).filter((event) => event.type === "run.started");
      expect(started.map((event) => event.payload["origin"])).toEqual(["client", "client"]);
      expect(started[1]?.payload["queuedMessageIds"]).toEqual([messageId]);
      expect(policyOf(t, id, started[1]?.payload["runId"] as string)).toMatchObject({ mode: { effective: "plan", ceiling: "plan" } });
      expect(adapter.lastRun().input.mode).toBe("plan");
    });

    it("adopts the turn once a change that answers later has taken", async () => {
      let resolve!: () => void;
      const changed: Mode[] = [];
      const adapter = withTurnSetMode((mode) => new Promise<void>((done) => (resolve = () => (changed.push(mode), done()))));
      const { t, id } = await lowered(adapter);
      await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
      await new Promise((settle) => setTimeout(settle, 20));
      expect(sessionEvents(t, id).filter((event) => event.type === "run.started")).toHaveLength(1);
      resolve();
      await vi.waitFor(() => expect(sessionEvents(t, id).filter((event) => event.type === "run.ended")).toHaveLength(2));
      const adopted = sessionEvents(t, id).filter((event) => event.type === "run.started")[1];
      expect(adopted?.payload["origin"]).toBe("provider");
      expect(policyOf(t, id, adopted?.payload["runId"] as string)).toMatchObject({ mode: { effective: "plan", ceiling: "plan" } });
      expect(changed).toEqual(["plan"]);
    });

    it("lets the turn go, with nothing left unhandled, when its session cannot be read once a change that answered later has taken", async () => {
      let resolve!: () => void;
      const adapter = withTurnSetMode(() => new Promise<void>((done) => (resolve = done)));
      const { t, id, messageId } = await lowered(adapter);
      await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
      const unhandled: unknown[] = [];
      const guard = (reason: unknown) => void unhandled.push(reason);
      process.on("unhandledRejection", guard);
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const read = t.env.log.read.bind(t.env.log);
      let armed = true;
      // The session read the settlement makes fails once; every other read is answered.
      vi.spyOn(t.env.log, "read").mockImplementation(((sql: string, ...params: unknown[]) => {
        if (armed && sql.includes("FROM sessions WHERE id = ?")) {
          armed = false;
          throw new Error("The database is busy.");
        }
        return read(sql, ...(params as never[]));
      }) as never);
      try {
        resolve();
        await vi.waitFor(() => expect(adapter.runs[1]).toMatchObject({ adopted: true, disposed: true }));
        await new Promise((settle) => setTimeout(settle, 20));
        expect(unhandled).toEqual([]);
        expect(armed).toBe(false);
        expect(sessionEvents(t, id).filter((event) => event.type === "run.started")).toHaveLength(1);
        expect(sessionEvents(t, id).at(-1)).toMatchObject({ type: "message.requeued", payload: { messageId } });
        expect(errors.mock.calls.some(([message]) => String(message).startsWith("Reading session"))).toBe(true);
      } finally {
        process.off("unhandledRejection", guard);
        vi.restoreAllMocks();
      }
    });
  });

  it("lets a provider-opened turn go and reads its messages from the queue when the adapter cannot bring it to the mode resolved", async () => {
    const held = gate();
    const t = await start({ capabilities: { providerQueue: true, steering: false, modeChange: false } });
    t.adapter.nextScripts.push(heldScript(held));
    const client = await t.client();
    const { id } = await create(client);
    const { runId: first } = await startRun(client, id, { mode: "bypassPermissions" });
    await vi.waitFor(() => expect(runEvents(t, id, first).map((event) => event.type)).toContain("assistant.text"));
    const sent = await send(client, "runs.send", { sessionId: id, text: "Also this" });
    await send(client, "permissions.mode.set", { sessionId: id, mode: "plan" });
    held.open();
    await vi.waitFor(() => expect(sessionEvents(t, id).filter((event) => event.type === "run.ended")).toHaveLength(2));
    expect(t.adapter.runs[1]).toMatchObject({ adopted: true, disposed: true });
    const started = sessionEvents(t, id).filter((event) => event.type === "run.started");
    expect(started).toHaveLength(2);
    expect(started[1]?.payload).toMatchObject({ origin: "client", queuedMessageIds: [sent.result?.messageId] });
    expect(policyOf(t, id, started[1]?.payload["runId"] as string)).toMatchObject({ mode: { requested: "plan", effective: "plan" } });
    expect(t.adapter.lastRun().input.mode).toBe("plan");
  });
});

describe("permissions.mode.set", () => {
  it("returns the effective mode and clamp, appends session.mode.set, and applies at the next run when none is live", async () => {
    const t = await start();
    const client = await pairedClient(t, "auto");
    const { id } = await create(client);
    const answer = await send(client, "permissions.mode.set", { sessionId: id, mode: "bypassPermissions" });
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(answer.result).toEqual({
      sessionId: id,
      mode: { requested: "bypassPermissions", effective: "auto", ceiling: "auto", clamped: true, clampReason: "ceiling" },
      live: null,
    });
    const set = sessionEvents(t, id).filter((event) => event.type === "session.mode.set");
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({
      actor: { kind: "client_session", id: client.hello.clientSessionId },
      payload: { mode: { requested: "bypassPermissions", effective: "auto", ceiling: "auto", clamped: true, clampReason: "ceiling" }, live: null },
    });
    // The summary carries the effective mode (#179): the event is list-flagged and patches it, and updatedAt does not move.
    expect(patchOf(set[0] as EventEnvelope)).toEqual({ op: "set", sessionId: id, fields: { mode: "auto" } });
    const summary = await get(client, id);
    expect(summary.mode).toBe("auto");
    expect(summary.updatedAt).toBe(summary.createdAt);

    const { runId } = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(policyOf(t, id, runId)).toMatchObject({ mode: { requested: "auto", effective: "auto", clamped: false } });
    expect(t.adapter.lastRun().input.mode).toBe("auto");
  });

  it("keeps the mode a low ceiling allowed: a later run from a higher ceiling does not raise it", async () => {
    const t = await start();
    const low = await pairedClient(t, "acceptEdits");
    const { id } = await create(low);
    await send(low, "permissions.mode.set", { sessionId: id, mode: "bypassPermissions" });
    const high = await t.client();
    const { runId } = await startRun(high, id);
    await untilEnded(t, id, runId);
    expect(policyOf(t, id, runId)).toMatchObject({ mode: { requested: "acceptEdits", effective: "acceptEdits", ceiling: "bypassPermissions", clamped: false } });
  });

  it("applies live through the adapter's mode seam while a run is live, clamped to that run's ceiling too", async () => {
    const held = gate();
    const t = await start({ script: heldScript(held) });
    const low = await pairedClient(t, "acceptEdits");
    const { id } = await create(low);
    const { runId } = await startRun(low, id, { mode: "plan" });
    await vi.waitFor(() => expect(runEvents(t, id, runId).map((event) => event.type)).toContain("assistant.text"));

    const admin = await t.client();
    const answer = await send(admin, "permissions.mode.set", { sessionId: id, mode: "bypassPermissions" });
    expect(answer.result).toMatchObject({
      mode: { requested: "bypassPermissions", effective: "bypassPermissions", ceiling: "bypassPermissions", clamped: false },
      live: { runId, mode: "acceptEdits" },
    });
    await vi.waitFor(() => expect(t.adapter.lastRun().modeChanges).toEqual(["acceptEdits"]));
    expect(sessionEvents(t, id).find((event) => event.type === "session.mode.set")?.payload["live"]).toEqual({ runId, mode: "acceptEdits" });
    held.open();
    await untilEnded(t, id, runId);
    policyOf(t, id, runId);
  });

  it("appends nothing for the mode the session has already, but still applies it to a live run", async () => {
    const held = gate();
    const t = await start({ script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client, { mode: "plan" });
    const { runId } = await startRun(client, id, { mode: "bypassPermissions" });
    await vi.waitFor(() => expect(runEvents(t, id, runId).map((event) => event.type)).toContain("assistant.text"));
    const head = t.env.log.head();
    const answer = await send(client, "permissions.mode.set", { sessionId: id, mode: "plan" });
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(answer.result).toMatchObject({ mode: { requested: "plan", effective: "plan" }, live: { runId, mode: "plan" } });
    expect(t.env.log.head()).toBe(head);
    await vi.waitFor(() => expect(t.adapter.lastRun().modeChanges).toEqual(["plan"]));
    held.open();
    await untilEnded(t, id, runId);
  });

  it("applies at the next run when the live run's adapter cannot change its mode", async () => {
    const held = gate();
    const t = await start({ script: heldScript(held), capabilities: { modeChange: false } });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id, { mode: "plan" });
    await vi.waitFor(() => expect(runEvents(t, id, runId).map((event) => event.type)).toContain("assistant.text"));
    const answer = await send(client, "permissions.mode.set", { sessionId: id, mode: "auto" });
    expect(answer.result).toMatchObject({ mode: { effective: "auto" }, live: null });
    held.open();
    await untilEnded(t, id, runId);
    expect(t.adapter.runs[0]?.modeChanges).toEqual([]);
    const { runId: next } = await startRun(client, id);
    await untilEnded(t, id, next);
    expect(t.adapter.lastRun().input.mode).toBe("auto");
  });

  it("refuses an unknown session not_found, a mode that is not one of the four invalid_params, and a client without runs:drive forbidden", async () => {
    const t = await start();
    const client = await t.client();
    const unknown = randomUUID();
    expect((await send(client, "permissions.mode.set", { sessionId: unknown, mode: "plan" })).receipt).toMatchObject({ status: "rejected", reason: "not_found" });
    const { id } = await create(client);
    expect(await refusal(client.request("permissions.mode.set", { commandId: randomUUID(), sessionId: id, mode: "dontAsk" } as never))).toMatchObject({ code: "invalid_params" });
    const reader = await pairedClient(t, "bypassPermissions", ["read", "sessions:write"]);
    expect(await refusal(reader.request("permissions.mode.set", { commandId: randomUUID(), sessionId: id, mode: "plan" }))).toMatchObject({
      code: "forbidden",
      data: { scope: "runs:drive" },
    });
  });
});

describe("access.sessions.setCeiling", () => {
  it("refuses the caller's own session, conflict own_session, whatever its scopes, and changes nothing", async () => {
    const t = await start();
    const admin = await t.client();
    const head = t.env.log.head();
    const answer = await send(admin, "access.sessions.setCeiling", { clientSessionId: admin.hello.clientSessionId, ceiling: "plan" });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { code: "conflict", data: { reason: "own_session" } } });
    expect(t.env.log.head()).toBe(head);
    const own = (await admin.request("access.sessions.list", {})).sessions.find((s) => s.id === admin.hello.clientSessionId);
    expect(own?.ceiling).toBe("bypassPermissions");
  });

  it("changes another client session's ceiling from an admin session, recorded as ceiling.changed in the access log", async () => {
    const t = await start();
    const target = await t.pair({ ceiling: "plan" });
    const admin = await t.client();
    const answer = await send(admin, "access.sessions.setCeiling", { clientSessionId: target.clientSessionId, ceiling: "bypassPermissions" });
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(answer.result).toEqual({ clientSessionId: target.clientSessionId, from: "plan", to: "bypassPermissions" });
    const [changed] = await accessEvents(admin, "ceiling.changed");
    expect(changed).toMatchObject({
      streamKind: "access",
      actor: { kind: "client_session", id: admin.hello.clientSessionId },
      payload: { clientSessionId: target.clientSessionId, from: "plan", to: "bypassPermissions" },
    });
    const listed = (await admin.request("access.sessions.list", {})).sessions.find((s) => s.id === target.clientSessionId);
    expect(listed?.ceiling).toBe("bypassPermissions");
    expect((await t.client({ token: target.token })).hello.ceiling).toBe("bypassPermissions");
    // The same ceiling again changes nothing, and appends nothing.
    const head = t.env.log.head();
    expect((await send(admin, "access.sessions.setCeiling", { clientSessionId: target.clientSessionId, ceiling: "bypassPermissions" })).receipt).toMatchObject({
      status: "accepted",
      changed: false,
    });
    expect(t.env.log.head()).toBe(head);
    expect(await accessEvents(admin, "ceiling.changed")).toHaveLength(1);
  });

  it("refuses raising another session above the caller's own ceiling, forbidden reason ceiling; lowering is always allowed (#180)", async () => {
    const t = await start();
    const phone = await pairedClient(t, "acceptEdits");
    const low = await t.pair({ ceiling: "plan" });
    const high = await t.pair({ ceiling: "bypassPermissions" });
    const head = t.env.log.head();
    expect((await send(phone, "access.sessions.setCeiling", { clientSessionId: low.clientSessionId, ceiling: "auto" })).receipt).toMatchObject({
      status: "rejected",
      reason: "forbidden",
      error: { code: "forbidden", data: { scope: "admin", reason: "ceiling", ceiling: "acceptEdits" } },
    });
    expect(t.env.log.head()).toBe(head);
    // Up to the caller's own ceiling is allowed.
    expect((await send(phone, "access.sessions.setCeiling", { clientSessionId: low.clientSessionId, ceiling: "acceptEdits" })).result).toEqual({
      clientSessionId: low.clientSessionId,
      from: "plan",
      to: "acceptEdits",
    });
    // Lowering is allowed even when the new ceiling is still above the caller's.
    expect((await send(phone, "access.sessions.setCeiling", { clientSessionId: high.clientSessionId, ceiling: "auto" })).result).toEqual({
      clientSessionId: high.clientSessionId,
      from: "bypassPermissions",
      to: "auto",
    });
  });

  it("keeps the change across a restart", async () => {
    const dataDir = tempDir();
    const first = await startTestEnvironment({ dataDir: `${dataDir}/data` });
    const target = await first.pair({ ceiling: "plan" });
    const admin = await first.client();
    await send(admin, "access.sessions.setCeiling", { clientSessionId: target.clientSessionId, ceiling: "auto" });
    await first.close();
    const second = await startTestEnvironment({ dataDir: `${dataDir}/data` });
    onCleanup(() => second.close());
    expect((await second.client({ token: target.token })).hello.ceiling).toBe("auto");
  });

  it("refuses a revoked client session, conflict revoked", async () => {
    const t = await start();
    const target = await t.pair({ ceiling: "plan" });
    const admin = await t.client();
    await admin.apply("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: target.clientSessionId });
    const head = t.env.log.head();
    expect((await send(admin, "access.sessions.setCeiling", { clientSessionId: target.clientSessionId, ceiling: "auto" })).receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "revoked" } },
    });
    expect(t.env.log.head()).toBe(head);
  });

  it("refuses an unknown client session not_found, and a caller without admin forbidden", async () => {
    const t = await start();
    const admin = await t.client();
    expect((await send(admin, "access.sessions.setCeiling", { clientSessionId: "cs-unknown", ceiling: "plan" })).receipt).toMatchObject({
      status: "rejected",
      reason: "not_found",
    });
    const driver = await pairedClient(t, "bypassPermissions", ["read", "runs:drive"]);
    expect(await refusal(driver.request("access.sessions.setCeiling", { commandId: randomUUID(), clientSessionId: admin.hello.clientSessionId, ceiling: "plan" }))).toMatchObject({
      code: "forbidden",
      data: { scope: "admin" },
    });
  });

  it("applies to the session's next run, even on a socket opened before it; a running run keeps its resolved policy", async () => {
    const held = gate();
    const t = await start();
    t.adapter.nextScripts.push(heldScript(held));
    const target = await t.pair({ ceiling: "bypassPermissions" });
    const driver = await t.client({ token: target.token });
    const { id } = await create(driver);
    const { runId } = await startRun(driver, id, { mode: "bypassPermissions" });
    await vi.waitFor(() => expect(runEvents(t, id, runId).map((event) => event.type)).toContain("assistant.text"));

    const admin = await t.client();
    await send(admin, "access.sessions.setCeiling", { clientSessionId: target.clientSessionId, ceiling: "plan" });
    held.open();
    await untilEnded(t, id, runId);
    expect(policyOf(t, id, runId)).toMatchObject({ mode: { effective: "bypassPermissions", ceiling: "bypassPermissions", clamped: false } });
    expect(t.adapter.runs[0]?.modeChanges).toEqual([]);

    const { runId: next } = await startRun(driver, id, { mode: "bypassPermissions" });
    await untilEnded(t, id, next);
    expect(policyOf(t, id, next)).toMatchObject({ mode: { requested: "bypassPermissions", effective: "plan", ceiling: "plan", clamped: true, clampReason: "ceiling" } });
    expect(t.adapter.lastRun().input.mode).toBe("plan");
  });
});

describe("permissions.settings.get", () => {
  it("returns the default ceiling, the unattended mode and its acknowledgement, the TTL, containment, isRoot false and the denylist counts", async () => {
    const t = await start();
    const reader = await pairedClient(t, "plan", ["read"]);
    expect(await reader.request("permissions.settings.get", {})).toEqual({
      values: {
        "permissions.defaultCeiling": "acceptEdits",
        "permissions.unattended.mode": "acceptEdits",
        "permissions.unattended.bypassAcknowledgedAt": null,
        "permissions.parkedPrompt.ttl": { amount: 24, unit: "hours" },
        "permissions.containment.default": "off",
      },
      // The helper's probe finds no bubblewrap: only off can be enforced (containment.test.ts has the rest).
      containment: {
        levels: [
          { level: "off", available: true, reason: null, cause: null },
          { level: "workspace", available: false, reason: expect.stringContaining("bubblewrap is not installed") as unknown as string, cause: "binary_missing" },
          { level: "workspace-no-network", available: false, reason: expect.stringContaining("bubblewrap is not installed") as unknown as string, cause: "binary_missing" },
        ],
        mechanism: null,
        container: { declared: false, detected: false },
        platform: "linux",
      },
      isRoot: false,
      // The presets seeded on first start (#132).
      denylist: { browserDomains: 29, paths: 15, commandPatterns: 15, hosts: 0 },
    });
  });
});

describe("permissions.settings.set", () => {
  it("takes any subset, answers every value, and records the change in the access log", async () => {
    const t = await start();
    const admin = await t.client();
    const answer = await send(admin, "permissions.settings.set", { values: { "permissions.parkedPrompt.ttl": "never" } });
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(answer.result?.values).toMatchObject({ "permissions.parkedPrompt.ttl": "never", "permissions.defaultCeiling": "acceptEdits" });
    await send(admin, "permissions.settings.set", { values: { "permissions.parkedPrompt.ttl": { amount: 30, unit: "minutes" }, "permissions.defaultCeiling": "auto" } });
    expect((await admin.request("permissions.settings.get", {})).values).toMatchObject({
      "permissions.parkedPrompt.ttl": { amount: 30, unit: "minutes" },
      "permissions.defaultCeiling": "auto",
    });
    const changes = await accessEvents(admin, "settings.changed");
    expect(changes.map((event) => event.payload)).toEqual([
      { area: "permissions", keys: ["permissions.parkedPrompt.ttl"], values: { "permissions.parkedPrompt.ttl": "never" } },
      {
        area: "permissions",
        keys: ["permissions.defaultCeiling", "permissions.parkedPrompt.ttl"],
        values: { "permissions.defaultCeiling": "auto", "permissions.parkedPrompt.ttl": { amount: 30, unit: "minutes" } },
      },
    ]);
    expect(changes[0]?.actor).toEqual({ kind: "client_session", id: admin.hello.clientSessionId });
    // A value the setting holds already changes nothing.
    expect((await send(admin, "permissions.settings.set", { values: { "permissions.defaultCeiling": "auto" } })).receipt).toMatchObject({ changed: false });
  });

  it("refuses the first unattended bypassPermissions without acknowledgeBypass, invalid_params, and changes nothing", async () => {
    const t = await start();
    const admin = await t.client();
    const head = t.env.log.head();
    const refused = await refusal(admin.request("permissions.settings.set", { commandId: randomUUID(), values: { "permissions.unattended.mode": "bypassPermissions" } }));
    expect(refused).toMatchObject({ code: "invalid_params", data: { issues: [{ path: ["acknowledgeBypass"] }] } });
    expect(JSON.stringify(refused.data)).toContain(BYPASS_SENTENCE);
    expect(t.env.log.head()).toBe(head);
    expect((await admin.request("permissions.settings.get", {})).values["permissions.unattended.mode"]).toBe("acceptEdits");
  });

  it("records the first acknowledgement's time and bypass.acknowledged, and asks for it only once", async () => {
    const t = await start();
    const admin = await t.client();
    const answer = await send(admin, "permissions.settings.set", { values: { "permissions.unattended.mode": "bypassPermissions" }, acknowledgeBypass: true });
    expect(answer.result?.values).toMatchObject({
      "permissions.unattended.mode": "bypassPermissions",
      "permissions.unattended.bypassAcknowledgedAt": MANUAL_CLOCK_START,
    });
    const events = await accessEvents(admin, "bypass.acknowledged", "settings.changed");
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      ["bypass.acknowledged", { setting: "permissions.unattended.mode", sentence: BYPASS_SENTENCE }],
      [
        "settings.changed",
        {
          area: "permissions",
          keys: ["permissions.unattended.mode", "permissions.unattended.bypassAcknowledgedAt"],
          values: { "permissions.unattended.mode": "bypassPermissions", "permissions.unattended.bypassAcknowledgedAt": MANUAL_CLOCK_START },
        },
      ],
    ]);

    t.clock.advance(60_000);
    await send(admin, "permissions.settings.set", { values: { "permissions.unattended.mode": "acceptEdits" } });
    await send(admin, "permissions.settings.set", { values: { "permissions.unattended.mode": "bypassPermissions" } });
    await send(admin, "permissions.settings.set", { values: { "permissions.unattended.mode": "bypassPermissions" }, acknowledgeBypass: true });
    expect(await accessEvents(admin, "bypass.acknowledged")).toHaveLength(1);
    expect((await admin.request("permissions.settings.get", {})).values["permissions.unattended.bypassAcknowledgedAt"]).toBe(MANUAL_CLOCK_START);
  });

  it("refuses an unattended mode other than acceptEdits or bypassPermissions, and the acknowledgement time as a value, invalid_params", async () => {
    const t = await start();
    const admin = await t.client();
    for (const values of [{ "permissions.unattended.mode": "plan" }, { "permissions.unattended.bypassAcknowledgedAt": MANUAL_CLOCK_START }, { "permissions.parkedPrompt.ttl": "forever" }]) {
      expect(await refusal(admin.request("permissions.settings.set", { commandId: randomUUID(), values } as never)), JSON.stringify(values)).toMatchObject({ code: "invalid_params" });
    }
  });

  it("refuses a containment default this environment cannot enforce, containment_unavailable", async () => {
    const t = await start();
    const admin = await t.client();
    const answer = await send(admin, "permissions.settings.set", { values: { "permissions.containment.default": "workspace" } });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "containment_unavailable", error: { data: { level: "workspace", reason: expect.stringContaining("bubblewrap is not installed") } } });
    expect((await send(admin, "permissions.settings.set", { values: { "permissions.containment.default": "off" } })).receipt).toMatchObject({ status: "accepted" });
  });

  it("leaves the permission keys to it: the generic settings.update refuses them, settings.get reads what it wrote on the settings stream", async () => {
    const t = await start();
    const admin = await t.client();
    const refused = await refusal(admin.request("settings.update", { commandId: randomUUID(), values: { "permissions.unattended.mode": "bypassPermissions" } } as never));
    expect(refused).toMatchObject({ code: "invalid_params" });
    expect((await admin.request("permissions.settings.get", {})).values["permissions.unattended.mode"]).toBe("acceptEdits");
    await send(admin, "permissions.settings.set", { values: { "permissions.parkedPrompt.ttl": "never" } });
    expect(await admin.request("settings.get", { keys: ["permissions.parkedPrompt.ttl"] })).toEqual({ values: { "permissions.parkedPrompt.ttl": "never" } });
    const [updated] = t.env.log.readStream({ kind: "settings", id: t.env.id }).map(toWireEnvelope);
    expect(updated).toMatchObject({ type: "settings.updated", actor: { kind: "client_session", id: admin.hello.clientSessionId }, payload: { values: { "permissions.parkedPrompt.ttl": "never" } } });
  });

  it("needs admin", async () => {
    const t = await start();
    const driver = await pairedClient(t, "bypassPermissions", ["read", "runs:drive", "sessions:write"]);
    expect(await refusal(driver.request("permissions.settings.set", { commandId: randomUUID(), values: {} }))).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
  });

  it("fails loudly on a settings.changed whose values are not valid for their keys: the append is refused, nothing changes", async () => {
    const t = await start();
    const append = () =>
      t.env.log.append(
        { kind: "access", id: t.env.id },
        [{ type: "settings.changed", payload: { area: "permissions", keys: ["permissions.parkedPrompt.ttl"], values: { "permissions.parkedPrompt.ttl": "forever" } } }],
        { actor: "system:test" },
      );
    expect(append).toThrow();
    expect((await (await t.client()).request("permissions.settings.get", {})).values["permissions.parkedPrompt.ttl"]).toEqual({ amount: 24, unit: "hours" });
  });

  it("keeps the settings across a restart", async () => {
    const dataDir = tempDir();
    const first = await startTestEnvironment({ dataDir: `${dataDir}/data` });
    const admin = await first.client();
    await send(admin, "permissions.settings.set", { values: { "permissions.defaultCeiling": "plan", "permissions.parkedPrompt.ttl": "never" } });
    await first.close();
    const second = await startTestEnvironment({ dataDir: `${dataDir}/data` });
    onCleanup(() => second.close());
    const values = (await (await second.client()).request("permissions.settings.get", {})).values;
    expect(values).toMatchObject({ "permissions.defaultCeiling": "plan", "permissions.parkedPrompt.ttl": "never" });
    expect((await second.createPairing()).ceiling).toBe("plan");
  });
});
