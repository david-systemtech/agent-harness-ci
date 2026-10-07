import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection, createServer, type Server } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BRIDGE_PATH,
  EXTENSION_ORIGIN,
  PORT_FILE_NAME,
  decodeFromExtension,
  encodeBridgeMessage,
  type BridgeFromExtension,
  type ResultOf,
} from "@agent-harness/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { EXTENSION_BUILD, HARNESS_VERSION } from "../serve/start.js";
import { useCleanups } from "../../test/cleanups.js";
import {
  DialRefusedError,
  TEST_EXTENSION,
  TEST_EXTENSION_VERSION,
  dialExtension,
  readPortFile,
  writeExtensionBuild,
  type DialOptions,
  type FakeExtension,
} from "../../test/fake-extension.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { WAIT_MS } from "../../test/wire-client.js";

/**
 * The extension's folder, its port file and its listener through the primary
 * seam (browser spec, "The extension, its folder and its listener" and
 * "Testing Decisions"; ADR 0024; #547): the in-process environment with the
 * listener's preferred port set to 0 and a fixture extension folder as the
 * built extension it carries, the fake extension dialling it over a real
 * WebSocket, and a typed client reading `browser.status` and
 * `environment.subscribe`. What is asserted is what Chrome and the
 * extension find (the folder's files, the port file, the socket's answers)
 * and what a client sees.
 */

const { onCleanup, tempDir } = useCleanups();

/** Spawning tsx and bundling the extension with Vite on a loaded runner: a cap for a hang, not a budget. */
const BUILD_MS = 120_000;

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  // Set up's start pass appends its results after the start returns: done before the test reads the log or a step (#1804).
  await t.env.setup.startPass;
  return t;
};

const folderOf = (t: Pick<TestEnvironment, "dataDir">): string => join(t.dataDir, "extension", "current");

const status = async (t: TestEnvironment): Promise<ResultOf<"browser.status">> => {
  const client = await t.client();
  try {
    return (await client.request("browser.status", {})) as ResultOf<"browser.status">;
  } finally {
    await client.close();
  }
};

/** The fake extension dialling the environment `t` from its folder, closed after the test. */
const dial = async (t: Pick<TestEnvironment, "dataDir">, options?: DialOptions): Promise<FakeExtension> => {
  const extension = await dialExtension(folderOf(t), options);
  onCleanup(() => extension.close());
  return extension;
};

/** Holds a loopback port, as another program would, until the test ends: answers the port. */
const holdPort = async (port = 0): Promise<number> => {
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve());
  });
  onCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The held port has no address.");
  return address.port;
};

/** A loopback port free a moment ago, for a range two environments share. */
const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, () => resolve()));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("The free port has no address.");
  return address.port;
};

const portOf = (answer: ResultOf<"browser.status">): number => {
  if (answer.listener.state !== "listening") throw new Error(`The listener is not listening: ${answer.listener.message}`);
  return answer.listener.port;
};

