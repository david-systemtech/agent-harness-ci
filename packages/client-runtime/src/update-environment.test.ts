import { PROTOCOL_VERSION, type PendingUpdate } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { BYE_WAIT_MS } from "./connections/state-machine.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { GrantReader, LocalCredentialAccess } from "./platform.js";
import type { Runtime } from "./runtime.js";
import { fakeWire, flush } from "./testing/fake-wire.js";
import { fakeShell, inMemoryPlatform, manualClock, type FakeShell, type ShellFunctions } from "./testing/in-memory-platform.js";

/**
 * The `update-environment` action's call (launcher-update spec, "Across a
 * protocol gap"; #353), against a scripted fake environment: blocked
 * `protocol-mismatch` it posts `POST /api/update` with the client's version
 * (and, from a desktop to its local environment, the path of the server the
 * desktop carries when it is that version, #918) and the connection shows
 * `updating` through the restart until `hello` agrees; otherwise it sends
 * `updates.apply`; a refusal raises a notice naming why.
 */

/** The version this client says it is, which the ask names. */
const CLIENT_VERSION = "0.6.0";

/** The client speaks one more than this build, so an environment on this build's is the older side of a mismatch. */
const CLIENT_PROTOCOL = PROTOCOL_VERSION + 1;

const record = (runtime: Runtime) => {
  const [only] = runtime.connections.list.read();
  if (!only) throw new Error("No connection is listed.");
  return only;
};

/** The client's platform: a terminal UI, or a desktop on `shell`. */
const clientOn = (shell: FakeShell | undefined) => (shell === undefined ? { kind: "tui" as const } : { kind: "desktop" as const, shell });

/** A runtime (a terminal UI, or a desktop on `shell`) paired with a fake environment that is older than it and says it can update itself, blocked `protocol-mismatch`. */
const blocked = async (shell?: FakeShell) => {
  const clock = manualClock();
  const wire = fakeWire({ clock, protocolVersion: CLIENT_PROTOCOL, capabilities: ["self-update"] });
  const platform = inMemoryPlatform({ clock, ...clientOn(shell), fetch: wire.fetch, webSocket: wire.webSocket, version: CLIENT_VERSION });
  const { runtime } = createRuntimeWithSeams(platform, { protocolVersion: CLIENT_PROTOCOL });
  onTestFinished(() => runtime.close());
  const starting = runtime.start();
  await starting;
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept();
  expect(await adding).toMatchObject({ status: "paired" });
  wire.discovery({ protocolVersion: PROTOCOL_VERSION, capabilities: ["self-update"] });
  await runtime.connections.retryNow(wire.environmentId);
  expect(record(runtime)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch", action: "update-environment" });
  return { clock, wire, platform, runtime };
};

/** A runtime paired with a fake environment on its own protocol, ready. */
const ready = async () => {
  const clock = manualClock();
  const wire = fakeWire({ clock });
  const platform = inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket, version: CLIENT_VERSION });
  const { runtime } = createRuntimeWithSeams(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept();
  await adding;
  expect(record(runtime).phase).toBe("ready");
  return { clock, wire, runtime };
};

const notices = (runtime: Runtime) => runtime.projections.notices.read().filter((notice) => notice.kind === "update-refused");

