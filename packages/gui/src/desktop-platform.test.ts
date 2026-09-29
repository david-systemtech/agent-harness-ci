import { createRuntime, type SocketHandlers, type WebSocketFactory } from "@agent-harness/client-runtime";
import { fakeShell, inMemoryDocuments, inMemoryNetwork, manualClock, seededRandom, type FakeShell } from "@agent-harness/client-runtime/testing";
import { scriptedWorld, type ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopPlatform, desktopShellOf, windowDesktopPlatform, type DesktopPlatform } from "./platform/desktop-platform.js";

/**
 * The desktop platform (docs/specs/gui.md, "Packages and the platform";
 * docs/specs/client-runtime.md, "Package and platform"): the runtime on the
 * desktop's shell, here the recording fake shell answering for the scripted
 * world, with the documents, clock, network signal and sockets a test holds.
 */

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

/** The shell answering for `world`: its HTTP, and its local environment's grant. */
const shellFor = (world: ScriptedWorld): FakeShell => {
  const shell = fakeShell();
  shell.answer("http", world.fetch);
  shell.answer("localGrant.read", async () => world.grant?.read());
  shell.answer("system", async () => ({ platform: "darwin", architecture: "arm64", hostname: "studio", user: "seth" }));
  return shell;
};

/** Every socket opened, by URL, in order, beside every address list the lockdown was told. */
const recording = (open: WebSocketFactory, shell: FakeShell) => {
  const seen: string[] = [];
  shell.answer("network.allow", async (addresses) => void seen.push(`allow ${[...addresses].join(" ")}`));
  const webSocket: WebSocketFactory = (url: string, handlers: SocketHandlers) => {
    seen.push(`open ${url}`);
    return open(url, handlers);
  };
  return { seen, webSocket };
};

const onDesktop = async (world: ScriptedWorld, clock = manualClock()) => {
  const shell = shellFor(world);
  const sockets = recording(world.webSocket, shell);
  const reported: unknown[] = [];
  const platform = await desktopPlatform({
    shell,
    version: "0.5.0",
    documents: inMemoryDocuments(),
    clock,
    network: inMemoryNetwork(),
    webSocket: sockets.webSocket,
    random: seededRandom(),
    reportError: (error) => reported.push(error),
  });
  const runtime = createRuntime(platform);
  const stop = platform.follow(runtime.connections.list);
  closing.push(async () => {
    stop();
    await runtime.close();
  });
  return { shell, platform, runtime, seen: sockets.seen, reported };
};

