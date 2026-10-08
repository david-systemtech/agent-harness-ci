import { randomUUID } from "node:crypto";
import type { ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { noticeEvent } from "../test/events.js";
import { forgeEventPayload, forgeRecord } from "../test/forges.js";
import { CA_FOR_TESTS, KEY_MANAGER_EVENT_TYPES, keyManagerEventPayload, keyManagerRecord, keyManagerStatus, listedConnection, toolRow, toolsUpdatedPayload } from "../test/key-managers.js";
import { usePaired } from "../test/paired.js";
import { subscription } from "../test/scripted.js";
import { createRuntimeWithSeams } from "./internal.js";
import { addConnection, formProblem, type ConnectionForm } from "./key-managers/actions.js";
import { connectionHealth } from "./key-managers/words.js";
import type { Runtime } from "./runtime.js";
import { fakeWire, flush, type FakeWire } from "./testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "./testing/in-memory-platform.js";

/**
 * Key managers in the client runtime (#384; key-managers spec, "Modules",
 * "Wire methods" and "Events and notices"; ADR 0011, ADR 0028), through the
 * fake wire: the connections, Move's items and the managed tools in the
 * request cache, the status rows, and the calls that carry a credential or
 * answer a secret, sent directly.
 */

const { paired, pairedMany } = usePaired();

/** The flags an environment with key managers and managed tools offers. */
const KEY_MANAGER_FLAGS = ["keyManagers", "managedTools"] as const;

describe("the key managers and the managed tools in the request cache", () => {
  it("fetch keyManagers.list and keyManagers.move.list again on every key-manager.* notice, and tools.list and keyManagers.list, whose connections carry their CLI's row, on tools.updated", async () => {
    const { runtime, wire, env, environment } = await paired({ capabilities: KEY_MANAGER_FLAGS });
    const connection = keyManagerRecord();
    const asked = { "keyManagers.list": 0, "keyManagers.move.list": 0, "tools.list": 0 };
    wire.answer("keyManagers.list", () => (asked["keyManagers.list"]++, { result: { connections: [listedConnection(connection)] } }));
    wire.answer("keyManagers.move.list", () => (asked["keyManagers.move.list"]++, { result: { items: [] } }));
    wire.answer("tools.list", () => (asked["tools.list"]++, { result: { tools: [toolRow()], probedAt: "2026-09-24T00:00:00.000Z" } }));
    for (const method of ["keyManagers.list", "keyManagers.move.list"] as const) runtime.requests.cached(env, method, {}).subscribe(() => undefined);
    const tools = runtime.requests.cached(env, "tools.list", {});
    tools.subscribe(() => undefined);
    await flush();
    expect(asked).toEqual({ "keyManagers.list": 1, "keyManagers.move.list": 1, "tools.list": 1 });
    expect(runtime.requests.cached(env, "keyManagers.list", {}).read()).toMatchObject({ result: { connections: [listedConnection(connection)] }, error: null });
    expect(tools.read()).toMatchObject({ result: { tools: [toolRow()] }, error: null });

    for (const [index, type] of KEY_MANAGER_EVENT_TYPES.entries()) {
      environment.event(noticeEvent(index + 1, env, type, keyManagerEventPayload(type, connection)));
      await flush();
      expect(asked, type).toEqual({ "keyManagers.list": index + 2, "keyManagers.move.list": index + 2, "tools.list": 1 });
    }
    const heard = KEY_MANAGER_EVENT_TYPES.length;
    environment.event(noticeEvent(heard + 1, env, "tools.updated", toolsUpdatedPayload(toolRow({ version: "2.2.0" }))));
    await flush();
    expect(asked).toEqual({ "keyManagers.list": heard + 2, "keyManagers.move.list": heard + 1, "tools.list": 2 });
  });

  it("fetch keyManagers.move.list again when a forge account changes, since a forge account's stored token is an item", async () => {
    const { runtime, wire, env, environment } = await paired({ capabilities: ["forge", ...KEY_MANAGER_FLAGS] });
    let asked = 0;
    wire.answer("keyManagers.move.list", () => (asked++, { result: { items: [] } }));
    runtime.requests.cached(env, "keyManagers.move.list", {}).subscribe(() => undefined);
    await flush();
    expect(asked).toBe(1);
    const account = forgeRecord();
    const types = ["forge.account.added", "forge.account.updated", "forge.account.removed"] as const;
    for (const [index, type] of types.entries()) {
      environment.event(noticeEvent(index + 1, env, type, forgeEventPayload(type, account)));
      await flush();
      expect(asked, type).toBe(index + 2);
    }
  });
});

describe("the key-manager and managed-tool methods without their flags", () => {
  it("answer absent with reason unsupported, sending nothing, and present once the environment offers the flag", async () => {
    const { runtime, wire, env } = await paired({ capabilities: ["forge"] });
    let asked = 0;
    for (const method of ["keyManagers.list", "tools.list"]) wire.answer(method, () => (asked++, { result: {} }));
    const keyManagers = { status: "absent", reason: "unsupported", message: "desk runs an older agent-harness without this. Update desk to use it.", details: ["keyManagers"] } as const;
    const managedTools = { status: "absent", reason: "unsupported", message: "desk runs an older agent-harness without this. Update desk to use it.", details: ["managedTools"] } as const;
    for (const method of ["keyManagers.list", "keyManagers.move.list", "keyManagers.connections.add", "keyManagers.connections.signIn", "keyManagers.move.copyValue"] as const) {
      expect(runtime.capability(env, method), method).toEqual(keyManagers);
    }
    expect(runtime.capability(env, "tools.list")).toEqual(managedTools);
    expect(await runtime.requests.call(env, "keyManagers.list", {})).toEqual({ ok: false, error: { code: "unsupported", message: keyManagers.message } });
    const cached = runtime.requests.cached(env, "tools.list", {});
    cached.subscribe(() => undefined);
    await flush();
    expect(cached.read()).toMatchObject({ result: null, error: { code: "unsupported", message: managedTools.message } });
    expect(asked).toBe(0);

    // Each flag gates its own methods alone.
    const onlyKeyManagers = await paired({ capabilities: ["keyManagers"] });
    expect(onlyKeyManagers.runtime.capability(onlyKeyManagers.env, "keyManagers.list")).toEqual({ status: "present" });
    expect(onlyKeyManagers.runtime.capability(onlyKeyManagers.env, "keyManagers.move.copyValue")).toEqual({ status: "present" });
    expect(onlyKeyManagers.runtime.capability(onlyKeyManagers.env, "tools.list")).toMatchObject({ status: "absent", reason: "unsupported" });
    const onlyTools = await paired({ capabilities: ["managedTools"] });
    expect(onlyTools.runtime.capability(onlyTools.env, "tools.list")).toEqual({ status: "present" });
    expect(onlyTools.runtime.capability(onlyTools.env, "keyManagers.list")).toMatchObject({ status: "absent", reason: "unsupported" });
  });
});

/** A credential as a person enters one: nothing a secret scanner takes for a real one. */
const SECRET_ID = "secret-id-for-tests";
/** A stored value as `keyManagers.move.copyValue` answers it. */
const VALUE = "stored-value-for-tests";

describe("the calls that carry a credential or answer a secret", () => {
  const credential = { method: "approle", roleId: "role-id-for-tests", secretId: SECRET_ID } as const;
  const item = { kind: "forge-account", id: randomUUID() } as const;
  /** Each call as `commands.dispatch` would take it (no command id), and as `requests.call` sends it. */
  const calls = (connectionId: string) =>
    [
      ["keyManagers.connections.add", { connectionId, provider: "openbao", label: "OpenBao", address: "https://bao.example.com:8200", credential }],
      ["keyManagers.connections.signIn", { connectionId, credential }],
      ["keyManagers.move.copyValue", { connectionId, item }],
    ] as const;
  /** The key-manager requests the environment heard, as method and params. */
  const keyManagerRequests = (wire: FakeWire) =>
    wire.server.received().flatMap((frame) => (frame.type === "request" && frame.method.startsWith("keyManagers.") ? [[frame.method, frame.params] as const] : []));

  it("are sent directly, never through the outbox, and nothing holding a secret is kept on the client", async () => {
    const { runtime, wire, env, kept } = await paired({ capabilities: KEY_MANAGER_FLAGS });
    const connection = keyManagerRecord();
    const receipt = { status: "accepted", sequence: 1, changed: true } as const;
    wire.answer("keyManagers.connections.add", () => ({ result: { receipt, result: { connection } } }));
    wire.answer("keyManagers.connections.signIn", () => ({ result: { receipt, result: { connection } } }));
    const reference = { provider: "openbao", connectionId: connection.id, mount: "personal", path: "harness/forge-github", key: "token" } as const;
    wire.answer("keyManagers.move.copyValue", () => ({ result: { receipt, result: { item, reference, value: VALUE } } }));

    for (const [method, params] of calls(connection.id)) {
      expect(await runtime.commands.dispatch(env, method, params), method).toMatchObject({ ok: false, commandId: null, error: { code: "direct" } });
    }
    expect(keyManagerRequests(wire)).toEqual([]);

    const [add, signIn, copyValue] = calls(connection.id).map(([, params]) => ({ commandId: randomUUID(), ...params })) as unknown as [
      ParamsOf<"keyManagers.connections.add">,
      ParamsOf<"keyManagers.connections.signIn">,
      ParamsOf<"keyManagers.move.copyValue">,
    ];
    expect(await runtime.requests.call(env, "keyManagers.connections.add", add)).toMatchObject({ ok: true, result: { receipt: { status: "accepted" }, result: { connection } } });
    expect(await runtime.requests.call(env, "keyManagers.connections.signIn", signIn)).toMatchObject({ ok: true, result: { receipt: { status: "accepted" } } });
    expect(await runtime.requests.call(env, "keyManagers.move.copyValue", copyValue)).toEqual({ ok: true, result: { receipt, result: { item, reference, value: VALUE } } });
    expect(keyManagerRequests(wire)).toEqual([
      ["keyManagers.connections.add", add],
      ["keyManagers.connections.signIn", signIn],
      ["keyManagers.move.copyValue", copyValue],
    ]);
    await flush();
    expect(kept()).not.toContain(SECRET_ID);
    expect(kept()).not.toContain(VALUE);
  });

  it("fail at once while the environment cannot be reached, parking nothing, and send nothing once it is back", async () => {
    const { runtime, wire, env, kept } = await paired({ capabilities: KEY_MANAGER_FLAGS });
    wire.discovery("unreachable");
    wire.server.drop();
    await flush();
    expect(runtime.connections.list.read()[0]?.phase).toBe("backoff");

    const connectionId = randomUUID();
    for (const [method, params] of calls(connectionId)) {
      expect(await runtime.requests.call(env, method, { commandId: randomUUID(), ...params } as never), method).toMatchObject({ ok: false, error: { code: "unreachable" } });
      expect(await runtime.commands.dispatch(env, method, params), method).toMatchObject({ ok: false, commandId: null, error: { code: "direct" } });
    }
    await flush();
    expect(runtime.projections.environments.read()[0]?.pendingCommands).toBe(0);
    expect(kept()).not.toContain(SECRET_ID);

    // Back again, nothing parked is sent: the environment hears no key-manager call it was not asked for now.
    wire.discovery({});
    void runtime.connections.retryNow(env);
    await wire.server.accept();
    await flush();
    expect(keyManagerRequests(wire)).toEqual([]);
  });
});

describe("the key-manager status rows", () => {
  /** What each notice says, and where it points. */
  const shown = (runtime: Runtime) => runtime.projections.notices.read().map(({ environmentId, kind, message, action }) => ({ environmentId, kind, message, action }));
  const UNREACHABLE = "OpenBao at https://bao.example.com:8200 did not answer: check it is running, then check again in Set up, Key manager.";
  const SEALED = "OpenBao at https://bao.example.com:8200 is sealed: unseal it, then check again in Set up, Key manager.";
  const REJECTED = "OpenBao refused the AppRole's secret id. Sign in again in Set up, Key manager.";

  it("raise one row for each change of a connection's status to one that needs David, naming the environment and the connection, offering the Key manager step", async () => {
    const { runtime, env, environment } = await paired({ capabilities: KEY_MANAGER_FLAGS });
    const connection = keyManagerRecord({ label: "Home vault" });
    const verified = (sequence: number, status: ReturnType<typeof keyManagerStatus>, fields: Record<string, unknown> = {}) =>
      noticeEvent(sequence, env, "key-manager.connection.verified", keyManagerEventPayload("key-manager.connection.verified", connection, { status, ...fields }));
    const events = [
      noticeEvent(1, env, "key-manager.connection.added", keyManagerEventPayload("key-manager.connection.added", connection)),
      verified(2, keyManagerStatus("unreachable", UNREACHABLE)),
      verified(3, keyManagerStatus("sealed", SEALED)),
      // Still sealed, the policies known beside it changed: no new status.
      verified(4, keyManagerStatus("sealed", SEALED), { canMint: false }),
      // Signed in again: nothing needs David.
      verified(5, keyManagerStatus("signed-in", "Signed in to OpenBao as approle.")),
      // The environment's own sign-in after a start, refused.
      noticeEvent(6, env, "key-manager.connection.signed-in", keyManagerEventPayload("key-manager.connection.signed-in", connection, { status: keyManagerStatus("credential-rejected", REJECTED), tokenInformation: null })),
    ];
    for (const event of events) environment.event(event);
    await flush();

    const keyManager = { environmentId: env, kind: "key-manager", action: "setup.key-manager" } as const;
    expect(shown(runtime)).toEqual([
      { ...keyManager, message: `Home vault on desk: ${UNREACHABLE}` },
      { ...keyManager, message: `Home vault on desk: ${SEALED}` },
      { ...keyManager, message: `Home vault on desk: ${REJECTED}` },
    ]);
  });

  it("raise none for a managed tool's row, a newer version known being a badge and one below its minimum its step's failure (#374, ADR 0026)", async () => {
    const { runtime, env, environment } = await paired({ capabilities: KEY_MANAGER_FLAGS });
    environment.event(noticeEvent(1, env, "tools.updated", toolsUpdatedPayload(toolRow({ latest: "2.7.0", status: "update-available" }))));
    environment.event(noticeEvent(2, env, "tools.updated", toolsUpdatedPayload(toolRow({ version: "2.0.0", latest: "2.7.0", status: "below-minimum" }))));
    await flush();
    expect(shown(runtime)).toEqual([]);
  });

  it("raise one for a connection added standing in a status that needs David, a copy awaiting its sign-in among them, and none for a sign-out, which a person asked for", async () => {
    const { runtime, env, environment } = await paired({ capabilities: KEY_MANAGER_FLAGS });
    const signedIn = keyManagerRecord();
    const copy = keyManagerRecord({
      label: "Laptop's vault",
      address: "https://vault.example.com",
      status: keyManagerStatus("awaiting-sign-in", "No credential is on this environment: sign in in Set up, Key manager."),
      tokenInformation: null,
      policies: null,
      canMint: null,
      injects: false,
      copiedFrom: { environmentId: randomUUID(), environmentName: "laptop" },
    });
    const unanswered = keyManagerRecord({ label: "Doppler", provider: "doppler", address: "https://api.doppler.com", ca: null, method: null, mount: null, ticks: null, basePath: null, status: keyManagerStatus("unreachable", "Doppler did not answer.") });
    const events = [
      noticeEvent(1, env, "key-manager.connection.added", keyManagerEventPayload("key-manager.connection.added", signedIn)),
      noticeEvent(2, env, "key-manager.connection.added", keyManagerEventPayload("key-manager.connection.added", copy, { credential: null })),
      noticeEvent(3, env, "key-manager.connection.added", keyManagerEventPayload("key-manager.connection.added", unanswered)),
      noticeEvent(4, env, "key-manager.connection.signed-out", keyManagerEventPayload("key-manager.connection.signed-out", signedIn)),
    ];
    for (const event of events) environment.event(event);
    await flush();
    expect(shown(runtime).map((notice) => notice.message)).toEqual([
      "Laptop's vault on desk: No credential is on this environment: sign in in Set up, Key manager.",
      "Doppler on desk: Doppler did not answer.",
    ]);
  });

  it("withdraw every row about a connection once it is removed, leaving the others' (#1851)", async () => {
    const { runtime, env, environment } = await paired({ capabilities: KEY_MANAGER_FLAGS });
    const kept = keyManagerRecord({ label: "Home vault", status: keyManagerStatus("sealed", "OpenBao is sealed.") });
    const removed = keyManagerRecord({ label: "Old vault", address: "https://127.0.0.1:1", status: keyManagerStatus("unreachable", "OpenBao at https://127.0.0.1:1 did not answer.") });
    const verified = (sequence: number, status: ReturnType<typeof keyManagerStatus>) =>
      noticeEvent(sequence, env, "key-manager.connection.verified", keyManagerEventPayload("key-manager.connection.verified", removed, { status }));
    for (const event of [
      noticeEvent(1, env, "key-manager.connection.added", keyManagerEventPayload("key-manager.connection.added", kept)),
      noticeEvent(2, env, "key-manager.connection.added", keyManagerEventPayload("key-manager.connection.added", removed)),
      verified(3, keyManagerStatus("certificate-rejected", "OpenBao at https://127.0.0.1:1 presented a certificate no CA verifies.")),
    ]) environment.event(event);
    await flush();
    expect(shown(runtime)).toHaveLength(3);

    environment.event(noticeEvent(4, env, "key-manager.connection.removed", keyManagerEventPayload("key-manager.connection.removed", removed)));
    await flush();
    expect(shown(runtime).map((notice) => notice.message)).toEqual(["Home vault on desk: OpenBao is sealed."]);
  });

  it("raise none for what a replay onto an empty cache holds, which is history, and read it for the labels and statuses it names", async () => {
    const clock = manualClock();
    const wire = fakeWire({ clock, name: "desk", capabilities: [...KEY_MANAGER_FLAGS] });
    for (const method of ["sessions.subscribe", "environment.subscribe"]) wire.answer(method, () => undefined);
    let asked = 0;
    wire.answer("keyManagers.list", () => (asked++, { result: { connections: [] } }));
    const { runtime } = createRuntimeWithSeams(inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket }));
    await runtime.start();
    try {
      const adding = runtime.connections.add({ link: wire.link });
      await wire.server.accept();
      (await subscription(wire, "sessions.subscribe")).synchronized(0);
      const environment = await subscription(wire, "environment.subscribe");
      const env = wire.environmentId;
      const connection = keyManagerRecord();
      const history = [
        noticeEvent(1, env, "key-manager.connection.added", keyManagerEventPayload("key-manager.connection.added", connection)),
        noticeEvent(2, env, "key-manager.connection.updated", keyManagerEventPayload("key-manager.connection.updated", connection, { label: "Agent box vault" })),
        noticeEvent(3, env, "key-manager.connection.verified", keyManagerEventPayload("key-manager.connection.verified", connection, { status: keyManagerStatus("sealed", SEALED) })),
      ];
      for (const event of history) environment.event(event);
      environment.synchronized(history.length);
      await adding;
      await flush();
      expect(shown(runtime)).toEqual([]);

      // News after it: still sealed is no change; unreachable is, said with the label history last gave, with no read of the list.
      environment.event(noticeEvent(4, env, "key-manager.connection.verified", keyManagerEventPayload("key-manager.connection.verified", connection, { status: keyManagerStatus("sealed", SEALED), canMint: false })));
      environment.event(noticeEvent(5, env, "key-manager.connection.verified", keyManagerEventPayload("key-manager.connection.verified", connection, { status: keyManagerStatus("unreachable", UNREACHABLE) })));
      await flush();
      expect(shown(runtime).map((notice) => notice.message)).toEqual([`Agent box vault on desk: ${UNREACHABLE}`]);
      expect(asked).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("read the connections for a label not heard, raising the row once they answer, in the order the rows were heard", async () => {
    const { runtime, wire, env, environment } = await paired({ capabilities: KEY_MANAGER_FLAGS });
    const connection = keyManagerRecord({ label: "Home vault" });
    let answer: (connections: readonly ReturnType<typeof keyManagerRecord>[]) => void = () => undefined;
    let asked = 0;
    wire.answer("keyManagers.list", () => {
      asked++;
      return new Promise((resolve) => (answer = (connections) => resolve({ result: { connections: connections.map((each) => listedConnection(each)) } })));
    });
    // Its add was before this client's cursor: nothing here names its label.
    environment.event(noticeEvent(1, env, "key-manager.connection.verified", keyManagerEventPayload("key-manager.connection.verified", connection, { status: keyManagerStatus("unreachable", UNREACHABLE) })));
    environment.event(noticeEvent(2, env, "key-manager.connection.verified", keyManagerEventPayload("key-manager.connection.verified", connection, { status: keyManagerStatus("sealed", SEALED) })));
    await flush();
    expect(shown(runtime)).toEqual([]);
    expect(asked).toBe(1);

    answer([connection]);
    await flush();
    expect(shown(runtime).map((notice) => notice.message)).toEqual([`Home vault on desk: ${UNREACHABLE}`, `Home vault on desk: ${SEALED}`]);
    expect(asked).toBe(1);

    // One the environment no longer holds is said all the same, without its label.
    const gone = keyManagerRecord();
    environment.event(noticeEvent(3, env, "key-manager.connection.verified", keyManagerEventPayload("key-manager.connection.verified", gone, { status: keyManagerStatus("expired", "The token expired.") })));
    await flush();
    answer([connection]);
    await flush();
    expect(shown(runtime).at(-1)?.message).toBe("A key manager on desk: The token expired.");
  });
});

/** Answers every keyManagers.connections.add accepted, with the connection it would add awaiting a sign-in, and records what each was asked. */
const acceptingAdds = (wire: FakeWire) => {
  const asked: Record<string, unknown>[] = [];
  wire.answer("keyManagers.connections.add", (params) => {
    asked.push(params);
    const connection = keyManagerRecord({ id: params["connectionId"] as string, status: keyManagerStatus("awaiting-sign-in"), tokenInformation: null, policies: null, canMint: null, injects: false });
    return { result: { receipt: { status: "accepted", sequence: asked.length, changed: true }, result: { connection } } };
  });
  return asked;
};

describe("copying a key-manager connection to other environments", () => {
  it("calls keyManagers.connections.add on each chosen environment with its address, CA, method, mount, username, token role, ticks, base path and source, never a credential", async () => {
    const { runtime, wires, ids } = await pairedMany(KEY_MANAGER_FLAGS, [{ name: "desk" }, { name: "laptop" }, { name: "server" }]);
    const [desk, laptop, server] = ids as [string, string, string];
    const [, laptopWire, serverWire] = wires as [FakeWire, FakeWire, FakeWire];
    const onLaptop = acceptingAdds(laptopWire);
    const onServer = acceptingAdds(serverWire);
    const approle = keyManagerRecord({ label: "Agent box vault", tokenRole: "agent-runs" });
    const userpass = keyManagerRecord({
      label: "People vault",
      address: "https://people.example.com",
      ca: null,
      method: "userpass",
      mount: "people",
      username: "david",
      ticks: null,
      basePath: null,
    });
    const doppler = keyManagerRecord({ label: "Doppler", provider: "doppler", address: "https://api.doppler.com", ca: null, method: null, mount: null, ticks: null, basePath: "harness", policies: null });

    const reports = await Promise.all([approle, userpass, doppler].map((connection) => runtime.keyManagers.copy(desk, connection, [laptop, server])));
    expect(reports.flat().map(({ environmentId, status }) => [environmentId, status])).toEqual([
      [laptop, "copied"],
      [server, "copied"],
      [laptop, "copied"],
      [server, "copied"],
      [laptop, "copied"],
      [server, "copied"],
    ]);
    expect(reports[0]?.[0]).toMatchObject({ status: "copied", result: { status: { kind: "awaiting-sign-in" } } });
    const copiedFrom = { environmentId: desk, environmentName: "desk" };
    const expected = [
      {
        provider: "openbao",
        label: "Agent box vault",
        address: "https://bao.example.com:8200",
        ca: CA_FOR_TESTS,
        method: "approle",
        mount: "approle",
        tokenRole: "agent-runs",
        ticks: ["default", "agent-read"],
        basePath: "personal/harness",
        copiedFrom,
      },
      { provider: "openbao", label: "People vault", address: "https://people.example.com", method: "userpass", mount: "people", username: "david", copiedFrom },
      { provider: "doppler", label: "Doppler", address: "https://api.doppler.com", basePath: "harness", copiedFrom },
    ];
    for (const asked of [onLaptop, onServer]) {
      expect(asked).toEqual(expected.map((params) => ({ ...params, commandId: expect.any(String), connectionId: expect.any(String) })));
      // A copy is a new connection there: its own id, never the source's.
      expect(asked.map((params) => params["connectionId"])).not.toContain(approle.id);
      for (const params of asked) expect(params).not.toHaveProperty("credential");
    }
  });

  it("reports each environment on its own, going on past one that holds the key manager already, cannot be reached, was paired without admin or does not offer key managers", async () => {
    const { runtime, wires, ids } = await pairedMany(KEY_MANAGER_FLAGS, [{ name: "desk" }, { name: "laptop" }, { name: "server" }, { name: "phone", scopes: ["read", "sessions:write"] }, { name: "attic" }]);
    const [desk, laptop, server, phone, attic] = ids as [string, string, string, string, string];
    const [, laptopWire, serverWire, , atticWire] = wires as [FakeWire, FakeWire, FakeWire, FakeWire, FakeWire];
    const connection = keyManagerRecord();
    const held = {
      code: "conflict",
      message: "OpenBao at https://bao.example.com:8200 is connected on this environment already.",
      data: { reason: "connection_exists", provider: "openbao", address: "https://bao.example.com:8200", connectionId: randomUUID() },
    };
    laptopWire.answer("keyManagers.connections.add", () => ({ result: { receipt: { status: "rejected", sequence: 3, changed: false, reason: "conflict", error: held } } }));
    const onServer = acceptingAdds(serverWire);
    atticWire.discovery("unreachable");
    atticWire.server.drop();
    await flush();

    const reports = await runtime.keyManagers.copy(desk, connection, [laptop, server, phone, attic, randomUUID()]);
    expect(reports.map(({ environmentId, status }) => [environmentId, status])).toEqual([
      [laptop, "refused"],
      [server, "copied"],
      [phone, "refused"],
      [attic, "refused"],
      [expect.any(String), "refused"],
    ]);
    const [exists, copied, scope, unreachable, unknown] = reports;
    expect(exists).toEqual({ environmentId: laptop, status: "refused", error: held });
    expect(copied).toMatchObject({ status: "copied", result: { address: "https://bao.example.com:8200", status: { kind: "awaiting-sign-in" } } });
    expect(onServer).toHaveLength(1);
    expect(scope).toMatchObject({ error: { code: "scope", message: "This app has limited access to phone, so it cannot change settings or sign in accounts. Pair again with full access to change this." } });
    expect(unreachable).toMatchObject({ error: { code: "unreachable" } });
    expect(unknown).toMatchObject({ error: { code: "unreachable" } });

    const bare = await pairedMany([], [{ name: "desk" }, { name: "old" }]);
    const [bareDesk, old] = bare.ids as [string, string];
    expect(await bare.runtime.keyManagers.copy(bareDesk, connection, [old])).toEqual([
      { environmentId: old, status: "refused", error: { code: "unsupported", message: "old runs an older agent-harness without this. Update old to use it." } },
    ]);
  });
});

describe("the Key manager form (#1118)", () => {
  const token = { method: "token", token: "token-for-tests" } as const;
  /** A form for `provider` as the pane fills it: a label, an address and what OpenBao alone sends. */
  const formFor = (provider: ConnectionForm["provider"], address: string): ConnectionForm => ({
    provider,
    label: "Mine",
    address,
    method: "approle",
    mount: "approle",
    username: "",
    tokenRole: "",
    ca: null,
  });

  it("asks a 1Password connection for no address, and adds it without one: the account URL its token names is learned at sign-in", async () => {
    const { runtime, wire, env, clock } = await paired({ capabilities: KEY_MANAGER_FLAGS });
    const asked = acceptingAdds(wire);

    expect(formProblem(formFor("onepassword", ""), token)).toBeUndefined();
    // An address typed for another provider before 1Password was chosen is not sent either.
    const added = await addConnection({ runtime, clock }, env, formFor("onepassword", "https://bao.example.com:8200"), token);

    expect(added).toMatchObject({ ok: true, line: expect.stringMatching(/^Saved\. /) });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ provider: "onepassword", label: "Mine", credential: token });
    expect(asked[0]).not.toHaveProperty("address");
  });

  it("still asks OpenBao, Doppler and Bitwarden for their address, and sends it", async () => {
    const { runtime, wire, env, clock } = await paired({ capabilities: KEY_MANAGER_FLAGS });
    const asked = acceptingAdds(wire);

    for (const provider of ["openbao", "doppler", "bitwarden"] as const) {
      expect(formProblem(formFor(provider, " "), token), provider).toBe("Give it the key manager's address.");
    }
    await addConnection({ runtime, clock }, env, formFor("doppler", " https://api.doppler.com "), token);
    expect(asked).toEqual([expect.objectContaining({ provider: "doppler", address: "https://api.doppler.com" })]);
  });
});