describe("the extension's folder", () => {
  it("is the built extension copied to extension/current at startup, with the port file written into it once the listener is bound", async () => {
    const t = await start({ name: "Laptop", harnessVersion: "1.0.0-test" });
    const folder = folderOf(t);

    expect(readdirSync(folder).sort()).toEqual(["manifest.json", PORT_FILE_NAME, "worker.js"]);
    expect(readFileSync(join(folder, "manifest.json"), "utf8")).toBe(readFileSync(join(TEST_EXTENSION, "manifest.json"), "utf8"));
    const answer = await status(t);
    expect(answer).toEqual({
      listener: { state: "listening", port: expect.any(Number) as number },
      folder: { path: folder, problem: null },
      shippedVersion: TEST_EXTENSION_VERSION,
      unpairedConnected: false,
      headless: { allowRuns: true, availability: expect.objectContaining({ available: false }), liveContexts: 0 },
    });
    const port = answer.listener.state === "listening" ? answer.listener.port : 0;
    expect(readPortFile(folder)).toEqual({ port, environmentId: t.env.id, environmentName: "Laptop", harnessVersion: "1.0.0-test" });
    // No staging folder is left beside it.
    expect(readdirSync(join(t.dataDir, "extension"))).toEqual(["current"]);
    expect(existsSync(join(folder, `${PORT_FILE_NAME}.tmp`))).toBe(false);
  });

  it("is left as it is by a start of the same version, which writes only the port file again", async () => {
    const dataDir = join(tempDir("agent-harness-extension-"), "data");
    const first = await start({ dataDir });
    const folder = folderOf(first);
    await first.close();
    // Something the copy would never make: a folder copied again would lose it.
    writeFileSync(join(folder, "left-by-chrome.txt"), "kept");

    const second = await start({ dataDir });
    const answer = await status(second);

    expect(readFileSync(join(folder, "left-by-chrome.txt"), "utf8")).toBe("kept");
    expect(answer).toMatchObject({ folder: { path: folder, problem: null }, shippedVersion: TEST_EXTENSION_VERSION });
    expect(readPortFile(folder).port).toBe(answer.listener.state === "listening" ? answer.listener.port : undefined);
  });

  it("is replaced whole by a start of another harness version over the same data directory: the new manifest, and no file of the old", async () => {
    const dataDir = join(tempDir("agent-harness-extension-"), "data");
    const older = writeExtensionBuild(tempDir("agent-harness-build-"), "0.9.0", { "old-worker.js": "// 0.9.0" });
    const newer = writeExtensionBuild(tempDir("agent-harness-build-"), "1.1.0", { "new-worker.js": "// 1.1.0" });
    const first = await start({ dataDir, harnessVersion: "0.9.0", browser: { extensionSource: older } });
    const folder = folderOf(first);
    expect(readdirSync(folder).sort()).toEqual(["manifest.json", "old-worker.js", PORT_FILE_NAME]);
    await first.close();

    const second = await start({ dataDir, harnessVersion: "1.1.0", browser: { extensionSource: newer } });

    expect(readdirSync(folder).sort()).toEqual(["manifest.json", "new-worker.js", PORT_FILE_NAME]);
    expect(readFileSync(join(folder, "manifest.json"), "utf8")).toBe(readFileSync(join(newer, "manifest.json"), "utf8"));
    expect(readPortFile(folder)).toMatchObject({ environmentId: second.env.id, harnessVersion: "1.1.0" });
    expect(await status(second)).toMatchObject({ folder: { path: folder, problem: null }, shippedVersion: "1.1.0" });
    // The staging folder was renamed into place and the old folder removed: nothing is left beside it.
    expect(readdirSync(join(dataDir, "extension"))).toEqual(["current"]);
  });

  it("is made again, with its port file, when browser.status finds it missing", async () => {
    const t = await start();
    const folder = folderOf(t);
    const before = readPortFile(folder);
    rmSync(folder, { recursive: true, force: true });

    const answer = await status(t);

    expect(answer).toMatchObject({ folder: { path: folder, problem: null }, shippedVersion: TEST_EXTENSION_VERSION });
    expect(readdirSync(folder).sort()).toEqual(["manifest.json", PORT_FILE_NAME, "worker.js"]);
    expect(readPortFile(folder)).toEqual(before);
  });

  it("is not made when the environment carries no built extension, and browser.status says so, with no shipped version", async () => {
    const t = await start({ browser: { extensionSource: join(tempDir("agent-harness-build-"), "absent") } });

    const answer = await status(t);

    expect(answer.shippedVersion).toBeNull();
    expect(answer.folder.problem).toMatch(/^This environment carries no built extension/);
    expect(existsSync(folderOf(t))).toBe(false);
  });
});

describe("the port file", () => {
  it("follows a rename of the environment, so the extension's options page names it as it is now", async () => {
    const t = await start({ name: "Laptop" });
    const admin = await t.client();

    await admin.apply("environment.rename", { commandId: randomUUID(), name: "Work laptop" });

    await expect.poll(() => readPortFile(folderOf(t)).environmentName, { timeout: WAIT_MS }).toBe("Work laptop");
    expect(readPortFile(folderOf(t))).toMatchObject({ environmentId: t.env.id });
  });
});

