import {
  Ceiling,
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  EnvironmentNotice,
  defineMethod,
  errorSchema,
  registry,
  subscriptionParams,
  type EventFrame,
  type Frame,
  type Scope,
  type SubscribedFrame,
} from "@agent-harness/contracts";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { useCleanups } from "../../test/cleanups.js";
import { NO_INTERFACES, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { REPLAY_BOUND, type EventInput, type JsonObject, type StreamRef } from "../event-log/event-log.js";
import { presetColour } from "../look/look.js";
import { NO_LAUNCHER } from "../serve/launcher.js";
import { HARNESS_VERSION, startEnvironment } from "../serve/start.js";
import type { Outlet, SubscriptionHooks } from "./subscriptions.js";

/**
 * Subscriptions through the primary seam: an environment in-process and a
 * real client. The session and transcript streams arrive with later tickets,
 * so most tests subscribe to a synthetic stream the helper serves on the
 * environment's method table (`probe.subscribe`), whose events the test
 * appends straight to the environment's log.
 */

const { onCleanup, tempDir } = useCleanups();

/** A synthetic stream: the events of the `probe` stream the params name. Its snapshot counts them. */
const probeSubscribe = defineMethod({
  name: "probe.subscribe",
  scope: "read",
  kind: "stream",
  params: subscriptionParams({ probe: z.string().min(1) }),
  result: z.object({ count: z.int().nonnegative() }),
  errors: [errorSchema("probe_missing", z.object({}))],
});

const probeStream = (probe: string): StreamRef => ({ kind: "probe", id: probe });

/** How many events the test has appended to each probe stream: the snapshot's read model. */
let appended = new Map<string, number>();

/** A test environment serving the probe stream, closed after the test. */
const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  appended = new Map();
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  t.serve(probeSubscribe, ({ probe }) => {
    if (probe === "missing") throw new ContractError({ code: "probe_missing", message: "No such probe.", data: {} });
    return {
      stream: probeStream(probe),
      snapshot: () => ({ count: appended.get(probe) ?? 0 }),
      // Every probe.ended event ends the subscription: the source's answer is the rule, replayed or live.
      // A session's source answers from its state now, so an undone deletion does not (deletion.test.ts).
      endOn: (event) => (event.type === "probe.ended" ? "deleted" : undefined),
    };
  });
  return t;
};

/** Appends `count` events to a probe stream, `payload` for each; returns their sequences. */
const append = (t: TestEnvironment, probe: string, count: number, payload: (i: number) => JsonObject = (i) => ({ i })): number[] => {
  const events: EventInput[] = Array.from({ length: count }, (_, i) => ({ type: "probe.poked", payload: payload(i) }));
  const { events: written } = t.env.log.append(probeStream(probe), events, { actor: "system:test" });
  appended.set(probe, (appended.get(probe) ?? 0) + count);
  return written.map((event) => event.sequence);
};

/** Appends one event of each type to a probe stream, in order; returns their sequences. */
const appendTypes = (t: TestEnvironment, probe: string, types: readonly string[]): number[] =>
  t.env.log.append(probeStream(probe), types.map((type) => ({ type, payload: {} })), { actor: "system:test" }).events.map((event) => event.sequence);

/** A client session issued straight from the environment, holding only `scopes`. */
const narrowToken = (t: TestEnvironment, scopes: readonly Scope[]): string =>
  t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token;

/** Every frame the client has received for `subscription`, in order. */
const framesOf = (client: WireClient, subscription: string): Frame[] =>
  client.received.filter((frame) => "subscription" in frame && frame.subscription === subscription);

/** The sequences of the `event` frames the client has received for `subscription`, in order. */
const sequencesOf = (client: WireClient, subscription: string): number[] =>
  framesOf(client, subscription).flatMap((frame) => (frame.type === "event" ? [frame.sequence] : []));

/** Resolves once `condition` holds of what the client has received. */
const until = (condition: () => boolean) =>
  vi.waitFor(() => expect(condition()).toBe(true), { timeout: WAIT_MS, interval: 2 });