describe("the desktop platform", () => {
  it("is a desktop client, named <user>@<hostname> from the shell's system, of the bundle's version", async () => {
    const world = scriptedWorld(manualClock(), { environments: [] });
    const { platform } = await onDesktop(world);
    expect(platform.client).toEqual({ kind: "desktop", label: "seth@studio", version: "0.5.0" });
  });

  it("reads the local grant through the shell's localGrant and reaches the environment's HTTP through its http", async () => {
    const world = scriptedWorld(manualClock(), { environments: [{ name: "desk", reach: "local" }] });
    const { shell, runtime } = await onDesktop(world);
    await runtime.start();

    expect(runtime.connections.list.read()).toMatchObject([{ kind: "local", phase: "ready" }]);
    const origin = world.environment("desk").wire.origin;
    expect(shell.calls.map(([member, url]) => (member === "http" ? `http ${String(url).slice(origin.length)}` : member))).toEqual(
      expect.arrayContaining(["localGrant.read", "http /.well-known/agent-harness/environment", "http /api/bootstrap"]),
    );
    const bootstrap = shell.calls.find(([member, url]) => member === "http" && String(url).endsWith("/api/bootstrap"));
    expect(JSON.parse(String((bootstrap?.[2] as { readonly body?: string } | undefined)?.body))).toMatchObject({ kind: "desktop", label: "seth@studio" });
    expect(world.environment("desk").server.received()).toContainEqual(expect.objectContaining({ type: "auth", clientKind: "desktop", harnessVersion: "0.5.0" }));
  });

  it("keeps a paired environment's token through the shell's secrets, and never in its documents", async () => {
    const world = scriptedWorld(manualClock(), { environments: [{ name: "laptop", reach: "unpaired" }] });
    const { shell, platform, runtime } = await onDesktop(world);
    await runtime.start();
    const laptop = world.environment("laptop");
    expect(await runtime.connections.add({ link: laptop.wire.link })).toMatchObject({ status: "paired" });

    const token = await shell.secrets.get(laptop.environmentId);
    expect(token).toEqual(expect.any(String));
    expect(shell.calls).toContainEqual(["secrets.set", laptop.environmentId, token]);
    expect(JSON.stringify((platform.documents as ReturnType<typeof inMemoryDocuments>).entries())).not.toContain(token);
  });

  it("declares a pairing's address to the lockdown before its socket opens, each connection's address after, and a forgotten one's no more", async () => {
    const world = scriptedWorld(manualClock(), { environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "unpaired" }] });
    const { runtime, seen } = await onDesktop(world);
    await runtime.start();
    const desk = world.environment("desk").wire.origin;
    const laptop = world.environment("laptop");
    const wire = (origin: string) => `open ${origin.replace(/^http/, "ws")}/ws`;

    await runtime.connections.add({ link: laptop.wire.link });
    const pairing = seen.indexOf(wire(laptop.wire.origin));
    expect(pairing).toBeGreaterThan(0);
    expect(seen.slice(0, pairing).some((entry) => entry.startsWith("allow ") && entry.includes(laptop.wire.origin))).toBe(true);
    const allowed = () => seen.filter((entry) => entry.startsWith("allow ")).at(-1);
    expect(allowed()).toBe(`allow ${[desk, laptop.wire.origin].sort().join(" ")}`);

    await runtime.connections.remove(laptop.environmentId);
    expect(allowed()).toBe(`allow ${desk}`);
  });

  it("opens a socket to loopback at once, and one closed before its address was declared never opens, and says it closed", async () => {
    const world = scriptedWorld(manualClock(), { environments: [] });
    const { shell, platform, seen } = await onDesktop(world);
    let declared!: () => void;
    shell.answer("network.allow", () => new Promise<void>((resolve) => (declared = resolve)));
    const closes: string[] = [];
    const handlers = (name: string): SocketHandlers => ({ onOpen: () => undefined, onMessage: () => undefined, onClose: (code) => void closes.push(`${name} closed ${code}`) });

    platform.webSocket("ws://127.0.0.1:7433/ws", handlers("loopback"));
    expect(seen).toContain("open ws://127.0.0.1:7433/ws");

    platform.webSocket("ws://laptop.tail1234.ts.net:7433/ws", handlers("laptop")).close(1000, "no longer wanted");
    await new Promise((resolve) => setTimeout(resolve, 0));
    declared();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).not.toContain("open ws://laptop.tail1234.ts.net:7433/ws");
    expect(closes.filter((close) => close.startsWith("laptop"))).toEqual(["laptop closed 1006"]);
  });
});

describe("the desktop platform in the window", () => {
  it("is the desktop's only when its preload exposed the shell the platform is built on", () => {
    expect(desktopShellOf(window)).toBeUndefined();
    const shell = fakeShell();
    Object.defineProperty(window, "desktopShell", { value: shell, configurable: true });
    try {
      expect(desktopShellOf(window)).toBe(shell);
    } finally {
      Reflect.deleteProperty(window, "desktopShell");
    }
  });

  it("keeps its documents in the window's IndexedDB, and reports a fault to the window's console, which the desktop's log hears", async () => {
    const indexedDB = new IDBFactory();
    Object.defineProperty(window, "indexedDB", { value: indexedDB, configurable: true });
    const errors = vi.spyOn(window.console, "error").mockImplementation(() => undefined);
    try {
      const first: DesktopPlatform = await windowDesktopPlatform(window, fakeShell(), "0.5.0");
      await first.documents.set("presentation", { format: 1, textSize: 16 });
      const again = await windowDesktopPlatform(window, fakeShell(), "0.5.0");
      expect(await again.documents.get("presentation")).toEqual({ format: 1, textSize: 16 });

      again.reportError(new Error("The presentation document could not be written."));
      expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^Error: The presentation document could not be written\.\n\s+at /));
    } finally {
      errors.mockRestore();
      Reflect.deleteProperty(window, "indexedDB");
    }
  });
});