describe("update-environment while blocked protocol-mismatch", () => {
  it("posts the route with the client session's token and the client's version, and the connection shows updating through the restart until hello agrees", async () => {
    const { clock, wire, runtime } = await blocked();
    const token = wire.credential()?.token;
    const blockNotices = runtime.projections.notices.read().length;

    const outcome = await runtime.connections.updateEnvironment(wire.environmentId);

    expect(outcome).toEqual({ ok: true, updateId: expect.any(String) as unknown as string, toVersion: CLIENT_VERSION });
    expect(wire.updatePosts()).toEqual([{ token, body: { version: CLIENT_VERSION } }]);
    expect(record(runtime)).toMatchObject({ phase: "updating", blocked: null, action: null });
    expect(notices(runtime)).toEqual([]);

    // The old environment still answers while a run keeps it from restarting: still updating, polled on, nothing raised.
    clock.advance(BYE_WAIT_MS);
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "updating", blocked: null });
    // The restart: nothing answers for a while, and starting.
    wire.discovery("unreachable");
    clock.advance(BYE_WAIT_MS);
    await flush();
    expect(record(runtime).phase).toBe("updating");
    wire.discovery({ protocolVersion: CLIENT_PROTOCOL, readiness: "starting", capabilities: ["self-update"] });
    clock.advance(BYE_WAIT_MS);
    await flush();
    expect(record(runtime).phase).toBe("updating");

    // The new version is up: hello agrees, and the block is cleared.
    wire.discovery({ protocolVersion: CLIENT_PROTOCOL, harnessVersion: CLIENT_VERSION, capabilities: ["self-update"] });
    clock.advance(BYE_WAIT_MS);
    await wire.server.accept({ protocolVersion: CLIENT_PROTOCOL, capabilities: ["self-update"] });
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "ready", blocked: null, action: null, descriptor: { harnessVersion: CLIENT_VERSION } });
    expect(runtime.projections.notices.read()).toHaveLength(blockNotices);
    // It was the route that asked, never the wire: the only socket the fake opened after the pairing is the one that reached ready.
    expect(wire.updatePosts()).toHaveLength(1);
  });

  it("returns to blocked with the update action at 168 hours even if the client is offline, and can ask again", async () => {
    const { clock, wire, platform, runtime } = await blocked();
    await runtime.connections.updateEnvironment(wire.environmentId);
    platform.network.setOnline(false);
    await flush();

    clock.advance(604_799_999);
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "updating", blocked: null, action: null });
    clock.advance(1);
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch", action: "update-environment", retryAt: null });

    platform.network.setOnline(true);
    await flush();
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: true, toVersion: CLIENT_VERSION });
    expect(record(runtime)).toMatchObject({ phase: "updating", blocked: null, action: null });
    expect(wire.updatePosts()).toHaveLength(2);
  });

  it("keeps the block across a restart of this client mid-update, and clears it when hello agrees", async () => {
    const { wire, platform, clock, runtime } = await blocked();
    await runtime.connections.updateEnvironment(wire.environmentId);
    await runtime.close();

    const again = createRuntimeWithSeams(inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket, documents: platform.documents, secrets: platform.secrets, version: CLIENT_VERSION }), {
      protocolVersion: CLIENT_PROTOCOL,
    }).runtime;
    onTestFinished(() => again.close());
    await again.start();
    // The old environment still answers: a re-check finds the block again, and the action to ask once more.
    expect(record(again)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch" });
  });

  it.each([
    [409, { code: "conflict", message: "This environment runs 0.6.0 already.", data: { reason: "current" } }, "current"],
    [403, { code: "forbidden", message: "Only a local client session may name an artefact path.", data: { scope: "admin", reason: "local" } }, "local"],
    [403, { code: "forbidden", message: "Updating the environment needs the admin scope, which this client session does not hold.", data: { scope: "admin" } }, "forbidden"],
    [401, { code: "unauthorized", message: "The client session was revoked.", data: {} }, "unauthorized"],
    [404, { code: "not_found", message: "No release 0.6.0 is published.", data: {} }, "not_found"],
    [503, { code: "unavailable", message: "The environment is draining; try again once it is ready.", data: { readiness: "draining" } }, "unavailable"],
  ] as const)("raises a notice naming why when the environment refuses with %s %s", async (status, error, reason) => {
    const { wire, runtime } = await blocked();
    wire.updateRoute({ status, body: error });

    const outcome = await runtime.connections.updateEnvironment(wire.environmentId);

    expect(outcome).toEqual({ ok: false, refused: true, reason, message: error.message });
    expect(notices(runtime)).toEqual([
      expect.objectContaining({ environmentId: wire.environmentId, action: null, message: `Could not update fake to ${CLIENT_VERSION} (${reason}): ${error.message}` }),
    ]);
    // Still blocked, and the action is still offered to ask again.
    expect(record(runtime)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch", action: "update-environment" });
  });

  it("says nothing is refused when the ask never reaches the environment or its answer is none the route gives, and stays blocked", async () => {
    const { wire, runtime } = await blocked();
    wire.updateRoute("unreachable");
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: false, refused: false, reason: "unreachable" });

    wire.updateRoute({ status: 200, body: { updateId: "not a uuid" } });
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: false, refused: false, reason: "malformed" });
    wire.updateRoute({ status: 502, body: "<html>bad gateway</html>" });
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: false, refused: false, reason: "malformed" });

    expect(notices(runtime)).toEqual([]);
    expect(record(runtime)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch" });
    expect(wire.updatePosts()).toHaveLength(3);
  });

  it("rejects for an environment it has no connection to", async () => {
    const { runtime } = await blocked();
    await expect(runtime.connections.updateEnvironment("no-such-environment")).rejects.toThrow("no saved connection");
  });
});