/** Resolves once the client has received `frame` kinds for the subscription matching `predicate`. */
const frame = <T extends Frame["type"]>(client: WireClient, subscription: string, type: T) =>
  client.next((f): f is Extract<Frame, { type: T }> => f.type === type && "subscription" in f && f.subscription === subscription);

/** The frame types received for a subscription, events collapsed to their sequence. */
const shape = (client: WireClient, subscription: string): (string | number)[] =>
  framesOf(client, subscription).map((f) => (f.type === "event" ? f.sequence : f.type));

/** A sure round trip: once its answer is here, every frame the environment sent before it is here too. */
const roundTrip = async (client: WireClient): Promise<void> => {
  await client.request("environment.status", {});
};

/** The events from 1 to n, as consecutive sequences starting at `from`. */
const run = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Hooks that hold every catch-up until released, telling the test when one is held. */
const holdCatchUp = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const hooks: SubscriptionHooks = {
    beforeCatchUp: async () => {
      reach();
      await gate;
    },
  };
  return { hooks, reached, release };
};

/**
 * A slow socket: while paused, what the environment sends is held rather
 * than written, and counts as not yet flushed; resuming writes it all, in order.
 */
const valve = () => {
  let paused = false;
  const held: { readonly outlet: Outlet; readonly text: string; readonly flushed: () => void }[] = [];
  const hooks: SubscriptionHooks = {
    outlet: (outlet) => ({
      send: (text, flushed) => (paused ? void held.push({ outlet, text, flushed }) : outlet.send(text, flushed)),
    }),
  };
  return {
    hooks,
    pause: () => void (paused = true),
    resume: () => {
      paused = false;
      for (const { outlet, text, flushed } of held.splice(0)) outlet.send(text, flushed);
    },
  };
};

