import { randomUUID } from "node:crypto";
import { registry, type RoutineInjection, type RunPolicyResolvedPayload, type SettingsPatch } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProcessEnvironmentScope, ProcessEnvironmentSupplier } from "../adapter/process-environment.js";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { fakePty } from "../../test/fake-pty.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { updateSettings } from "../../test/shelf.js";
import { openTerminal } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The injection setting (key-managers spec, "Injection"; ADR 0011, ADR
 * 0028; #367) through the primary seam: an in-process environment with the
 * scripted fake adapter, which reports the variables its process was given,
 * a test supplier registered with the process environment (#307), and the
 * settings written over the wire as a client writes them. What is asserted
 * is whether the supplier was asked, what each process was given, and the
 * key each run was handed, never the resolver's own state.
 */

const { onCleanup } = useCleanups();

/** A second account on the fake adapter's provider, beside the preset `claude-max`. */
const WORK = "claude-work";

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const adapter = fakeAdapter();
  const t = await startTestEnvironment({
    adapter,
    accounts: [
      { id: "claude-max", provider: adapter.descriptor.provider },
      { id: WORK, provider: adapter.descriptor.provider },
    ],
    ...options,
  });
  onCleanup(() => t.close());
  return t;
};

const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

/** Starts a run on the session as a client does and waits for its end. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<void> => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1));
};

/** Sets settings over the wire, as an admin client does; throws unless the update was accepted. */
const set = async (client: WireClient, values: SettingsPatch): Promise<void> => {
  const answer = await updateSettings(client, values);
  if (answer.receipt.status !== "accepted") throw new Error(`settings.update was refused: ${JSON.stringify(answer.receipt)}`);
};

/** A supplier that records each scope it supplied, and gives every spawn one variable. */
const recordingSupplier = () => {
  const supplied: ProcessEnvironmentScope[] = [];
  const supplier: ProcessEnvironmentSupplier = {
    name: "test",
    key: () => "test",
    supply: (scope) => {
      supplied.push(scope);
      return { variables: { HARNESS_TEST_TOKEN: "token-for-tests" }, release: () => undefined };
    },
  };
  return { supplier, supplied };
};

/** An environment with the recording supplier registered, and a client. */
const withSupplier = async (options: TestEnvironmentOptions = {}) => {
  const t = await start(options);
  const { supplier, supplied } = recordingSupplier();
  t.env.processEnvironments.register(supplier);
  return { t, supplied, client: await t.client() };
};

/** What the session's latest process was given. */
const givenTo = async (t: TestEnvironment, sessionId: string): Promise<Readonly<Record<string, string>>> => {
  const process = t.adapter.processesOf(sessionId).at(-1);
  if (process === undefined) throw new Error(`Session ${sessionId} has no process.`);
  return process.supplied;
};

describe("the environment's credentials.injection", () => {
  it("allows by its preset: a run's process is given what the suppliers supply", async () => {
    const { t, client, supplied } = await withSupplier();
    const session = await create(client);

    await runTo(t, client, session.id);

    expect(await givenTo(t, session.id)).toEqual({ HARNESS_TEST_TOKEN: "token-for-tests" });
    expect(supplied).toHaveLength(1);
  });

  it("denies every run once set to deny: no supplier is asked and the process is given nothing", async () => {
    const { t, client, supplied } = await withSupplier();
    await set(client, { "credentials.injection": "deny" });
    const session = await create(client);

    await runTo(t, client, session.id);

    expect(await givenTo(t, session.id)).toEqual({});
    expect(supplied).toEqual([]);
  });
});

describe("an account's entry in credentials.injectionByAccount", () => {
  it("outranks the environment's value for that account's runs, either way, and leaves another account's runs to the environment's", async () => {
    const { t, client, supplied } = await withSupplier();
    await set(client, { "credentials.injection": "deny", "credentials.injectionByAccount": { "claude-max": "allow" } });
    const max = await create(client, { account: "claude-max" });
    const work = await create(client, { account: WORK });

    await runTo(t, client, max.id);
    await runTo(t, client, work.id);

    expect(await givenTo(t, max.id)).toEqual({ HARNESS_TEST_TOKEN: "token-for-tests" });
    expect(await givenTo(t, work.id)).toEqual({});
    expect(supplied.map((scope) => scope.accountId)).toEqual(["claude-max"]);

    await set(client, { "credentials.injection": "allow", "credentials.injectionByAccount": { [WORK]: "deny" } });
    await runTo(t, client, max.id, "Again");
    await runTo(t, client, work.id, "Again");

    expect(await givenTo(t, max.id)).toEqual({ HARNESS_TEST_TOKEN: "token-for-tests" });
    expect(await givenTo(t, work.id)).toEqual({});
    expect(supplied.map((scope) => scope.accountId)).toEqual(["claude-max", "claude-max"]);
  });

  it("governs the session's terminal as it governs its runs", async () => {
    const pty = fakePty();
    const { t, client, supplied } = await withSupplier({ terminals: { pty, shell: () => ({ file: "/bin/sh", args: [] }) } });
    await set(client, { "credentials.injectionByAccount": { [WORK]: "deny" } });
    const work = await create(client, { account: WORK });
    const max = await create(client, { account: "claude-max" });

    await openTerminal(client, work.id);
    await openTerminal(client, max.id);

    await vi.waitFor(() => expect(pty.spawned).toHaveLength(2));
    expect(pty.spawned[0]?.options.env).not.toHaveProperty("HARNESS_TEST_TOKEN");
    expect(pty.spawned[1]?.options.env).toMatchObject({ HARNESS_TEST_TOKEN: "token-for-tests" });
    expect(supplied.map((scope) => [scope.sessionId, scope.accountId])).toEqual([[max.id, "claude-max"]]);
  });
});

/** Fires a run on the session as #92's firing starts one, for the routine `routine-nightly` with its own injection. */
const fire = async (t: TestEnvironment, sessionId: string, injection?: RoutineInjection): Promise<void> => {
  const before = ended(t, sessionId).length;
  t.env.startRun({
    sessionId,
    text: "Reconcile the receipts",
    actor: { kind: "routine", name: "nightly-receipts", ceiling: "acceptEdits", clientSessionId: null },
    actorId: "routine-nightly",
    ...(injection !== undefined && { injection }),
  });
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1));
};

