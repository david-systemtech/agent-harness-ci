import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { listEvent, scriptedEnvironments, type ScriptedEnvironment } from "../../test/environments.js";
import { noticeEvent } from "../../test/events.js";
import { recorded } from "../../test/transcript.js";
import { subscription } from "../../test/scripted.js";
import { createRuntimeWithSeams } from "../internal.js";
import { createNotices, NOTICE_LIMIT, type Notices } from "../notices.js";
import { desktopSawUnanswered } from "../updates/credential-notice.js";
import { fakeWire, flush } from "../testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "../testing/in-memory-platform.js";
import type { AttentionEvent } from "./attention.js";
import { createEnvironmentNotices, type EnvironmentNoticeContext } from "./notices.js";

/**
 * `projections.notices` (docs/specs/client-runtime.md, "Projections"): one
 * queue of at most 100 from the environment's own stream, from receipts
 * and from the connection, dismissed on this client only; and the attention
 * events a renderer surfaces (`run-ended`, `prompt-parked`,
 * `notice-arrived`), which the runtime never takes to the shell itself.
 */

const oneEnvironment = async () => {
  const made = await scriptedEnvironments({ onCleanup: onTestFinished, environments: [{ name: "desk", title: "Invoices" }] });
  const [desk] = made.environments as [ScriptedEnvironment];
  const heard: AttentionEvent[] = [];
  const stop = made.runtime.attention.subscribe((event) => heard.push(event));
  onTestFinished(stop);
  return { ...made, desk, env: desk.wire.environmentId, heard };
};

const runId = recorded("run.started")["runId"] as string;

/** A routine's succeeded firing delivered to the clients (#525), with `fields` over it. */
const delivered = (sequence: number, environmentId: string, fields: Record<string, unknown>) =>
  noticeEvent(sequence, environmentId, "routine.delivered", {
    routineId: randomUUID(),
    name: "Upstream watch",
    entryId: randomUUID(),
    entryKind: "firing",
    outcome: "succeeded",
    summary: "Three new releases; digest filed.",
    body: "Three new releases; digest filed.\nThe details follow.",
    ...fields,
  });

