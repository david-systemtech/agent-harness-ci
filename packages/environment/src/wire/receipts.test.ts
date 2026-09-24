import { randomUUID } from "node:crypto";
import { commandParams, defineMethod, type ClientSessionCredential, type CommandReceipt, type ResponseFrame } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import type { WireClient } from "../../test/wire-client.js";
import { formatActor, RECEIPT_RETENTION_MS, type StreamRef } from "../event-log/event-log.js";
import { SWEEP_INTERVAL_MS } from "../auth/client-sessions.js";

/**
 * Command receipts through the wire (env spec, "Commands"; session-state
 * spec, "Commands"): every command is answered with the receipt stored under
 * the calling client session and its command id, in the transaction of its
 * events, and a retry is answered from it without applying anything.
 */

const { onCleanup } = useCleanups();

const DAY = 24 * 60 * 60 * 1000;

/**
 * The suite's synthetic mutating method: sets a target's value. A target the
 * suite has not made is rejected `not_found`; a target that already has the
 * value is a no-op; otherwise one `target.set` event goes on the target's stream.
 */
const targetsSet = defineMethod({
  name: "test.targets.set",
  scope: "sessions:write",
  params: commandParams({ target: z.string().min(1), value: z.string() }),
  result: z.object({ value: z.string() }),
  errors: [],
  kind: "command",
});

/** A command whose handler appends its event itself, through the command's transaction, then may throw. */
const targetsSetThenFail = defineMethod({
  name: "test.targets.setThenFail",
  scope: "sessions:write",
  params: commandParams({ target: z.string().min(1), value: z.string() }),
  result: z.object({ value: z.string() }),
  errors: [],
  kind: "command",
});

const targetStream = (target: string): StreamRef => ({ kind: "target", id: target });

interface Suite {
  readonly t: TestEnvironment;
  /** The targets that exist; a test adds and deletes them. */
  readonly targets: Set<string>;
  /** Every handler run, as the target it was aimed at: a retry answered from its receipt runs none. */
  readonly runs: string[];
  /** Whether `test.targets.setThenFail` throws after appending. */
  failing: boolean;
  /** The values set on a target's stream, oldest first. */
  values(target: string): unknown[];
}

const start = async (): Promise<Suite> => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  const suite: Suite = {
    t,
    targets: new Set(["t1", "t2"]),
    runs: [],
    failing: true,
    values: (target) => t.env.log.readStream(targetStream(target)).map((event) => event.payload["value"]),
  };
  t.serve(targetsSet, ({ target, value }) => {
    suite.runs.push(target);
    const aggregate = targetStream(target);
    if (!suite.targets.has(target)) {
      return {
        aggregate,
        rejected: { reason: "not_found", error: { code: "not_found", message: `No target is named ${target}.`, data: { kind: "target" } } },
      };
    }
    if (suite.values(target).at(-1) === value) return { aggregate, result: { value } };
    return { aggregate, result: { value }, events: [{ type: "target.set", payload: { value } }] };
  });
  t.serve(targetsSetThenFail, ({ target, value }, { actor, commandId, tx }) => {
    suite.runs.push(target);
    const aggregate = targetStream(target);
    t.env.log.append(aggregate, [{ type: "target.set", payload: { value } }], { tx, actor, commandId });
    if (suite.failing) throw new Error("the handler failed after appending");
    return { aggregate, result: { value } };
  });
  return suite;
};

/** A client of its own client session, paired with every scope. */
const paired = async (t: TestEnvironment): Promise<{ client: WireClient; credential: ClientSessionCredential }> => {
  const credential = await t.pair();
  return { client: await t.client({ token: credential.token, clientKind: "program" }), credential };
};