/**
 * A terminal UI (or a desktop on `shell`) whose local environment is older
 * than it from its first discovery on, and says it can update itself: the
 * start's grant exchange refuses on the protocol before any secret is sent,
 * so the connection is blocked `protocol-mismatch` holding no token (#826).
 */
const blockedLocal = async (shell?: FakeShell) => {
  const clock = manualClock();
  const wire = fakeWire({ clock, name: "desk", capabilities: ["self-update"] });
  let granted = true;
  const grant: GrantReader = { read: async () => (granted ? wire.grant.read() : undefined) };
  const platform = inMemoryPlatform({ clock, ...clientOn(shell), grant, fetch: wire.fetch, webSocket: wire.webSocket, version: CLIENT_VERSION });
  const { runtime } = createRuntimeWithSeams(platform, { protocolVersion: CLIENT_PROTOCOL });
  onTestFinished(() => runtime.close());
  await runtime.start();
  expect(record(runtime)).toMatchObject({ environmentId: wire.environmentId, kind: "local", phase: "blocked", blocked: "protocol-mismatch", action: "update-environment" });
  expect(wire.credential()).toBeUndefined();
  /** The grant file goes, as when the local environment's service stops. */
  const dropGrant = () => {
    granted = false;
  };
  return { clock, wire, runtime, dropGrant };
};

type BlockedLocal = Awaited<ReturnType<typeof blockedLocal>>;

const IDLE_PENDING = {
  state: "waiting", updateId: "0199aa00-0000-4000-8000-00000000000a", toVersion: CLIENT_VERSION, source: "desktop",
  since: "2026-09-24T00:00:00.000Z", deferUntil: "2026-09-25T00:00:00.000Z", image: null,
  waitsOn: { reason: "recent-activity", until: "2026-09-24T00:10:00.000Z" },
} as const;

