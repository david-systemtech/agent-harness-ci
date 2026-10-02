import { BRIDGE_PROOF_TEST_VECTOR } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { workerHarness } from "../test/worker-harness.js";
import { startWorker, type RunningWorker } from "./service-worker.js";

/**
 * The service worker (browser spec, "The extension, its folder and its
 * listener"; #549) against the fake `chrome` API and a scripted environment
 * speaking bridge protocol version 2 on a loopback WebSocket: what the
 * environment hears on its socket, and what the worker keeps and says in
 * Chrome's storage, which its options page reads. Time is a manual clock.
 */

const { POLICY, environmentOf, setUp, setUpPaired, statusOnce, announced, challenged, pairingWith, onCleanup } = workerHarness();

const onStop = (worker: RunningWorker): void => onCleanup(() => worker.stop());

describe("a worker that holds no credential", () => {
  it("dials the port its port file names and opens with announce: the protocol and extension versions and the name it would pair as", async () => {
    const { environment } = await setUp();

    const socket = await environment.nextSocket();

    expect(await socket.next()).toEqual({ type: "announce", protocolVersion: 2, extensionVersion: "1.2.3-test", name: "" });
  });

  it("holds the announced socket, saying which environment it is connected to, and pings it every 20 seconds", async () => {
    const setup = await setUp();
    const socket = await setup.environment.nextSocket();

    await announced(setup, socket);

    expect(setup.chrome.storage.session.peek("status")).toEqual({ state: "unpaired", port: setup.environment.port, environmentName: "Laptop" });
    setup.clock.advance(20_000);
    expect(await socket.next()).toEqual({ type: "ping" });
    socket.send({ type: "pong" });
    setup.clock.advance(20_000);
    expect(await socket.next()).toEqual({ type: "ping" });
    expect(setup.environment.socketCount()).toBe(1);
  });

  it("creates an alarm every 30 seconds that dials again when its socket has gone, without waiting for the retry", async () => {
    const setup = await setUp();
    await announced(setup, await setup.environment.nextSocket());
    expect([...setup.chrome.alarmsCreated]).toEqual([["connect", 0.5]]);

    // The environment stops; the worker would retry in a second, and the alarm comes first.
    await setup.environment.close();
    await statusOnce(setup.chrome, (status) => status.state !== "unpaired");
    const restarted = await environmentOf({ name: "Laptop" });
    setup.folder.writePortFile(restarted.portFile);
    setup.chrome.fireAlarm("connect");

    expect(await (await restarted.nextSocket()).next()).toMatchObject({ type: "announce" });
  });

  it("is started again after Chrome stopped it, and announces on a new socket", async () => {
    const setup = await setUp({ started: false });
    const first = setup.start();
    const socket = await setup.environment.nextSocket();
    await announced(setup, socket);

    first.stop();
    expect((await socket.closed).code).toBe(1005);
    setup.start();

    expect(await (await setup.environment.nextSocket()).next()).toMatchObject({ type: "announce" });
    expect([...setup.chrome.alarmsCreated]).toEqual([["connect", 0.5]]);
  });
});

