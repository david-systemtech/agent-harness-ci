import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { listEvent, scriptedEnvironments, type ScriptedEnvironment } from "../../test/environments.js";
import { noticeEvent } from "../../test/events.js";
import { recorded } from "../../test/transcript.js";
import { subscription } from "../../test/scripted.js";
import { createRuntimeWithSeams } from "../internal.js";
import { NOTICE_LIMIT } from "../notices.js";
import { fakeWire, flush } from "../testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "../testing/in-memory-platform.js";
import type { AttentionEvent } from "./attention.js";

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

describe("the notices from the environment's stream", () => {
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
    environment.synchronized(2);
    await adding;
    await flush();
    expect(runtime.projections.notices.read()).toEqual([]);
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