describe("a subscription", () => {
  it("is answered subscribed, then the events after the cursor, then synchronized, then live events, all carrying its id", async () => {
    const t = await start();
    // Connected first: opening a socket appends to the access stream, which would move the head.
    const client = await t.client();
    const earlier = append(t, "a", 3);
    const [head] = append(t, "b", 1);

    const subscribed = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    expect(subscribed).toEqual({ type: "subscribed", id: expect.any(String), subscription: expect.any(String) });
    const { subscription } = subscribed;
    const synchronized = await frame(client, subscription, "synchronized");
    // Synchronized as of the log's head, which the other stream's event is.
    expect(synchronized.sequence).toBe(head);

    const live = append(t, "a", 2);
    append(t, "b", 1);
    await until(() => sequencesOf(client, subscription).length === 5);
    await roundTrip(client);

    expect(shape(client, subscription)).toEqual(["subscribed", ...earlier, "synchronized", ...live]);
    const events = framesOf(client, subscription).filter((f): f is EventFrame => f.type === "event");
    for (const event of events) {
      expect(event.event).toMatchObject({ streamKind: "probe", streamId: "a", type: "probe.poked", sequence: event.sequence });
    }
    expect(events.map((e) => e.event.payload)).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }, { i: 0 }, { i: 1 }]);
    const unrelated = client.received.filter((f) => f.type === "event" && f.subscription !== subscription);
    expect(unrelated).toEqual([]);
  });

  it("replays only the events after its afterSequence cursor", async () => {
    const t = await start();
    const sequences = append(t, "a", 5);
    const client = await t.client();
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: sequences[2] as number });
    await frame(client, subscription, "synchronized");
    expect(shape(client, subscription)).toEqual(["subscribed", ...sequences.slice(3), "synchronized"]);
  });

  it("sends synchronized with nothing before it when no event follows the cursor", async () => {
    const t = await start();
    const client = await t.client();
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "empty", afterSequence: 0 });
    const synchronized = await frame(client, subscription, "synchronized");
    await roundTrip(client);
    expect(shape(client, subscription)).toEqual(["subscribed", "synchronized"]);
    // The environment's own start notice is in the log, so the cursor it hands back is past it.
    expect(synchronized.sequence).toBeGreaterThan(0);
  });

  it(`replays exactly ${REPLAY_BOUND.events} events as events`, async () => {
    const t = await start();
    const sequences = append(t, "a", REPLAY_BOUND.events);
    const client = await t.client();
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    await frame(client, subscription, "synchronized");
    expect(shape(client, subscription)).toEqual(["subscribed", ...sequences, "synchronized"]);
  });

  it(`sends one snapshot instead when ${REPLAY_BOUND.events + 1} events follow the cursor, then synchronized, then live`, async () => {
    const t = await start();
    const client = await t.client();
    const sequences = append(t, "a", REPLAY_BOUND.events + 1);
    const head = sequences.at(-1) as number;
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });

    const snapshot = await frame(client, subscription, "snapshot");
    expect(snapshot).toEqual({ type: "snapshot", subscription, sequence: head, payload: { count: REPLAY_BOUND.events + 1 } });
    expect((await frame(client, subscription, "synchronized")).sequence).toBe(head);
    const live = append(t, "a", 1);
    await until(() => sequencesOf(client, subscription).length === 1);
    append(t, "a", 1);
    await until(() => sequencesOf(client, subscription).length === 2);
    await roundTrip(client);
    expect(shape(client, subscription)).toEqual(["subscribed", "snapshot", "synchronized", ...live, head + 2]);
  });

  it("sends one snapshot when the events after the cursor pass 8 MiB, and replays them once the cursor leaves them within it", async () => {
    const t = await start();
    const oneMiB = () => ({ text: "x".repeat(1024 * 1024) });
    const sequences = append(t, "a", 9, oneMiB);
    const client = await t.client();

    const over = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    await frame(client, over.subscription, "synchronized");
    expect(shape(client, over.subscription)).toEqual(["subscribed", "snapshot", "synchronized"]);

    const within = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: sequences[1] as number });
    await frame(client, within.subscription, "synchronized");
    expect(shape(client, within.subscription)).toEqual(["subscribed", ...sequences.slice(2), "synchronized"]);
  });

  it("sends a snapshot for a cursor past the log's head, which is no cursor of this log", async () => {
    const t = await start();
    const client = await t.client();
    const [head] = append(t, "a", 2).slice(-1);
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: (head as number) + 50 });
    expect(await frame(client, subscription, "snapshot")).toMatchObject({ sequence: head, payload: { count: 2 } });
    expect((await frame(client, subscription, "synchronized")).sequence).toBe(head);
    const live = append(t, "a", 1);
    await until(() => sequencesOf(client, subscription).length === 1);
    expect(sequencesOf(client, subscription)).toEqual(live);
  });

  it("sends synchronized exactly once, however many events come live after it", async () => {
    const t = await start();
    append(t, "a", 2);
    const client = await t.client();
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    for (let i = 0; i < 5; i++) append(t, "a", 3);
    await until(() => sequencesOf(client, subscription).length === 17);
    await roundTrip(client);
    expect(framesOf(client, subscription).filter((f) => f.type === "synchronized")).toHaveLength(1);
  });

  it("delivers the events appended while catch-up is in progress, with no gap and none twice", async () => {
    const hold = holdCatchUp();
    const t = await start({ subscriptionHooks: hold.hooks });
    const client = await t.client();
    const before = append(t, "a", 3);

    const subscribing = client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    await hold.reached;
    // The live feed is attached and catch-up has not read yet: these land in both.
    const during = append(t, "a", 4);
    hold.release();
    const { subscription } = await subscribing;
    await frame(client, subscription, "synchronized");
    const after = append(t, "a", 2);
    await until(() => sequencesOf(client, subscription).length === 9);
    await roundTrip(client);

    const received = sequencesOf(client, subscription);
    expect(received).toEqual([...before, ...during, ...after]);
    expect(received).toEqual(run(received[0] as number, received.at(-1) as number));
    expect(shape(client, subscription).filter((f) => f === "synchronized")).toHaveLength(1);
  });

  it("gives each subscription on a socket its own id, and feeds each its own stream", async () => {
    const t = await start();
    const client = await t.client();
    const one = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    const two = await client.subscribe("probe.subscribe", { probe: "b", afterSequence: 0 });
    const three = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    expect(new Set([one.subscription, two.subscription, three.subscription]).size).toBe(3);
    const a = append(t, "a", 2);
    const b = append(t, "b", 1);
    await until(() => sequencesOf(client, one.subscription).length === 2 && sequencesOf(client, two.subscription).length === 1);
    await until(() => sequencesOf(client, three.subscription).length === 2);
    expect(sequencesOf(client, one.subscription)).toEqual(a);
    expect(sequencesOf(client, two.subscription)).toEqual(b);
    expect(sequencesOf(client, three.subscription)).toEqual(a);
  });
});