describe("the notices from the environment's stream", () => {
  it("say a final webhook delivery failed once, naming the routine, environment, endpoint and error", async () => {
    const { runtime, desk, env } = await oneEnvironment();
    const event = noticeEvent(1, env, "routine.delivery-failed", { routineId: randomUUID(), name: "Upstream watch", entryId: randomUUID(), endpoint: "hermes", error: "The endpoint answered 400." });
    desk.notices.event(event);
    desk.notices.event(event);
    await flush();
    expect(runtime.projections.notices.read().map(({ environmentId, kind, message, action, about }) => ({ environmentId, kind, message, action, about }))).toEqual([
      { environmentId: env, kind: "routine-delivery-failed", message: "Upstream watch on desk could not deliver to hermes: The endpoint answered 400.", action: null, about: null },
    ]);
  });

  it("keeps one draining condition per environment across repeated drain events", async () => {
    const { runtime, desk, env } = await oneEnvironment();
    desk.notices.event(noticeEvent(1, env, "environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" }));
    desk.notices.event(noticeEvent(2, env, "environment.draining", { drainingSince: "2026-09-24T00:00:02.000Z", trigger: "launcher" }));
    await flush();
    expect(runtime.projections.notices.read().filter((notice) => notice.kind === "draining")).toHaveLength(1);
  });

  it("retires an obsolete drain after reconnect replays the restart, keeping other environments and update outcomes", async () => {
    const { runtime, clock, environments } = await scriptedEnvironments({ onCleanup: onTestFinished, environments: [{ name: "desk" }, { name: "laptop" }] });
    const [desk, laptop] = environments as [ScriptedEnvironment, ScriptedEnvironment];
    const env = desk.wire.environmentId;
    for (const environment of environments) environment.notices.event(noticeEvent(1, environment.wire.environmentId, "environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" }));
    desk.notices.event(noticeEvent(2, env, "environment.update-failed", { updateId: randomUUID(), fromVersion: "0.1.0", toVersion: "0.2.0", stage: "switch", reason: "disk", rolledBack: false }));
    await flush();
    expect(runtime.projections.notices.read()).toHaveLength(3);
    desk.wire.server.drop();
    await flush();
    clock.advance(1250);
    await desk.wire.server.accept();
    (await subscription(desk.wire, "sessions.subscribe")).synchronized(1);
    const resumed = await subscription(desk.wire, "environment.subscribe");
    expect(resumed.params).toEqual({ afterSequence: 2 });
    resumed.event(noticeEvent(3, env, "environment.started", { harnessVersion: "0.1.0", protocolVersion: 1 }));
    resumed.synchronized(3);
    await flush();
    expect(runtime.projections.environments.read().find((view) => view.environmentId === env)?.phase).toBe("ready");
    expect(runtime.projections.notices.read().map(({ environmentId, kind }) => ({ environmentId, kind }))).toEqual([
      { environmentId: laptop.wire.environmentId, kind: "draining" },
      { environmentId: env, kind: "update-failed" },
    ]);
    resumed.event(noticeEvent(4, env, "environment.draining", { drainingSince: "2026-09-24T00:00:04.000Z", trigger: "launcher" }));
    await flush();
    expect(runtime.projections.notices.read().filter((notice) => notice.kind === "draining")).toHaveLength(2);
  });

  it("retires a draining notice when a restart is replayed onto an empty cache", async () => {
    const { runtime, desk, env } = await oneEnvironment();
    const drain = noticeEvent(1, env, "environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" });
    desk.notices.event(drain);
    await flush();
    expect(runtime.projections.notices.read()).toHaveLength(1);
    await runtime.connections.remove(env);
    const adding = runtime.connections.add({ link: desk.wire.link });
    await desk.wire.server.accept();
    (await subscription(desk.wire, "sessions.subscribe")).synchronized(0);
    const resumed = await subscription(desk.wire, "environment.subscribe");
    resumed.event(drain);
    resumed.event(noticeEvent(2, env, "environment.started", { harnessVersion: "0.1.0", protocolVersion: 1 }));
    resumed.synchronized(2);
    await adding;
    expect(runtime.projections.notices.read()).toEqual([]);
  });

  it("keeps a current drain when empty-cache replay includes an older startup", async () => {
    const { runtime, desk, env } = await oneEnvironment();
    const start = noticeEvent(1, env, "environment.started", { harnessVersion: "0.1.0", protocolVersion: 1 });
    const drain = noticeEvent(2, env, "environment.draining", { drainingSince: "2026-09-24T00:00:02.000Z", trigger: "launcher" });
    desk.notices.event(start);
    desk.notices.event(drain);
    await flush();
    expect(runtime.projections.notices.read()).toHaveLength(1);
    await runtime.connections.remove(env);
    const adding = runtime.connections.add({ link: desk.wire.link });
    await desk.wire.server.accept();
    (await subscription(desk.wire, "sessions.subscribe")).synchronized(0);
    const resumed = await subscription(desk.wire, "environment.subscribe");
    resumed.event(start);
    resumed.event(drain);
    resumed.synchronized(2);
    await adding;
    expect(runtime.projections.notices.read().map((notice) => notice.kind)).toEqual(["draining"]);
  });

  it.each([0, 2002])("retires only the recovered environment's drain when a ready snapshot resets its cursor to %s", async (sequence) => {
    const { runtime, clock, environments } = await scriptedEnvironments({ onCleanup: onTestFinished, environments: [{ name: "desk" }, { name: "laptop" }] });
    const [desk, laptop] = environments as [ScriptedEnvironment, ScriptedEnvironment];
    const env = desk.wire.environmentId;
    for (const environment of environments) environment.notices.event(noticeEvent(1, environment.wire.environmentId, "environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" }));
    desk.notices.event(noticeEvent(2, env, "environment.updated", { fromVersion: "0.1.0", toVersion: "0.2.0" }));
    await flush();
    desk.wire.server.drop();
    await flush();
    clock.advance(1250);
    await desk.wire.server.accept();
    (await subscription(desk.wire, "sessions.subscribe")).synchronized(1);
    const resumed = await subscription(desk.wire, "environment.subscribe");
    resumed.snapshot(sequence, { sequence, status: { readiness: "draining", activity: { state: "idle" }, updatesManagedOutside: false } });
    await flush();
    expect(runtime.projections.notices.read()).toHaveLength(3);
    resumed.snapshot(sequence, { sequence, status: { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false } });
    resumed.synchronized(sequence);
    await flush();
    expect(runtime.projections.environments.read().find((view) => view.environmentId === env)?.phase).toBe("ready");
    expect(runtime.projections.notices.read().map(({ environmentId, kind }) => ({ environmentId, kind }))).toEqual([
      { environmentId: laptop.wire.environmentId, kind: "draining" },
      { environmentId: env, kind: "updated" },
    ]);
  });

  it("say it is draining, an account's warning and a prompt parked, each once, as news", async () => {
    const { runtime, desk, env } = await oneEnvironment();
    desk.notices.event(noticeEvent(1, env, "environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" }));
    desk.notices.event(
      noticeEvent(2, env, "account.updated", { accountId: "claude-max", change: "identity-mismatch", warning: "claude-max now reads as signed in as other@example.com." }),
    );
    desk.notices.event(noticeEvent(3, env, "account.updated", { accountId: "claude-max", change: "relabelled", warning: null }));
    desk.notices.event(
      noticeEvent(4, env, "prompt.parked", { sessionId: desk.sessionId, runId, promptId: "toolu_1", kind: "permission", title: "Invoices", summary: "Bash: rm -rf build" }),
    );
    await flush();
    expect(runtime.projections.notices.read().map(({ environmentId, kind, message, about }) => ({ environmentId, kind, message, about }))).toEqual([
      { environmentId: env, kind: "draining", message: "desk is draining: it takes no new runs until it restarts.", about: null },
      { environmentId: env, kind: "account", message: "desk: claude-max now reads as signed in as other@example.com.", about: null },
      { environmentId: env, kind: "prompt-parked", message: "Invoices is waiting on desk: Bash: rm -rf build", about: { sessionId: desk.sessionId, runId, promptId: "toolu_1" } },
    ]);
  });

  it("say an update took, whether its event names its update id or is of the older shape, and raise nothing for an update pending, started or cancelled (#335)", async () => {
    const { runtime, desk, env } = await oneEnvironment();
    const updateId = randomUUID();
    const since = "2026-09-24T00:00:01.000Z";
    desk.notices.event(noticeEvent(1, env, "environment.update-pending", { updateId, toVersion: "0.2.0", source: "channel", since, deferUntil: "2026-09-25T00:00:01.000Z" }));
    desk.notices.event(noticeEvent(2, env, "environment.update-started", { updateId, fromVersion: "0.1.0", toVersion: "0.2.0", cause: "idle" }));
    desk.notices.event(noticeEvent(3, env, "environment.updated", { fromVersion: "0.1.0", toVersion: "0.2.0", updateId }));
    desk.notices.event(noticeEvent(4, env, "environment.update-cancelled", { updateId: randomUUID(), toVersion: "0.3.0", cause: "settings" }));
    desk.notices.event(noticeEvent(5, env, "environment.updated", { fromVersion: "0.2.0", toVersion: "0.2.1" }));
    await flush();
    expect(runtime.projections.notices.read().map(({ kind, message }) => ({ kind, message }))).toEqual([
      { kind: "updated", message: "desk was updated from 0.1.0 to 0.2.0." },
      { kind: "updated", message: "desk was updated from 0.2.0 to 0.2.1." },
    ]);
  });

  it("say an update failed, once for each update-failed, with its stage and reason and the version running (#344)", async () => {
    const { runtime, desk, env } = await oneEnvironment();
    const failed = (sequence: number, stage: string, reason: string, toVersion: string) =>
      noticeEvent(sequence, env, "environment.update-failed", { updateId: randomUUID(), fromVersion: "0.1.0", toVersion, stage, reason, rolledBack: stage !== "switch" });
    desk.notices.event(failed(1, "trial", "deadline", "0.2.0"));
    desk.notices.event(failed(2, "switch", "disk", "0.2.1"));
    await flush();
    expect(runtime.projections.notices.read().map(({ environmentId, kind, message, action }) => ({ environmentId, kind, message, action }))).toEqual([
      { environmentId: env, kind: "update-failed", message: "desk could not be updated to 0.2.0 (trial: deadline). It is running 0.1.0.", action: null },
      { environmentId: env, kind: "update-failed", message: "desk could not be updated to 0.2.1 (switch: disk). It is running 0.1.0.", action: null },
    ]);
  });

  it("say a trial that failed on its stored key needs the macOS prompt answered with Always Allow, not a reason code (#1689)", async () => {
    const { runtime, desk, env } = await oneEnvironment();
    desk.notices.event(noticeEvent(1, env, "environment.update-failed", { updateId: randomUUID(), fromVersion: "0.1.1", toVersion: "0.1.3", stage: "trial", reason: "credential", rolledBack: true }));
    await flush();
    expect(runtime.projections.notices.read().map(({ kind, message }) => ({ kind, message }))).toEqual([
      {
        kind: "update-failed",
        message:
          "desk could not be updated to 0.1.3: macOS asked to let agent-harness use its stored key, and the prompt was refused or not answered. It is running 0.1.1. Update again, and answer “Always Allow” when macOS asks.",
      },
    ]);
  });

  describe("under a launcher older than the stored-key wait, whose trial fails at deadline (#1689)", () => {
    const env = randomUUID();
    const context: EnvironmentNoticeContext = { name: "desk", accountLabel: () => null, title: () => null };
    const failed = (sequence: number, reason: string) =>
      noticeEvent(sequence, env, "environment.update-failed", { updateId: randomUUID(), fromVersion: "0.1.1", toVersion: "0.1.3", stage: "trial", reason, rolledBack: true });
    const CREDENTIAL =
      "desk could not be updated to 0.1.3: macOS asked to let agent-harness use its stored key, and the prompt was refused or not answered. It is running 0.1.1. Update again, and answer “Always Allow” when macOS asks.";
    const UNANSWERED =
      "desk could not be updated to 0.1.3: macOS asked to let agent-harness use its stored key, and the prompt was refused or not answered. Update again, and answer “Always Allow” when macOS asks.";
    const shown = (notices: Notices) => notices.list.read().map(({ kind, message }) => ({ kind, message }));
    /** The window's notices on a held clock, and the projection of the environment's. */
    const window = () => {
      const clock = manualClock();
      const notices = createNotices(clock);
      return { clock, notices, heard: (event: ReturnType<typeof failed>) => createEnvironmentNotices(notices).heard(env, event, context) };
    };

    it("words the environment's deadline as the stored key's once the desktop said that trial's prompt went unanswered", () => {
      const { clock, notices, heard } = window();
      desktopSawUnanswered(notices, env, "desk", "0.1.3", clock.now());
      heard(failed(1, "deadline"));
      expect(shown(notices)).toEqual([{ kind: "update-failed", message: CREDENTIAL }]);
    });

    it("rewords the environment's deadline already shown once the desktop says the prompt it saw since went unanswered", () => {
      const { clock, notices, heard } = window();
      const seenAt = clock.now();
      clock.advance(1_000);
      heard(failed(1, "deadline"));
      expect(shown(notices)).toEqual([{ kind: "update-failed", message: "desk could not be updated to 0.1.3 (trial: deadline). It is running 0.1.1." }]);
      desktopSawUnanswered(notices, env, "desk", "0.1.3", seenAt);
      expect(shown(notices)).toEqual([{ kind: "update-failed", message: CREDENTIAL }]);
    });

    it("keeps a later trial's own reason, though the earlier one's stored-key notice is still shown", () => {
      const { clock, notices, heard } = window();
      desktopSawUnanswered(notices, env, "desk", "0.1.3", clock.now());
      heard(failed(1, "deadline"));
      // Update again: the person answers Always Allow, and this trial fails for another reason.
      heard(failed(2, "snapshot"));
      clock.advance(60 * 60_000);
      heard(failed(3, "deadline"));
      expect(shown(notices)).toEqual([
        { kind: "update-failed", message: CREDENTIAL },
        { kind: "update-failed", message: "desk could not be updated to 0.1.3 (trial: snapshot). It is running 0.1.1." },
        { kind: "update-failed", message: "desk could not be updated to 0.1.3 (trial: deadline). It is running 0.1.1." },
      ]);
    });

    it("leaves an earlier attempt's failure alone when a later one's prompt goes unanswered", () => {
      const { clock, notices, heard } = window();
      heard(failed(1, "snapshot"));
      heard(failed(2, "deadline"));
      clock.advance(1_000);
      desktopSawUnanswered(notices, env, "desk", "0.1.3", clock.now());
      expect(shown(notices)).toEqual([
        { kind: "update-failed", message: "desk could not be updated to 0.1.3 (trial: snapshot). It is running 0.1.1." },
        { kind: "update-failed", message: "desk could not be updated to 0.1.3 (trial: deadline). It is running 0.1.1." },
        { kind: "update-failed", message: UNANSWERED },
      ]);
    });
  });

  it("take a parked prompt's notice back once it is resolved, and say so when nobody answered it", async () => {
    const { runtime, desk, env } = await oneEnvironment();
    const parked = (promptId: string, sequence: number) =>
      noticeEvent(sequence, env, "prompt.parked", { sessionId: desk.sessionId, runId, promptId, kind: "permission", title: "Invoices", summary: `Bash: ${promptId}` });
    desk.notices.event(parked("toolu_1", 1));
    desk.notices.event(parked("toolu_2", 2));
    await flush();
    expect(runtime.projections.notices.read().map((n) => n.kind)).toEqual(["prompt-parked", "prompt-parked"]);

    // A person answered the first, from some client: its notice goes, and nothing is said.
    desk.notices.event(noticeEvent(3, env, "prompt.resolved", { sessionId: desk.sessionId, runId, promptId: "toolu_1", decision: "allow", decidedBy: "cs-1" }));
    // Nobody answered the second before its TTL.
    desk.notices.event(noticeEvent(4, env, "prompt.resolved", { sessionId: desk.sessionId, runId, promptId: "toolu_2", decision: "deny", decidedBy: { auto: "ttl" } }));
    await flush();
    expect(runtime.projections.notices.read().map(({ kind, message }) => ({ kind, message }))).toEqual([
      { kind: "prompt-resolved", message: "Invoices: Bash: toolu_2 was denied: nobody answered it before its time ran out." },
    ]);
  });

  it("say a routine's result delivered to the clients, marked a success or a failure, about the firing's session; a skip's about none (#525)", async () => {
    const { runtime, desk, env } = await oneEnvironment();
    const routineId = randomUUID();
    desk.notices.event(delivered(1, env, { routineId, sessionId: desk.sessionId }));
    desk.notices.event(
      delivered(2, env, {
        routineId,
        entryKind: "skip",
        sessionId: null,
        outcome: "failed",
        summary: "The firing could not start: The account claude-max does not offer the model opus.",
        body: "The account claude-max does not offer the model opus.",
      }),
    );
    await flush();
    expect(runtime.projections.notices.read().map(({ environmentId, kind, message, action, about, outcome }) => ({ environmentId, kind, message, action, about, outcome }))).toEqual([
      {
        environmentId: env,
        kind: "routine",
        message: "Upstream watch on desk: Three new releases; digest filed.",
        action: null,
        about: { sessionId: desk.sessionId, runId: null, promptId: null },
        outcome: "succeeded",
      },
      {
        environmentId: env,
        kind: "routine",
        message: "Upstream watch on desk: The firing could not start: The account claude-max does not offer the model opus.",
        action: null,
        about: null,
        outcome: "failed",
      },
    ]);
  });

  it("say a routine's result delivered while this client was away, replayed onto the cursor it held, as news (#525)", async () => {
    const { runtime, desk, env, clock } = await oneEnvironment();
    desk.notices.event(noticeEvent(1, env, "environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" }));
    await flush();
    desk.wire.server.drop();
    await flush();
    clock.advance(1250);
    await desk.wire.server.accept();
    (await subscription(desk.wire, "sessions.subscribe")).synchronized(1);
    const resumed = await subscription(desk.wire, "environment.subscribe");
    expect(resumed.params).toEqual({ afterSequence: 1 });
    resumed.event(delivered(2, env, { sessionId: desk.sessionId }));
    resumed.synchronized(2);
    await flush();
    expect(runtime.projections.notices.read().map(({ kind, message }) => ({ kind, message }))).toEqual([
      { kind: "draining", message: "desk is draining: it takes no new runs until it restarts." },
      { kind: "routine", message: "Upstream watch on desk: Three new releases; digest filed." },
    ]);
  });

  it("say a worktree was kept at its last session's purge, naming its path, branch and session and why, once for each (#330)", async () => {
    const { runtime, desk, env } = await oneEnvironment();
    const path = "/data/worktrees/app-0123456789ab/agent-harness-7c9e6679";
    desk.notices.event(noticeEvent(1, env, "workspace.kept", { path, branch: "agent-harness/7c9e6679", title: "Invoices", reason: "uncommitted_changes" }));
    desk.notices.event(noticeEvent(2, env, "workspace.kept", { path, branch: null, title: "Nightly", reason: "git_filters_refused" }));
    desk.notices.event(noticeEvent(3, env, "workspace.kept", { path, branch: "main", title: "Invoices", reason: "git_failed" }));
    await flush();
    expect(runtime.projections.notices.read().map(({ kind, message, action, about }) => ({ kind, message, action, about }))).toEqual([
      {
        kind: "workspace-kept",
        message: `desk kept the worktree ${path} (branch agent-harness/7c9e6679) when Invoices was purged: it has uncommitted changes.`,
        action: null,
        about: null,
      },
      {
        kind: "workspace-kept",
        message: `desk kept the worktree ${path} when Nightly was purged: its repository configures filters the environment will not run to check it.`,
        action: null,
        about: null,
      },
      { kind: "workspace-kept", message: `desk kept the worktree ${path} (branch main) when Invoices was purged: git could not check or remove it.`, action: null, about: null },
    ]);
  });

  it("are not raised for what a replay onto an empty cache holds: that is history", async () => {
    const clock = manualClock();
    const wire = fakeWire({ clock, name: "desk" });
    for (const method of ["sessions.subscribe", "environment.subscribe"]) wire.answer(method, () => undefined);
    const { runtime } = createRuntimeWithSeams(inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket }));
    onTestFinished(() => runtime.close());
    await runtime.start();
    const adding = runtime.connections.add({ link: wire.link });
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    const environment = await subscription(wire, "environment.subscribe");
    environment.event(noticeEvent(1, wire.environmentId, "environment.draining", { drainingSince: "2026-09-24T00:00:01.000Z", trigger: "launcher" }));
    environment.event(
      noticeEvent(2, wire.environmentId, "prompt.parked", { sessionId: randomUUID(), runId, promptId: "toolu_1", kind: "permission", title: "Invoices", summary: "Bash: ls" }),
    );
    environment.event(delivered(3, wire.environmentId, { sessionId: randomUUID() }));
    environment.synchronized(3);
    await adding;
    await flush();
    expect(runtime.projections.notices.read()).toEqual([]);
  });
});