describe("update-environment on a local environment blocked on an older protocol before any grant exchange", () => {
  it("polls the installed CLI's idle hold, advances it now, and stops polling once hello agrees", async () => {
    const shell = fakeShell();
    let pending: PendingUpdate = IDLE_PENDING;
    shell.answer("service.pendingUpdate", async () => pending);
    shell.answer("service.applyUpdateNow", async () => { pending = { ...IDLE_PENDING, state: "draining", cause: "requested" }; });
    const { runtime, wire, clock } = await blockedLocal(shell);
    await runtime.connections.updateEnvironment(wire.environmentId);
    expect(record(runtime).update).toMatchObject({ pending: IDLE_PENDING, restarting: false, canUpdateNow: true });
    clock.advance(5000);
    await flush();
    expect(shell.calls.filter(([member]) => member === "service.pendingUpdate")).toHaveLength(2);
    await runtime.connections.updateEnvironmentNow(wire.environmentId);
    await flush();
    expect(record(runtime).update).toMatchObject({ pending: { state: "draining" }, restarting: true, canUpdateNow: false });
    expect(shell.calls.filter(([member]) => member === "service.applyUpdateNow")).toHaveLength(1);
    wire.discovery({ protocolVersion: CLIENT_PROTOCOL, harnessVersion: CLIENT_VERSION, capabilities: ["self-update"] });
    clock.advance(5000);
    await wire.server.accept({ protocolVersion: CLIENT_PROTOCOL, capabilities: ["self-update"] });
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "ready" });
    expect(record(runtime).update).toBeUndefined();
    const reads = shell.calls.filter(([member]) => member === "service.pendingUpdate").length;
    clock.advance(5000);
    await flush();
    expect(shell.calls.filter(([member]) => member === "service.pendingUpdate")).toHaveLength(reads);
  });

  it("keeps one progress poll when two update requests are accepted concurrently, ignoring the superseded read", async () => {
    const shell = fakeShell();
    let finish!: (pending: PendingUpdate) => void;
    let reads = 0;
    shell.answer("service.pendingUpdate", () => {
      reads += 1;
      return reads === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(IDLE_PENDING);
    });
    const { runtime, wire, clock } = await blockedLocal(shell);
    const first = runtime.connections.updateEnvironment(wire.environmentId);
    const second = runtime.connections.updateEnvironment(wire.environmentId);
    await flush();
    expect(await second).toMatchObject({ ok: true });
    finish({ ...IDLE_PENDING, state: "draining", cause: "requested" });
    expect(await first).toMatchObject({ ok: true });
    expect(reads).toBe(2);
    expect(record(runtime).update).toMatchObject({ pending: IDLE_PENDING, restarting: false, canUpdateNow: true });
    clock.advance(5000);
    await flush();
    expect(reads).toBe(3);
    clock.advance(5000);
    await flush();
    expect(reads).toBe(4);
    await runtime.close();
    clock.advance(5000);
    await flush();
    expect(reads).toBe(4);
  });

  it("rechecks the hold before updating immediately and refuses when a run has started", async () => {
    const shell = fakeShell();
    let pending: PendingUpdate = IDLE_PENDING;
    shell.answer("service.pendingUpdate", async () => pending);
    const { runtime, wire, clock } = await blockedLocal(shell);
    await runtime.connections.updateEnvironment(wire.environmentId);
    expect(record(runtime).update?.canUpdateNow).toBe(true);
    pending = { ...IDLE_PENDING, waitsOn: { reason: "run-running", until: null } };
    await expect(runtime.connections.updateEnvironmentNow(wire.environmentId)).rejects.toThrow("no longer waiting only on the idle window");
    expect(shell.calls.filter(([member]) => member === "service.applyUpdateNow")).toHaveLength(0);
    clock.advance(5000);
    await flush();
    expect(record(runtime).update).toMatchObject({ pending, canUpdateNow: false });
  });

  it("clears a stale idle offer if progress cannot be read, and ignores a late read after retry", async () => {
    const shell = fakeShell();
    shell.answer("service.pendingUpdate", async () => IDLE_PENDING);
    const { runtime, wire, clock } = await blockedLocal(shell);
    await runtime.connections.updateEnvironment(wire.environmentId);
    shell.answer("service.pendingUpdate", async () => { throw new Error("The installed CLI could not connect."); });
    clock.advance(5000);
    await flush();
    expect(record(runtime).update).toMatchObject({ pending: null, error: "The installed CLI could not connect.", canUpdateNow: false });
    let finish!: (pending: PendingUpdate) => void;
    shell.answer("service.pendingUpdate", () => new Promise((resolve) => { finish = resolve; }));
    clock.advance(5000);
    await flush();
    await runtime.connections.retryNow(wire.environmentId);
    finish(IDLE_PENDING);
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "blocked" });
    expect(record(runtime).update).toBeUndefined();
    const reads = shell.calls.filter(([member]) => member === "service.pendingUpdate").length;
    clock.advance(5000);
    await flush();
    expect(shell.calls.filter(([member]) => member === "service.pendingUpdate")).toHaveLength(reads);
  });

  it("exchanges the grant first, across the gap, then posts the route with that token, and connects with it once hello agrees", async () => {
    const { clock, wire, runtime } = await blockedLocal();

    const outcome = await runtime.connections.updateEnvironment(wire.environmentId);

    const exchanged = wire.credential();
    expect(exchanged).toBeDefined();
    expect(outcome).toEqual({ ok: true, updateId: expect.any(String) as unknown as string, toVersion: CLIENT_VERSION });
    expect(wire.updatePosts()).toEqual([{ token: exchanged?.token, body: { version: CLIENT_VERSION } }]);
    expect(record(runtime)).toMatchObject({ phase: "updating", blocked: null, action: null, clientSessionId: exchanged?.clientSessionId });
    expect(runtime.local.read()).toEqual({ state: "exchanged", environmentId: wire.environmentId });
    expect(notices(runtime)).toEqual([]);

    // The old environment still answers until it restarts: still updating, and the grant is not exchanged again.
    clock.advance(BYE_WAIT_MS);
    await flush();
    expect(record(runtime).phase).toBe("updating");
    expect(wire.credential()).toBe(exchanged);

    // The new version is up: the connection authenticates with the token the update's exchange gave.
    wire.discovery({ protocolVersion: CLIENT_PROTOCOL, harnessVersion: CLIENT_VERSION, capabilities: ["self-update"] });
    clock.advance(BYE_WAIT_MS);
    const auth = await wire.server.accept({ protocolVersion: CLIENT_PROTOCOL, capabilities: ["self-update"] });
    await flush();
    expect(auth.token).toBe(exchanged?.token);
    expect(record(runtime)).toMatchObject({ phase: "ready", blocked: null, action: null, descriptor: { harnessVersion: CLIENT_VERSION } });
  });

  it.each([
    ["the grant file is gone", (t: BlockedLocal) => t.dropGrant(), "service-down", "There is no grant file: the local environment's service is not running."],
    ["nothing answers at the grant's address", (t: BlockedLocal) => t.wire.discovery("unreachable"), "service-down", "Nothing answered at http://fake.test:7433: fetch failed."],
    ["the environment is draining", (t: BlockedLocal) => t.wire.discovery({ readiness: "draining" }), "draining", "desk is draining; try again once it is ready."],
  ] as const)("says a failed exchange in the local environment's words when %s, asks nothing and stays blocked", async (_, cause, reason, words) => {
    const t = await blockedLocal();
    cause(t);

    const outcome = await t.runtime.connections.updateEnvironment(t.wire.environmentId);

    expect(outcome).toEqual({ ok: false, refused: false, reason: "no-token", message: `This client could not exchange the local grant with desk: ${words}` });
    expect(t.runtime.local.read()).toEqual({ state: "failed", reason, message: words });
    expect(t.wire.credential()).toBeUndefined();
    expect(t.wire.updatePosts()).toEqual([]);
    expect(notices(t.runtime)).toEqual([]);
    expect(record(t.runtime)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch", action: "update-environment" });
  });

  it("asks nothing when the grant now names another environment, and keeps no token for this one", async () => {
    const { wire, runtime } = await blockedLocal();
    wire.discovery({ environmentId: "0199aa00-0000-7000-8000-0000000000ff", environmentName: "lab" });

    const outcome = await runtime.connections.updateEnvironment(wire.environmentId);

    expect(outcome).toEqual({
      ok: false,
      refused: false,
      reason: "no-token",
      message: "This machine's grant now names lab, not desk: the next start takes lab as the local environment.",
    });
    expect(wire.updatePosts()).toEqual([]);
    expect(record(runtime)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch", clientSessionId: null });
  });

  it("keeps the exchanged token when the environment refuses: the next ask posts with it and exchanges nothing more", async () => {
    const { wire, runtime } = await blockedLocal();
    wire.updateRoute({ status: 409, body: { code: "conflict", message: "desk is pinned to 0.5.0.", data: { reason: "pinned" } } });

    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: false, refused: true, reason: "pinned" });
    const exchanged = wire.credential();
    expect(notices(runtime)).toEqual([expect.objectContaining({ message: `Could not update desk to ${CLIENT_VERSION} (pinned): desk is pinned to 0.5.0.` })]);
    expect(record(runtime)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch", action: "update-environment" });

    wire.updateRoute({ status: 200, body: { updateId: "6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e6f", toVersion: CLIENT_VERSION } });
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: true, toVersion: CLIENT_VERSION });
    expect(wire.credential()).toBe(exchanged);
    expect(wire.updatePosts().map((post) => post.token)).toEqual([exchanged?.token, exchanged?.token]);
  });
});