describe("the listener", () => {
  it("binds the preferred port, else the next free one up to the last, on loopback only", async () => {
    const held = await holdPort();
    const t = await start({ browser: { ports: { preferred: held, last: held + 19 } } });

    const port = portOf(await status(t));

    expect(port).toBeGreaterThan(held);
    expect(port).toBeLessThanOrEqual(held + 19);
    expect(readPortFile(folderOf(t)).port).toBe(port);
    // Nothing answers on the machine's other addresses.
    const outward = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4");
    if (outward !== undefined) {
      const connected = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: outward.address, port }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
        // A machine that drops rather than refuses answers nothing either.
        socket.setTimeout(WAIT_MS, () => {
          socket.destroy();
          resolve(false);
        });
      });
      expect(connected).toBe(false);
    }
  });

  it("does not listen when every port of its range is taken: browser.status answers the port-in-use error, and the folder holds no port file", async () => {
    const held = await holdPort();
    const t = await start({ browser: { ports: { preferred: held, last: held } } });

    const answer = await status(t);

    expect(answer.listener).toEqual({ state: "not-listening", reason: "port-in-use", message: expect.stringContaining(`Port ${held}`) as string });
    expect(answer.folder).toEqual({ path: folderOf(t), problem: null });
    expect(existsSync(join(folderOf(t), PORT_FILE_NAME))).toBe(false);
  });

  it("gives two environments on one machine a folder and a port each, the second taking the next free port", async () => {
    const first = await freePort();
    const ports = { preferred: first, last: first + 19 };
    const laptop = await start({ name: "Laptop", browser: { ports } });
    const second = await start({ name: "Second", browser: { ports } });

    const [a, b] = [portOf(await status(laptop)), portOf(await status(second))];

    expect(b).toBeGreaterThan(a);
    expect(folderOf(laptop)).not.toBe(folderOf(second));
    expect(readPortFile(folderOf(laptop))).toMatchObject({ port: a, environmentId: laptop.env.id, environmentName: "Laptop" });
    expect(readPortFile(folderOf(second))).toMatchObject({ port: b, environmentId: second.env.id, environmentName: "Second" });
    expect(await (await dial(laptop)).announce()).toEqual({ type: "announced", environmentId: laptop.env.id, environmentName: "Laptop" });
    expect(await (await dial(second)).announce()).toEqual({ type: "announced", environmentId: second.env.id, environmentName: "Second" });
  });
});