describe("a parked prompt's notice", () => {
  it("is taken back by its resolution replayed as history, the environment removed and added again, and nothing more is said", async () => {
    const { runtime, desk, env } = await oneEnvironment();
    const parked = noticeEvent(1, env, "prompt.parked", { sessionId: desk.sessionId, runId, promptId: "toolu_1", kind: "permission", title: "Invoices", summary: "Bash: ls" });
    desk.notices.event(parked);
    await flush();
    const prompts = () => runtime.projections.notices.read().filter((n) => n.kind.startsWith("prompt-"));
    expect(prompts().map((n) => n.kind)).toEqual(["prompt-parked"]);

    // Removed and added again, its stream holds nothing: what it replays is history, a resolution included.
    await runtime.connections.remove(env);
    const adding = runtime.connections.add({ link: desk.wire.link });
    await desk.wire.server.accept();
    (await subscription(desk.wire, "sessions.subscribe")).synchronized(0);
    const environment = await subscription(desk.wire, "environment.subscribe");
    environment.event(parked);
    environment.event(noticeEvent(2, env, "prompt.resolved", { sessionId: desk.sessionId, runId, promptId: "toolu_1", decision: "deny", decidedBy: { auto: "ttl" } }));
    environment.synchronized(2);
    await adding;
    await flush();
    expect(prompts()).toEqual([]);
  });
});