/** Sends `test.targets.set` and resolves with its response's result: the receipt, and the result when it applied. */
const setTarget = async (client: WireClient, commandId: string, target: string, value: string) => {
  const answer = (await client.call("test.targets.set", { commandId, target, value })) as ResponseFrame;
  if (answer.error) throw new Error(`test.targets.set answered an error: ${JSON.stringify(answer.error)}`);
  return answer.result as { receipt: CommandReceipt; result?: { value: string } };
};

describe("a command's commandId", () => {
  it("is a UUID: a malformed one is invalid_params, and nothing runs or is appended", async () => {
    const { t, runs, values } = await start();
    const client = await t.client();
    const head = t.env.log.head();
    for (const commandId of ["not-a-uuid", "", 7, undefined]) {
      const answer = await client.call("test.targets.set", { commandId, target: "t1", value: "a" });
      expect(answer, JSON.stringify(commandId)).toMatchObject({
        type: "response",
        error: { code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["commandId"] })] } },
      });
    }
    expect(runs).toEqual([]);
    expect(values("t1")).toEqual([]);
    expect(t.env.log.head()).toBe(head);
  });

  it("is required by the registered commands too", async () => {
    const { t } = await start();
    const client = await t.client();
    const answer = await client.call("access.pairings.create", { commandId: "7" });
    expect(answer).toMatchObject({ type: "response", error: { code: "invalid_params" } });
  });
});

describe("an accepted command", () => {
  it("answers its result beside a receipt with the head after its events and changed true", async () => {
    const { t, values } = await start();
    const client = await t.client();
    const answer = await setTarget(client, randomUUID(), "t1", "a");
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { value: "a" } });
    expect(values("t1")).toEqual(["a"]);
    const [event] = t.env.log.readStream(targetStream("t1"));
    expect(event?.sequence).toBe(answer.receipt.sequence);
  });

  it("puts the command id and the client session on its events", async () => {
    const { t } = await start();
    const client = await t.client();
    const commandId = randomUUID();
    await setTarget(client, commandId, "t1", "a");
    expect(t.env.log.readStream(targetStream("t1"))).toMatchObject([
      { commandId, actor: formatActor({ kind: "client_session", id: client.hello.clientSessionId }) },
    ]);
  });
});

describe("a repeated command id", () => {
  it("is answered with the stored receipt and no result, and appends nothing, on the same socket or another of the same client session", async () => {
    const { t, runs, values } = await start();
    const { client, credential } = await paired(t);
    const commandId = randomUUID();
    const first = await setTarget(client, commandId, "t1", "a");
    const head = t.env.log.head();

    expect(await setTarget(client, commandId, "t1", "a")).toEqual({ receipt: first.receipt });
    // Even with other params: the id is the command, and it was answered.
    expect(await setTarget(client, commandId, "t1", "b")).toEqual({ receipt: first.receipt });
    expect(t.env.log.head()).toBe(head);
    // Another socket is the same actor; its opening and closing are access events, not the command's.
    await client.close();
    const again = await t.client({ token: credential.token, clientKind: "program" });
    expect(await setTarget(again, commandId, "t1", "a")).toEqual({ receipt: first.receipt });

    expect(values("t1")).toEqual(["a"]);
    expect(runs).toEqual(["t1"]);
  });

  it("from another client session is that client session's own command, and neither reads the other's receipt", async () => {
    const { t, values } = await start();
    const alice = await paired(t);
    const bob = await paired(t);
    const commandId = randomUUID();

    const hers = await setTarget(alice.client, commandId, "t1", "a");
    const his = await setTarget(bob.client, commandId, "t1", "b");
    expect(his).toEqual({ receipt: { status: "accepted", sequence: hers.receipt.sequence + 1, changed: true }, result: { value: "b" } });
    expect(values("t1")).toEqual(["a", "b"]);

    expect(await setTarget(alice.client, commandId, "t1", "a")).toEqual({ receipt: hers.receipt });
    expect(await setTarget(bob.client, commandId, "t1", "b")).toEqual({ receipt: his.receipt });
    expect(values("t1")).toEqual(["a", "b"]);
  });
});