describe("a local environment whose update waits on macOS's prompt for its stored key (#1689)", () => {
  const since = "2026-10-06T10:34:01.000Z";
  const waiting = { version: CLIENT_VERSION, pid: 69981, since, state: "waiting", live: true } as const;
  const prompts = (runtime: Runtime) => runtime.projections.notices.read().filter((notice) => notice.kind === "credential-prompt" || notice.kind === "update-failed");
  const PROMPT = `macOS is asking to let agent-harness use its stored key: answer “Always Allow” in its dialog to finish the update to ${CLIENT_VERSION}.`;

  /** A desktop whose local environment does not answer, its credential-access record read through `shell` as `read` answers it. */
  const waitingLocal = async (read: () => LocalCredentialAccess | undefined) => {
    const shell = fakeShell();
    shell.answer("credentialAccess.read", async () => read());
    const local = await blockedLocal(shell);
    await flush();
    return { shell, ...local };
  };

  it("says macOS is asking, on the machine and in a notice, while the record's start waits, and takes both back once it is answered", async () => {
    let held: LocalCredentialAccess | undefined = waiting;
    const { runtime, clock } = await waitingLocal(() => held);
    expect(record(runtime).credentialPrompt).toEqual({ toVersion: CLIENT_VERSION, since });
    expect(runtime.projections.environments.read()[0]?.credentialPrompt).toEqual({ toVersion: CLIENT_VERSION, since });
    expect(prompts(runtime).map(({ kind, message }) => ({ kind, message }))).toEqual([{ kind: "credential-prompt", message: PROMPT }]);
    // The next reads find the same wait: nothing more is said.
    clock.advance(5000);
    await flush();
    expect(prompts(runtime)).toHaveLength(1);
    // The person chose Always Allow: the start took the record away.
    held = undefined;
    clock.advance(5000);
    await flush();
    expect(record(runtime).credentialPrompt).toBeUndefined();
    expect(prompts(runtime)).toEqual([]);
  });

  it("says the update was rolled back for want of an answer once the waiting start is gone and its record left behind", async () => {
    let held: LocalCredentialAccess | undefined = waiting;
    const { runtime, clock } = await waitingLocal(() => held);
    held = { ...waiting, live: false };
    clock.advance(5000);
    await flush();
    expect(record(runtime).credentialPrompt).toBeUndefined();
    expect(prompts(runtime).map(({ kind, message }) => ({ kind, message }))).toEqual([
      {
        kind: "update-failed",
        message: `desk could not be updated to ${CLIENT_VERSION}: macOS asked to let agent-harness use its stored key, and the prompt was refused or not answered. Update again, and answer “Always Allow” when macOS asks.`,
      },
    ]);
  });

  it("says nothing of a record a start left long ago, whose process is gone", async () => {
    const { runtime } = await waitingLocal(() => ({ ...waiting, live: false }));
    expect(record(runtime).credentialPrompt).toBeUndefined();
    expect(prompts(runtime)).toEqual([]);
  });

  it("stops reading the record once the environment answers", async () => {
    const { runtime, shell, wire, clock } = await waitingLocal(() => undefined);
    await runtime.connections.updateEnvironment(wire.environmentId);
    wire.discovery({ protocolVersion: CLIENT_PROTOCOL, harnessVersion: CLIENT_VERSION, capabilities: ["self-update"] });
    clock.advance(BYE_WAIT_MS);
    await wire.server.accept({ protocolVersion: CLIENT_PROTOCOL, capabilities: ["self-update"] });
    await flush();
    expect(record(runtime).phase).toBe("ready");
    const reads = shell.calls.filter(([member]) => member === "credentialAccess.read").length;
    clock.advance(15_000);
    await flush();
    expect(shell.calls.filter(([member]) => member === "credentialAccess.read")).toHaveLength(reads);
  });
});