describe("the port", () => {
  it("is read from the port file at each connection attempt: a port rewritten across the environment's restart is dialled at the next attempt", async () => {
    const setup = await setUp();
    const first = await setup.environment.nextSocket();
    await announced(setup, first);

    // The environment restarts on another port and rewrites the file; the old socket closes as it stops.
    const restarted = await environmentOf({ name: "Laptop" });
    setup.folder.writePortFile(restarted.portFile);
    first.close(1001);
    await statusOnce(setup.chrome, (status) => status.state === "connecting");
    setup.clock.advance(1_000);

    const second = await restarted.nextSocket();
    await announced({ chrome: setup.chrome, environment: restarted }, second);
    expect(setup.chrome.storage.session.peek("status")).toMatchObject({ state: "unpaired", port: restarted.port });
  });

  it("is the override while one is set, which wins over the port file; setting or clearing it dials again at once", async () => {
    const setup = await setUp();
    const fromFile = await setup.environment.nextSocket();
    await announced(setup, fromFile);
    const elsewhere = await environmentOf({ name: "Desktop" });

    await setup.chrome.storage.local.set({ portOverride: elsewhere.port });

    expect((await fromFile.closed).code).toBe(1000);
    await announced({ chrome: setup.chrome, environment: elsewhere }, await elsewhere.nextSocket());
    expect(setup.chrome.storage.session.peek("status")).toMatchObject({ state: "unpaired", port: elsewhere.port, environmentName: "Desktop" });

    await setup.chrome.storage.local.remove("portOverride");

    await announced(setup, await setup.environment.nextSocket());
    expect(setup.chrome.storage.session.peek("status")).toMatchObject({ state: "unpaired", port: setup.environment.port });
  });

  it("is read again when the override is set while an attempt is reading it, so the attempt dials the override", async () => {
    const setup = await setUp({ started: false });
    const elsewhere = await environmentOf({ name: "Desktop" });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    const worker = startWorker({
      chrome: setup.chrome,
      clock: setup.clock,
      readOwnFile: async (path) => {
        reads += 1;
        if (reads === 1) await held;
        return setup.folder.readOwnFile(path);
      },
    });
    onStop(worker);

    await setup.chrome.storage.local.set({ portOverride: elsewhere.port });
    await Promise.resolve();
    release();

    await announced({ chrome: setup.chrome, environment: elsewhere }, await elsewhere.nextSocket());
    expect(setup.environment.socketCount()).toBe(0);
  });

  it("is missing while the folder holds no port file: the worker says so, and dials once the file is written", async () => {
    const setup = await setUp({ started: false });
    setup.folder.removePortFile();
    setup.start();

    expect(await statusOnce(setup.chrome, (status) => status.state === "no-port")).toEqual({
      state: "no-port",
      problem: "This extension's folder holds no port file yet: the environment writes one once it listens. Start the environment; this updates by itself.",
    });
    setup.folder.writePortFile(setup.environment.portFile);
    setup.clock.advance(1_000);

    expect(await (await setup.environment.nextSocket()).next()).toMatchObject({ type: "announce" });
  });

  it("says nothing answers when no environment takes the socket, and tries again", async () => {
    const setup = await setUp({ started: false });
    const port = setup.environment.port;
    await setup.environment.close();
    setup.start();

    expect(await statusOnce(setup.chrome, (status) => status.state === "unreachable")).toEqual({ state: "unreachable", port });
    const back = await environmentOf();
    setup.folder.writePortFile(back.portFile);
    setup.clock.advance(1_000);

    expect(await (await back.nextSocket()).next()).toMatchObject({ type: "announce" });
  });
});