describe("overflow", () => {
  it(`ends a subscriber more than ${REPLAY_BOUND.events} events behind with overflow; a resubscribe from its cursor loses nothing`, async () => {
    const socket = valve();
    const t = await start({ subscriptionHooks: socket.hooks });
    const client = await t.client();
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    await frame(client, subscription, "synchronized");

    socket.pause();
    const sequences = append(t, "a", REPLAY_BOUND.events + 5);
    socket.resume();
    expect(await frame(client, subscription, "end")).toEqual({ type: "end", subscription, reason: "overflow" });
    const delivered = sequencesOf(client, subscription);
    expect(delivered).toEqual(sequences.slice(0, REPLAY_BOUND.events));

    // No event follows the end.
    append(t, "a", 1);
    await roundTrip(client);
    expect(framesOf(client, subscription).at(-1)).toMatchObject({ type: "end" });

    const cursor = delivered.at(-1) as number;
    const again = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: cursor });
    await frame(client, again.subscription, "synchronized");
    const resumed = sequencesOf(client, again.subscription);
    expect([...delivered, ...resumed]).toEqual(run(sequences[0] as number, (sequences.at(-1) as number) + 1));
  });

  it("ends a subscriber more than 8 MiB behind with overflow, however few the events", async () => {
    const socket = valve();
    const t = await start({ subscriptionHooks: socket.hooks });
    const client = await t.client();
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    await frame(client, subscription, "synchronized");

    socket.pause();
    const sequences = append(t, "a", 9, () => ({ text: "x".repeat(1024 * 1024) }));
    socket.resume();
    await frame(client, subscription, "end");
    const delivered = sequencesOf(client, subscription);
    expect(delivered.length).toBeLessThan(9);
    expect(delivered).toEqual(sequences.slice(0, delivered.length));

    const again = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: delivered.at(-1) as number });
    await frame(client, again.subscription, "synchronized");
    expect([...delivered, ...sequencesOf(client, again.subscription)]).toEqual(sequences);
  });

  it("answers subscribed then end overflow when more than the bound is appended while its catch-up is held", async () => {
    const hold = holdCatchUp();
    const t = await start({ subscriptionHooks: hold.hooks });
    const client = await t.client();
    const subscribing = client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    await hold.reached;
    const sequences = append(t, "a", REPLAY_BOUND.events + 1);
    const { subscription } = await subscribing;
    expect(await frame(client, subscription, "end")).toEqual({ type: "end", subscription, reason: "overflow" });
    hold.release();
    await roundTrip(client);
    expect(shape(client, subscription)).toEqual(["subscribed", "end"]);
    expect(t.env.subscriptions()).toBe(0);

    const again = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    expect(await frame(client, again.subscription, "snapshot")).toMatchObject({ sequence: sequences.at(-1) });
  });

  it("does not end a subscriber whose socket keeps up, however many events come", async () => {
    const t = await start();
    const client = await t.client();
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    await frame(client, subscription, "synchronized");
    for (let i = 0; i < 3; i++) {
      append(t, "a", REPLAY_BOUND.events / 2);
      await until(() => sequencesOf(client, subscription).length === ((i + 1) * REPLAY_BOUND.events) / 2);
    }
    expect(framesOf(client, subscription).some((f) => f.type === "end")).toBe(false);
  });
});

