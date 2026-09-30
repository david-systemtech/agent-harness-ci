import { randomUUID } from "node:crypto";
import {
  MAX_ROUTINE_TEXT,
  registry,
  type MessageSentPayload,
  type Mode,
  type PromptAnsweredPayload,
  type RoutineDefinitionInput,
  type RunPolicyResolvedPayload,
  type RunStartedPayload,
  type SessionCreatedPayload,
  type Workspace,
} from "@agent-harness/contracts";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { bubblewrapProbe } from "../../test/containment.js";
import { ask, end, fakeAdapter, gate, say, signedInAs, type Gate, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { created, history, listed, ranNow, routineCommand, routineEvents, routineUpdates, runNow, untilEvent, untilSettled, untilStarted, written } from "../../test/routines.js";
import { deleteSession, get, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { git, makeDirectory, scriptedResolver } from "../../test/workspaces.js";

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

/** Resolves once the run has said it is working: its adapter has it, past its skill set and its instructions (#493, #496). */
const working = (t: TestEnvironment, sessionId: string, runId: string) =>
  untilEvent(t, { kind: "session", id: sessionId }, (event) => event.type === "assistant.text" && event.payload["runId"] === runId);

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

/** A repository of the test's own with one commit on `main`; answers its main checkout. */
const repository = (): string => {
  const checkout = join(tempDir("agent-harness-repository-"), "app");
  git(tempDir(), "init", "-q", checkout);
  writeFileSync(join(checkout, "README.md"), "# app\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "first");
  return checkout;
};

/** The firing's session's workspace, once it has started. */
const workspaceOf = async (t: TestEnvironment, client: WireClient, routineId: string, firingId: string) =>
  (await get(client, (await untilStarted(t, routineId, firingId)).payload["sessionId"] as string)).workspace;

describe("a firing's workspace", () => {
  it("goes through the resolver: a directory is checked, and one it cannot use is cannot-start workspace_unusable with the resolver's problem", async () => {
    const t = await start();
    const client = await t.client();
    const directory = tempDir();
    const { state } = await created(client, routine({ workspace: { kind: "directory", path: directory, repositoryIdentity: null } }));
    const firingId = await ranNow(client, state.id);
    expect(await workspaceOf(t, client, state.id, firingId)).toEqual({ kind: "directory", path: directory });
    await untilSettled(t, state.id, firingId);

    const gone = join(directory, "gone");
    await routineCommand(client, "routines.update", { routineId: state.id, fields: { workspace: { kind: "directory", path: gone, repositoryIdentity: null } } });
    const skipId = await ranNow(client, state.id);
    expect((await untilSettled(t, state.id, skipId)).payload).toMatchObject({
      reason: "cannot-start",
      cannotStart: "workspace_unusable",
      detail: `There is no directory ${gone} on this environment. (does_not_exist)`,
    });
    expect((await client.request("sessions.list", {})).sessions).toHaveLength(1);
  });

  it("makes a scratch directory per firing", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine({ workspace: { kind: "scratch", repositoryIdentity: null } }));
    const places = [];
    for (let n = 0; n < 2; n += 1) {
      const firingId = await ranNow(client, state.id);
      places.push(await workspaceOf(t, client, state.id, firingId));
      await untilSettled(t, state.id, firingId);
    }
    const [first, second] = places;
    expect(first?.kind).toBe("scratch");
    expect(second?.kind).toBe("scratch");
    expect(first?.path).not.toBe(second?.path);
    for (const place of places) expect(place?.path.startsWith(join(t.dataDir, "scratch"))).toBe(true);
    expect(places.every((place) => existsSync(place?.path ?? ""))).toBe(true);
  });

  it("makes a worktree per firing, each on a branch of its own", async () => {
    const t = await start();
    const client = await t.client();
    const checkout = repository();
    const { state } = await created(client, routine({ workspace: { kind: "worktree", repository: checkout, repositoryIdentity: null } }));
    const places = [];
    for (let n = 0; n < 2; n += 1) {
      const firingId = await ranNow(client, state.id);
      places.push(await workspaceOf(t, client, state.id, firingId));
      await untilSettled(t, state.id, firingId);
    }
    expect(places.map((place) => place.kind)).toEqual(["worktree", "worktree"]);
    const [first, second] = places as [Extract<Workspace, { kind: "worktree" }>, Extract<Workspace, { kind: "worktree" }>];
    expect(first.branch).not.toBe(second.branch);
    expect(first.path).not.toBe(second.path);
    const listed = git(checkout, "worktree", "list", "--porcelain");
    expect(listed).toContain(first.path);
    expect(listed).toContain(second.path);
  });
});

describe("the firing's transaction", () => {
  it("rolls back whole when the run's start refuses, and the resolver's undo removes the worktree it made: cannot-start start_refused, no session", async () => {
    const t = await start();
    const client = await t.client();
    const checkout = repository();
    const branches = git(checkout, "branch", "--list");
    // haiku takes no effort, so the run's start refuses the one the routine names.
    const { state } = await created(client, routine({ model: "haiku", effort: "high", workspace: { kind: "worktree", repository: checkout, repositoryIdentity: null } }));
    const entryId = await ranNow(client, state.id);
    expect((await untilSettled(t, state.id, entryId)).payload).toMatchObject({
      skipId: entryId,
      reason: "cannot-start",
      cannotStart: "start_refused",
      detail: "The model haiku does not take the effort high.",
    });
    expect((await client.request("sessions.list", {})).sessions).toEqual([]);
    expect(t.env.log.readStream({ kinds: ["session"] })).toEqual([]);
    expect(git(checkout, "branch", "--list")).toBe(branches);
    expect(git(checkout, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(t.adapter.runs).toHaveLength(0);
  });

  it("leaves no session when it fails between the resolver's prepare and the commit, and removes the scratch directory made for it", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine({ workspace: { kind: "scratch", repositoryIdentity: null } }));
    const append = t.env.log.append.bind(t.env.log);
    let failed = false;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => quiet.mockRestore());
    vi.spyOn(t.env.log, "append").mockImplementation((stream, events, options) => {
      if (!failed && events.some((event) => event.type === "session.created")) {
        failed = true;
        throw new Error("The disk is full.");
      }
      return append(stream, events, options);
    });

    const entryId = await ranNow(client, state.id);
    expect((await untilSettled(t, state.id, entryId)).payload).toMatchObject({ reason: "cannot-start", cannotStart: "start_refused", detail: "The disk is full." });
    expect((await client.request("sessions.list", {})).sessions).toEqual([]);
    expect(readdirSync(join(t.dataDir, "scratch"))).toEqual([]);
    expect(t.adapter.runs).toHaveLength(0);

    // The next firing starts whole.
    const next = await ranNow(client, state.id);
    await untilStarted(t, state.id, next);
    expect(await untilSettled(t, state.id, next)).toMatchObject({ type: "routine.firing-ended" });
    expect(readdirSync(join(t.dataDir, "scratch"))).toHaveLength(1);
  });
});