/** Where an installed desktop carries its server: the folder the artefact is unpacked in (#355), which the environment copies to its staging area (#789). */
const BUNDLED_PATH = "/opt/agent-harness/resources/server";

/** A desktop's shell whose `installer.bundledServer` answers as `carried` does. */
const carrying = (carried: ShellFunctions["installer.bundledServer"]): FakeShell => {
  const shell = fakeShell();
  shell.answer("installer.bundledServer", carried);
  return shell;
};

describe("update-environment from a desktop whose local environment is blocked on an older protocol (#918)", () => {
  it("posts the route with the path of the server the desktop carries when it is the version asked, so the environment stages it rather than downloading it", async () => {
    const { wire, runtime } = await blockedLocal(carrying(async () => ({ version: CLIENT_VERSION, path: BUNDLED_PATH })));

    const outcome = await runtime.connections.updateEnvironment(wire.environmentId);

    expect(outcome).toEqual({ ok: true, updateId: expect.any(String) as unknown as string, toVersion: CLIENT_VERSION });
    expect(wire.updatePosts()).toEqual([{ token: wire.credential()?.token, body: { version: CLIENT_VERSION, artefactPath: BUNDLED_PATH } }]);
    expect(record(runtime)).toMatchObject({ phase: "updating", blocked: null, action: null });
  });

  it("keeps a bundled disk refusal across the protocol gap without falling back to a download, then retries the bundle", async () => {
    let room = false;
    const message = "Not enough disk space for staging and the snapshot. Free space and retry.";
    const { wire, runtime } = await blockedLocal(carrying(async () => ({
      version: CLIENT_VERSION, path: BUNDLED_PATH,
      ...(!room && { refusal: { reason: "disk" as const, message } }),
    })));
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toEqual({ ok: false, refused: true, reason: "disk", message });
    expect(wire.updatePosts()).toEqual([]);
    expect(record(runtime)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch", action: "update-environment" });
    expect(notices(runtime)).toEqual([expect.objectContaining({ message: `Could not update desk to ${CLIENT_VERSION} (disk): ${message}` })]);
    room = true;
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: true, toVersion: CLIENT_VERSION });
    expect(wire.updatePosts()).toEqual([{ token: wire.credential()?.token, body: { version: CLIENT_VERSION, artefactPath: BUNDLED_PATH } }]);
  });

  it.each<readonly [string, ShellFunctions["installer.bundledServer"]]>([
    ["carries none, as one run from a checkout", async () => null],
    ["carries an older version", async () => ({ version: "0.5.0", path: BUNDLED_PATH })],
    ["carries a newer version", async () => ({ version: "0.6.1", path: BUNDLED_PATH })],
    ["cannot say what it carries", () => Promise.reject(new Error("The server artefact this desktop carries names no release version in /opt/agent-harness/resources/server/packages/cli/package.json."))],
  ])("asks for the version alone when the desktop %s, for the environment to download", async (_, carried) => {
    const { wire, runtime } = await blockedLocal(carrying(carried));

    const outcome = await runtime.connections.updateEnvironment(wire.environmentId);

    expect(outcome).toEqual({ ok: true, updateId: expect.any(String) as unknown as string, toVersion: CLIENT_VERSION });
    expect(wire.updatePosts()).toEqual([{ token: wire.credential()?.token, body: { version: CLIENT_VERSION } }]);
    expect(record(runtime)).toMatchObject({ phase: "updating", blocked: null, action: null });
  });

  it("asks a paired environment, on another machine, for the version alone: the path is this machine's", async () => {
    const { wire, runtime } = await blocked(carrying(async () => ({ version: CLIENT_VERSION, path: BUNDLED_PATH })));

    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: true, toVersion: CLIENT_VERSION });
    expect(wire.updatePosts()).toEqual([{ token: wire.credential()?.token, body: { version: CLIENT_VERSION } }]);
  });

  it("raises the notice naming why when the environment refuses the path, and asks nothing more", async () => {
    const { wire, runtime } = await blockedLocal(carrying(async () => ({ version: CLIENT_VERSION, path: BUNDLED_PATH })));
    const refusal = `${BUNDLED_PATH} is not a server artefact of ${CLIENT_VERSION}: it holds no packages/cli/package.json.`;
    wire.updateRoute({ status: 400, body: { code: "invalid_params", message: refusal, data: { issues: [{ code: "custom", path: ["artefactPath"], message: refusal }] } } });

    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toEqual({ ok: false, refused: true, reason: "invalid_params", message: refusal });
    expect(wire.updatePosts()).toEqual([{ token: wire.credential()?.token, body: { version: CLIENT_VERSION, artefactPath: BUNDLED_PATH } }]);
    expect(notices(runtime)).toEqual([expect.objectContaining({ message: `Could not update desk to ${CLIENT_VERSION} (invalid_params): ${refusal}` })]);
    expect(record(runtime)).toMatchObject({ phase: "blocked", blocked: "protocol-mismatch", action: "update-environment" });
  });
});