describe("a command on a missing target", () => {
  it("is rejected not_found in a receipt with the head and no event, and its retry is answered the same even once the target exists", async () => {
    const { t, targets, runs } = await start();
    const client = await t.client();
    await setTarget(client, randomUUID(), "t1", "a");
    const head = t.env.log.head();
    const commandId = randomUUID();

    const rejected = await setTarget(client, commandId, "gone", "a");
    expect(rejected).toEqual({
      receipt: {
        status: "rejected",
        sequence: head,
        changed: false,
        reason: "not_found",
        error: { code: "not_found", message: "No target is named gone.", data: { kind: "target" } },
      },
    });
    expect(t.env.log.head()).toBe(head);

    targets.add("gone");
    expect(await setTarget(client, commandId, "gone", "a")).toEqual(rejected);
    expect(t.env.log.readStream(targetStream("gone"))).toEqual([]);
    expect(runs).toEqual(["t1", "gone"]);
  });

  it("is rejected once its target is deleted, while a command before the deletion keeps its accepted receipt", async () => {
    const { t, targets } = await start();
    const client = await t.client();
    const before = randomUUID();
    const accepted = await setTarget(client, before, "t2", "a");
    targets.delete("t2");

    expect((await setTarget(client, randomUUID(), "t2", "b")).receipt).toMatchObject({ status: "rejected", reason: "not_found" });
    expect(await setTarget(client, before, "t2", "a")).toEqual({ receipt: accepted.receipt });
  });
});

describe("an accepted command that changes nothing", () => {
  it("answers its result with a receipt of the head and changed false, appends nothing, and its retry gets the same receipt", async () => {
    const { t, values } = await start();
    const client = await t.client();
    await setTarget(client, randomUUID(), "t1", "a");
    await setTarget(client, randomUUID(), "t2", "x");
    const head = t.env.log.head();
    const commandId = randomUUID();

    const noOp = await setTarget(client, commandId, "t1", "a");
    expect(noOp).toEqual({ receipt: { status: "accepted", sequence: head, changed: false }, result: { value: "a" } });
    expect(values("t1")).toEqual(["a"]);
    expect(t.env.log.head()).toBe(head);

    await setTarget(client, randomUUID(), "t1", "b");
    expect(await setTarget(client, commandId, "t1", "a")).toEqual({ receipt: noOp.receipt });
    expect(values("t1")).toEqual(["a", "b"]);
  });
});

describe("a command's receipt and events", () => {
  it("commit in one transaction: a handler that throws after appending leaves no event and no receipt, so the retry applies", async () => {
    const suite = await start();
    const { t, values } = suite;
    const client = await t.client();
    const published: string[] = [];
    t.env.log.subscribe((event) => published.push(event.type));
    const head = t.env.log.head();
    const commandId = randomUUID();
    const quiet = { error: console.error };
    console.error = () => undefined;
    try {
      const failed = await client.call("test.targets.setThenFail", { commandId, target: "t1", value: "a" });
      expect(failed).toMatchObject({ type: "response", error: { code: "internal" } });
    } finally {
      console.error = quiet.error;
    }
    expect(values("t1")).toEqual([]);
    expect(published).toEqual([]);
    expect(t.env.log.receipt(formatActor({ kind: "client_session", id: client.hello.clientSessionId }), commandId)).toBeNull();

    suite.failing = false;
    const applied = await client.call("test.targets.setThenFail", { commandId, target: "t1", value: "a" });
    expect(applied).toMatchObject({
      type: "response",
      result: { receipt: { status: "accepted", sequence: head + 1, changed: true }, result: { value: "a" } },
    });
    expect(values("t1")).toEqual(["a"]);
    expect(published).toEqual(["target.set"]);
  });
});