describe("a routine's own injection", () => {
  it("outranks the account's entry and the environment's value either way, the routine the level that decided it", async () => {
    const { t, client, supplied } = await withSupplier();
    await set(client, { "credentials.injection": "deny", "credentials.injectionByAccount": { "claude-max": "deny" } });
    const session = await create(client, { account: "claude-max" });

    await fire(t, session.id, "allow");

    expect(await givenTo(t, session.id)).toEqual({ HARNESS_TEST_TOKEN: "token-for-tests" });
    expect(supplied.map((scope) => [scope.origin, scope.override])).toEqual([["routine", { answer: "allow", level: { kind: "routine", id: "routine-nightly" } }]]);
    expect(JSON.parse(t.adapter.lastRun().input.processEnvironment.key)).toMatchObject({ injection: "allow", level: { kind: "routine", id: "routine-nightly" } });

    await set(client, { "credentials.injection": "allow", "credentials.injectionByAccount": { "claude-max": "allow" } });
    await fire(t, session.id, "deny");

    expect(await givenTo(t, session.id)).toEqual({});
    expect(JSON.parse(t.adapter.lastRun().input.processEnvironment.key)).toEqual({ injection: "deny", level: { kind: "routine", id: "routine-nightly" } });
    expect(supplied).toHaveLength(1);
  });

  it("passes the question on as inherit, or when the firing names none: the account's entry answers, else the environment's value", async () => {
    const { t, client } = await withSupplier();
    await set(client, { "credentials.injection": "allow", "credentials.injectionByAccount": { [WORK]: "deny" } });
    const work = await create(client, { account: WORK });
    const max = await create(client, { account: "claude-max" });

    await fire(t, work.id, "inherit");
    await fire(t, max.id);

    expect(await givenTo(t, work.id)).toEqual({});
    expect(JSON.parse(t.adapter.runs[0]?.input.processEnvironment.key ?? "")).toEqual({ injection: "deny", level: { kind: "account", id: WORK } });
    expect(await givenTo(t, max.id)).toEqual({ HARNESS_TEST_TOKEN: "token-for-tests" });
    expect(JSON.parse(t.adapter.runs[1]?.input.processEnvironment.key ?? "")).toMatchObject({ injection: "allow", level: { kind: "environment" } });
  });

  it("is recorded on the run's policy, a firing that names none recording nothing", async () => {
    const { t, client } = await withSupplier();
    const session = await create(client);

    await fire(t, session.id, "deny");
    await fire(t, session.id, "inherit");

    const policies = t.env.log
      .readStream({ kind: "session", id: session.id })
      .filter((event) => event.type === "run.policy.resolved")
      .map((event) => event.payload as RunPolicyResolvedPayload);
    expect(policies.map((policy) => policy.injection)).toEqual([{ answer: "deny", id: "routine-nightly" }, undefined]);
  });
});