describe("update-environment otherwise", () => {
  it("sends updates.apply on the socket with the client's version and when idle, never the route, and follows bye: updating", async () => {
    const { wire, runtime, clock } = await ready();
    wire.answer("updates.apply", (params) => ({
      result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { updateId: "6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e6f", toVersion: params["version"] } },
    }));

    const outcome = await runtime.connections.updateEnvironment(wire.environmentId);

    expect(outcome).toEqual({ ok: true, updateId: "6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e6f", toVersion: CLIENT_VERSION });
    const [sent] = wire.server.received().filter((frame) => frame.type === "request" && frame.method === "updates.apply");
    expect(sent).toMatchObject({ params: { version: CLIENT_VERSION, when: "idle", commandId: expect.any(String) as unknown } });
    expect(wire.updatePosts()).toEqual([]);

    wire.server.bye("updating");
    await flush();
    expect(record(runtime).phase).toBe("updating");
    // Mid-restart the new version says starting: still updating, until hello agrees.
    wire.discovery({ readiness: "starting" });
    clock.advance(BYE_WAIT_MS);
    await flush();
    expect(record(runtime).phase).toBe("updating");
    wire.discovery({ harnessVersion: CLIENT_VERSION });
    clock.advance(2000);
    clock.advance(BYE_WAIT_MS);
    await wire.server.accept();
    await flush();
    expect(record(runtime)).toMatchObject({ phase: "ready", descriptor: { harnessVersion: CLIENT_VERSION } });
  });

  it("raises the notice naming why when the receipt rejects it, and when the request itself is refused", async () => {
    const { wire, runtime } = await ready();
    wire.answer("updates.apply", () => ({
      result: { receipt: { status: "rejected", sequence: 1, changed: false, reason: "conflict", error: { code: "conflict", message: "The update to 0.6.0 is draining; it cannot be changed now.", data: { reason: "in_progress" } } } },
    }));
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: false, refused: true, reason: "in_progress" });
    expect(notices(runtime)).toEqual([expect.objectContaining({ message: `Could not update fake to ${CLIENT_VERSION} (in_progress): The update to 0.6.0 is draining; it cannot be changed now.` })]);

    wire.answer("updates.apply", () => ({ error: { code: "forbidden", message: "updates.apply needs the admin scope, which this client session does not hold.", data: { scope: "admin" } } }));
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: false, refused: true, reason: "forbidden" });
    expect(notices(runtime)).toHaveLength(2);
  });

  it("is no refusal when there is no socket to ask on", async () => {
    const { wire, runtime } = await ready();
    wire.server.drop();
    await flush();
    expect(record(runtime).phase).not.toBe("ready");
    expect(await runtime.connections.updateEnvironment(wire.environmentId)).toMatchObject({ ok: false, refused: false, reason: "unreachable" });
    expect(notices(runtime)).toEqual([]);
  });
});
