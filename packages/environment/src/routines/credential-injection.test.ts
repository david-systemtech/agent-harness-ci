import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { created, history, runNow, untilEvent, untilSettled, untilStarted, written } from "../../test/routines.js";
import type { ProcessEnvironmentScope } from "../adapter/process-environment.js";

const { onCleanup } = useCleanups();
const VALUE = "credential-for-routine-tests";

/** A supplier that holds its scrub registration only for the process's life. */
const supplyTo = (t: TestEnvironment) => {
  const keys: ProcessEnvironmentScope[] = [];
  const supplies: ProcessEnvironmentScope[] = [];
  const releases: number[] = [];
  t.env.processEnvironments.register({
    name: "routine-test",
    key(scope) {
      keys.push(scope);
      return "routine-test-credentials";
    },
    supply(scope) {
      const index = supplies.push(scope) - 1;
      releases[index] = 0;
      const unregister = t.scrub.register(VALUE, { owner: `routine-test:${index}` });
      return {
        variables: { HARNESS_TEST_CREDENTIAL: VALUE },
        release() {
          releases[index] = (releases[index] ?? 0) + 1;
          unregister();
        },
      };
    },
  });
  return { keys, supplies, releases };
};

const placeScript = (t: TestEnvironment, body: string, path = "credential.sh") => {
  const file = join(t.dataDir, "scripts", path);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return { kind: "script" as const, path };
};