/** A client of a client session paired under `ceiling` with the scopes run now and the routine commands need, as a phone would be. */
const paired = async (t: TestEnvironment, ceiling: Mode, label = "a phone"): Promise<WireClient> =>
  t.client({ token: (await t.pair({ kind: "web", label, ceiling, scopes: ["read", "sessions:write", "runs:drive"] })).token, clientKind: "web" });

/** The run's `run.ended`, once it is on the log. */
const untilRunEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  untilEvent(t, { kind: "session", id: sessionId }, (event) => event.type === "run.ended" && event.payload["runId"] === runId);

/** The payloads of the session's events of `type`. */
const payloadsOf = <P>(t: TestEnvironment, sessionId: string, type: string): P[] =>
  sessionEvents(t, sessionId)
    .filter((event) => event.type === type)
    .map((event) => event.payload as P);

describe("the firing's run", () => {
  it("starts with a header naming the routine, the environment and the due time, that nobody is present, and the marker, then the instructions", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine({ name: "Upstream watch", silenceMarker: "[QUIET]", instructions: "Read the sources and file a digest." }));
    const firingId = await ranNow(client, state.id);
    const { sessionId } = (await untilStarted(t, state.id, firingId)).payload as { sessionId: string };
    expect(payloadsOf<MessageSentPayload>(t, sessionId, "message.sent").map((sent) => sent.text)).toEqual([
      [
        'This is a firing of the routine "Upstream watch" on the environment "laptop", due 2026-09-24 08:00 (Asia/Manila).',
        "Nobody is present: prompts are answered automatically, and anything that needs a person's approval is denied.",
        "If there is nothing worth reporting, answer with [QUIET] alone, and nothing is sent.",
        "",
        "Read the sources and file a digest.",
      ].join("\n"),
    ]);
  });

  it("runs unattended as the routine, by its name and effort: a prompt is denied at once and the run goes on, and the Unattended review lists it under the routine's name", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine({ name: "Nightly receipts", model: "opus", effort: "low" }));
    t.adapter.nextScripts.push(ask("permission", { toolName: "Bash", toolCallId: "toolu_1", input: { command: "sudo apt install jq" }, summary: "Claude wants to run sudo apt install jq" }));
    const firingId = await ranNow(client, state.id);
    const { sessionId, runId } = (await untilStarted(t, state.id, firingId)).payload as { sessionId: string; runId: string };
    expect((await untilSettled(t, state.id, firingId)).payload).toMatchObject({ outcome: "succeeded" });

    const [runStarted] = payloadsOf<RunStartedPayload>(t, sessionId, "run.started");
    expect(runStarted).toMatchObject({ runId, origin: "routine", model: "opus", effort: "low" });
    expect(sessionEvents(t, sessionId).find((event) => event.type === "run.started")?.actor).toBe(`routine:${state.id}`);
    expect(payloadsOf<RunPolicyResolvedPayload>(t, sessionId, "run.policy.resolved")).toEqual([expect.objectContaining({ runId, actorKind: "routine", actorName: "Nightly receipts", attended: false })]);
    expect(payloadsOf<PromptAnsweredPayload>(t, sessionId, "prompt.answered")).toEqual([expect.objectContaining({ decision: "deny", decidedBy: { auto: "unattended" } })]);
    // Answered in the transaction that opened it: it never parked.
    expect(t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "prompt.parked")).toEqual([]);
    // The run went on after the denial and said what it was told.
    expect(payloadsOf<{ text: string }>(t, sessionId, "assistant.text").map((payload) => payload.text)).toEqual(["Working", expect.stringMatching(/^Told .*deny/)]);

    const review = registry["permissions.review.list"].result.parse(await client.request("permissions.review.list", {}));
    expect(review.runs).toEqual([expect.objectContaining({ sessionId, runId, actor: { kind: "routine", name: "Nightly receipts" }, attended: false })]);
  });

  it("takes the default account, the default family's strongest model and the default effort when the routine names none", async () => {
    const t = await start({ accounts: [{ id: "first", provider: "fake" }, { id: "second", provider: "fake" }] });
    const client = await t.client();
    await client.request("settings.update", {
      commandId: randomUUID(),
      values: { "accounts.defaultAccount": "second", "accounts.defaultModelFamily": "sonnet", "accounts.defaultEffort": "high" },
    });
    const { state } = await created(client, routine({ account: null, model: null, effort: null }));
    const firingId = await ranNow(client, state.id);
    const { sessionId, runId } = (await untilStarted(t, state.id, firingId)).payload as { sessionId: string; runId: string };
    expect(sessionEvents(t, sessionId)[0]?.payload).toMatchObject({ account: "second", model: null });
    expect(payloadsOf<RunStartedPayload>(t, sessionId, "run.started")).toEqual([expect.objectContaining({ runId, accountId: "second", model: "sonnet", effort: "high" })]);
  });

  it("carries the routine's own credential injection on its policy, allow or deny by the routine's id, and none for inherit", async () => {
    const t = await start();
    const client = await t.client();
    const injectionOf = async (injection: "inherit" | "allow" | "deny") => {
      const { state } = await created(client, routine({ name: `Injection ${injection}`, injection }));
      const firingId = await ranNow(client, state.id);
      const { sessionId } = (await untilStarted(t, state.id, firingId)).payload as { sessionId: string };
      await untilSettled(t, state.id, firingId);
      return { routineId: state.id, policy: payloadsOf<RunPolicyResolvedPayload>(t, sessionId, "run.policy.resolved")[0] };
    };
    const denied = await injectionOf("deny");
    expect(denied.policy?.injection).toEqual({ answer: "deny", id: denied.routineId });
    const allowed = await injectionOf("allow");
    expect(allowed.policy?.injection).toEqual({ answer: "allow", id: allowed.routineId });
    expect((await injectionOf("inherit")).policy).not.toHaveProperty("injection");
  });

  it("is clamped to the ceiling the routine was saved under, and for run now to the caller's when that is lower; run.policy.resolved shows it with the routine's containment", async () => {
    const t = await start({ containment: bubblewrapProbe() });
    const desktop = await t.client();
    const phone = await paired(t, "plan");
    const fire = async (client: WireClient, routineId: string) => {
      const firingId = await ranNow(client, routineId);
      const { sessionId, runId } = (await untilStarted(t, routineId, firingId)).payload as { sessionId: string; runId: string };
      await untilSettled(t, routineId, firingId);
      return payloadsOf<RunPolicyResolvedPayload>(t, sessionId, "run.policy.resolved").find((policy) => policy.runId === runId);
    };

    // Saved from the phone, whose ceiling is plan: the desktop's run now is clamped to it all the same.
    const low = await created(phone, routine({ name: "Saved low", mode: "bypassPermissions", containment: "off" }));
    expect(await fire(desktop, low.state.id)).toMatchObject({
      mode: { requested: "bypassPermissions", effective: "plan", ceiling: "plan", clamped: true, clampReason: "ceiling" },
      // The routine's level is the session's own, over the environment's workspace default.
      containment: { requested: "off", effective: "off", reason: null },
    });

    // Saved from the desktop: the phone's run now is clamped to the phone's ceiling.
    const high = await created(desktop, routine({ name: "Saved high", mode: "bypassPermissions", containment: "workspace" }));
    expect(await fire(phone, high.state.id)).toMatchObject({
      mode: { requested: "bypassPermissions", effective: "plan", ceiling: "plan", clamped: true, clampReason: "ceiling" },
      containment: { requested: "workspace", effective: "workspace", reason: null },
    });
    expect(await fire(desktop, high.state.id)).toMatchObject({
      mode: { requested: "bypassPermissions", effective: "bypassPermissions", ceiling: "bypassPermissions", clamped: false, clampReason: null },
    });
  });
});

