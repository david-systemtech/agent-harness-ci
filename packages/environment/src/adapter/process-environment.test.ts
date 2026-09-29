import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, runCommand, say, type FakeAdapter, type FakeAdapterOptions } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { fakePty } from "../../test/fake-pty.js";
import { create } from "../../test/sessions.js";
import { openTerminal, terminalCommand } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";
import type { AdapterEvent } from "./contract.js";
import { presetInjection, type InjectionAnswer, type ProcessEnvironmentScope, type ProcessEnvironmentSupplier } from "./process-environment.js";

/**
 * The process environment through the primary seam (forge spec, "Per
 * provider process"; #307): an in-process environment with the scripted
 * fake adapter, which reports the variables its process was given and runs
 * a scripted command in them, driven by a real client. What is asserted is
 * what the fake was handed and what its process was given, what a test
 * supplier was asked and released, and what the log and the data directory
 * hold, never the registry's own state.
 */

const { onCleanup, tempDir } = useCleanups();

/** A provider process's idle time, the setting's preset. */
const IDLE = 30 * 60_000;

/** What a run reports as a Claude run's first init does, so a later rewind has a provider session to rewind. */
const linked: AdapterEvent = { type: "session.provider-linked", payload: { providerSessionId: "provider-1" } };

const start = async (adapter: FakeAdapterOptions | FakeAdapter = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: "descriptor" in adapter ? adapter : fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

const events = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId });
const ended = (t: TestEnvironment, sessionId: string) => events(t, sessionId).filter((event) => event.type === "run.ended");
/** What the session's runs said, as their `assistant.text` recorded it. */
const texts = (t: TestEnvironment, sessionId: string): unknown[] =>
  events(t, sessionId).flatMap((event) => (event.type === "assistant.text" ? [event.payload["text"]] : []));

/** Starts a run on the session and waits for its end. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts") => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1));
  return answer.result;
};

/**
 * A supplier a test registers: its part of the key names its generation,
 * which `next` raises; each spawn is supplied `variables`. It records the
 * scope it was asked each key and each supply for, and how many times each
 * spawn's release was called.
 */
const testSupplier = (variables: Readonly<Record<string, string>>, name = "test") => {
  const asked = { keys: [] as ProcessEnvironmentScope[], supplies: [] as ProcessEnvironmentScope[], releases: [] as number[] };
  let generation = 1;
  const supplier: ProcessEnvironmentSupplier = {
    name,
    key: (scope) => {
      asked.keys.push(scope);
      return `generation ${generation}`;
    },
    supply: (scope) => {
      const spawn = asked.supplies.push(scope) - 1;
      asked.releases[spawn] = 0;
      return { variables, release: () => void (asked.releases[spawn] = (asked.releases[spawn] ?? 0) + 1) };
    },
  };
  return { supplier, asked, next: () => void (generation += 1) };
};