describe("the notices queue", () => {
  it("holds at most 100, the newest last, from the stream, the receipts and the connection, and a dismissal is this client's", async () => {
    const { runtime, desk, env } = await oneEnvironment();
    const { wire } = desk;
    for (let sequence = 1; sequence <= NOTICE_LIMIT + 5; sequence++) {
      desk.notices.event(noticeEvent(sequence, env, "environment.updated", { fromVersion: `0.${sequence - 1}.0`, toVersion: `0.${sequence}.0` }));
    }
    await flush();
    let notices = runtime.projections.notices.read();
    expect(notices).toHaveLength(NOTICE_LIMIT);
    expect(notices[0]?.message).toBe("desk was updated from 0.5.0 to 0.6.0.");

    // A receipt's rejection joins the same queue.
    wire.answer("sessions.archive", () => ({ error: { code: "not_found", message: "No such session.", data: { kind: "session" } } }));
    await runtime.commands.dispatch(env, "sessions.archive", { sessionId: desk.sessionId });
    // And the connection's own: revoked.
    wire.server.bye("revoked");
    await flush();
    notices = runtime.projections.notices.read();
    expect(notices).toHaveLength(NOTICE_LIMIT);
    expect(notices.slice(-2).map((n) => n.kind)).toEqual(["command-rejected", "revoked"]);

    runtime.notices.dismiss(notices.at(-1)!.id);
    expect(runtime.projections.notices.read().map((n) => n.kind).slice(-1)).toEqual(["command-rejected"]);
  });
});