describe("an extension's socket", () => {
  it("is refused before any message when the upgrade's Host is not loopback", async () => {
    const t = await start();
    const head = t.env.log.head();
    const port = readPortFile(folderOf(t)).port;

    await expect(dial(t, { host: `rebound.example:${port}` })).rejects.toMatchObject({ status: 421 });

    expect(t.env.log.head()).toBe(head);
    expect((await status(t)).unpairedConnected).toBe(false);
  });

  it("is refused before any message when the upgrade does not carry the extension's Origin", async () => {
    const t = await start();
    const head = t.env.log.head();

    for (const origin of [null, "https://example.com", "chrome-extension://abcdefghijklmnopabcdefghijklmnop"]) {
      const refused = await dial(t, { origin }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused, String(origin)).toBeInstanceOf(DialRefusedError);
      expect(refused).toMatchObject({ status: 403 });
    }
    expect(t.env.log.head()).toBe(head);
  });

  it("answers announce with the environment's id and name and keeps the socket: extension.seen on environment.subscribe, and browser.status's unpaired flag while it is open", async () => {
    const t = await start({ name: "Laptop" });
    const watcher = await t.client();
    const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    const extension = await dial(t);

    expect(await extension.announce({ extensionVersion: "1.0.0-test", name: "Work" })).toEqual({ type: "announced", environmentId: t.env.id, environmentName: "Laptop" });

    const frame = await watcher.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "extension.seen");
    expect(frame).toMatchObject({ event: { type: "extension.seen", payload: { protocolVersion: 2, extensionVersion: "1.0.0-test" }, actor: { kind: "system", id: "browser" } } });
    expect((await status(t)).unpairedConnected).toBe(true);
    extension.send({ type: "ping" });
    expect(await extension.next((message) => message.type === "pong")).toEqual({ type: "pong" });
    expect(extension.isOpen()).toBe(true);

    await extension.close();
    await expect.poll(async () => (await status(t)).unpairedConnected, { timeout: WAIT_MS }).toBe(false);
  });

  it("serves an extension one bridge version behind, and closes an older or a newer one with the Reload sentence", async () => {
    const t = await start();
    const behind = await dial(t);
    expect(await behind.announce({ protocolVersion: 1 })).toMatchObject({ type: "announced", environmentId: t.env.id });

    for (const protocolVersion of [0, 3]) {
      const other = await dial(t);
      const answer = await other.announce({ protocolVersion });
      expect(answer).toEqual({
        type: "refused",
        reason: `This extension speaks bridge version ${protocolVersion} and this environment speaks 2. Open chrome://extensions and click Reload on the extension.`,
      });
      expect((await other.closed).code).toBe(1008);
    }
    expect(behind.isOpen()).toBe(true);
  });

  it("is closed with a sentence when it opens with anything but announce or hello, or sends what the codec refuses", async () => {
    const t = await start();
    for (const opening of ['{"type":"proof","mac":"00"}', "not json", JSON.stringify({ type: "result", id: "call-1", result: { ok: false, reason: "No." } })]) {
      const extension = await dial(t);
      extension.send(opening);
      expect(await extension.next()).toMatchObject({ type: "refused", reason: expect.any(String) as string });
      expect((await extension.closed).code).toBe(1008);
    }
    expect((await status(t)).unpairedConnected).toBe(false);
  });
});

describe("the fake extension", () => {
  it("reads the port file, dials with the extension's Origin, speaks version 2, and answers each call from its script", async () => {
    // A scripted environment peer: it takes the socket at the bridge's path, answers announce, then calls two verbs.
    const peer = new WebSocketServer({ host: "127.0.0.1", port: 0, path: BRIDGE_PATH });
    onCleanup(() => new Promise<void>((resolve) => peer.close(() => resolve())));
    await new Promise<void>((resolve) => peer.once("listening", () => resolve()));
    const address = peer.address();
    if (address === null || typeof address === "string") throw new Error("The peer has no port.");
    const heard: BridgeFromExtension[] = [];
    let origin: string | undefined;
    peer.on("connection", (socket, request) => {
      origin = request.headers.origin;
      socket.on("message", (data) => {
        const decoded = decodeFromExtension(String(data));
        if (!decoded.ok) throw new Error(decoded.reason);
        heard.push(decoded.message);
        if (decoded.message.type !== "announce") return;
        socket.send(encodeBridgeMessage({ type: "announced", environmentId: "0f8fad5b-d9cb-469f-a165-70867728950e", environmentName: "Peer" }));
        socket.send(encodeBridgeMessage({ type: "call", id: "call-1", pageKey: "env/session", command: { verb: "navigate", args: { url: "https://example.com/" } } }));
        socket.send(encodeBridgeMessage({ type: "call", id: "call-2", pageKey: "env/session", command: { verb: "screenshot", args: {} } }));
      });
    });
    const folder = writeExtensionBuild(tempDir("agent-harness-unpacked-"), "1.2.0");
    writeFileSync(
      join(folder, PORT_FILE_NAME),
      JSON.stringify({ port: address.port, environmentId: "0f8fad5b-d9cb-469f-a165-70867728950e", environmentName: "Peer", harnessVersion: "1.2.0" }),
    );

    const extension = await dialExtension(folder, {
      script: { navigate: (call) => ({ ok: true, value: { url: call.command.args.url, title: "Example" } }) },
    });
    onCleanup(() => extension.close());
    expect(await extension.announce()).toEqual({ type: "announced", environmentId: "0f8fad5b-d9cb-469f-a165-70867728950e", environmentName: "Peer" });

    await expect.poll(() => heard.filter((message) => message.type === "result").length, { timeout: WAIT_MS }).toBe(2);
    expect(origin).toBe(EXTENSION_ORIGIN);
    expect(heard[0]).toEqual({ type: "announce", protocolVersion: 2, extensionVersion: "1.2.0", name: "Chrome" });
    // Each result names its call, and may come in any order.
    expect(heard.slice(1).sort((a, b) => ("id" in a && "id" in b ? a.id.localeCompare(b.id) : 0))).toEqual([
      { type: "result", id: "call-1", result: { ok: true, value: { url: "https://example.com/", title: "Example" } } },
      { type: "result", id: "call-2", result: { ok: false, reason: "The fake extension has no answer scripted for screenshot." } },
    ]);
    expect(extension.calls.map((call) => call.id)).toEqual(["call-1", "call-2"]);
  });
});