describe("a completions request", () => {
  /** Posts a completions request for `claude-max` as a program, carrying `extension` under agent-harness; resolves once it is answered. */
  const complete = async (t: TestEnvironment, extension: Record<string, unknown>): Promise<void> => {
    const { token } = await t.pair({ kind: "program", scopes: ["read", "sessions:write", "runs:drive"], ceiling: "bypassPermissions", label: "hermes" });
    const answer = await fetch(`http://${t.address.host}:${t.address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "claude-max/opus", messages: [{ role: "user", content: "Summarise the receipts" }], "agent-harness": extension }),
    });
    expect(answer.status).toBe(200);
    await answer.text();
  };

  it("cannot ask for injection: its run gets its account's answer, else the environment's", async () => {
    const { t, client, supplied } = await withSupplier();
    await set(client, { "credentials.injection": "deny" });

    await complete(t, { injection: "allow" });

    expect(await t.adapter.processes.at(-1)?.supplied).toEqual({});
    expect(JSON.parse(t.adapter.lastRun().input.processEnvironment.key)).toEqual({ injection: "deny", level: { kind: "environment" } });

    await set(client, { "credentials.injectionByAccount": { "claude-max": "allow" } });
    await complete(t, { injection: "deny" });

    expect(await t.adapter.processes.at(-1)?.supplied).toEqual({ HARNESS_TEST_TOKEN: "token-for-tests" });
    expect(supplied.map((scope) => [scope.origin, scope.override])).toEqual([["completions", null]]);
  });
});

describe("the process key", () => {
  /** The key the session's latest run was handed, read as JSON. */
  const keyOf = (t: TestEnvironment): unknown => JSON.parse(t.adapter.lastRun().input.processEnvironment.key);

  it("names the answer and the level that decided it, so changing either gives the session's next run a fresh process and a settings write that changes neither does not", async () => {
    const { t, client } = await withSupplier();
    const session = await create(client, { account: "claude-max" });
    await runTo(t, client, session.id);
    expect(keyOf(t)).toMatchObject({ injection: "allow", level: { kind: "environment" } });

    // The same answer from another level: a fresh process.
    await set(client, { "credentials.injectionByAccount": { "claude-max": "allow" } });
    await runTo(t, client, session.id, "The account's now");
    expect(keyOf(t)).toMatchObject({ injection: "allow", level: { kind: "account", id: "claude-max" } });
    expect(t.adapter.processesOf(session.id)).toHaveLength(2);

    // The environment's value changed, but the account's entry still decides: the same process.
    await set(client, { "credentials.injection": "deny", "credentials.injectionByAccount": { "claude-max": "allow", [WORK]: "deny" } });
    await runTo(t, client, session.id, "Nothing changed for this account");
    expect(t.adapter.processesOf(session.id)).toHaveLength(2);

    // Another answer at the same level: a fresh process, given nothing.
    await set(client, { "credentials.injectionByAccount": { "claude-max": "deny" } });
    await runTo(t, client, session.id, "Denied now");
    expect(keyOf(t)).toEqual({ injection: "deny", level: { kind: "account", id: "claude-max" } });
    expect(t.adapter.processesOf(session.id)).toHaveLength(3);
    expect(await givenTo(t, session.id)).toEqual({});
  });
});