describe("receipt retention", () => {
  it("answers a retry from the receipt for 30 days; after that the sweep has removed it and the retry is a new command", async () => {
    const { t, values } = await start();
    const bot = await t.pair({ scopes: ["sessions:write", "read"] });
    const actor = formatActor({ kind: "client_session", id: bot.clientSessionId });
    const commandId = randomUUID();
    let client = await t.client({ token: bot.token, clientKind: "program" });
    const first = await setTarget(client, commandId, "t1", "a");
    await setTarget(client, randomUUID(), "t1", "b");
    // Closed while time passes, so no socket is pinged through the days.
    await client.close();

    t.clock.advance(29 * DAY);
    client = await t.client({ token: bot.token, clientKind: "program" });
    expect(await setTarget(client, commandId, "t1", "a")).toEqual({ receipt: first.receipt });
    // The client session would expire before the receipt does; renewed, it is the same actor.
    const renewed = await client.apply("access.sessions.refresh", { commandId: randomUUID() });
    await client.close();

    // The sweep a minute past the window has removed the row, not merely stopped answering it.
    const stored = () => t.env.log.read("SELECT command_id FROM command_receipts WHERE actor = ? AND command_id = ?", actor, commandId);
    expect(stored()).toHaveLength(1);
    t.clock.advance(RECEIPT_RETENTION_MS - 29 * DAY + SWEEP_INTERVAL_MS);
    expect(stored()).toEqual([]);
    client = await t.client({ token: renewed.token, clientKind: "program" });
    const again = await setTarget(client, commandId, "t1", "a");
    expect(again).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { value: "a" } });
    expect(values("t1")).toEqual(["a", "b", "a"]);
  });

  it("is exact without the sweep: one millisecond past 30 days, before the next sweep, the retry is a new command", async () => {
    const { t, values } = await start();
    const bot = await t.pair({ scopes: ["sessions:write", "read"] });
    const commandId = randomUUID();
    let client = await t.client({ token: bot.token, clientKind: "program" });
    const first = await setTarget(client, commandId, "t1", "a");
    await setTarget(client, randomUUID(), "t1", "b");
    await client.close();

    // Renewed a day before it would expire, so the same client session retries after the window.
    t.clock.advance(RECEIPT_RETENTION_MS - DAY);
    client = await t.client({ token: bot.token, clientKind: "program" });
    const renewed = await client.apply("access.sessions.refresh", { commandId: randomUUID() });
    await client.close();

    // Exactly 30 days old, and the sweep on the minute has just passed: still answered.
    t.clock.advance(DAY);
    client = await t.client({ token: renewed.token, clientKind: "program" });
    expect(await setTarget(client, commandId, "t1", "a")).toEqual({ receipt: first.receipt });
    await client.close();

    // A millisecond older, with the next sweep a minute away: a new command.
    t.clock.advance(1);
    client = await t.client({ token: renewed.token, clientKind: "program" });
    expect((await setTarget(client, commandId, "t1", "a")).receipt).toMatchObject({ status: "accepted", changed: true });
    expect(values("t1")).toEqual(["a", "b", "a"]);
  });
});

describe("access.pairings.create", () => {
  it("retried, answers the stored receipt without a second code, and the access log holds one pairing.created", async () => {
    const { t } = await start();
    const { client } = await paired(t);
    const commandId = randomUUID();

    const first = await client.request("access.pairings.create", { commandId, scopes: ["read"] });
    expect(first.receipt).toEqual({ status: "accepted", sequence: expect.any(Number), changed: true });
    expect(first.result).toMatchObject({ scopes: ["read"], code: expect.any(String) });
    const retry = await client.request("access.pairings.create", { commandId, scopes: ["read"] });
    expect(retry).toEqual({ receipt: first.receipt });

    const { events } = await client.apply("access.log.list", { limit: 1000 });
    const created = events.filter((event) => event.type === "pairing.created" && event.commandId === commandId);
    expect(created).toHaveLength(1);
    expect(created[0]?.sequence).toBe(first.receipt.sequence);
  });
});