describe("ending a subscription", () => {
  it("answers unsubscribe with end unsubscribed, and sends nothing for it after", async () => {
    const t = await start();
    const client = await t.client();
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    await frame(client, subscription, "synchronized");
    client.send({ type: "unsubscribe", subscription });
    expect(await frame(client, subscription, "end")).toEqual({ type: "end", subscription, reason: "unsubscribed" });
    append(t, "a", 2);
    await roundTrip(client);
    expect(shape(client, subscription)).toEqual(["subscribed", "synchronized", "end"]);
    await until(() => t.env.subscriptions() === 0);
  });

  it("ignores an unsubscribe naming no subscription of this socket, and a second unsubscribe", async () => {
    const t = await start();
    const client = await t.client();
    const other = await t.client();
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    await frame(client, subscription, "synchronized");

    other.send({ type: "unsubscribe", subscription });
    other.send({ type: "unsubscribe", subscription: "no-such-subscription" });
    await roundTrip(other);
    expect(other.received.filter((f) => f.type === "end")).toEqual([]);
    expect(other.isOpen()).toBe(true);

    client.send({ type: "unsubscribe", subscription });
    client.send({ type: "unsubscribe", subscription });
    await roundTrip(client);
    expect(client.received.filter((f) => f.type === "end")).toHaveLength(1);
  });

  it("ends every subscription of a socket the client closes, and feeds them no more", async () => {
    const t = await start();
    const client = await t.client();
    const staying = await t.client();
    await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    await client.subscribe("probe.subscribe", { probe: "b", afterSequence: 0 });
    const kept = await staying.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    expect(t.env.subscriptions()).toBe(3);

    await client.close();
    await until(() => t.env.subscriptions() === 1);
    const live = append(t, "a", 1);
    await until(() => sequencesOf(staying, kept.subscription).length === 1);
    expect(sequencesOf(staying, kept.subscription)).toEqual(live);
  });

  it("ends every subscription with closed before bye draining when the environment closes", async () => {
    const t = await start();
    const client = await t.client();
    const one = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    const two = await client.subscribe("environment.subscribe", { afterSequence: 0 });
    await frame(client, two.subscription, "synchronized");
    await t.env.close();
    const closed = await client.closed;
    expect(closed.bye?.reason).toBe("draining");
    const tail = client.received.slice(-3);
    expect(tail).toEqual([
      { type: "end", subscription: one.subscription, reason: "closed" },
      { type: "end", subscription: two.subscription, reason: "closed" },
      expect.objectContaining({ type: "bye", reason: "draining" }),
    ]);
  });

  it("ends every subscription with revoked before bye revoked when its client session is revoked", async () => {
    const t = await start();
    const credential = t.env.clientSessions.issue({
      kind: "program",
      label: "revoked soon",
      scopes: ["read"],
      ceiling: Ceiling.parse("acceptEdits"),
    });
    const client = await t.client({ token: credential.token });
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    await frame(client, subscription, "synchronized");

    t.env.clientSessions.revoke(credential.clientSessionId);
    const closed = await client.closed;
    expect(closed.bye?.reason).toBe("revoked");
    expect(client.received.slice(-2)).toEqual([
      { type: "end", subscription, reason: "revoked" },
      expect.objectContaining({ type: "bye", reason: "revoked" }),
    ]);
    await until(() => t.env.subscriptions() === 0);
  });

  it("never opens a subscription whose socket closed while its handler was still answering", async () => {
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    let reach!: () => void;
    const called = new Promise<void>((resolve) => (reach = resolve));
    const t = await start();
    t.serve(defineMethod({ ...probeSubscribe, name: "probe.slow" }), async ({ probe }) => {
      reach();
      await answered;
      return { stream: probeStream(probe), snapshot: () => ({ count: 0 }) };
    });
    const client = await t.client();
    client.send({ type: "request", id: "slow", method: "probe.slow", params: { probe: "a", afterSequence: 0 } });
    await called;
    await client.close();
    release();
    // A subscription opened after its socket went would be fed forever; a later one on another socket shows none was.
    const other = await t.client();
    await other.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    expect(t.env.subscriptions()).toBe(1);
  });

  it("ends a subscription whose socket closes while its catch-up is held, and sends it nothing", async () => {
    const hold = holdCatchUp();
    const t = await start({ subscriptionHooks: hold.hooks });
    const client = await t.client();
    client.send({ type: "request", id: "held", method: "probe.subscribe", params: { probe: "a", afterSequence: 0 } });
    await hold.reached;
    expect(t.env.subscriptions()).toBe(1);
    await client.close();
    hold.release();
    await until(() => t.env.subscriptions() === 0);
    expect(client.received.filter((f) => f.type === "subscribed")).toEqual([]);
  });
});