describe("a worker that holds a credential", () => {
  it("opens with hello and answers the challenge with the proof, #541's test vector, and holds the proved socket", async () => {
    const setup = await setUpPaired();
    const socket = await setup.environment.nextSocket();

    expect(await socket.next()).toEqual({
      type: "hello",
      protocolVersion: 2,
      extensionVersion: "1.2.3-test",
      environmentId: setup.environment.environmentId,
      chromeId: "6b0d6a3e-7c4f-4d0e-9f6a-2b1c3d4e5f60",
      name: "Work",
    });
    socket.send({ type: "challenge", environmentId: setup.environment.environmentId, nonce: BRIDGE_PROOF_TEST_VECTOR.nonce });
    expect(await socket.next()).toEqual({ type: "proof", mac: BRIDGE_PROOF_TEST_VECTOR.proof });
    socket.send({ type: "ready", policy: POLICY });

    expect(await statusOnce(setup.chrome, (status) => status.state === "connected")).toEqual({
      state: "connected",
      port: setup.environment.port,
      environmentName: "Laptop",
      name: "Work",
    });
    setup.clock.advance(20_000);
    expect(await socket.next()).toEqual({ type: "ping" });
  });

  it("does not prove itself to another environment on its port: it closes, keeps its pairing, and says another environment holds the port", async () => {
    const setup = await setUpPaired();
    const socket = await setup.environment.nextSocket();
    expect(await socket.next()).toMatchObject({ type: "hello" });

    socket.send({ type: "challenge", environmentId: "0f8fad5b-d9cb-469f-a165-70867728950e", nonce: BRIDGE_PROOF_TEST_VECTOR.nonce });

    expect((await socket.closed).code).toBe(1000);
    expect(socket.received.map((message) => message.type)).toEqual(["hello"]);
    expect(await statusOnce(setup.chrome, (status) => status.state === "other-environment")).toEqual({
      state: "other-environment",
      port: setup.environment.port,
      pairedWith: "Laptop",
    });
    expect(setup.chrome.storage.local.peek("pairing")).toEqual(pairingWith(setup.environment));
  });

  it("forgets its pairing and announces again at once when the environment refuses it as unpaired on its proved socket", async () => {
    const setup = await setUpPaired();
    const socket = await setup.environment.nextSocket();
    await challenged(setup, socket);
    socket.send({ type: "ready", policy: POLICY });
    await statusOnce(setup.chrome, (status) => status.state === "connected");

    socket.refuse("This Chrome was unpaired from Laptop.");

    const again = await setup.environment.nextSocket();
    expect(await again.next()).toEqual({ type: "announce", protocolVersion: 2, extensionVersion: "1.2.3-test", name: "" });
    expect(setup.chrome.storage.local.peek("pairing")).toBeUndefined();
    again.send({ type: "announced", environmentId: setup.environment.environmentId, environmentName: "Laptop" });
    expect(await statusOnce(setup.chrome, (status) => status.state === "unpaired")).toEqual({
      state: "unpaired",
      port: setup.environment.port,
      environmentName: "Laptop",
      forgotten: "This Chrome was unpaired from Laptop.",
    });
  });

  it("closes its proved socket and announces again at once when its pairing is removed from storage, as the options page's Forget does", async () => {
    const setup = await setUpPaired();
    const socket = await setup.environment.nextSocket();
    await challenged(setup, socket);
    socket.send({ type: "ready", policy: POLICY });
    await statusOnce(setup.chrome, (status) => status.state === "connected");

    await setup.chrome.storage.local.remove("pairing");

    expect((await socket.closed).code).toBe(1000);
    expect(await (await setup.environment.nextSocket()).next()).toEqual({ type: "announce", protocolVersion: 2, extensionVersion: "1.2.3-test", name: "" });
    expect(setup.environment.socketCount()).toBe(2);
  });

  it("forgets its pairing and announces again at once when its proof is refused", async () => {
    const setup = await setUpPaired();
    const socket = await setup.environment.nextSocket();
    await challenged(setup, socket);

    socket.refuse("Laptop holds no pairing for this Chrome. Pair it again.");

    expect(await (await setup.environment.nextSocket()).next()).toMatchObject({ type: "announce" });
    expect(setup.chrome.storage.local.peek("pairing")).toBeUndefined();
  });

  it("keeps its pairing when its hello is refused, says why, and opens with hello again later", async () => {
    const setup = await setUpPaired();
    const socket = await setup.environment.nextSocket();
    expect(await socket.next()).toMatchObject({ type: "hello" });
    const reload = "This extension speaks bridge version 2 and this environment speaks 4. Open chrome://extensions and click Reload on the extension.";

    socket.refuse(reload);

    // The worker says it was refused before its socket's close sets the retry, so the clock moves only once the retry waits.
    expect(await statusOnce(setup.chrome, (status) => status.state === "refused" && setup.clock.pending() > 0)).toEqual({
      state: "refused",
      port: setup.environment.port,
      reason: reload,
    });
    expect(setup.chrome.storage.local.peek("pairing")).toEqual(pairingWith(setup.environment));
    setup.clock.advance(1_000);
    expect(await (await setup.environment.nextSocket()).next()).toMatchObject({ type: "hello" });
  });

  it("keeps its pairing when the socket closes with no refusal, as an environment failing during the proof closes it, and dials again with hello", async () => {
    const setup = await setUpPaired();
    const socket = await setup.environment.nextSocket();
    await challenged(setup, socket);

    socket.close(1011);
    await statusOnce(setup.chrome, (status) => status.state === "connecting" && setup.clock.pending() > 0);
    setup.clock.advance(1_000);

    const again = await setup.environment.nextSocket();
    await challenged(setup, again);
    again.send({ type: "ready", policy: POLICY });
    expect(await statusOnce(setup.chrome, (status) => status.state === "connected")).toMatchObject({
      state: "connected",
      environmentName: "Laptop",
      name: "Work",
    });
    expect(setup.chrome.storage.local.peek("pairing")).toEqual(pairingWith(setup.environment));
  });

  it("answers a verb only on a live socket: a call before the proof, or on the announced socket, is out of turn, and no tab is made", async () => {
    const call = { type: "call", id: "call-1", pageKey: "env/session", command: { verb: "open", args: { url: "https://example.com/" } } } as const;
    const paired = await setUpPaired();
    const proving = await paired.environment.nextSocket();
    expect(await proving.next()).toMatchObject({ type: "hello" });
    proving.send(call);
    expect(await proving.next()).toEqual({ type: "refused", reason: "The extension did not expect call here." });

    const unpaired = await setUp();
    const announcing = await unpaired.environment.nextSocket();
    await announced(unpaired, announcing);
    announcing.send(call);
    expect(await announcing.next((message) => message.type === "refused")).toEqual({ type: "refused", reason: "The extension did not expect call here." });

    expect([...paired.chrome.tabsOpen(), ...unpaired.chrome.tabsOpen()]).toEqual([]);
  });
});