describe("what Connect says (setup-copy.md §5.7; #1851)", () => {
  const token = { method: "token", token: "token-for-tests" } as const;
  const form: ConnectionForm = { provider: "openbao", label: "Home OpenBao", address: "https://127.0.0.1:1", method: "token", mount: "token", username: "", tokenRole: "", ca: null };

  /** Answers every add with the connection standing in `kind`. */
  const addingAs = (wire: FakeWire, kind: Parameters<typeof keyManagerStatus>[0]) =>
    wire.answer("keyManagers.connections.add", (params) => {
      const connection = keyManagerRecord({ id: params["connectionId"] as string, label: "Home OpenBao", address: "https://127.0.0.1:1", status: keyManagerStatus(kind, "connect ECONNREFUSED 127.0.0.1:1") });
      return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { connection } } };
    });

  /** Rejects every add with `code`, its message and data. */
  const refusingAs = (wire: FakeWire, code: string, message: string, data: Record<string, unknown>) =>
    wire.answer("keyManagers.connections.add", () => ({ result: { receipt: { status: "rejected", sequence: 1, changed: false, reason: code, error: { code, message, data } } } }));

  it("says a connection signed in is connected, and one saved that cannot be reached saved, never Added followed by what failed", async () => {
    const { runtime, wire, env, clock } = await paired({ capabilities: KEY_MANAGER_FLAGS });
    addingAs(wire, "signed-in");
    expect(await addConnection({ runtime, clock }, env, form, token)).toMatchObject({ ok: true, line: "Connected to Home OpenBao." });
    addingAs(wire, "unreachable");
    const unreachable = await addConnection({ runtime, clock }, env, form, token);
    expect(unreachable).toMatchObject({ ok: true, line: "Saved, but agent-harness could not reach https://127.0.0.1:1. Check the address, then choose Check again." });
    expect(unreachable.line).not.toMatch(/Added|ECONNREFUSED/);
    addingAs(wire, "sealed");
    expect(await addConnection({ runtime, clock }, env, form, token)).toMatchObject({ ok: true, line: "Saved, but Home OpenBao is not connected yet. Unlock it, then choose Check again." });
    addingAs(wire, "awaiting-sign-in");
    expect(await addConnection({ runtime, clock }, env, form, token)).toMatchObject({ ok: true, line: "Saved. Home OpenBao is not signed in yet." });
  });

  it("says each sign-in refusal in §5.7's words for the provider and address it was given, its raw words and data.details under Details", async () => {
    const { runtime, wire, env, clock } = await paired({ capabilities: KEY_MANAGER_FLAGS });
    const cases: readonly (readonly [code: string, data: Record<string, unknown>, line: string])[] = [
      ["verification_failed", { reason: "rejected", details: ["OpenBao answered HTTP 403: permission denied.", "Nothing was stored."] }, "OpenBao did not accept these details. Check them and try again."],
      ["verification_failed", { reason: "root_token", details: [] }, "Use a token that is not the root token. agent-harness never uses root."],
      ["unreachable", { details: ["connect ECONNREFUSED 127.0.0.1:1"] }, "agent-harness could not reach https://127.0.0.1:1. Check the address."],
      ["sealed", {}, "OpenBao is locked (sealed). Unlock it, then connect."],
      ["certificate_rejected", {}, "agent-harness does not trust this site's certificate."],
      ["provider_unavailable", { provider: "openbao" }, "agent-harness cannot connect to OpenBao on this computer yet."],
      ["conflict", { reason: "connection_exists" }, "OpenBao at https://127.0.0.1:1 is connected already."],
    ];
    for (const [code, data, line] of cases) {
      refusingAs(wire, code, `The raw words for ${code}.`, data);
      const refused = await addConnection({ runtime, clock }, env, form, token);
      expect(refused, code).toEqual({ ok: false, code, line, details: [expect.stringContaining(`The raw words for ${code}.`), ...((data["details"] as string[] | undefined) ?? [])] });
    }
  });

  it("says a refusal of this client's own, the computer not reached, as the request layer's plain line", async () => {
    const { runtime, wire, env, clock } = await paired({ capabilities: KEY_MANAGER_FLAGS });
    wire.discovery("unreachable");
    wire.server.drop();
    await flush();
    const refused = await addConnection({ runtime, clock }, env, form, token);
    expect(refused).toMatchObject({ ok: false, line: "This app cannot reach that computer right now. Choose Connect OpenBao to try again." });
  });
});

