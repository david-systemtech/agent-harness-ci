import { CONTAINMENT_LEVELS, presetPermissionSettings } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { createRuntimeWithSeams } from "./internal.js";
import { noticeEvent } from "../test/events.js";
import { forgeEventPayload, forgeRecord } from "../test/forges.js";
import { keyManagerEventPayload, keyManagerRecord, toolRow, toolsUpdatedPayload } from "../test/key-managers.js";
import { subscription } from "../test/scripted.js";
import { createRequestCache, REQUEST_CACHE_TTL_MS, REQUEST_TIMEOUT_MS, UPDATE_APPLY_TIMEOUT_MS } from "./requests.js";
import { writable } from "./observable.js";
import type { ConnectionRecord } from "./connections/records.js";
import { fakeWire, flush } from "./testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "./testing/in-memory-platform.js";

/**
 * `requests.call` (docs/specs/client-runtime.md, "The offline outbox":
 * non-mutating calls and the `admin` calls, which are direct requests): never
 * queued, refused at once absent-with-reason when the connection cannot take
 * it, answered with the method's response checked against its schema, and
 * given up after 30 seconds (20 minutes for update staging); and the request cache (#128), which keeps a
 * query's answer five minutes and fetches it again on ready and on the
 * notice that says it may have changed.
 */

const paired = async (hello: Parameters<ReturnType<typeof fakeWire>["server"]["accept"]>[0] = {}) => {
  const clock = manualClock();
  const wire = fakeWire({ clock, name: "box" });
  const platform = inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket });
  const { runtime } = createRuntimeWithSeams(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept(hello);
  expect(await adding).toMatchObject({ status: "paired" });
  return { clock, wire, runtime, id: wire.environmentId };
};

