import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { Server, request } from "node:http";
import { hostname } from "node:os";
import { join, relative, sep } from "node:path";
import {
  DISCOVERY_PATH,
  DiscoveryDocument,
  HEALTH_PATH,
  HealthDocument,
  PROTOCOL_VERSION,
  WIRE_PATH,
  registry,
} from "@agent-harness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { TEST_EXTENSION, TEST_EXTENSION_PORTS } from "../../test/fake-extension.js";
import {
  NO_LAUNCHER,
  RootRefusedError,
  ROOT_REFUSAL,
  SIGNING_KEY,
  StartupError,
  TOP_CEILING,
  fileVault,
  startEnvironment,
  type Address,
  type EnvironmentHandle,
  type EnvironmentOptions,
  type InterfaceDetector,
  type LauncherChannel,
  type StartupStep,
  type UserCheck,
} from "../index.js";
import { loadKeychainBinding } from "./keychain.js";
import { presetColour } from "../look/look.js";

const posix = process.platform !== "win32";
const { version: packageVersion } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

const notPrivileged: UserCheck = { isPrivileged: () => false };
/** No Tailscale on the machine and no LAN address as far as these tests know, so none binds a real interface. */
const interfaces: InterfaceDetector = { tailscaleAddress: async () => undefined, tailnetName: async () => undefined, lanAddresses: () => [] };
const privileged: UserCheck = { isPrivileged: () => true };

const { onCleanup, tempDir } = useCleanups();
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A launcher channel that records what reaches it. */
const recordingLauncher = (onPrepared?: () => void | Promise<void>, onClose?: () => void | Promise<void>) => {
  const signals: string[] = [];
  const channel: LauncherChannel = {
    present: () => false,
    onQuery: () => undefined,
    request: () => Promise.resolve(NO_LAUNCHER),
    prepared: async () => {
      signals.push("prepared");
      await onPrepared?.();
    },
    close: async () => {
      signals.push("close");
      await onClose?.();
    },
  };
  return { signals, channel };
};

/** The extension a test environment unpacks, and its listener on any free port, never 47615 (#547). */
const browser = { extensionSource: TEST_EXTENSION, ports: TEST_EXTENSION_PORTS };

/** Starts an environment on loopback port 0 as an ordinary user, closed after the test. */
const start = async (options: EnvironmentOptions = {}): Promise<EnvironmentHandle> => {
  const handle = await startEnvironment({
    dataDir: options.dataDir ?? join(tempDir(), "data"),
    port: 0,
    user: notPrivileged,
    launcher: recordingLauncher().channel,
    interfaces,
    browser,
    ...options,
  });
  onCleanup(() => handle.close());
  return handle;
};

/** Hooks that hold startup before `step` until released, reporting the address bound so far. */
const holdBefore = (step: StartupStep) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reach!: (address: Address | undefined) => void;
  const reached = new Promise<Address | undefined>((resolve) => (reach = resolve));
  return {
    hooks: {
      beforeStep: async (current: StartupStep, progress: { readonly address: Address | undefined }) => {
        if (current !== step) return;
        reach(progress.address);
        await gate;
      },
    },
    reached,
    release,
  };
};

const url = (address: Address, path: string) => `http://${address.host}:${address.port}${path}`;

const getJson = async (address: Address, path: string) => {
  const response = await fetch(url(address, path));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

/** A GET with a Host header of our choosing, which fetch does not allow. */
const getWithHost = (address: Address, path: string, host: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: address.host, port: address.port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });

/** Raw bytes to the listener and the status line back: for a request fetch cannot make. */
const rawStatusLine = (address: Address, text: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(address.port, address.host, () => socket.write(text));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("end", () => resolve(data.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });

/** Raw bytes to the listener and the first status line back, the connection then let go: for an upgrade, which stays open. */
const firstStatusLine = (address: Address, text: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(address.port, address.host, () => socket.write(text));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (!data.includes("\r\n")) return;
      socket.destroy();
      resolve(data.split("\r\n")[0] ?? "");
    });
    socket.on("error", reject);
  });