describe("a routine's credential injection", () => {
  it("allows its pre-check and firing to receive credentials even when the environment denies them, scrubbing before release and hashing exact bytes", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const asked = supplyTo(t);
    const client = await t.client();
    await client.request("settings.update", { commandId: randomUUID(), values: { "credentials.injection": "deny" } });
    const preCheck = placeScript(t, 'printf "%s\\n" "${HARNESS_TEST_CREDENTIAL-unset}"');
    const { state } = await created(client, written({ schedule: { kind: "manual" }, injection: "allow", preCheck }));
    const answer = await runNow(client, state.id, { withPreCheck: true });
    if (answer.result === undefined) throw new Error("The firing was refused.");
    const firingId = answer.result.entryId;
    const started = await untilStarted(t, state.id, firingId);
    await untilSettled(t, state.id, firingId);
    const sessionId = started.payload["sessionId"] as string;
    expect(started.payload["preCheck"]).toMatchObject({
      output: "[redacted]\n",
      hash: createHash("sha256").update(`${VALUE}\n`).digest("hex"),
    });
    expect(await t.adapter.processesOf(sessionId)[0]?.supplied).toEqual({ HARNESS_TEST_CREDENTIAL: VALUE });
    expect(asked.supplies).toEqual([
      { sessionId: null, accountId: "claude-max", origin: "routine", holder: "pre-check", override: { answer: "allow", level: { kind: "routine", id: state.id } } },
      { sessionId, accountId: "claude-max", origin: "routine", holder: "provider-process", override: { answer: "allow", level: { kind: "routine", id: state.id } } },
    ]);
    expect(asked.releases).toEqual([1, 0]);
    expect(JSON.stringify(await history(client, state.id))).not.toContain(VALUE);
  });

  it.each([
    ["deny", "allow", false],
    ["deny", "deny", false],
    ["allow", "allow", true],
    ["inherit", "allow", true],
    ["inherit", "deny", false],
  ] as const)("uses %s over the environment's %s for its pre-check, test answer and firing", async (injection, environment, allowed) => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const asked = supplyTo(t);
    const client = await t.client();
    await client.request("settings.update", { commandId: randomUUID(), values: { "credentials.injection": environment } });
    const preCheck = placeScript(t, 'printf "%s\\n" "${HARNESS_TEST_CREDENTIAL-unset}"');
    const { state } = await created(client, written({ schedule: { kind: "manual" }, injection, preCheck }));
    const expected = { output: allowed ? "[redacted]\n" : "unset\n", hash: createHash("sha256").update(allowed ? `${VALUE}\n` : "unset\n").digest("hex") };
    expect(await client.request("routines.testPreCheck", { routineId: state.id })).toMatchObject(expected);
    expect(asked.releases).toEqual(allowed ? [1] : []);
    const answer = await runNow(client, state.id, { withPreCheck: true });
    if (answer.result === undefined) throw new Error("The firing was refused.");
    const firingId = answer.result.entryId;
    const started = await untilStarted(t, state.id, firingId);
    await untilSettled(t, state.id, firingId);
    const sessionId = started.payload["sessionId"] as string;
    expect(started.payload["preCheck"]).toMatchObject(expected);
    expect(await t.adapter.processesOf(sessionId)[0]?.supplied).toEqual(allowed ? { HARNESS_TEST_CREDENTIAL: VALUE } : {});
    expect(asked.keys).toHaveLength(allowed ? 3 : 0);
    expect(asked.supplies).toHaveLength(allowed ? 3 : 0);
    expect(asked.releases).toEqual(allowed ? [1, 1, 0] : []);
    for (const scope of asked.supplies) {
      expect(scope.override).toEqual(injection === "inherit" ? null : { answer: injection, level: { kind: "routine", id: state.id } });
    }
  });

  it("inherits the named account's setting for a firing and its tested pre-check, rather than the default account's", async () => {
    const t = await startTestEnvironment({ accounts: [{ id: "first", provider: "fake" }, { id: "second", provider: "fake" }] });
    onCleanup(() => t.close());
    const asked = supplyTo(t);
    const client = await t.client();
    await client.request("settings.update", { commandId: randomUUID(), values: { "credentials.injection": "deny", "credentials.injectionByAccount": { second: "allow" } } });
    const preCheck = placeScript(t, 'printf "%s\\n" "${HARNESS_TEST_CREDENTIAL-unset}"');
    const { state } = await created(client, written({ schedule: { kind: "manual" }, account: { provider: "fake", email: "second@example.com", organisation: null }, preCheck }));
    expect(await client.request("routines.testPreCheck", { routineId: state.id })).toMatchObject({ output: "[redacted]\n" });
    const answer = await runNow(client, state.id, { withPreCheck: true });
    if (answer.result === undefined) throw new Error("The firing was refused.");
    await untilSettled(t, state.id, answer.result.entryId);
    expect(asked.supplies.map((scope) => scope.accountId)).toEqual(["second", "second", "second"]);
  });

  it("scrubs a failing script's output and standard error in the test answer and history before releasing its registration", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const asked = supplyTo(t);
    const client = await t.client();
    const preCheck = placeScript(t, 'printf "%s\\n" "$HARNESS_TEST_CREDENTIAL"; printf "%s\\n" "$HARNESS_TEST_CREDENTIAL" >&2; exit 1');
    const { state } = await created(client, written({ schedule: { kind: "manual" }, preCheck }));
    const expected = { output: "[redacted]\n", stderr: "[redacted]\n", hash: null, failure: { reason: "exit_status" } };
    expect(await client.request("routines.testPreCheck", { routineId: state.id })).toMatchObject(expected);
    expect(asked.releases).toEqual([1]);
    expect(t.scrub.scrub(VALUE)).toBe(VALUE);
    const answer = await runNow(client, state.id, { withPreCheck: true });
    if (answer.result === undefined) throw new Error("The firing was refused.");
    await untilSettled(t, state.id, answer.result.entryId);
    expect((await history(client, state.id))[0]).toMatchObject({ preCheck: expected, detail: "The script exited with status 1.\n\nThe last of its standard error:\n[redacted]\n" });
    expect(asked.releases).toEqual([1, 1]);
  });

  it("scrubs spawn failure detail while the injected value is still registered", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const asked = supplyTo(t);
    const client = await t.client();
    const preCheck = placeScript(t, "", `${VALUE}.sh`);
    writeFileSync(join(t.dataDir, "scripts", preCheck.path), "#!/a-script-interpreter-that-does-not-exist\n");
    const { state } = await created(client, written({ preCheck }));
    const answer = await client.request("routines.testPreCheck", { routineId: state.id });
    expect(answer.failure?.detail).toContain("[redacted].sh");
    expect(JSON.stringify(answer)).not.toContain(VALUE);
    expect(asked.releases).toEqual([1]);
    expect(t.scrub.scrub(VALUE)).toBe(VALUE);
  });

  it("gives a person's attended run no routine override and replaces a kept process when the answer differs", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const asked = supplyTo(t);
    const client = await t.client();
    await client.request("settings.update", { commandId: randomUUID(), values: { "credentials.injection": "deny" } });
    const { state } = await created(client, written({ schedule: { kind: "manual" }, injection: "allow" }));
    const first = await runNow(client, state.id);
    if (first.result === undefined) throw new Error("The firing was refused.");
    const started = await untilStarted(t, state.id, first.result.entryId);
    const sessionId = started.payload["sessionId"] as string;
    await untilSettled(t, state.id, first.result.entryId);
    const attended = await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Check the report." });
    if (attended.result === undefined) throw new Error("The attended run was refused.");
    const runId = attended.result.runId;
    await untilEvent(t, { kind: "session", id: sessionId }, (event) => event.type === "run.ended" && event.payload["runId"] === runId);
    const [firing, person] = t.adapter.runs;
    expect(person?.input.processEnvironment.key).not.toBe(firing?.input.processEnvironment.key);
    const processes = t.adapter.processesOf(sessionId);
    expect(processes).toHaveLength(2);
    expect(await processes[1]?.supplied).toEqual({});
    expect(asked.releases).toEqual([1]);
    const policy = t.env.log.readStream({ kind: "session", id: sessionId }).find((event) => event.type === "run.policy.resolved" && event.payload["runId"] === runId);
    expect(policy?.payload).not.toHaveProperty("injection");
  });

  it("tests an unsaved pre-check with inherited injection on the default account and no routine override", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const asked = supplyTo(t);
    const client = await t.client();
    const preCheck = placeScript(t, 'printf "%s\\n" "${HARNESS_TEST_CREDENTIAL-unset}"');
    expect(await client.request("routines.testPreCheck", { preCheck, workspace: { kind: "scratch", repositoryIdentity: null } })).toMatchObject({ output: "[redacted]\n" });
    expect(asked.supplies).toEqual([{ sessionId: null, accountId: "claude-max", origin: "routine", holder: "pre-check", override: null }]);
    expect(asked.releases).toEqual([1]);
  });

  it.each(["timeout", "close"] as const)("releases injected variables when %s ends a pre-check's process", async (cause) => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const asked = supplyTo(t);
    const client = await t.client();
    const ready = join(t.dataDir, "ready");
    const preCheck = placeScript(t, `echo ready > '${ready}'; sleep 600`);
    const { state } = await created(client, written({ schedule: { kind: "manual" }, preCheck: { ...preCheck, timeoutSeconds: 60 } }));
    const answer = await runNow(client, state.id, { withPreCheck: true });
    if (answer.result === undefined) throw new Error("The firing was refused.");
    while (!existsSync(ready)) await sleep(5);
    expect(asked.releases).toEqual([0]);
    if (cause === "close") await t.close();
    else {
      t.clock.advance(60_000);
      await untilSettled(t, state.id, answer.result.entryId);
    }
    expect(asked.releases).toEqual([1]);
    expect(t.scrub.scrub(VALUE)).toBe(VALUE);
  });

  it("releases injected variables when a script exceeds the output limit", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const asked = supplyTo(t);
    const client = await t.client();
    const preCheck = placeScript(t, 'while :; do printf "%s\\n" "$HARNESS_TEST_CREDENTIAL"; done');
    const { state } = await created(client, written({ schedule: { kind: "manual" }, preCheck }));
    const answer = await runNow(client, state.id, { withPreCheck: true });
    if (answer.result === undefined) throw new Error("The firing was refused.");
    await untilSettled(t, state.id, answer.result.entryId);
    expect((await history(client, state.id))[0]?.preCheck?.failure?.reason).toBe("output_too_large");
    expect(asked.releases).toEqual([1]);
    expect(t.scrub.scrub(VALUE)).toBe(VALUE);
  });
});