describe("requests.call", () => {
  it("answers a query with its result, checked against the method's schema", async () => {
    const { runtime, id } = await paired();
    expect(await runtime.requests.call(id, "environment.status", {})).toEqual({
      ok: true,
      result: { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false },
    });
  });

  it("answers a command with its receipt beside its result", async () => {
    const { runtime, wire, id } = await paired();
    wire.answer("access.pairings.create", () => ({
      result: {
        receipt: { status: "accepted", sequence: 4, changed: true },
        result: {
          pairingId: "0199aa00-0000-7000-8000-000000000001",
          code: "K7Q2MXH4RT",
          link: "http://fake.test:7433/pair#K7Q2MXH4RT",
          expiresAt: "2026-09-24T00:10:00.000Z",
          scopes: ["read"],
          ceiling: "bypassPermissions",
        },
      },
    }));
    const answer = await runtime.requests.call(id, "access.pairings.create", { commandId: "0199aa00-0000-7000-8000-0000000000aa" });
    expect(answer).toMatchObject({ ok: true, result: { receipt: { status: "accepted" }, result: { code: "K7Q2MXH4RT" } } });
    expect(wire.server.received().filter((f) => f.type === "request").map((f) => (f as { method: string }).method)).toContain("access.pairings.create");
  });

  it("passes the environment's error on as it is", async () => {
    const { runtime, id } = await paired();
    const answer = await runtime.requests.call(id, "groups.list", {});
    expect(answer).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("refuses at once, sending nothing, when the connection is not ready", async () => {
    const { runtime, wire, id } = await paired();
    wire.server.drop();
    await flush();
    const before = wire.server.received().length;
    const answer = await runtime.requests.call(id, "environment.status", {});
    expect(answer).toMatchObject({ ok: false, error: { code: "unreachable" } });
    expect(wire.server.received().length).toBe(before);
  });

  it("refuses at once as unreachable while the connection is on its way back, not yet ready", async () => {
    const { runtime, wire, clock, id } = await paired();
    wire.server.drop();
    await flush();
    clock.advance(1250);
    await flush();
    expect(runtime.connections.list.read()[0]?.phase).toBe("connecting");
    const before = wire.server.received().length;
    const answer = await runtime.requests.call(id, "environment.status", {});
    expect(answer).toEqual({ ok: false, error: { code: "unreachable", message: "Connecting to box." } });
    expect(wire.server.received().length).toBe(before);
  });

  it("refuses an environment it has no connection to", async () => {
    const { runtime } = await paired();
    expect(await runtime.requests.call("0199aa00-0000-7000-8000-00000000dead", "environment.status", {})).toMatchObject({
      ok: false,
      error: { code: "unreachable" },
    });
  });

  it("refuses a method whose scope the client session lacks, with the capability's line", async () => {
    const { runtime, id } = await paired({ scopes: ["read"] });
    const answer = await runtime.requests.call(id, "access.sessions.list", {});
    expect(answer).toEqual({ ok: false, error: { code: "scope", message: expect.stringContaining("admin") } });
  });

  it("refuses params that are not the method's, sending nothing", async () => {
    const { runtime, wire, id } = await paired();
    const before = wire.server.received().length;
    const answer = await runtime.requests.call(id, "access.sessions.revoke", { commandId: "not a uuid", clientSessionId: "x" } as never);
    expect(answer).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(wire.server.received().length).toBe(before);
  });

  it("refuses a stream: subscriptions are the runtime's own", async () => {
    const { runtime, id } = await paired();
    expect(await runtime.requests.call(id, "sessions.subscribe", { afterSequence: 0 })).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("refuses a sessions:write command, sending nothing: every one goes through the outbox", async () => {
    const { runtime, wire, id } = await paired();
    const before = wire.server.received().length;
    const answer = await runtime.requests.call(id, "sessions.archive", {
      commandId: "0199aa00-0000-7000-8000-0000000000ab",
      sessionId: "0199aa00-0000-4000-8000-000000000001",
    });
    expect(answer).toEqual({ ok: false, error: { code: "outbox", message: expect.stringContaining("sessions:write") } });
    expect(wire.server.received().length).toBe(before);
  });

  it("calls an answer that does not match the method's schema malformed", async () => {
    const { runtime, wire, id } = await paired();
    wire.answer("access.sessions.list", () => ({ result: { sessions: "none" } }));
    expect(await runtime.requests.call(id, "access.sessions.list", {})).toMatchObject({ ok: false, error: { code: "malformed" } });
  });

  it("gives up after 30 seconds without an answer", async () => {
    const { runtime, wire, clock, id } = await paired();
    wire.answer("access.sessions.list", () => undefined);
    let settled: unknown;
    void runtime.requests.call(id, "access.sessions.list", {}).then((answer) => (settled = answer));
    await flush();
    clock.advance(REQUEST_TIMEOUT_MS - 1);
    await flush();
    expect(settled).toBeUndefined();
    clock.advance(1);
    await flush();
    expect(settled).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it.each(["accepted", "rejected"] as const)("keeps a staging update open past 30 seconds and returns its %s receipt", async (status) => {
    const { runtime, wire, clock, id } = await paired();
    wire.answer("updates.apply", () => undefined);
    let settled: unknown;
    const answer = runtime.requests.call(id, "updates.apply", { commandId: "0199aa00-0000-7000-8000-0000000000ab", when: "idle" });
    void answer.then((result) => (settled = result));
    const request = await wire.server.request("updates.apply");
    for (let i = 0; i < 3; i++) {
      wire.server.ping();
      await flush();
      clock.advance(20_000);
      await flush();
    }
    expect(settled).toBeUndefined();
    const receipt = status === "accepted"
      ? { status, sequence: 1, changed: true }
      : { status, sequence: 1, changed: false, reason: "conflict", error: { code: "conflict", message: "The launcher refused to install 0.6.0: disk.", data: { reason: "install", launcherReason: "disk" } } };
    wire.server.send({ type: "response", id: request.id, result: {
      receipt,
      ...(status === "accepted" && { result: { updateId: "0199aa00-0000-4000-8000-000000000001", toVersion: "0.6.0" } }),
    } });
    expect(await answer).toMatchObject({ ok: true, result: { receipt } });
  });

  it("bounds an unanswered update stage at 20 minutes", async () => {
    const { runtime, wire, clock, id } = await paired();
    wire.answer("updates.apply", () => undefined);
    let settled: unknown;
    const answer = runtime.requests.call(id, "updates.apply", { commandId: "0199aa00-0000-7000-8000-0000000000ab", when: "idle" });
    void answer.then((result) => (settled = result));
    await wire.server.request("updates.apply");
    for (let elapsed = 0; elapsed < UPDATE_APPLY_TIMEOUT_MS - 20_000; elapsed += 20_000) {
      wire.server.ping();
      await flush();
      clock.advance(20_000);
      await flush();
    }
    wire.server.ping();
    await flush();
    clock.advance(19_999);
    await flush();
    expect(settled).toBeUndefined();
    clock.advance(1);
    expect(await answer).toEqual({ ok: false, error: { code: "timeout", message: "The environment did not answer updates.apply within 1200 seconds." } });
  });

  it("answers unreachable when the socket closes before the answer", async () => {
    const { runtime, wire, id } = await paired();
    wire.answer("access.sessions.list", () => undefined);
    const answer = runtime.requests.call(id, "access.sessions.list", {});
    await flush();
    wire.server.drop();
    expect(await answer).toMatchObject({ ok: false, error: { code: "unreachable" } });
  });
});

/** What permissions.settings.get answers on an environment nobody has changed, containment unavailable everywhere but off. */
const PERMISSIONS_REPORT = {
  values: presetPermissionSettings(),
  containment: {
    levels: CONTAINMENT_LEVELS.map((level) => ({ level, available: level === "off", reason: level === "off" ? null : "No mechanism here.", cause: level === "off" ? null : "binary_missing" })),
    mechanism: null,
    container: { declared: false, detected: false },
  },
  isRoot: false,
  denylist: { browserDomains: 0, paths: 0, commandPatterns: 0, hosts: 0 },
};

/** An `updates.status` answer: an environment under its launcher with nothing pending. */
const UPDATES_STATUS = {
  version: "0.1.0",
  protocolVersion: 1,
  bundledClaudeCodeVersion: null,
  manager: { kind: "launcher", launcherVersion: "0.1.0" },
  releaseSource: { origin: "https://git.example.com", kind: "forgejo", repository: "david/agent-harness" },
  newest: null,
  lastCheck: null,
  target: null,
  passedOver: null,
  pending: { state: "current" },
  lastOutcome: null,
  failedVersions: [],
  installed: ["0.1.0"],
};

describe("the request cache", () => {
  /** A runtime paired with the fake wire, counting the `groups.list` requests it sends. */
  const counting = async (setup: { readonly environmentStream?: boolean; readonly banks?: boolean } = {}) => {
    const clock = manualClock();
    const wire = fakeWire({ clock, name: "box", capabilities: setup.banks ? ["banks"] : [] });
    let asked = 0;
    wire.answer("groups.list", () => {
      asked++;
      return { result: { groups: [] } };
    });
    if (setup.environmentStream) wire.answer("environment.subscribe", () => undefined);
    const platform = inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket });
    const { runtime } = createRuntimeWithSeams(platform);
    onTestFinished(() => runtime.close());
    await runtime.start();
    const adding = runtime.connections.add({ link: wire.link });
    await wire.server.accept();
    const environment = setup.environmentStream ? await subscription(wire, "environment.subscribe") : undefined;
    environment?.synchronized(0);
    expect(await adding).toMatchObject({ status: "paired" });
    return { clock, wire, runtime, id: wire.environmentId, asked: () => asked, environment };
  };

  it("fetches a query when first followed, and answers every follower from it for five minutes", async () => {
    const { clock, runtime, id, asked } = await counting();
    const cached = runtime.requests.cached(id, "groups.list", {});
    expect(cached.read()).toEqual({ result: null, fetchedAt: null, error: null, loading: false });
    expect(asked()).toBe(0);

    const stop = cached.subscribe(() => undefined);
    expect(cached.read().loading).toBe(true);
    await flush();
    expect(cached.read()).toEqual({ result: { groups: [] }, fetchedAt: clock.now().toISOString(), error: null, loading: false });
    expect(runtime.requests.cached(id, "groups.list", {})).toBe(cached);
    const again = runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    await flush();
    expect(asked()).toBe(1);

    clock.advance(REQUEST_CACHE_TTL_MS - 1);
    await flush();
    expect(asked()).toBe(1);
    clock.advance(1);
    await flush();
    expect(asked()).toBe(2);

    // Followed by nobody, it is not fetched again until someone follows it once more.
    stop();
    again();
    clock.advance(REQUEST_CACHE_TTL_MS * 2);
    await flush();
    expect(asked()).toBe(2);
    cached.subscribe(() => undefined);
    await flush();
    expect(asked()).toBe(3);
    expect(REQUEST_CACHE_TTL_MS).toBe(5 * 60_000);
  });

  it("keeps the last result beside the failure while the environment cannot be reached, and fetches again on ready", async () => {
    const { clock, wire, runtime, id, asked } = await counting();
    const cached = runtime.requests.cached(id, "groups.list", {});
    cached.subscribe(() => undefined);
    await flush();
    expect(asked()).toBe(1);
    wire.discovery("unreachable");
    wire.server.drop();
    await flush();
    // The five minutes run out with no socket: the answer is unreachable at once, and the last result stays.
    clock.advance(REQUEST_CACHE_TTL_MS);
    await flush();
    expect(asked()).toBe(1);
    expect(cached.read()).toMatchObject({ result: { groups: [] }, error: { code: "unreachable" }, loading: false });

    wire.discovery({});
    void runtime.connections.retryNow(id);
    await wire.server.accept();
    await flush();
    expect(asked()).toBe(2);
    expect(cached.read()).toMatchObject({ result: { groups: [] }, error: null });
  });

  it("fetches again on a notice that the environment restarted or was updated", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    await flush();
    expect(asked()).toBe(1);
    environment?.event(noticeEvent(1, wire.environmentId, "environment.updated", { fromVersion: "0.1.0", toVersion: "0.2.0" }));
    await flush();
    expect(asked()).toBe(2);
    environment?.event(noticeEvent(2, wire.environmentId, "environment.draining", { drainingSince: "2026-09-24T00:00:00.000Z" }));
    await flush();
    expect(asked()).toBe(2);
  });

  it("refreshes a followed draft queue when a memory change is queued (#1030)", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true, banks: true });
    const sessionId = "0199aa00-0000-4000-8000-000000000001";
    const bankId = "0199aa00-0000-4000-8000-000000000002";
    const change = { kind: "retire" as const, name: "old-fact", path: "projects/team/work/memories/old-fact.md", reason: "The fact no longer applies." };
    let queued = false;
    wire.answer("banks.drafts.list", () => ({ result: { queues: queued ? [{ bankId, drafts: [change] }] : [] } }));
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const drafts = runtime.requests.cached(id, "banks.drafts.list", { sessionId, bankId });
    drafts.subscribe(() => undefined);
    await flush();
    expect(drafts.read()).toMatchObject({ result: { queues: [] }, error: null });

    queued = true;
    environment?.event(noticeEvent(1, wire.environmentId, "bank.draft-queued", { sessionId, bankId, change }));
    await flush();
    expect(drafts.read()).toMatchObject({ result: { queues: [{ bankId, drafts: [change] }] }, error: null });
    expect(asked()).toBe(1);
    queued = false;
    environment?.event(noticeEvent(2, wire.environmentId, "bank.drafts-consumed", { sessionId, bankId, changes: [change] }));
    await flush();
    expect(drafts.read()).toMatchObject({ result: { queues: [] }, error: null });
    expect(asked()).toBe(1);
  });

  it("fetches updates.status again on every update notice and a check of the channel that changed it, and no other query for the pending, started, failed, cancelled or checked one (#344, #1795)", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    let statuses = 0;
    wire.answer("updates.status", () => {
      statuses++;
      return { result: UPDATES_STATUS };
    });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const status = runtime.requests.cached(id, "updates.status", {});
    status.subscribe(() => undefined);
    await flush();
    expect([asked(), statuses]).toEqual([1, 1]);

    const updateId = "0d4f2c1e-7a3b-4c5d-8e9f-0a1b2c3d4e5f";
    const steps: [string, Record<string, unknown>][] = [
      ["environment.update-pending", { updateId, toVersion: "0.2.0", source: "channel", since: "2026-09-24T00:00:00.000Z", deferUntil: "2026-09-25T00:00:00.000Z" }],
      ["environment.update-started", { updateId, fromVersion: "0.1.0", toVersion: "0.2.0", cause: "idle" }],
      ["environment.update-failed", { updateId, fromVersion: "0.1.0", toVersion: "0.2.0", stage: "trial", reason: "deadline", rolledBack: true }],
      ["environment.update-cancelled", { updateId, toVersion: "0.2.0", cause: "requested" }],
      ["environment.channel-checked", { newest: "0.2.0", lastCheck: { at: "2026-09-24T00:00:00.000Z", result: "ok" } }],
    ];
    for (const [sequence, [type, payload]] of steps.entries()) {
      environment?.event(noticeEvent(sequence + 1, wire.environmentId, type, payload));
      await flush();
      expect([asked(), statuses], type).toEqual([1, sequence + 2]);
    }
    // The update that took refreshes every answer, this one with them.
    environment?.event(noticeEvent(steps.length + 1, wire.environmentId, "environment.updated", { fromVersion: "0.1.0", toVersion: "0.2.0", updateId }));
    await flush();
    expect([asked(), statuses]).toEqual([2, steps.length + 2]);
    expect(status.read()).toMatchObject({ result: UPDATES_STATUS, error: null });
  });

  it("fetches settings.get and permissions.settings.get again on settings.changed, and no other query, well inside the five minutes (#391)", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    let settings = 0;
    let permissions = 0;
    let values: Record<string, unknown> = { "sessions.autoSettleOnMerge": false };
    wire.answer("settings.get", () => {
      settings++;
      return { result: { values } };
    });
    wire.answer("permissions.settings.get", () => {
      permissions++;
      return { result: PERMISSIONS_REPORT };
    });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const cached = runtime.requests.cached(id, "settings.get", {});
    cached.subscribe(() => undefined);
    runtime.requests.cached(id, "permissions.settings.get", {}).subscribe(() => undefined);
    await flush();
    expect([asked(), settings, permissions]).toEqual([1, 1, 1]);

    values = { "sessions.autoSettleOnMerge": true };
    environment?.event(noticeEvent(1, wire.environmentId, "settings.changed", { keys: ["sessions.autoSettleOnMerge"] }));
    await flush();
    expect([asked(), settings, permissions]).toEqual([1, 2, 2]);
    expect(cached.read()).toMatchObject({ result: { values: { "sessions.autoSettleOnMerge": true } }, error: null });
  });

  it("fetches permissions.denylist.get and permissions.settings.get, whose section counts it changes, again on denylist.updated, and permissions.review.list on review.updated, each no other query (#811)", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    const reads = { denylist: 0, permissions: 0, review: 0 };
    let hosts: { id: string; pattern: string; note: string; preset: boolean; enabled: boolean }[] = [];
    wire.answer("permissions.denylist.get", () => {
      reads.denylist++;
      return { result: { denylist: { browserDomains: [], paths: [], commandPatterns: [], hosts } } };
    });
    wire.answer("permissions.settings.get", () => {
      reads.permissions++;
      return { result: PERMISSIONS_REPORT };
    });
    wire.answer("permissions.review.list", () => {
      reads.review++;
      return { result: { watermark: 0, head: 7, runs: [] } };
    });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const denylist = runtime.requests.cached(id, "permissions.denylist.get", {});
    denylist.subscribe(() => undefined);
    runtime.requests.cached(id, "permissions.settings.get", {}).subscribe(() => undefined);
    runtime.requests.cached(id, "permissions.review.list", {}).subscribe(() => undefined);
    await flush();
    expect([asked(), reads.denylist, reads.permissions, reads.review]).toEqual([1, 1, 1, 1]);

    hosts = [{ id: "metadata", pattern: "169.254.169.254", note: "", preset: false, enabled: true }];
    environment?.event(noticeEvent(1, wire.environmentId, "denylist.updated", { sections: ["hosts"] }));
    await flush();
    expect([asked(), reads.denylist, reads.permissions, reads.review]).toEqual([1, 2, 2, 1]);
    expect(denylist.read()).toMatchObject({ result: { denylist: { hosts } }, error: null });

    environment?.event(noticeEvent(2, wire.environmentId, "review.updated", {}));
    await flush();
    expect([asked(), reads.denylist, reads.permissions, reads.review]).toEqual([1, 2, 2, 2]);
    // Neither list is a setting.
    environment?.event(noticeEvent(3, wire.environmentId, "settings.changed", { keys: ["permissions.defaultCeiling"] }));
    await flush();
    expect([asked(), reads.denylist, reads.permissions, reads.review]).toEqual([1, 2, 3, 2]);
  });

  it("fetches a session's skills.get again on skills.updated, account changes, trust.updated and forge aliases, and no other query (#494, #501, #516)", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    let reads = 0;
    const accounts = [{ accountId: "claude-max", channel: "system-prompt-append", reason: null }];
    const view = { ownDirectory: "/home/david/.local/state/agent-harness/skills/own", sources: [], choices: [], accountId: "claude-max", accounts, members: [] };
    wire.answer("skills.get", () => {
      reads++;
      return { result: view };
    });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const skills = runtime.requests.cached(id, "skills.get", { sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" });
    skills.subscribe(() => undefined);
    await flush();
    expect([asked(), reads]).toEqual([1, 1]);
    environment?.event(noticeEvent(1, wire.environmentId, "skills.updated", {}));
    await flush();
    expect([asked(), reads]).toEqual([1, 2]);
    expect(skills.read()).toMatchObject({ result: view, error: null });
    // The view lists the accounts, and an account's removal drops the choices naming it.
    environment?.event(noticeEvent(2, wire.environmentId, "account.updated", { accountId: "claude-max", change: "removed", warning: null }));
    await flush();
    expect([asked(), reads]).toEqual([1, 3]);
    // Trust and canonical-host aliases determine the session's repository members.
    environment?.event(noticeEvent(3, wire.environmentId, "trust.updated", {}));
    await flush();
    expect([asked(), reads]).toEqual([1, 4]);
    environment?.event(noticeEvent(4, wire.environmentId, "forge.account.verified", forgeEventPayload("forge.account.verified", forgeRecord())));
    await flush();
    expect([asked(), reads]).toEqual([1, 5]);
    expect(skills.read()).toMatchObject({ result: view, error: null });
  });

  it("fetches skills.readiness again on skills.updated, account changes and trust.updated, and no other query (#510, #516)", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    let reads = 0;
    const ready = { skills: [{ name: "tdd", state: "ready", declaredBy: null }] };
    const setupNeeded = {
      skills: [
        {
          name: "to-spec",
          state: "setup-needed",
          declaredBy: "overlay",
          failing: [{ check: { kind: "file", paths: ["docs/agents/issue-tracker.md"] }, outcome: "failed", message: "docs/agents/issue-tracker.md is not in the workspace." }],
          why: null,
          fix: "/setup-matt-pocock-skills",
        },
      ],
    };
    wire.answer("skills.readiness", () => {
      reads++;
      return { result: reads > 1 ? setupNeeded : ready };
    });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const readiness = runtime.requests.cached(id, "skills.readiness", { sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" });
    readiness.subscribe(() => undefined);
    await flush();
    expect([asked(), reads]).toEqual([1, 1]);
    environment?.event(noticeEvent(1, wire.environmentId, "skills.updated", {}));
    await flush();
    expect([asked(), reads]).toEqual([1, 2]);
    expect(readiness.read()).toMatchObject({ result: setupNeeded, error: null });
    environment?.event(noticeEvent(2, wire.environmentId, "account.updated", { accountId: "claude-max", change: "removed", warning: null }));
    await flush();
    expect([asked(), reads]).toEqual([1, 3]);
    environment?.event(noticeEvent(3, wire.environmentId, "trust.updated", {}));
    await flush();
    expect([asked(), reads]).toEqual([1, 4]);
  });

  it("fetches trust.get and trust.list again on trust.updated and on a forge account's aliases changing, and no other query (#500)", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    const reads = { get: 0, list: 0 };
    const offer = { instructionFiles: ["CLAUDE.md"], skillRoots: [], commands: 0, hooks: [], permissionRules: { allow: 0, ask: 0, deny: 0 }, subagents: 0, mcpServers: [] };
    const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    wire.answer("trust.get", () => {
      reads.get++;
      return { result: { key: "https://git.systemtech.dev/david/agent-harness", keyKind: "identity", decision: reads.get > 1 ? "trusted" : "undecided", offer } };
    });
    wire.answer("trust.list", () => {
      reads.list++;
      return { result: { trusted: [], declined: [] } };
    });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const trust = runtime.requests.cached(id, "trust.get", { sessionId });
    trust.subscribe(() => undefined);
    runtime.requests.cached(id, "trust.list", {}).subscribe(() => undefined);
    await flush();
    expect([asked(), reads.get, reads.list]).toEqual([1, 1, 1]);

    environment?.event(noticeEvent(1, wire.environmentId, "trust.updated", {}));
    await flush();
    expect([asked(), reads.get, reads.list]).toEqual([1, 2, 2]);
    expect(trust.read()).toMatchObject({ result: { decision: "trusted" }, error: null });
    environment?.event(noticeEvent(2, wire.environmentId, "skills.updated", {}));
    await flush();
    expect([asked(), reads.get, reads.list]).toEqual([1, 2, 2]);
    // A key is read on the canonical host of a verified alias: an alias verified since may change it.
    environment?.event(noticeEvent(3, wire.environmentId, "forge.account.verified", forgeEventPayload("forge.account.verified", forgeRecord())));
    await flush();
    expect([asked(), reads.get, reads.list]).toEqual([1, 3, 3]);
  });

  it("fetches a session's commands.list again on skills.updated, trust.updated, a forge account's aliases or an account changing, and no other query (#503)", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    let reads = 0;
    const tdd = { kind: "skill", name: "tdd", description: "Test-driven development.", invocation: "slash-only", origin: null, alwaysOn: false, argumentHint: null };
    wire.answer("commands.list", () => {
      reads++;
      return { result: { accountId: "claude-max", entries: reads > 1 ? [tdd] : [] } };
    });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const listing = runtime.requests.cached(id, "commands.list", { sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" });
    listing.subscribe(() => undefined);
    await flush();
    expect([asked(), reads]).toEqual([1, 1]);

    // The set changed: a member added, switched off or made always-on.
    environment?.event(noticeEvent(1, wire.environmentId, "skills.updated", {}));
    await flush();
    expect([asked(), reads]).toEqual([1, 2]);
    expect(listing.read()).toMatchObject({ result: { entries: [tdd] }, error: null });
    // The session's trust changed, and with it the repository's members and the provider's own commands.
    environment?.event(noticeEvent(2, wire.environmentId, "trust.updated", {}));
    await flush();
    expect([asked(), reads]).toEqual([1, 3]);
    environment?.event(noticeEvent(3, wire.environmentId, "forge.account.verified", forgeEventPayload("forge.account.verified", forgeRecord())));
    await flush();
    expect([asked(), reads]).toEqual([1, 4]);
    // The account's choices, or the default account a session on none lists, changed.
    environment?.event(noticeEvent(4, wire.environmentId, "account.updated", { accountId: "claude-max", change: "removed", warning: null }));
    await flush();
    expect([asked(), reads]).toEqual([1, 5]);
    environment?.event(noticeEvent(5, wire.environmentId, "instructions.updated", {}));
    await flush();
    expect([asked(), reads]).toEqual([1, 5]);
  });

  it("fetches browser.status again on extension.seen, and no other query (#547)", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    let reads = 0;
    wire.answer("browser.status", () => {
      reads++;
      return {
        result: {
          listener: { state: "listening", port: 47615 },
          folder: { path: "/home/david/.local/state/agent-harness/extension/current", problem: null },
          shippedVersion: "0.4.2",
          unpairedConnected: reads > 1,
          headless: { allowRuns: true, availability: { available: false, reason: "No Chromium or Chrome was found." }, liveContexts: 0 },
        },
      };
    });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const status = runtime.requests.cached(id, "browser.status", {});
    status.subscribe(() => undefined);
    await flush();
    expect([asked(), reads]).toEqual([1, 1]);

    environment?.event(noticeEvent(1, wire.environmentId, "extension.seen", { protocolVersion: 2, extensionVersion: "0.4.2" }));
    await flush();
    expect([asked(), reads]).toEqual([1, 2]);
    expect(status.read()).toMatchObject({ result: { unpairedConnected: true }, error: null });
  });

  it("fetches browser.chromes.list and browser.status again on chrome.updated, and no other query (#548)", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    const chromeId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const chrome = { id: chromeId, name: "Work", pairedAt: "2026-09-24T00:00:00.000Z", lastConnectedAt: "2026-09-24T00:00:00.000Z", lastReportedVersion: "0.4.2", outdated: false };
    const reads = { list: 0, status: 0 };
    wire.answer("browser.chromes.list", () => {
      reads.list++;
      return { result: { chromes: [{ ...chrome, connected: reads.list > 1 }] } };
    });
    wire.answer("browser.status", () => {
      reads.status++;
      return {
        result: {
          listener: { state: "listening", port: 47615 },
          folder: { path: "/home/david/.local/state/agent-harness/extension/current", problem: null },
          shippedVersion: "0.4.2",
          unpairedConnected: reads.status === 1,
          headless: { allowRuns: true, availability: { available: false, reason: "No Chromium or Chrome was found." }, liveContexts: 0 },
        },
      };
    });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const list = runtime.requests.cached(id, "browser.chromes.list", {});
    list.subscribe(() => undefined);
    const status = runtime.requests.cached(id, "browser.status", {});
    status.subscribe(() => undefined);
    await flush();
    expect([asked(), reads.list, reads.status]).toEqual([1, 1, 1]);

    environment?.event(noticeEvent(1, wire.environmentId, "chrome.updated", { chromeId, name: "Work", change: "connected" }));
    await flush();
    expect([asked(), reads.list, reads.status]).toEqual([1, 2, 2]);
    expect(list.read()).toMatchObject({ result: { chromes: [{ id: chromeId, connected: true }] }, error: null });
    expect(status.read()).toMatchObject({ result: { unpairedConnected: false }, error: null });
  });

  it("fetches carryOver.inventory again when an import of the account's directory ends, a memory folder is assigned or the skill set changes, and no other query (#578, #580)", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    let reads = 0;
    wire.answer("carryOver.inventory", () => {
      reads++;
      return {
        result: {
          accountId: "claude-max",
          sessions: { total: 3, archived: 1, missingDirectory: 1, new: reads > 1 ? 0 : 2 },
          memory: { folders: 2, repositories: 1, unmappable: reads > 2 ? [] : [{ folder: "-tmp-pad", path: "/home/david/.claude/projects/-tmp-pad/memory" }], new: 0 },
          skills: { skills: 1, commands: 0, new: 0, offered: [], invalid: 0 },
          notCarried: [],
          doesNotCarry: { hooks: 0, mcpServers: 0, permissionRules: 0 },
        },
      };
    });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const inventory = runtime.requests.cached(id, "carryOver.inventory", { accountId: "claude-max" });
    inventory.subscribe(() => undefined);
    await flush();
    expect([asked(), reads]).toEqual([1, 1]);

    const imported = { accountId: "claude-max", sessions: { listed: 3, imported: 2, archived: 1, missingDirectory: 1, held: 1 }, failed: [] };
    environment?.event(noticeEvent(1, wire.environmentId, "carry-over.imported", imported));
    await flush();
    expect([asked(), reads]).toEqual([1, 2]);
    expect(inventory.read()).toMatchObject({ result: { sessions: { new: 0 } }, error: null });

    const copy = { folder: "-tmp-pad", path: "/home/david/.claude/projects/-tmp-pad/memory", key: "https://git.example.com/david/pad", outcome: "copied", under: null, digest: `sha256:${"0".repeat(64)}` };
    environment?.event(noticeEvent(2, wire.environmentId, "carry-over.memory-assigned", { accountId: "claude-max", repositoryIdentity: "https://git.example.com/david/pad", copy }));
    await flush();
    expect([asked(), reads]).toEqual([1, 3]);
    expect(inventory.read()).toMatchObject({ result: { memory: { unmappable: [] } }, error: null });

    environment?.event(noticeEvent(3, wire.environmentId, "skills.updated", {}));
    await flush();
    expect([asked(), reads]).toEqual([1, 4]);
    environment?.event(noticeEvent(4, wire.environmentId, "trust.updated", {}));
    await flush();
    expect([asked(), reads]).toEqual([1, 4]);
  });

  it("fetches instructions.list and instructions.preview again on instructions.updated, on the settings, an account, a forge account, a key-manager connection, the managed tools or the known environments changing, and no other query (#505)", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    const reads = { list: 0, preview: 0 };
    const accounts = [{ accountId: "claude-max", label: "Claude Max", channel: { kind: "system-prompt-append", maxCharacters: null }, reason: null }];
    const manifest = { channel: "system-prompt-append", layers: [], alwaysOn: [], skillSetFingerprint: null, unreadRegistries: [], leftOut: [] };
    wire.answer("instructions.list", () => {
      reads.list++;
      return { result: { orientation: { enabled: reads.list === 1, text: "# Orientation", unreadRegistries: [], accounts }, instructions: [], dismissed: [] } };
    });
    wire.answer("instructions.preview", () => {
      reads.preview++;
      return { result: { parts: [], text: "", manifest } };
    });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const listed = runtime.requests.cached(id, "instructions.list", {});
    listed.subscribe(() => undefined);
    runtime.requests.cached(id, "instructions.preview", { sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }).subscribe(() => undefined);
    await flush();
    expect([asked(), reads.list, reads.preview]).toEqual([1, 1, 1]);

    environment?.event(noticeEvent(1, wire.environmentId, "instructions.updated", {}));
    await flush();
    expect([asked(), reads.list, reads.preview]).toEqual([1, 2, 2]);
    expect(listed.read()).toMatchObject({ result: { orientation: { enabled: false } }, error: null });
    environment?.event(noticeEvent(2, wire.environmentId, "trust.updated", {}));
    await flush();
    expect([asked(), reads.list, reads.preview]).toEqual([1, 2, 2]);
    // The orientation switch is a setting.
    environment?.event(noticeEvent(3, wire.environmentId, "settings.changed", { keys: ["instructions.orientation"] }));
    await flush();
    expect([asked(), reads.list, reads.preview]).toEqual([1, 3, 3]);
    // Every row carries the accounts, and the block names them.
    environment?.event(noticeEvent(4, wire.environmentId, "account.updated", { accountId: "claude-max", change: "added", warning: null }));
    await flush();
    expect(reads.list).toBe(4);
    expect(reads.preview).toBe(4);
    // The block's forges and key managers sections: a forge account, a key-manager connection and its CLI's row.
    environment?.event(noticeEvent(5, wire.environmentId, "forge.account.verified", forgeEventPayload("forge.account.verified", forgeRecord())));
    await flush();
    expect([reads.list, reads.preview]).toEqual([5, 5]);
    environment?.event(noticeEvent(6, wire.environmentId, "key-manager.connection.added", keyManagerEventPayload("key-manager.connection.added", keyManagerRecord())));
    await flush();
    expect([reads.list, reads.preview]).toEqual([6, 6]);
    environment?.event(noticeEvent(7, wire.environmentId, "tools.updated", toolsUpdatedPayload(toolRow({ version: "2.2.0" }))));
    await flush();
    expect([asked(), reads.list, reads.preview]).toEqual([1, 7, 7]);
    // The block's other environments section (#382).
    environment?.event(noticeEvent(8, wire.environmentId, "environment.known-environments-updated", { environments: [{ name: "laptop", address: "http://laptop:7433" }] }));
    await flush();
    expect([asked(), reads.list, reads.preview]).toEqual([1, 8, 8]);
  });

  it("fetches instructions.diff again on instructions.updated alone (#509)", async () => {
    const { runtime, wire, id, environment } = await counting({ environmentStream: true });
    let reads = 0;
    wire.answer("instructions.diff", () => {
      reads++;
      return { result: { catalogueId: "coding.fresh-checkout", fromVersion: 1, toVersion: 2, from: "Old.", to: "New.", body: reads === 1 ? "Old." : "New." } };
    });
    const diffed = runtime.requests.cached(id, "instructions.diff", { instructionId: "0f8fad5b-d9cb-469f-a165-70867728950e" });
    diffed.subscribe(() => undefined);
    await flush();
    expect(reads).toBe(1);
    environment?.event(noticeEvent(1, wire.environmentId, "settings.changed", { keys: ["instructions.orientation"] }));
    environment?.event(noticeEvent(2, wire.environmentId, "account.updated", { accountId: "claude-max", change: "added", warning: null }));
    await flush();
    expect(reads).toBe(1);
    environment?.event(noticeEvent(3, wire.environmentId, "instructions.updated", {}));
    await flush();
    expect(reads).toBe(2);
    expect(diffed.read()).toMatchObject({ result: { body: "New." }, error: null });
  });

  it("fetches stateImport.detect again when a state import ends, leaving unrelated queries alone (#581)", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    let reads = 0;
    wire.answer("stateImport.detect", () => {
      reads++;
      return { result: { dataFolder: null, terminalFolder: reads > 1 ? null : { path: "/home/david/.local/state/source" } } };
    });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const detection = runtime.requests.cached(id, "stateImport.detect", {});
    detection.subscribe(() => undefined);
    await flush();
    expect([asked(), reads]).toEqual([1, 1]);

    const carried = { accounts: 0, archived: 0, pins: 0, groups: 0, forgeAccounts: 0, keyManagerConnections: 0, banks: 0, routines: 0, instructions: 0, skillSources: 0, alwaysOnSkills: 0, drafts: 0, devSites: 0 };
    environment?.event(noticeEvent(1, wire.environmentId, "state-import.finished", { carried, reEnter: [], later: [], notCarried: [], failed: [] }));
    await flush();
    expect([asked(), reads]).toEqual([1, 2]);
    expect(detection.read()).toMatchObject({ result: { terminalFolder: null }, error: null });
    environment?.event(noticeEvent(2, wire.environmentId, "carry-over.imported", { accountId: "claude-max", sessions: { listed: 0, imported: 0, archived: 0, missingDirectory: 0, held: 0 }, failed: [] }));
    await flush();
    expect([asked(), reads]).toEqual([1, 2]);
  });

  it("fetches one query again when asked to, at once while followed and by its next follower otherwise, and no other query (#576)", async () => {
    const { runtime, wire, id, asked } = await counting();
    let reads = 0;
    wire.answer("environment.status", () => {
      reads++;
      return { result: { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false } };
    });
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const status = runtime.requests.cached(id, "environment.status", {});
    const stop = status.subscribe(() => undefined);
    await flush();
    expect([asked(), reads]).toEqual([1, 1]);

    runtime.requests.refresh(id, "environment.status", {});
    await flush();
    expect([asked(), reads]).toEqual([1, 2]);

    // Followed by nobody, it is fetched by its next follower, well inside the five minutes.
    stop();
    runtime.requests.refresh(id, "environment.status", {});
    await flush();
    expect(reads).toBe(2);
    status.subscribe(() => undefined);
    await flush();
    expect(reads).toBe(3);

    // A query nobody has asked for has nothing to fetch again.
    runtime.requests.refresh(id, "trust.list", {});
    await flush();
    expect(runtime.requests.cached(id, "trust.list", {}).read()).toEqual({ result: null, fetchedAt: null, error: null, loading: false });
  });

  it("refreshes origin settings from another client, including while the editor is closed", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    let settings = { clientOrigins: [] as string[], connectOrigins: [] as string[] };
    wire.answer("web.origins.get", () => ({ result: settings }));
    runtime.requests.cached(id, "groups.list", {}).subscribe(() => undefined);
    const origins = runtime.requests.cached(id, "web.origins.get", {});
    const stop = origins.subscribe(() => undefined);
    await flush();
    settings = { clientOrigins: ["https://client.example.test"], connectOrigins: [] };
    environment?.event(noticeEvent(1, id, "web.origins.updated", {}));
    await flush();
    expect(origins.read().result).toEqual(settings);
    stop();
    settings = { clientOrigins: [], connectOrigins: ["https://second.example.test"] };
    environment?.event(noticeEvent(2, id, "web.origins.updated", {}));
    await flush();
    origins.subscribe(() => undefined);
    await flush();
    expect(origins.read().result).toEqual(settings);
    expect(asked()).toBe(1);
  });

  it("fetches once more after a fetch asked for again while under way only while followed, and never for five minutes running out during it", async () => {
    const { clock, wire, runtime, id, asked, environment } = await counting({ environmentStream: true });
    const cached = runtime.requests.cached(id, "groups.list", {});
    let stop = cached.subscribe(() => undefined);
    await flush();
    expect(asked()).toBe(1);

    // From now on each answer is held until the test lets it go.
    let held = 0;
    let release = () => undefined as void;
    wire.answer("groups.list", () => {
      held++;
      return new Promise((resolve) => (release = () => resolve({ result: { groups: [] } })));
    });

    // A notice fetches before the five minutes are out, and they run out while that fetch is under way: that is not a second
    // ask, so its answer is the only one sent, and the next comes five minutes after it.
    clock.advance(REQUEST_CACHE_TTL_MS - 1_000);
    environment?.event(noticeEvent(1, wire.environmentId, "environment.updated", { fromVersion: "0.1.0", toVersion: "0.2.0" }));
    await flush();
    expect(held).toBe(1);
    clock.advance(1_000);
    await flush();
    release();
    await flush();
    expect(held).toBe(1);
    expect(cached.read()).toMatchObject({ loading: false, error: null });
    stop();

    // Followed, let go, followed and let go again while a fetch is under way: the second ask is not sent for nobody either,
    // but the answer counts as stale, so the next follower fetches it.
    clock.advance(REQUEST_CACHE_TTL_MS);
    stop = cached.subscribe(() => undefined);
    await flush();
    expect(held).toBe(2);
    stop();
    stop = cached.subscribe(() => undefined);
    stop();
    release();
    await flush();
    expect(held).toBe(2);
    cached.subscribe(() => undefined);
    await flush();
    expect(held).toBe(3);
  });

  it("stops loading when the environment is removed or the runtime closes with a fetch under way", async () => {
    const hold = async () => {
      const setup = await counting();
      setup.wire.answer("groups.list", () => new Promise(() => undefined));
      const cached = setup.runtime.requests.cached(setup.id, "groups.list", {});
      cached.subscribe(() => undefined);
      await flush();
      expect(cached.read().loading).toBe(true);
      return { ...setup, cached };
    };

    const removed = await hold();
    await removed.runtime.connections.remove(removed.id);
    await flush();
    expect(removed.cached.read().loading).toBe(false);

    const closed = await hold();
    await closed.runtime.close();
    await flush();
    expect(closed.cached.read().loading).toBe(false);
  });

  it("says when the fetch whose result it holds was sent, which a failed fetch after it does not move", async () => {
    const clock = manualClock();
    const answers: ((answer: unknown) => void)[] = [];
    const cache = createRequestCache({
      clock,
      call: () => new Promise((resolve) => answers.push(resolve)) as never,
      records: writable<readonly ConnectionRecord[]>([]),
      report: () => undefined,
    });
    onTestFinished(() => cache.close());
    const cached = cache.cached("env-1", "groups.list", {});
    expect(cache.askedAt("env-1", "groups.list", {})).toBeNull();
    const sent = clock.now().getTime();
    onTestFinished(cached.subscribe(() => undefined));
    clock.advance(500);
    answers[0]!({ ok: true, result: { groups: [] } });
    await flush();
    expect(cached.read().fetchedAt).toBe(new Date(sent + 500).toISOString());
    expect(cache.askedAt("env-1", "groups.list", {})).toBe(sent);

    clock.advance(REQUEST_CACHE_TTL_MS);
    await flush();
    answers[1]!({ ok: false, error: { code: "unreachable", message: "The environment cannot be reached." } });
    await flush();
    expect(cached.read()).toMatchObject({ result: { groups: [] }, error: { code: "unreachable" } });
    expect(cache.askedAt("env-1", "groups.list", {})).toBe(sent);
  });

  it("is not left in flight by a call that rejects: the failure is reported, loading ends, and the next follower fetches again", async () => {
    const clock = manualClock();
    const reported: unknown[] = [];
    let calls = 0;
    const cache = createRequestCache({
      clock,
      call: () => {
        calls++;
        return calls === 1 ? Promise.reject(new Error("the host broke")) : Promise.resolve({ ok: true, result: { groups: [] } } as never);
      },
      records: writable<readonly ConnectionRecord[]>([]),
      report: (error) => reported.push(error),
    });
    onTestFinished(() => cache.close());
    const cached = cache.cached("env-1", "groups.list", {});
    const stop = cached.subscribe(() => undefined);
    await flush();
    expect(reported).toEqual([new Error("the host broke")]);
    expect(cached.read().loading).toBe(false);
    stop();

    cached.subscribe(() => undefined);
    await flush();
    expect(calls).toBe(2);
    expect(cached.read()).toMatchObject({ result: { groups: [] }, loading: false, error: null });
  });

  it("keeps a call that rejected beside the last result as a failure, and tries it again five minutes on while followed", async () => {
    const clock = manualClock();
    const reported: unknown[] = [];
    let calls = 0;
    const cache = createRequestCache({
      clock,
      call: () => {
        calls++;
        return calls === 1 ? Promise.reject(new Error("the host broke")) : Promise.resolve({ ok: true, result: { groups: [] } } as never);
      },
      records: writable<readonly ConnectionRecord[]>([]),
      report: (error) => reported.push(error),
    });
    onTestFinished(() => cache.close());
    const cached = cache.cached("env-1", "groups.list", {});
    cached.subscribe(() => undefined);
    await flush();
    expect(reported).toEqual([new Error("the host broke")]);
    expect(cached.read()).toMatchObject({ result: null, loading: false, error: { code: "internal", message: "the host broke" } });

    clock.advance(REQUEST_CACHE_TTL_MS - 1);
    await flush();
    expect(calls).toBe(1);
    clock.advance(1);
    await flush();
    expect(calls).toBe(2);
    expect(cached.read()).toMatchObject({ result: { groups: [] }, loading: false, error: null });
  });

  it("is not moved by a caller changing its params object after the call: the entry keeps sending what it was given", async () => {
    const { runtime, wire, id, asked, environment } = await counting({ environmentStream: true });
    const params: Record<string, unknown> = {};
    const cached = runtime.requests.cached(id, "groups.list", params as never);
    cached.subscribe(() => undefined);
    await flush();
    expect(asked()).toBe(1);
    params["changed"] = "later";
    environment?.event(noticeEvent(1, wire.environmentId, "environment.updated", { fromVersion: "0.1.0", toVersion: "0.2.0" }));
    await flush();
    expect(asked()).toBe(2);
    expect(cached.read().loading).toBe(false);
    expect(wire.server.received().flatMap((f) => (f.type === "request" && f.method === "groups.list" ? [f.params] : []))).toEqual([{}, {}]);
  });

  it("keeps one answer per params, and none for what is not a query", async () => {
    const { runtime, id } = await counting();
    expect(runtime.requests.cached(id, "settings.get", { keys: ["sessions.autoSettleOnMerge"] })).not.toBe(
      runtime.requests.cached(id, "settings.get", { keys: ["sessions.autoSettleAfterIdle"] }),
    );
    const command = runtime.requests.cached(id, "sessions.archive" as never, {} as never);
    command.subscribe(() => undefined);
    await flush();
    expect(command.read()).toMatchObject({ result: null, error: { code: "unsupported" } });
  });
});