describe("a firing's end", () => {
  /** A firing of a fresh routine run now, whose run plays `script`: its routine, its id, its session and its run. */
  const firing = async (t: TestEnvironment, client: WireClient, script: Script, definition: RoutineDefinitionInput = routine()) => {
    const { state } = await created(client, definition);
    t.adapter.nextScripts.push(script);
    const firingId = await ranNow(client, state.id);
    const { sessionId, runId } = (await untilStarted(t, state.id, firingId)).payload as { sessionId: string; runId: string };
    return { routineId: state.id, firingId, sessionId, runId };
  };

  const usage = [{ model: "opus", inputTokens: 120, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, contextWindow: null }];

  it("is succeeded when its run completes: the result text, else the last assistant text, else empty; with the usage and the duration", async () => {
    const t = await start();
    const client = await t.client();
    const held = heldGate();
    const withResult = await firing(t, client, async function* () {
      yield say("Reading the sources.");
      await held.opened;
      yield end("completed", { resultText: "Three new releases; digest filed.", usage });
    });
    t.clock.advance(90_000);
    held.open();
    expect((await untilSettled(t, withResult.routineId, withResult.firingId)).payload).toEqual({
      firingId: withResult.firingId,
      outcome: "succeeded",
      reason: null,
      text: "Three new releases; digest filed.",
      usage,
      durationMs: 90_000,
      baselineAdvanced: false,
    });
    expect((await history(client, withResult.routineId))[0]).toMatchObject({
      endedAt: new Date(Date.parse(MANUAL_CLOCK_START) + 90_000).toISOString(),
      outcome: "succeeded",
      text: "Three new releases; digest filed.",
      usage,
      durationMs: 90_000,
      baselineAdvanced: false,
    });

    const saidOnly = await firing(t, client, () => [say("First thought."), say("Nothing new upstream."), end()], routine({ name: "Said only" }));
    expect((await untilSettled(t, saidOnly.routineId, saidOnly.firingId)).payload).toMatchObject({ outcome: "succeeded", text: "Nothing new upstream.", usage: null });

    // Empty text succeeds: the body a delivery gives it is #525's.
    const silentRun = await firing(t, client, () => [end()], routine({ name: "Said nothing" }));
    expect((await untilSettled(t, silentRun.routineId, silentRun.firingId)).payload).toMatchObject({ outcome: "succeeded", reason: null, text: "" });
  });

  it("keeps at most 16,000 characters of the final text", async () => {
    const t = await start();
    const client = await t.client();
    const long = "x".repeat(MAX_ROUTINE_TEXT + 500);
    const run = await firing(t, client, () => [end("completed", { resultText: long })]);
    expect((await untilSettled(t, run.routineId, run.firingId)).payload["text"]).toBe(long.slice(0, MAX_ROUTINE_TEXT));
  });

  it("is failed run_error when its run ends in error", async () => {
    const t = await start();
    const client = await t.client();
    const run = await firing(t, client, () => [say("Trying."), end("error", { error: { message: "The provider failed.", code: null } })]);
    expect((await untilSettled(t, run.routineId, run.firingId)).payload).toMatchObject({ outcome: "failed", reason: "run_error", text: "Trying." });
  });

  it("is cancelled when a person interrupts its run, and when its session is deleted", async () => {
    const t = await start();
    const client = await t.client();
    const interrupted = await firing(t, client, heldRun(heldGate()));
    await working(t, interrupted.sessionId, interrupted.runId);
    await client.apply("runs.interrupt", { commandId: randomUUID(), runId: interrupted.runId });
    expect((await untilSettled(t, interrupted.routineId, interrupted.firingId)).payload).toMatchObject({ outcome: "cancelled", reason: null, text: "Working" });

    const deleted = await firing(t, client, heldRun(heldGate()), routine({ name: "Deleted session" }));
    await deleteSession(client, deleted.sessionId);
    expect((await untilSettled(t, deleted.routineId, deleted.firingId)).payload).toMatchObject({ outcome: "cancelled", reason: null });
  });

  it("is failed restart when the environment closes under its run, and when a crash cut its run and the next start's recovery ends it", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start({ dataDir });
    const client = await first.client();
    const closed = await firing(first, client, heldRun(heldGate()));
    await working(first, closed.sessionId, closed.runId);
    await first.close();
    const second = await start({ dataDir, clock: first.clock });
    const reader = await second.client();
    expect((await history(reader, closed.routineId))[0]).toMatchObject({ id: closed.firingId, outcome: "failed", reason: "restart", text: "Working" });

    const cut = await firing(second, reader, heldRun(heldGate()), routine({ name: "Cut by a crash" }));
    await working(second, cut.sessionId, cut.runId);
    // The environment dies with the run mid-flight: its end never reaches the log.
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await reader.close();
    second.env.log.close();
    await second.close();
    loud.mockRestore();
    const third = await start({ dataDir, clock: first.clock });
    expect((await history(await third.client(), cut.routineId))[0]).toMatchObject({ id: cut.firingId, outcome: "failed", reason: "restart" });
    expect((await listed(await third.client(), cut.routineId))?.state).toMatchObject({ liveFiring: null, failureStreak: 1 });
  });
});