describe("a run's process environment", () => {
  it("has an empty key and adds nothing while no supplier is registered", async () => {
    const t = await start();
    const client = await t.client();
    const session = await create(client);

    await runTo(t, client, session.id);

    expect(t.adapter.lastRun().input.processEnvironment.key).toBe("");
    const [process] = t.adapter.processesOf(session.id);
    expect(await process?.supplied).toEqual({});
  });

  it("gives the process a registered supplier's variables, asked once per spawn, and a command the provider runs has them", async () => {
    const t = await start();
    const { supplier, asked } = testSupplier({ HARNESS_TEST_TOKEN: "token-for-tests" });
    t.env.processEnvironments.register(supplier);
    const client = await t.client();
    const session = await create(client);
    t.adapter.nextScripts.push(async function* (controls) {
      const result = yield* runCommand(controls, 'test "$HARNESS_TEST_TOKEN" = token-for-tests && echo matched');
      yield say(`The command said ${result.stdout.trim()}`);
      yield end();
    });

    await runTo(t, client, session.id);
    await runTo(t, client, session.id, "And the refunds");

    const [first, second] = t.adapter.runs;
    expect(first?.input.processEnvironment.key).not.toBe("");
    expect(second?.input.processEnvironment.key).toBe(first?.input.processEnvironment.key);
    // Both runs went to the one process, spawned once and supplied once.
    expect(t.adapter.processesOf(session.id)).toHaveLength(1);
    expect(await t.adapter.processesOf(session.id)[0]?.supplied).toEqual({ HARNESS_TEST_TOKEN: "token-for-tests" });
    expect(asked.supplies).toEqual([{ sessionId: session.id, accountId: "claude-max", origin: "client" }]);
    expect(texts(t, session.id)).toContain("The command said matched");
  });

  it("is built the same way for every run, whatever started it: a client, the completions surface, a routine", async () => {
    const t = await start();
    const { supplier, asked } = testSupplier({ HARNESS_TEST_VARIABLE: "for every run" });
    t.env.processEnvironments.register(supplier);
    const client = await t.client();
    const attended = await create(client);
    await runTo(t, client, attended.id);
    const { token } = await t.pair({ kind: "program", scopes: ["read", "sessions:write", "runs:drive"], ceiling: "bypassPermissions", label: "hermes" });
    const completion = await fetch(`http://${t.address.host}:${t.address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "claude-max/opus", messages: [{ role: "user", content: "Summarise the receipts" }] }),
    });
    expect(completion.status).toBe(200);
    await completion.text();
    const routine = await create(client);
    t.env.startRun({ sessionId: routine.id, text: "Nightly", actor: { kind: "routine", name: "nightly", ceiling: "acceptEdits", clientSessionId: null }, actorId: "routine-nightly" });
    await vi.waitFor(() => expect(ended(t, routine.id)).toHaveLength(1));

    const keys = t.adapter.runs.map((run) => run.input.processEnvironment.key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(asked.keys.map((scope) => scope.origin)).toEqual(["client", "completions", "routine"]);
    expect(asked.supplies.map((scope) => scope.origin)).toEqual(["client", "completions", "routine"]);
    const given = await Promise.all(t.adapter.processes.map((process) => process.supplied));
    expect(given).toEqual([{ HARNESS_TEST_VARIABLE: "for every run" }, { HARNESS_TEST_VARIABLE: "for every run" }, { HARNESS_TEST_VARIABLE: "for every run" }]);
  });

  it("leaves out a supplier that fails, saying so, and gives the process the others' variables, the later registered winning a name both give", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    const t = await start();
    const first = testSupplier({ HARNESS_SHARED: "first", HARNESS_FIRST: "1" }, "first");
    const failing: ProcessEnvironmentSupplier = {
      name: "failing",
      key: () => "failing",
      supply: () => Promise.reject(new Error("The vault is sealed.")),
    };
    const keyless: ProcessEnvironmentSupplier = {
      name: "keyless",
      key: () => {
        throw new Error("No key today.");
      },
      supply: () => ({ variables: { HARNESS_KEYLESS: "never" }, release: () => undefined }),
    };
    const last = testSupplier({ HARNESS_SHARED: "last" }, "last");
    for (const supplier of [first.supplier, failing, keyless, last.supplier]) t.env.processEnvironments.register(supplier);
    const client = await t.client();
    const session = await create(client);

    await runTo(t, client, session.id);

    expect(await t.adapter.processesOf(session.id)[0]?.supplied).toEqual({ HARNESS_SHARED: "last", HARNESS_FIRST: "1" });
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining("supplier keyless could not give its key"), expect.stringContaining("supplier failing failed")]),
    );
  });

  it("refuses a second supplier under a name registered already", async () => {
    const t = await start();
    t.env.processEnvironments.register(testSupplier({}, "forge").supplier);

    expect(() => t.env.processEnvironments.register(testSupplier({}, "forge").supplier)).toThrow(/named forge is registered already/);
  });

  it("never writes the variables to the data directory or the log", async () => {
    const value = `token-for-tests-${randomUUID()}`;
    const dataDir = join(tempDir(), "data");
    const t = await start({}, { dataDir });
    t.env.processEnvironments.register(testSupplier({ HARNESS_TEST_TOKEN: value }).supplier);
    const client = await t.client();
    const session = await create(client);
    await runTo(t, client, session.id);
    expect(await t.adapter.processesOf(session.id)[0]?.supplied).toEqual({ HARNESS_TEST_TOKEN: value });

    const logged = t.env.log.read<{ payload: string }>("SELECT payload FROM events");
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.some((row) => row.payload.includes(value))).toBe(false);
    await t.close();
    const written = readdirSync(dataDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((entry) => readFileSync(join(entry.parentPath, entry.name)).includes(value)).map((entry) => entry.name)).toEqual([]);
  });
});

describe("the injection answer", () => {
  it("is asked once per run, of a seam whose preset allows, for the run's session, account and origin", async () => {
    const answered: ProcessEnvironmentScope[] = [];
    const t = await start({}, { adapterSeams: { injection: (scope) => (answered.push(scope), presetInjection(scope)) } });
    const { supplier, asked } = testSupplier({ HARNESS_TEST_TOKEN: "token-for-tests" });
    t.env.processEnvironments.register(supplier);
    const client = await t.client();
    const session = await create(client);

    await runTo(t, client, session.id);
    await runTo(t, client, session.id, "And the refunds");

    expect(answered).toEqual([
      { sessionId: session.id, accountId: "claude-max", origin: "client" },
      { sessionId: session.id, accountId: "claude-max", origin: "client" },
    ]);
    expect(asked.supplies).toHaveLength(1);
  });

  it("asks no supplier on deny, so nothing is supplied, and is in the key: a run denied after an allowed one is served by a fresh process", async () => {
    let answer: InjectionAnswer = "allow";
    const t = await start({}, { adapterSeams: { injection: () => answer } });
    const { supplier, asked } = testSupplier({ HARNESS_TEST_TOKEN: "token-for-tests" });
    t.env.processEnvironments.register(supplier);
    const client = await t.client();
    const session = await create(client);
    await runTo(t, client, session.id);

    answer = "deny";
    await runTo(t, client, session.id, "And the refunds");

    const [allowed, denied] = t.adapter.runs;
    expect(denied?.input.processEnvironment.key).not.toBe(allowed?.input.processEnvironment.key);
    expect(denied?.input.processEnvironment.key).not.toBe("");
    expect(t.adapter.processesOf(session.id)).toHaveLength(2);
    expect(await t.adapter.processesOf(session.id)[1]?.supplied).toEqual({});
    // The supplier was asked for the allowed run alone, and what it supplied was released as the denied run's spawn replaced it.
    expect(asked.keys).toHaveLength(1);
    expect(asked.supplies).toHaveLength(1);
    expect(asked.releases).toEqual([1]);
  });
});

describe("the release of what a process was supplied", () => {
  /** An environment with a test supplier registered, a client, and a session that has run once. */
  const ranOnce = async (adapter: FakeAdapterOptions = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}) => {
    const t = await start(adapter, options);
    const supplied = testSupplier({ HARNESS_TEST_TOKEN: "token-for-tests" });
    t.env.processEnvironments.register(supplied.supplier);
    const client = await t.client();
    const session = await create(client);
    const first = await runTo(t, client, session.id);
    expect(supplied.asked.releases).toEqual([0]);
    return { t, client, session, first, ...supplied };
  };

  it("is called once as the process stops for its idle time, and a cold spawn after is supplied afresh", async () => {
    const { t, client, session, asked } = await ranOnce();

    t.clock.advance(IDLE);
    await vi.waitFor(() => expect(asked.releases).toEqual([1]));
    await runTo(t, client, session.id, "Back again");

    expect(asked.releases).toEqual([1, 0]);
    expect(t.adapter.processesOf(session.id)).toHaveLength(2);
  });

  it("is called once when the process exits on its own", async () => {
    const { t, session, asked } = await ranOnce();

    t.adapter.exit(session.id);

    expect(asked.releases).toEqual([1]);
  });

  it("is called once when a rewind stops the process", async () => {
    const { t, client, session, asked } = await ranOnce({ capabilities: { rewind: true }, script: ({ input }) => [linked, say(`Done: ${input.prompt[0]?.text}`), end()] });
    const second = await runTo(t, client, session.id, "And the refunds");

    const answer = registry["sessions.rewind"].response.parse(await client.request("sessions.rewind", { commandId: randomUUID(), sessionId: session.id, messageId: second.messageId }));

    expect(answer.receipt.status).toBe("accepted");
    await vi.waitFor(() => expect(asked.releases).toEqual([1]));
  });

  it("is called once when a drain stops the process, and not again as the environment closes", async () => {
    const { t, asked } = await ranOnce();

    const drained = t.env.drain("command");
    t.clock.advance(0);
    await drained;

    expect(asked.releases).toEqual([1]);
  });

  it("is called once as the environment closes", async () => {
    const { t, asked } = await ranOnce();

    await t.close();

    expect(asked.releases).toEqual([1]);
  });

  it("is called once when a run whose key differs lets the process go, and the fresh process is supplied its own", async () => {
    const { t, client, session, asked, next } = await ranOnce();
    next();

    await runTo(t, client, session.id, "After the change");

    expect(asked.releases).toEqual([1, 0]);
    const [before, after] = t.adapter.processesOf(session.id);
    expect(before).toMatchObject({ stopped: true });
    expect(after).toMatchObject({ stopped: false, runs: 1 });
    expect(after?.key).not.toBe(before?.key);
  });

  it("is never called for a run that ended before its adapter was asked for it: nothing was supplied", async () => {
    const t = await start({}, { adapterSeams: { instructions: () => new Promise(() => undefined) } });
    const { supplier, asked } = testSupplier({ HARNESS_TEST_TOKEN: "token-for-tests" });
    t.env.processEnvironments.register(supplier);
    const client = await t.client();
    const session = await create(client);
    const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId: session.id, text: "Fix the receipts" }));

    await client.request("runs.interrupt", { commandId: randomUUID(), runId: answer.result?.runId as string });

    await vi.waitFor(() => expect(ended(t, session.id)).toHaveLength(1));
    await t.close();
    expect(t.adapter.processes).toEqual([]);
    expect(asked).toEqual({ keys: [], supplies: [], releases: [] });
  });
});

describe("a session's terminal", () => {
  it("holds the session's process environment: supplied as it opens, for the session's account and a client, and released once as it closes", async () => {
    const pty = fakePty();
    const t = await start({}, { terminals: { pty, shell: () => ({ file: "/bin/sh", args: [] }) } });
    const { supplier, asked } = testSupplier({ HARNESS_TEST_TOKEN: "token-for-tests" });
    t.env.processEnvironments.register(supplier);
    const client = await t.client();
    const session = await create(client);

    const terminal = await openTerminal(client, session.id);

    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    expect(pty.spawned[0]?.options.env).toMatchObject({ HARNESS_TEST_TOKEN: "token-for-tests" });
    expect(asked.supplies).toEqual([{ sessionId: session.id, accountId: "claude-max", origin: "client" }]);
    await terminalCommand(client, "terminals.close", { id: terminal.id });
    await vi.waitFor(() => expect(asked.releases).toEqual([1]));
  });
});