describe("a connection's health (setup-copy.md §5.7; #1851)", () => {
  const now = new Date("2026-09-24T09:30:00");
  const since = new Date("2026-09-24T09:14:00").toISOString();
  it("is one line, its state since when, then the one thing to do, with the one button that does it", () => {
    const health = (kind: Parameters<typeof keyManagerStatus>[0]) => connectionHealth({ kind, since, message: "The environment's own words." }, now);
    expect(health("signed-in")).toEqual({ line: "Connected since 09:14.", fix: null });
    expect(health("signing-in")).toEqual({ line: "Signing in since 09:14.", fix: null });
    expect(health("awaiting-sign-in")).toEqual({ line: "Not signed in since 09:14. Sign in to use it.", fix: "sign-in" });
    expect(health("credential-rejected")).toEqual({ line: "Not accepted since 09:14. Sign in again with a working token.", fix: "sign-in-again" });
    expect(health("expired")).toEqual({ line: "Expired since 09:14. Sign in with a new token.", fix: "sign-in-again" });
    expect(health("unreachable")).toEqual({ line: "Not answering since 09:14. Check the address and the connection, then choose Check again.", fix: "check-again" });
    expect(health("sealed")).toEqual({ line: "Locked (sealed) since 09:14. Unlock it, then choose Check again.", fix: "check-again" });
    expect(health("certificate-rejected")).toEqual({ line: "Certificate not trusted since 09:14. Choose Check certificate to review it.", fix: "check-certificate" });
    expect(health("provider-unavailable")).toEqual({ line: "Not ready since 09:14. Choose Check again.", fix: "check-again" });
  });
});