describe("the attention events", () => {
  it("say a run ended, a prompt parked and a notice arrived, and the runtime never calls the shell for them", async () => {
    const { desk, env, heard, shell } = await oneEnvironment();
    desk.list.event(listEvent(2, desk.sessionId, "run.ended", recorded("run.ended"), { activity: { state: "idle", since: "2026-09-24T00:00:02.000Z" } }));
    desk.notices.event(
      noticeEvent(1, env, "prompt.parked", { sessionId: desk.sessionId, runId, promptId: "toolu_1", kind: "question", title: "Invoices", summary: "Which library?" }),
    );
    await flush();
    expect(heard).toEqual([
      { kind: "run-ended", environmentId: env, sessionId: desk.sessionId, runId, reason: "completed", cause: null },
      { kind: "prompt-parked", environmentId: env, sessionId: desk.sessionId, runId, promptId: "toolu_1", promptKind: "question", title: "Invoices", summary: "Which library?" },
      { kind: "notice-arrived", notice: expect.objectContaining({ kind: "prompt-parked", environmentId: env }) },
    ]);
    expect(shell.calls).toEqual([]);
  });

  it("keep going when a listener throws, and hand its fault to the platform", async () => {
    const { runtime, desk, env, heard, platform } = await oneEnvironment();
    const stop = runtime.attention.subscribe(() => {
      throw new Error("a renderer's fault");
    });
    onTestFinished(stop);
    desk.list.event(listEvent(2, desk.sessionId, "run.ended", recorded("run.ended"), {}));
    await flush();
    expect(heard.map((event) => event.kind)).toEqual(["run-ended"]);
    expect(platform.reported).toEqual([expect.objectContaining({ message: "a renderer's fault" })]);
    expect(env).toBeTruthy();
  });
});