describe("the extension package's build (#549)", () => {
  // The workspace build's own step, `pnpm --filter @agent-harness/extension build`, run once: the extension of the
  // harness version into the extension package's `dist`, the build an environment carries unless told otherwise.
  const script = fileURLToPath(new URL("../../../extension/scripts/build-extension.ts", import.meta.url));
  const tsx = createRequire(import.meta.url).resolve("tsx");
  beforeAll(async () => {
    await promisify(execFile)(process.execPath, ["--conditions=@agent-harness/source", "--import", tsx, script], { cwd: join(script, "..", "..") });
  }, BUILD_MS);
  const carried = { browser: { extensionSource: EXTENSION_BUILD } } as const;

  it("is unpacked whole into extension/current at startup, with the port file beside it, as the harness version", async () => {
    const t = await start({ name: "Laptop", ...carried });
    const folder = folderOf(t);

    expect(readdirSync(folder).sort()).toEqual([...readdirSync(EXTENSION_BUILD), PORT_FILE_NAME].sort());
    for (const file of readdirSync(EXTENSION_BUILD)) expect(readFileSync(join(folder, file)), file).toEqual(readFileSync(join(EXTENSION_BUILD, file)));
    expect(await status(t)).toMatchObject({ folder: { path: folder, problem: null }, shippedVersion: HARNESS_VERSION });
    expect(readPortFile(folder)).toMatchObject({ environmentId: t.env.id, environmentName: "Laptop", harnessVersion: HARNESS_VERSION });
  });

  it("replaces another version's folder whole", async () => {
    const dataDir = join(tempDir("agent-harness-extension-"), "data");
    const older = writeExtensionBuild(tempDir("agent-harness-build-"), "0.0.0-older", { "old-worker.js": "// older" });
    await (await start({ dataDir, harnessVersion: "0.0.0-older", browser: { extensionSource: older } })).close();

    const t = await start({ dataDir, ...carried });

    expect(readdirSync(folderOf(t)).sort()).toEqual([...readdirSync(EXTENSION_BUILD), PORT_FILE_NAME].sort());
    expect(await status(t)).toMatchObject({ folder: { problem: null }, shippedVersion: HARNESS_VERSION });
  });

  it("is found through its port file by an extension dialling from the folder, whose announce of the build's version raises extension.seen", async () => {
    const t = await start({ name: "Laptop", ...carried });
    const watcher = await t.client();
    const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    const extension = await dial(t);

    expect(await extension.announce()).toEqual({ type: "announced", environmentId: t.env.id, environmentName: "Laptop" });

    const frame = await watcher.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "extension.seen");
    expect(frame).toMatchObject({ event: { payload: { protocolVersion: 2, extensionVersion: HARNESS_VERSION } } });
    expect((await status(t)).unpairedConnected).toBe(true);
  });
});