describe("a subscription its source ends", () => {
  it("delivers the event its source ends on, then ends with the reason the source names, and sends nothing for it after", async () => {
    const t = await start();
    const client = await t.client();
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: t.env.log.head() });
    await frame(client, subscription, "synchronized");

    const [poked, ended] = appendTypes(t, "a", ["probe.poked", "probe.ended", "probe.poked"]);
    expect(await frame(client, subscription, "end")).toEqual({ type: "end", subscription, reason: "deleted" });
    appendTypes(t, "a", ["probe.poked"]);
    await roundTrip(client);
    expect(shape(client, subscription)).toEqual(["subscribed", "synchronized", poked, ended, "end"]);
    await until(() => t.env.subscriptions() === 0);
  });

  it("ends a replay at the event its source ends on, with no synchronized", async () => {
    const t = await start();
    const client = await t.client();
    const [poked, ended] = appendTypes(t, "a", ["probe.poked", "probe.ended", "probe.poked"]);
    const { subscription } = await client.subscribe("probe.subscribe", { probe: "a", afterSequence: 0 });
    expect(await frame(client, subscription, "end")).toEqual({ type: "end", subscription, reason: "deleted" });
    appendTypes(t, "a", ["probe.poked"]);
    await roundTrip(client);
    expect(shape(client, subscription)).toEqual(["subscribed", poked, ended, "end"]);
    expect(t.env.subscriptions()).toBe(0);
  });

  it("ends at the event its source ends on when it was appended while the catch-up was held, and delivers nothing the feed heard after it", async () => {
    const hold = holdCatchUp();
    const t = await start({ subscriptionHooks: hold.hooks });
    const client = await t.client();
    const subscribing = client.subscribe("probe.subscribe", { probe: "a", afterSequence: t.env.log.head() });
    await hold.reached;
    // The live feed hears these, and the catch-up reads them too.
    const [poked, ended] = appendTypes(t, "a", ["probe.poked", "probe.ended", "probe.poked"]);
    hold.release();
    const { subscription } = await subscribing;
    await frame(client, subscription, "end");
    await roundTrip(client);
    expect(shape(client, subscription)).toEqual(["subscribed", poked, ended, "end"]);
    expect(t.env.subscriptions()).toBe(0);
  });
});

describe("a subscription over stream kinds", () => {
  /**
   * A synthetic stream over every `session` and `group` stream, keeping only
   * `probe.poked` events: a type the session list does not project, so the
   * test appends to those kinds freely.
   */
  const probesSubscribe = defineMethod({
    name: "probes.subscribe",
    scope: "read",
    kind: "stream",
    params: subscriptionParams({}),
    result: z.object({ count: z.int().nonnegative() }),
    errors: [],
  });
  const poke = (kind: "session" | "group" | "access", id: string, types: readonly string[]) =>
    (t: TestEnvironment) =>
      t.env.log.append({ kind, id }, types.map((type) => ({ type, payload: {} })), { actor: "system:test" }).events.map((e) => e.sequence);

  it("carries every stream of the kinds its source names, only the types it names, replayed then live, in sequence order", async () => {
    const t = await start();
    t.serve(probesSubscribe, () => ({ stream: { kinds: ["session", "group"], types: ["probe.poked"] }, snapshot: () => ({ count: 0 }) }));
    const [a] = poke("session", "a", ["probe.poked"])(t);
    const [b] = poke("group", "x", ["probe.poked", "probe.ignored"])(t);
    poke("access", "a", ["probe.poked"])(t);
    const client = await t.client();
    const { subscription } = await client.subscribe("probes.subscribe", { afterSequence: 0 });
    await frame(client, subscription, "synchronized");
    const [c] = poke("session", "b", ["probe.poked"])(t);
    const [, d] = poke("group", "y", ["probe.ignored", "probe.poked"])(t);
    await roundTrip(client);
    expect(shape(client, subscription)).toEqual(["subscribed", a, b, "synchronized", c, d]);
  });

  it("sends a snapshot when the events of those kinds after the cursor pass the bound", async () => {
    const t = await start();
    t.serve(probesSubscribe, () => ({ stream: { kinds: ["session", "group"] }, snapshot: () => ({ count: 7 }) }));
    poke("session", "a", Array.from({ length: REPLAY_BOUND.events / 2 }, () => "probe.poked"))(t);
    poke("group", "x", Array.from({ length: REPLAY_BOUND.events / 2 + 1 }, () => "probe.poked"))(t);
    const client = await t.client();
    const { subscription } = await client.subscribe("probes.subscribe", { afterSequence: 0 });
    const snapshot = await frame(client, subscription, "snapshot");
    expect(snapshot.payload).toEqual({ count: 7 });
  });
});

