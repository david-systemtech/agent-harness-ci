import { randomUUID } from "node:crypto";
import type { RoutineDefinitionInput, SessionCreatedPayload } from "@agent-harness/contracts";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { end, fakeAdapter, gate, say, signedInAs, type Gate, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { created, history, listed, ranNow, routineCommand, routineEvents, runNow, untilSettled, untilStarted, written } from "../../test/routines.js";
import { get, refusal } from "../../test/sessions.js";
import { makeDirectory, scriptedResolver } from "../../test/workspaces.js";

/**
 * A routine's firing through run now (routines spec, "A firing"; #523),
 * through the primary seam: an in-process environment and a real client,
 * the scripted fake provider, the manual clock, and real directories and
 * git repositories in the temporary directory. What is asserted is what a
 * client sees: the answer, the history, the list, the firing's session and
 * its stream.
 */

const { onCleanup, tempDir } = useCleanups();

/** The zone the test environment runs in: not the machine's, so a preset zone is visibly the environment's. */
const ZONE = "Asia/Manila";

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ timeZone: ZONE, name: "laptop", ...options });
  onCleanup(() => t.close());
  return t;
};

/** A routine as a client writes it, firing in a scratch directory of its own. */
const routine = (overrides: Partial<RoutineDefinitionInput> = {}): RoutineDefinitionInput => written({ schedule: { kind: "manual" }, ...overrides });

const sessionEvents = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId });

/** A run that says it is working and waits for `held` to open, then says `text` and completes. */
const heldRun =
  (held: Gate, text = "Done."): Script =>
  async function* () {
    yield say("Working");
    await held.opened;
    yield say(text);
    yield end();
  };

/** A gate opened when the test ends, so a run it holds never outlives it. */
const heldGate = (): Gate => {
  const held = gate();
  onCleanup(() => held.open());
  return held;
};

describe("routines.runNow", () => {
  it("answers at once with the entry id, and the firing is a session tagged with the routine, made as the routine with the firing id as its command id", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine({ name: "Upstream watch", timezone: "Europe/London", model: "sonnet", mode: "plan" }));
    const routineId = state.id;

    const answer = await runNow(client, routineId);
    expect(answer.receipt).toMatchObject({ status: "accepted" });
    const firingId = answer.result?.entryId as string;
    const started = await untilStarted(t, routineId, firingId);
    const { sessionId, runId } = started.payload as { sessionId: string; runId: string };
    expect(started).toMatchObject({
      actor: `routine:${routineId}`,
      commandId: firingId,
      payload: { firingId, trigger: "run-now", dueAt: MANUAL_CLOCK_START, count: 1, requestedBy: client.hello.clientSessionId, preCheck: null, targets: [{ kind: "client-notice", on: "both" }] },
    });

    const [createdEvent] = sessionEvents(t, sessionId);
    expect(createdEvent).toMatchObject({ type: "session.created", actor: `routine:${routineId}`, commandId: firingId });
    expect(createdEvent?.payload as SessionCreatedPayload).toMatchObject({
      // The due time in the routine's zone: 00:00 UTC is 01:00 in London in September.
      title: "Upstream watch 2026-09-24 01:00",
      tags: ["routine", "Upstream watch"],
      account: "claude-max",
      model: "sonnet",
      mode: "plan",
    });
    expect(await get(client, sessionId)).toMatchObject({ title: "Upstream watch 2026-09-24 01:00", tags: ["routine", "Upstream watch"], accountId: "claude-max", model: "sonnet" });

    const ended = await untilSettled(t, routineId, firingId);
    expect(ended).toMatchObject({ type: "routine.firing-ended", actor: `routine:${routineId}`, payload: { firingId, outcome: "succeeded", reason: null } });
    const [entry] = await history(client, routineId);
    expect(entry).toMatchObject({ kind: "firing", id: firingId, sessionId, runId, trigger: "run-now", outcome: "succeeded", requestedBy: client.hello.clientSessionId });
    expect((await listed(client, routineId))?.state).toMatchObject({
      liveFiring: null,
      lastOutcome: { kind: "firing", entryId: firingId, outcome: "succeeded", reason: null, at: MANUAL_CLOCK_START },
      failureStreak: 0,
    });
    expect(await ranNow(client, routineId)).not.toBe(firingId);
  });

  it("refuses a run now while a firing of the routine is starting or live, conflict firing_running, and takes one again once it has ended", async () => {
    const root = tempDir();
    const resolving = heldGate();
    const resolver = scriptedResolver(async ({ sessionId }) => {
      if (resolver.calls.length === 1) await resolving.opened;
      return makeDirectory(join(root, sessionId), { kind: "scratch", path: join(root, sessionId) });
    });
    const t = await start({ workspaceResolver: resolver });
    const client = await t.client();
    const { state } = await created(client, routine());
    const held = heldGate();
    t.adapter.nextScripts.push(heldRun(held));

    const firingId = await ranNow(client, state.id);
    // Asked again while its workspace is being made, and again while its run is live.
    const conflict = { status: "rejected", reason: "conflict", error: { code: "conflict", data: { reason: "firing_running", routineId: state.id } } };
    await vi.waitFor(() => expect(resolver.calls).toHaveLength(1));
    expect((await runNow(client, state.id)).receipt).toMatchObject(conflict);
    resolving.open();
    const started = await untilStarted(t, state.id, firingId);
    expect((await runNow(client, state.id)).receipt).toMatchObject(conflict);
    expect((await listed(client, state.id))?.state.liveFiring).toEqual({
      firingId,
      trigger: "run-now",
      dueAt: MANUAL_CLOCK_START,
      startedAt: MANUAL_CLOCK_START,
      sessionId: started.payload["sessionId"],
      runId: started.payload["runId"],
    });

    held.open();
    await untilSettled(t, state.id, firingId);
    const next = await ranNow(client, state.id);
    await untilSettled(t, state.id, next);
    expect((await history(client, state.id)).map((entry) => entry.id)).toEqual([next, firingId]);
  });

  it("answers a repeated command id from its receipt, starting nothing twice", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine());
    const commandId = randomUUID();
    const first = await runNow(client, state.id, { commandId });
    const firingId = first.result?.entryId as string;
    await untilSettled(t, state.id, firingId);

    expect(await runNow(client, state.id, { commandId })).toEqual({ receipt: first.receipt });
    expect((await history(client, state.id)).map((entry) => entry.id)).toEqual([firingId]);
    expect(t.adapter.runs).toHaveLength(1);
  });

  it("refuses a routine the environment does not hold, or has deleted, not_found, and needs runs:drive; the history needs read", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine());
    await routineCommand(client, "routines.delete", { routineId: state.id });
    for (const routineId of [randomUUID(), state.id]) {
      expect((await runNow(client, routineId)).receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "routine", routineId } } });
      expect(await refusal(history(client, routineId))).toEqual({ code: "not_found", data: { kind: "routine", routineId } });
    }

    const kept = await created(client, routine({ name: "Kept" }));
    const writer = await t.client({ token: (await t.pair({ scopes: ["read", "sessions:write"] })).token });
    expect(await refusal(runNow(writer, kept.state.id))).toEqual({ code: "forbidden", data: { scope: "runs:drive" } });
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    expect(await history(reader, kept.state.id)).toEqual([]);
    expect(routineEvents(t, kept.state.id).map((event) => event.type)).toEqual(["routine.created"]);
  });
});