describe("a firing and its routine's changes", () => {
  it("ends cancelled when its routine is deleted, in the delete's transaction, and its run goes on as the session's", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine());
    const held = heldGate();
    t.adapter.nextScripts.push(heldRun(held, "Finished anyway."));
    const firingId = await ranNow(client, state.id);
    const { sessionId, runId } = (await untilStarted(t, state.id, firingId)).payload as { sessionId: string; runId: string };
    await working(t, sessionId, runId);
    t.clock.advance(30_000);

    await routineCommand(client, "routines.delete", { routineId: state.id });
    const [ended, deleted] = t.env.log.readStream({ kind: "routine", id: state.id }).slice(-2);
    expect(ended).toMatchObject({
      type: "routine.firing-ended",
      actor: `routine:${state.id}`,
      payload: { firingId, outcome: "cancelled", reason: null, text: "Working", usage: null, durationMs: 30_000, baselineAdvanced: false },
    });
    expect(deleted).toMatchObject({ type: "routine.deleted", actor: `client_session:${client.hello.clientSessionId}`, commandId: ended?.commandId });

    held.open();
    expect((await untilRunEnded(t, sessionId, runId)).payload).toMatchObject({ reason: "completed" });
    expect(t.env.log.readStream({ kind: "routine", id: state.id }).filter((event) => event.type === "routine.firing-ended")).toHaveLength(1);
    expect((await get(client, sessionId)).title).toBe("Upstream watch 2026-09-24 08:00");
  });

  it("finishes under the definition it started with when its routine is edited or disabled meanwhile", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine({ delivery: [{ kind: "client-notice", on: "failure" }] }));
    const held = heldGate();
    t.adapter.nextScripts.push(heldRun(held));
    const firingId = await ranNow(client, state.id);
    const { runId, sessionId } = (await untilStarted(t, state.id, firingId)).payload as { runId: string; sessionId: string };

    await routineCommand(client, "routines.update", { routineId: state.id, fields: { name: "Renamed", mode: "plan", delivery: [] } });
    await routineCommand(client, "routines.disable", { routineId: state.id });
    held.open();
    expect((await untilSettled(t, state.id, firingId)).payload).toMatchObject({ outcome: "succeeded", text: "Done." });
    expect((await history(client, state.id))[0]).toMatchObject({ id: firingId, runId, targets: [{ kind: "client-notice", on: "failure" }], outcome: "succeeded" });
    expect(payloadsOf<RunPolicyResolvedPayload>(t, sessionId, "run.policy.resolved")[0]).toMatchObject({ actorName: "Upstream watch" });
  });

  it("is not a person's: their message into its session starts an attended run of their own, whose end ends nothing", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine());
    const firingId = await ranNow(client, state.id);
    const { sessionId } = (await untilStarted(t, state.id, firingId)).payload as { sessionId: string };
    const ended = await untilSettled(t, state.id, firingId);

    const { runId } = await client.apply("runs.start", { commandId: randomUUID(), sessionId, text: "What did you find?" });
    await untilRunEnded(t, sessionId, runId);
    expect(payloadsOf<RunPolicyResolvedPayload>(t, sessionId, "run.policy.resolved").find((policy) => policy.runId === runId)).toMatchObject({ actorKind: "client", attended: true });
    expect(payloadsOf<RunStartedPayload>(t, sessionId, "run.started").find((started) => started.runId === runId)).toMatchObject({ origin: "client" });
    const records = t.env.log.readStream({ kind: "routine", id: state.id });
    expect(records.at(-1)?.eventId).toBe(ended.eventId);
    expect(await history(client, state.id)).toHaveLength(1);
  });
});