describe("refusing a subscription", () => {
  it("refuses a stream whose scope the client session lacks forbidden, before any subscribed", async () => {
    const t = await start();
    const client = await t.client({ token: narrowToken(t, ["admin"]) });
    for (const [method, params] of [
      ["probe.subscribe", { probe: "a", afterSequence: 0 }],
      ["environment.subscribe", { afterSequence: 0 }],
    ] as const) {
      const answer = await client.call(method, params);
      expect(answer, method).toEqual({
        type: "response",
        id: expect.any(String),
        error: { code: "forbidden", message: expect.stringContaining("read"), data: { scope: "read" } },
      });
    }
    expect(client.received.filter((f) => f.type === "subscribed")).toEqual([]);
    expect(t.env.subscriptions()).toBe(0);
  });

  it("refuses a missing cursor or a negative one invalid_params, before any subscribed", async () => {
    const t = await start();
    const client = await t.client();
    for (const params of [{ probe: "a" }, { probe: "a", afterSequence: -1 }, { probe: "a", afterSequence: 1.5 }]) {
      const answer = await client.call("probe.subscribe", params);
      expect(answer, JSON.stringify(params)).toMatchObject({
        type: "response",
        error: { code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["afterSequence"] })] } },
      });
    }
    expect(client.received.filter((f) => f.type === "subscribed")).toEqual([]);
  });

  it("answers the stream's own refusal as a response, before any subscribed", async () => {
    const t = await start();
    const client = await t.client();
    const answer = await client.call("probe.subscribe", { probe: "missing", afterSequence: 0 });
    expect(answer).toEqual({ type: "response", id: expect.any(String), error: { code: "probe_missing", message: "No such probe.", data: {} } });
    expect(client.received.filter((f) => f.type === "subscribed")).toEqual([]);
    expect(t.env.subscriptions()).toBe(0);
  });

  it("answers internal, before any subscribed, when the snapshot is outside the stream's result schema", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => quiet.mockRestore());
    const t = await start();
    t.serve(defineMethod({ ...probeSubscribe, name: "probe.broken" }), ({ probe }) => ({
      stream: probeStream(probe),
      snapshot: () => ({ count: -1 }),
    }));
    append(t, "a", REPLAY_BOUND.events + 1);
    const client = await t.client();
    const answer = await client.call("probe.broken", { probe: "a", afterSequence: 0 });
    expect(answer).toMatchObject({ type: "response", error: { code: "internal" } });
    expect(client.received.filter((f) => f.type === "subscribed")).toEqual([]);
    expect(t.env.subscriptions()).toBe(0);
    expect(quiet).toHaveBeenCalled();
  });
});