const refusesConnections = (address: Address) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(address.port, address.host);
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });

/** Every path under `root`, directories included, relative to it. */
const tree = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();

describe("discovery and health", () => {
  it("answer who the environment is, and that it is ready once started", async () => {
    const env = await start({ name: "desk", platform: "win32", containerDetector: { inContainer: () => false } });
    const discovery = await getJson(env.address, DISCOVERY_PATH);
    expect(discovery.status).toBe(200);
    expect(DiscoveryDocument.parse(discovery.body)).toEqual({
      environmentId: env.id,
      environmentName: "desk",
      // Its icon and colour (#323), which until set are the platform's and a hash of its id's.
      environmentIcon: "desktop",
      environmentColour: presetColour(env.id),
      harnessVersion: packageVersion,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: ["forge", "keyManagers", "managedTools", "fileUndo", "workspaceChecks", "banks", "setup", "stateImport"],
      authPolicy: "local-only",
      readiness: "ready",
    });
    const health = await getJson(env.address, HEALTH_PATH);
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: "ready", version: packageVersion });
    expect(HealthDocument.parse(health.body)).toEqual(health.body);
    expect(env.readiness()).toBe("ready");
  });

  it("answer starting while the startup gate is held, and ready after it", async () => {
    const hold = holdBefore("prepared");
    const starting = start({ hooks: hold.hooks });
    const address = await hold.reached;
    if (!address) throw new Error("the listener was not bound before the prepared step");

    expect((await getJson(address, DISCOVERY_PATH)).body).toMatchObject({ readiness: "starting" });
    expect((await getJson(address, HEALTH_PATH)).body).toEqual({ status: "starting", version: packageVersion });

    hold.release();
    const env = await starting;
    expect((await getJson(address, DISCOVERY_PATH)).body).toMatchObject({ environmentId: env.id, readiness: "ready" });
    expect((await getJson(address, HEALTH_PATH)).body).toEqual({ status: "ready", version: packageVersion });
  });

  it("answer starting until the extension's folder is made, so a reader after ready finds its manifest (#1804)", async () => {
    const dataDir = join(tempDir(), "data");
    const manifest = join(dataDir, "extension", "current", "manifest.json");
    const files = fileVault(join(dataDir, "vault.json"));
    // Past the gate, the extension's start reads the vault's keys first: held there, the folder is not made yet.
    let gated = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    let address: Address | undefined;
    const starting = start({
      dataDir,
      launcher: recordingLauncher(() => { gated = true; }).channel,
      hooks: { beforeStep: (_step, progress) => { address = progress.address; } },
      vault: {
        ...files,
        keys: async () => {
          if (gated) {
            gated = false;
            reach();
            await gate;
          }
          return files.keys();
        },
      },
    });
    await reached;
    if (!address) throw new Error("the listener was not bound before the gate");

    expect(existsSync(manifest)).toBe(false);
    expect((await getJson(address, DISCOVERY_PATH)).body).toMatchObject({ readiness: "starting" });
    expect((await getJson(address, HEALTH_PATH)).body).toEqual({ status: "starting", version: packageVersion });

    release();
    await starting;
    expect((await getJson(address, DISCOVERY_PATH)).body).toMatchObject({ readiness: "ready" });
    expect(existsSync(manifest)).toBe(true);
  });

  it("answer nothing else: an unknown path is not found and another method is not allowed", async () => {
    const env = await start();
    expect((await fetch(url(env.address, "/api/nothing"))).status).toBe(404);
    const post = await fetch(url(env.address, DISCOVERY_PATH), { method: "POST", body: "{}" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("are never cached, since readiness changes", async () => {
    const env = await start();
    for (const path of [DISCOVERY_PATH, HEALTH_PATH]) {
      const response = await fetch(url(env.address, path));
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    }
  });
});

describe("a request target the URL parser refuses", () => {
  it("is answered 400 rather than crashing the environment", async () => {
    const env = await start();
    for (const target of ["//", "///", "http://"]) {
      const answer = await getWithHost(env.address, target, "localhost");
      expect(answer.status, target).toBe(400);
    }
    const health = await fetch(`http://${env.address.host}:${env.address.port}/health`);
    expect(health.status).toBe(200);
  });
});

describe("binding and the Host check", () => {
  it("binds loopback", async () => {
    const env = await start();
    expect(env.address.host).toBe("127.0.0.1");
    expect(env.address.port).toBeGreaterThan(0);
  });

  it("accepts a Host naming loopback, with or without the port", async () => {
    const env = await start();
    const { port } = env.address;
    for (const host of ["localhost", `localhost:${port}`, "127.0.0.1", `127.0.0.1:${port}`, "[::1]", `[::1]:${port}`, "::1", "LocalHost"]) {
      expect((await getWithHost(env.address, HEALTH_PATH, host)).status, host).toBe(200);
    }
  });

  it("upgrades a WebSocket from the desktop's app scheme: the Host is checked, the Origin is not (#395)", async () => {
    const env = await start();
    const upgrade = (host: string) =>
      [
        `GET ${WIRE_PATH} HTTP/1.1`,
        `Host: ${host}`,
        "Origin: agent-harness://app",
        "Upgrade: websocket",
        "Connection: Upgrade",
        // Any sixteen bytes, base64: RFC 6455 asks no more of the key.
        `Sec-WebSocket-Key: ${Buffer.from("sixteen bytes!!!").toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n");
    expect(await firstStatusLine(env.address, upgrade(`127.0.0.1:${env.address.port}`))).toBe("HTTP/1.1 101 Switching Protocols");
    expect(await firstStatusLine(env.address, upgrade("evil.example"))).toMatch(/^HTTP\/1\.1 421 /);
  });

  it("refuses the environment's own tailnet name while the tailnet is not bound (binding.test.ts has it bound)", async () => {
    const env = await start({ tailnetName: "desk.tail1234.ts.net" });
    for (const host of ["desk.tail1234.ts.net", `desk.tail1234.ts.net:${env.address.port}`]) {
      expect((await getWithHost(env.address, DISCOVERY_PATH, host)).status, host).toBe(421);
    }
  });

  it("refuses any other Host with 421 and a one-line JSON body, on every route", async () => {
    const env = await start({ tailnetName: "desk.tail1234.ts.net" });
    const { port } = env.address;
    const foreign = [
      "evil.example",
      `evil.example:${port}`,
      "localhost.evil.example",
      "127.0.0.1.nip.io",
      "other.tail1234.ts.net",
      "desk.tail1234.ts.net.evil.example",
      "localhost:notaport",
      "[::1]x",
      "[::2]",
    ];
    for (const path of [DISCOVERY_PATH, HEALTH_PATH, "/api/nothing"]) {
      for (const host of foreign) {
        const response = await getWithHost(env.address, path, host);
        expect(response.status, `${host} ${path}`).toBe(421);
        expect(response.body.trim().split("\n")).toHaveLength(1);
        expect(JSON.parse(response.body)).toMatchObject({ error: "misdirected" });
      }
    }
  });

  it("refuses a tailnet name when none is configured", async () => {
    const env = await start();
    expect((await getWithHost(env.address, HEALTH_PATH, "desk.tail1234.ts.net")).status).toBe(421);
  });

  it("refuses a request that names no host at all, or an empty one", async () => {
    const env = await start();
    expect(await rawStatusLine(env.address, "GET /health HTTP/1.0\r\n\r\n")).toMatch(/^HTTP\/1\.[01] 421 /);
    expect(await rawStatusLine(env.address, "GET /health HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n")).toMatch(
      /^HTTP\/1\.1 421 /,
    );
  });
});

describe("the environment record and the signing key", () => {
  it("explains how to recover when the keychain cannot be read at the identity step", async () => {
    class Entry {
      getSecret = async (): Promise<never> => { throw new Error("The keychain is locked."); };
      setSecret = async () => undefined;
      deleteCredential = async () => false;
    }
    const binding = await loadKeychainBinding(async () => ({ AsyncEntry: Entry }));
    await expect(start({
      vault: {
        get: (key) => binding.get("service-for-tests", key),
        set: (key, value) => binding.set("service-for-tests", key, value),
        delete: (key) => binding.delete("service-for-tests", key),
        keys: async () => [SIGNING_KEY],
      },
    })).rejects.toMatchObject({
      step: "identity",
      message: `Startup failed at the identity step: Could not read keychain entry "${SIGNING_KEY}" under service "service-for-tests". Unlock your OS keychain and allow agent-harness to access this entry, then restart the environment. If it still fails, repair the entry in Keychain Access (macOS) or Credential Manager (Windows) without deleting the signing key.`,
    });
  });

  it("are written on first start and kept by a restart on the same directory", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start({ dataDir, name: "first" });
    const record = JSON.parse(readFileSync(join(dataDir, "environment.json"), "utf8")) as Record<string, unknown>;
    expect(record).toEqual({ id: first.id, createdAt: expect.any(String), name: "first" });
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const key = await fileVault(join(dataDir, "vault.json")).get(SIGNING_KEY);
    expect(Buffer.from(key ?? "", "base64")).toHaveLength(32);
    await first.close();

    const second = await start({ dataDir, name: "a new name is for a new environment" });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("first");
    expect(JSON.parse(readFileSync(join(dataDir, "environment.json"), "utf8"))).toEqual(record);
    expect(await fileVault(join(dataDir, "vault.json")).get(SIGNING_KEY)).toBe(key);
    expect((await getJson(second.address, DISCOVERY_PATH)).body).toMatchObject({ environmentId: first.id });
  });

  it("names a new environment for the machine's hostname's first label unless told otherwise", async () => {
    expect((await start({ hostname: "desk.tail1234.ts.net" })).name).toBe("desk");
    expect(hostname().startsWith((await start()).name)).toBe(true);
  });

  it("refuses an empty name before writing a record", async () => {
    const dataDir = join(tempDir(), "data");
    await expect(start({ dataDir, name: "  " })).rejects.toMatchObject({ step: "identity" });
    expect(existsSync(join(dataDir, "environment.json"))).toBe(false);
  });

  it("gives a second data directory a second environment", async () => {
    const one = await start();
    const two = await start();
    expect(two.id).not.toBe(one.id);
  });

  it.runIf(posix)("keeps the data directory and the vault readable by their owner alone", async () => {
    const env = await start();
    expect(statSync(env.dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(env.dataDir, "vault.json")).mode & 0o777).toBe(0o600);
  });

  it("logs one line saying which vault it holds and why", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    const env = await start();
    // No launcher started it: the file on every platform, for want of the service on macOS and Windows.
    expect(logged.filter((line) => line.startsWith("The vault is"))).toEqual([
      expect.stringContaining(`The vault is the file ${join(env.dataDir, "vault.json")}: the OS keychain is the vault `),
    ]);
  });

  it("uses the vault it is given instead of the file", async () => {
    const stored = new Map<string, string>();
    const env = await start({
      vault: {
        get: async (key) => stored.get(key),
        set: async (key, value) => void stored.set(key, value),
        delete: async (key) => void stored.delete(key),
        keys: async () => [...stored.keys()],
      },
    });
    expect(Buffer.from(stored.get(SIGNING_KEY) ?? "", "base64")).toHaveLength(32);
    expect(existsSync(join(env.dataDir, "vault.json"))).toBe(false);
  });

  it.runIf(process.platform === "linux")("writes nothing outside the data directory", async () => {
    const home = tempDir();
    const temp = tempDir();
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_STATE_HOME", undefined);
    vi.stubEnv("TMPDIR", temp);
    const before = tree(home);

    const env = await startEnvironment({ port: 0, user: notPrivileged, launcher: recordingLauncher().channel, interfaces, browser });
    onCleanup(() => env.close());
    await getJson(env.address, DISCOVERY_PATH);
    await env.close();

    expect(env.dataDir).toBe(join(home, ".local", "state", "agent-harness"));
    const inData = relative(home, env.dataDir);
    const added = tree(home).filter((path) => !before.includes(path));
    const outside = added.filter((path) => path !== inData && !path.startsWith(inData + sep) && !inData.startsWith(path + sep));
    expect(outside).toEqual([]);
    expect(added).toContain(join(inData, "environment.json"));
    expect(tree(temp)).toEqual([]);
  });
});

describe("the startup gate", () => {
  it.each([false, true])("refuses a marked restore before touching the database, with launcher present: %s", async (present) => {
    const dataDir = join(tempDir(), "data");
    const seeded = await start({ dataDir });
    await seeded.close();
    const updateId = "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20";
    const marker = JSON.stringify({ updateId, fromVersion: "0.4.0", toVersion: "0.5.0", stage: "trial", reason: "interrupted" });
    writeFileSync(join(dataDir, "restore-marker.json"), marker);
    // A cut-short copy may leave sidecars that SQLite must never replay or remove.
    writeFileSync(join(dataDir, "environment.db-wal"), "a WAL partly copied back");
    writeFileSync(join(dataDir, "environment.db-shm"), "a shm partly copied back");
    const files = ["environment.db", "environment.db-wal", "environment.db-shm", "restore-marker.json"];
    const before = files.map((file) => readFileSync(join(dataDir, file)));
    const launcher = recordingLauncher();
    const failure = start({
      dataDir,
      launcher: { ...launcher.channel, present: () => present },
      containerDetector: { inContainer: () => true, declared: () => true },
    });

    await expect(failure).rejects.toBeInstanceOf(StartupError);
    await expect(failure).rejects.toMatchObject({
      step: "database",
      message: expect.stringContaining(`The restore of update ${updateId} is unfinished; run agent-harness update restore to finish it before starting the environment.`),
    });
    expect(files.map((file) => readFileSync(join(dataDir, file)))).toEqual(before);
    expect(launcher.signals).toEqual(["close"]);
  });

  it.each(["{", "", JSON.stringify({ updateId: "not-an-update" })])("refuses an unreadable restore marker without creating a database: %j", async (marker) => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "restore-marker.json"), marker);

    await expect(start({ dataDir })).rejects.toMatchObject({
      step: "database",
      message: expect.stringContaining("agent-harness update restore"),
    });
    expect(existsSync(join(dataDir, "environment.db"))).toBe(false);
    expect(readFileSync(join(dataDir, "restore-marker.json"), "utf8")).toBe(marker);
  });

  it("signals prepared once, after the listener is bound, while readiness is still starting", async () => {
    let address: Address | undefined;
    const seenAtSignal: unknown[] = [];
    const launcher = recordingLauncher(async () => {
      if (!address) throw new Error("prepared was signalled before the listener was bound");
      seenAtSignal.push((await getJson(address, DISCOVERY_PATH)).body["readiness"]);
    });
    const steps: StartupStep[] = [];
    const env = await start({
      launcher: launcher.channel,
      hooks: {
        beforeStep: (step, progress) => {
          steps.push(step);
          address = progress.address;
        },
      },
    });
    expect(steps).toEqual(["data-directory", "database", "projectors", "identity", "adapter-host", "listen", "prepared"]);
    expect(launcher.signals).toEqual(["prepared"]);
    expect(seenAtSignal).toEqual(["starting"]);
    expect(env.readiness()).toBe("ready");
  });

  it("leaves no prepared signal and nothing listening when a step before the bind fails", async () => {
    const launcher = recordingLauncher();
    const failure = startEnvironment({
      dataDir: join(tempDir(), "data"),
      port: 0,
      interfaces,
      user: notPrivileged,
      launcher: launcher.channel,
      hooks: {
        beforeStep: (step) => {
          if (step === "adapter-host") throw new Error("the adapter host would not start");
        },
      },
    });
    await expect(failure).rejects.toBeInstanceOf(StartupError);
    await expect(failure).rejects.toMatchObject({ step: "adapter-host", message: expect.stringContaining("adapter-host") });
    expect(launcher.signals).toEqual(["close"]);
  });

  it("leaves no prepared signal when the listener cannot bind, and the data directory usable", async () => {
    const taken = await start();
    const dataDir = join(tempDir(), "data");
    const launcher = recordingLauncher();
    const failure = startEnvironment({ dataDir, port: taken.address.port, user: notPrivileged, launcher: launcher.channel, interfaces });
    await expect(failure).rejects.toMatchObject({ step: "listen" });
    expect(launcher.signals).toEqual(["close"]);

    const retry = await start({ dataDir });
    expect(retry.readiness()).toBe("ready");
  });

  it("closes the listener it bound when signalling prepared fails", async () => {
    let address: Address | undefined;
    const failure = startEnvironment({
      dataDir: join(tempDir(), "data"),
      port: 0,
      interfaces,
      user: notPrivileged,
      launcher: {
        present: () => true,
        prepared: () => {
          throw new Error("the launcher has gone");
        },
        onQuery: () => undefined,
        request: () => Promise.resolve(NO_LAUNCHER),
        close: () => undefined,
      },
      hooks: { beforeStep: (_step, progress) => void (address = progress.address) },
    });
    await expect(failure).rejects.toMatchObject({ step: "prepared" });
    if (!address) throw new Error("the listener was never bound");
    expect(await refusesConnections(address)).toBe(true);
  });

  it("refuses to replace an environment record it cannot read", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start({ dataDir });
    await first.close();
    const good = JSON.parse(readFileSync(join(dataDir, "environment.json"), "utf8")) as Record<string, unknown>;
    for (const corrupt of [
      '{"id": "not a record"',
      JSON.stringify({ ...good, id: "not-a-uuid" }),
      JSON.stringify({ ...good, name: "" }),
      JSON.stringify([good]),
    ]) {
      writeFileSync(join(dataDir, "environment.json"), corrupt);
      const launcher = recordingLauncher();
      await expect(start({ dataDir, launcher: launcher.channel }), corrupt).rejects.toMatchObject({ step: "identity" });
      expect(readFileSync(join(dataDir, "environment.json"), "utf8")).toBe(corrupt);
      expect(launcher.signals).toEqual(["close"]);
    }
  });
});

describe("never root", () => {
  it("refuses a privileged user before creating or opening anything, whatever the environment variables say", async () => {
    vi.stubEnv("IS_SANDBOX", "1");
    vi.stubEnv("CLAUDE_CODE_BUBBLEWRAP", "1");
    vi.stubEnv("container", "podman");
    const dataDir = join(tempDir(), "data");
    const launcher = recordingLauncher();
    const steps: StartupStep[] = [];
    const refusal = startEnvironment({
      dataDir,
      port: 0,
      user: privileged,
      launcher: launcher.channel,
      hooks: { beforeStep: (step) => void steps.push(step) },
    });
    await expect(refusal).rejects.toBeInstanceOf(RootRefusedError);
    await expect(refusal).rejects.toThrow(ROOT_REFUSAL);
    expect(existsSync(dataDir)).toBe(false);
    expect(steps).toEqual([]);
    expect(launcher.signals).toEqual([]);
  });

  it("refuses, saying so, when the check cannot tell", async () => {
    const dataDir = join(tempDir(), "data");
    const refusal = startEnvironment({
      dataDir,
      port: 0,
      user: {
        isPrivileged: () => {
          throw new Error("whoami.exe could not run: spawn ENOENT");
        },
      },
      launcher: recordingLauncher().channel,
    });
    await expect(refusal).rejects.toBeInstanceOf(RootRefusedError);
    await expect(refusal).rejects.toThrow(ROOT_REFUSAL.slice(0, -1));
    await expect(refusal).rejects.toThrow(/could not run: spawn ENOENT/);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("asks the check it is given, not one of its own", async () => {
    const isPrivileged = vi.fn(() => false);
    await start({ user: { isPrivileged } });
    expect(isPrivileged).toHaveBeenCalledOnce();
  });
});

describe("environment.status", () => {
  it("is registered with its status result: readiness, activity, who manages updates, and what it binds", async () => {
    const env = await start({ containerDetector: { inContainer: () => false } });
    const served = env.methods.get("environment.status");
    if (served?.kind !== "query" || !served.handler) throw new Error("environment.status has no handler");
    const { handler } = served;
    const clientSession = { id: "cs-1", kind: "tui", scopes: ["read"], ceiling: TOP_CEILING, local: true, expiresAt: 0 } as const;
    const result = await handler({}, { clientSession });
    // Busy for the idle window after its start (#445).
    expect(result).toEqual({
      readiness: "ready",
      activity: { state: "busy", reason: "recent-activity", busyUntil: expect.any(String) as unknown as string },
      updatesManagedOutside: false,
      binding: { tailnet: null, tailnetFound: null, lan: null, lanAddresses: [] },
    });
    expect(registry["environment.status"].result.parse(result)).toEqual(result);
    expect(registry["environment.status"].scope).toBe("read");
  });
});

describe("closing", () => {
  it("closes the event log even when the listener fails to close, and a second close retries the listener", async () => {
    const env = await start();
    const wal = join(env.dataDir, "environment.db-wal");
    expect(existsSync(wal)).toBe(true);
    // The wire's listener fails its first close; the extension's (#547) closes as it would.
    const close = Server.prototype.close;
    let refused = 0;
    const failing = vi.spyOn(Server.prototype, "close").mockImplementation(function (this: Server, callback?: (error?: Error) => void) {
      const bound = this.address();
      if (refused === 0 && typeof bound === "object" && bound?.port === env.address.port) {
        refused++;
        callback?.(new Error("the listener would not close"));
        return this;
      }
      return close.call(this, callback);
    });
    onCleanup(() => failing.mockRestore());

    await expect(env.close()).rejects.toThrow("the listener would not close");
    expect(refused).toBe(1);
    // SQLite removes the write-ahead log when its last connection closes.
    expect(existsSync(wal)).toBe(false);
    expect(await refusesConnections(env.address)).toBe(false);

    await env.close();
    expect(await refusesConnections(env.address)).toBe(true);
  });

  it("lets the launcher channel go last, after the listener and the event log are closed", async () => {
    const running: { env?: EnvironmentHandle } = {};
    const seenAtClose: { refusing: boolean; walPresent: boolean }[] = [];
    const launcher = recordingLauncher(undefined, async () => {
      if (!running.env) throw new Error("closed before the environment started");
      seenAtClose.push({
        refusing: await refusesConnections(running.env.address),
        walPresent: existsSync(join(running.env.dataDir, "environment.db-wal")),
      });
    });
    const env = await start({ launcher: launcher.channel });
    running.env = env;
    expect(launcher.signals).toEqual(["prepared"]);

    await env.close();
    expect(launcher.signals).toEqual(["prepared", "close"]);
    expect(seenAtClose).toEqual([{ refusing: true, walPresent: false }]);
    await env.close();
    expect(launcher.signals).toEqual(["prepared", "close"]);
  });

  it("stops listening, and may be called twice", async () => {
    const env = await start();
    await env.close();
    await env.close();
    expect(await refusesConnections(env.address)).toBe(true);
  });
});