describe("routines.history", () => {
  it("answers firings and skips newest first, 50 at a time unless asked for up to 500, before an entry when named", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine({ model: "a-model-nobody-offers" }));
    const ids: string[] = [];
    for (let n = 0; n < 52; n += 1) {
      const entryId = await ranNow(client, state.id);
      await untilSettled(t, state.id, entryId);
      ids.push(entryId);
    }
    await routineCommand(client, "routines.update", { routineId: state.id, fields: { model: null } });
    const firingId = await ranNow(client, state.id);
    await untilSettled(t, state.id, firingId);
    const newestFirst = [firingId, ...ids.reverse()];

    const page = await history(client, state.id);
    expect(page.map((entry) => entry.id)).toEqual(newestFirst.slice(0, 50));
    expect(page[0]).toMatchObject({ kind: "firing", outcome: "succeeded" });
    expect(page[1]).toMatchObject({ kind: "skip", cannotStart: "model_unavailable" });
    expect((await history(client, state.id, { before: page.at(-1)?.id as string })).map((entry) => entry.id)).toEqual(newestFirst.slice(50));
    expect((await history(client, state.id, { limit: 500 })).map((entry) => entry.id)).toEqual(newestFirst);
    expect((await history(client, state.id, { before: firingId, limit: 2 })).map((entry) => entry.id)).toEqual(newestFirst.slice(1, 3));

    expect((await refusal(history(client, state.id, { limit: 501 }))).code).toBe("invalid_params");
    const stranger = randomUUID();
    expect(await refusal(history(client, state.id, { before: stranger }))).toEqual({ code: "not_found", data: { kind: "entry", routineId: state.id, entryId: stranger } });
  });

  it("raises routine.updated for each new record: the firing's start and end, and a skip", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine());
    const head = t.env.log.head();
    const firingId = await ranNow(client, state.id);
    await untilSettled(t, state.id, firingId);
    await routineCommand(client, "routines.update", { routineId: state.id, fields: { model: "a-model-nobody-offers" } });
    const skipId = await ranNow(client, state.id);
    await untilSettled(t, state.id, skipId);

    const updates = await routineUpdates(await t.client(), head);
    expect(updates.map((event) => event.payload)).toEqual((["firing-started", "firing-ended", "edited", "skipped"] as const).map((change) => ({ routineId: state.id, change })));
    const records = t.env.log.readStream({ kind: "routine", id: state.id }, head);
    expect(updates.map((event) => event.causationId)).toEqual(records.map((event) => event.eventId));
  });
});