/** The identity of an account the fake signs in as `<id>@example.com`. */
const identityOf = (email: string) => ({ provider: "fake", email, organisation: null });

describe("a firing that cannot start", () => {
  it("is a skip cannot-start with no session when the account is missing, signed out, or does not offer the model; each counts as a failure", async () => {
    const adapter = fakeAdapter();
    const t = await start({ adapter, accounts: [{ id: "work", provider: "fake" }, { id: "home", provider: "fake" }] });
    const client = await t.client();
    const skipOf = async (definition: RoutineDefinitionInput) => {
      const { state } = await created(client, definition);
      const entryId = await ranNow(client, state.id);
      await untilSettled(t, state.id, entryId);
      return { routineId: state.id, entryId, entries: await history(client, state.id), listed: await listed(client, state.id) };
    };

    const absent = await skipOf(routine({ name: "Absent", account: identityOf("nobody@example.com") }));
    expect(absent.entries).toEqual([
      {
        kind: "skip",
        id: absent.entryId,
        trigger: "run-now",
        count: 1,
        preCheck: null,
        deliveries: [],
        dueAt: MANUAL_CLOCK_START,
        at: MANUAL_CLOCK_START,
        reason: "cannot-start",
        cannotStart: "account_missing",
        detail: "No account here is signed in as nobody@example.com on fake.",
      },
    ]);
    expect(absent.listed?.state).toMatchObject({ liveFiring: null, lastOutcome: { kind: "skip", entryId: absent.entryId, reason: "cannot-start", at: MANUAL_CLOCK_START }, failureStreak: 1 });
    expect(absent.listed?.attention).toEqual(["account_missing", "failing"]);

    const unoffered = await skipOf(routine({ name: "Unoffered", account: identityOf("home@example.com"), model: "a-model-nobody-offers" }));
    expect(unoffered.entries[0]).toMatchObject({ reason: "cannot-start", cannotStart: "model_unavailable", detail: "The account home does not offer the model a-model-nobody-offers." });

    adapter.setStatus(() => signedInAs(null));
    await client.request("accounts.refresh", {});
    const signedOut = await skipOf(routine({ name: "Signed out", account: identityOf("home@example.com") }));
    expect(signedOut.entries[0]).toMatchObject({ reason: "cannot-start", cannotStart: "account_signed_out", detail: "The account home is not signed in on this environment." });

    // No session was made for any of them, and no run started.
    expect((await client.request("sessions.list", {})).sessions).toEqual([]);
    expect(t.adapter.runs).toHaveLength(0);
  });

  it("is account_missing when the routine names no account and the environment has no default", async () => {
    const t = await start({ accounts: [] });
    const client = await t.client();
    const { state } = await created(client, routine());
    const entryId = await ranNow(client, state.id);
    expect((await untilSettled(t, state.id, entryId)).payload).toMatchObject({
      skipId: entryId,
      reason: "cannot-start",
      cannotStart: "account_missing",
      detail: "No account is the environment's default, so the firing has none to run on.",
    });
  });
});

describe("the failure streak", () => {
  it("counts consecutive failed firings and cannot-start skips, and a succeeded firing resets it", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine({ model: "a-model-nobody-offers" }));
    const fire = async () => untilSettled(t, state.id, await ranNow(client, state.id));
    const streak = async () => (await listed(client, state.id))?.state.failureStreak;

    await fire();
    await fire();
    expect(await streak()).toBe(2);
    t.adapter.nextScripts.push(() => [end("error", { error: { message: "The provider failed.", code: null } })]);
    await routineCommand(client, "routines.update", { routineId: state.id, fields: { model: null } });
    await fire();
    expect(await streak()).toBe(3);
    expect((await listed(client, state.id))?.attention).toEqual(["failing"]);

    await fire();
    expect(await streak()).toBe(0);
    expect((await listed(client, state.id))?.attention).toEqual([]);
  });
});