describe("environment.subscribe", () => {
  it("is served to a client session holding read, and delivers environment.started from this start as an event", async () => {
    const t = await start();
    const client = await t.client({ token: narrowToken(t, ["read"]) });
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
    const synchronized = await frame(client, subscription, "synchronized");

    // Set up's start pass's results follow it (#571).
    const events = framesOf(client, subscription).filter((f): f is EventFrame => f.type === "event" && f.event.type === "environment.started");
    expect(events).toHaveLength(1);
    const [started] = events;
    expect(started?.event).toMatchObject({
      streamKind: ENVIRONMENT_STREAM_KIND,
      streamId: t.env.id,
      streamVersion: 1,
      type: "environment.started",
      actor: { kind: "system", id: "lifecycle" },
    });
    expect(EnvironmentNotice.parse(started?.event)).toEqual({
      type: "environment.started",
      payload: { harnessVersion: HARNESS_VERSION, protocolVersion: client.hello.protocolVersion },
    });
    expect(synchronized.sequence).toBeGreaterThanOrEqual(started?.sequence as number);
  });

  it("delivers a notice appended later live", async () => {
    const t = await start();
    const client = await t.client();
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
    const synchronized = await frame(client, subscription, "synchronized");
    const [draining] = t.env.log.append({ kind: ENVIRONMENT_STREAM_KIND, id: t.env.id }, [
      { type: "environment.draining", payload: { drainingSince: t.clock.now().toISOString(), trigger: "command" } },
    ], { actor: "system:lifecycle" }).events;
    const live = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.sequence > synchronized.sequence);
    expect(live.sequence).toBe(draining?.sequence);
    expect(live.sequence).toBeGreaterThan(synchronized.sequence);
    expect(EnvironmentNotice.parse(live.event).type).toBe("environment.draining");
  });

  it("snapshots the environment's status and look, and Set up's cached results, every registered step's once the start pass has run, when its notices after the cursor are out of bounds", async () => {
    const t = await start({ name: "desk", platform: "linux" });
    await t.env.setup.startPass;
    const notices: EventInput[] = Array.from({ length: REPLAY_BOUND.events }, () => ({
      type: "environment.started",
      payload: { harnessVersion: HARNESS_VERSION, protocolVersion: 1 },
    }));
    const client = await t.client();
    const { events } = t.env.log.append({ kind: ENVIRONMENT_STREAM_KIND, id: t.env.id }, notices, { actor: "system:test" });
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
    const snapshot = await frame(client, subscription, "snapshot");
    expect(snapshot).toMatchObject({
      type: "snapshot",
      subscription,
      sequence: events.at(-1)?.sequence,
      payload: {
        status: { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false },
        environment: { name: "desk", icon: "server", colour: presetColour(t.env.id) },
      },
    });
    const { setup } = registry["environment.subscribe"].result.parse(snapshot.payload);
    expect(setup?.map((result) => result.step)).toEqual(["account", "carry-over", "your-machines", "forges", "key-manager", "memory-bank", "instructions", "browser", "permissions", "appearance"]);
    await frame(client, subscription, "synchronized");
    expect(shape(client, subscription)).toEqual(["subscribed", "snapshot", "synchronized"]);
  });

  it("holds no environment.started from a start that failed at the launcher's handshake, and one from the start after", async () => {
    const dataDir = join(tempDir(), "data");
    const failed = startEnvironment({
      dataDir,
      port: 0,
      user: { isPrivileged: () => false },
      launcher: {
        present: () => true,
        prepared: () => Promise.reject(new Error("the launcher has gone")),
        onQuery: () => undefined,
        request: () => Promise.resolve(NO_LAUNCHER),
        close: () => undefined,
      },
      interfaces: NO_INTERFACES,
    });
    await expect(failed).rejects.toMatchObject({ step: "prepared" });

    const t = await start({ dataDir });
    const client = await t.client();
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
    await frame(client, subscription, "synchronized");
    const types = framesOf(client, subscription).flatMap((f) => (f.type === "event" && f.event.type !== "setup.result-changed" ? [f.event.type] : []));
    expect(types).toEqual(["environment.started"]);
  });

  it("holds one environment.started per start on the same data directory", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await startTestEnvironment({ dataDir });
    await first.close();
    const again = await start({ dataDir });
    const client = await again.client();
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
    await frame(client, subscription, "synchronized");
    const types = framesOf(client, subscription).flatMap((f) => (f.type === "event" && f.event.type !== "setup.result-changed" ? [f.event.type] : []));
    expect(types).toEqual(["environment.started", "environment.started"]);
  });
});

describe("the test client", () => {
  it("resolves subscribe with the subscribed frame, and rejects a refusal with its ContractError", async () => {
    const t = await start();
    const client = await t.client();
    const subscribed: SubscribedFrame = await client.subscribe("environment.subscribe", { afterSequence: 0 });
    expect(subscribed.type).toBe("subscribed");
    await expect(client.subscribe("probe.subscribe", { probe: "missing", afterSequence: 0 })).rejects.toBeInstanceOf(ContractError);
  });
});
