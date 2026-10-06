import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, Script } from "node:vm";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanUp, scratch } from "../../test/harness.js";

/**
 * The preload as the window's sandbox runs it: the bundle Vite builds,
 * evaluated as a plain script in a context of its own with the sandbox's
 * wrapper arguments and a `require` that knows `electron` alone, so the
 * bundle is proved to need nothing more and to expose exactly the shell.
 */

const packageDir = join(import.meta.dirname, "..", "..");
let bundle: string;

beforeAll(async () => {
  const outDir = scratch();
  await build({ root: packageDir, configFile: join(packageDir, "vite.config.ts"), logLevel: "silent", build: { outDir, emptyOutDir: true } });
  bundle = readFileSync(join(outDir, "preload.cjs"), "utf8");
});
afterAll(cleanUp);

interface Preloaded {
  readonly required: string[];
  readonly exposed: (readonly [string, unknown])[];
  readonly asked: (readonly [string, ...unknown[]])[];
  readonly told: (readonly [string, ...unknown[]])[];
  /** Sends the page a message from the main process, as `webContents.send` does. */
  deliver(channel: string, ...args: unknown[]): void;
}

/** Runs the bundle as a sandboxed preload, `ipcRenderer.invoke` answered by `answers`. */
const preload = (answers: Readonly<Record<string, unknown>> = {}, devices: readonly { kind: string }[] = []): Preloaded => {
  const required: string[] = [];
  const exposed: (readonly [string, unknown])[] = [];
  const asked: (readonly [string, ...unknown[]])[] = [];
  const told: (readonly [string, ...unknown[]])[] = [];
  const heard = new Map<string, ((details: unknown, ...args: unknown[]) => void)[]>();
  const electron = {
    contextBridge: { exposeInMainWorld: (key: string, api: unknown) => void exposed.push([key, api]) },
    ipcRenderer: {
      invoke: async (channel: string, ...args: unknown[]) => {
        asked.push([channel, ...args]);
        return answers[channel];
      },
      send: (channel: string, ...args: unknown[]) => void told.push([channel, ...args]),
      on: (channel: string, listener: (details: unknown, ...args: unknown[]) => void) => void heard.set(channel, [...(heard.get(channel) ?? []), listener]),
    },
  };
  const sandboxRequire = (name: string): unknown => {
    required.push(name);
    if (name === "electron") return electron;
    throw new Error(`A sandboxed preload cannot require ${name}.`);
  };
  const wrapped = new Script(`(function (require, process, Buffer, global, setImmediate, clearImmediate, exports, module) {\n${bundle}\n})`);
  const run = wrapped.runInContext(createContext({ navigator: { mediaDevices: { enumerateDevices: async () => devices } } })) as (...args: unknown[]) => void;
  const module = { exports: {} };
  run(sandboxRequire, {}, undefined, {}, undefined, undefined, module.exports, module);
  return {
    required,
    exposed,
    asked,
    told,
    deliver: (channel, ...args) => heard.get(channel)?.forEach((listener) => listener({ sender: "the page's ipcRenderer" }, ...args)),
  };
};

type Exposed = Record<string, Record<string, (...args: unknown[]) => unknown> & ((...args: unknown[]) => unknown)>;

const shellOf = (loaded: Preloaded): Exposed => {
  expect(loaded.exposed).toHaveLength(1);
  const [[key, api] = []] = loaded.exposed;
  expect(key).toBe("desktopShell");
  return api as Exposed;
};

describe("the preload bundle", () => {
  it("resolves a camera member only when the window has a video input, without opening it", async () => {
    const present = shellOf(preload({}, [{ kind: "videoinput" }]));
    const absent = shellOf(preload({}, [{ kind: "audioinput" }]));
    const ready = async (shell: Exposed) => await shell["ready"]?.() as Exposed;
    expect(await ready(present)).toHaveProperty("camera.scanQr", expect.any(Function));
    expect(await ready(absent)).not.toHaveProperty("camera");
  });
  it("is one script that requires electron and nothing else, as the sandbox allows", () => {
    const loaded = preload();
    expect([...new Set(loaded.required)]).toEqual(["electron"]);
  });

  it("carries browser Stop and loading state through the sandboxed bundle", async () => {
    const state = { url: "https://example.org/", canGoBack: false, canGoForward: false, loading: true };
    const loaded = preload({ "shell:webView.state": state });
    const views = shellOf(loaded)["webView"]!;
    views["stop"]!("view-1");
    expect(loaded.told).toContainEqual(["shell:webView.stop", "view-1"]);
    expect(await views["state"]!("view-1")).toEqual(state);
    const heard: unknown[] = [];
    const unsubscribe = views["onChange"]!((id: string, changed: unknown) => heard.push([id, changed])) as () => void;
    loaded.deliver("shell:webView.changed", "view-1", state);
    unsubscribe();
    loaded.deliver("shell:webView.changed", "view-1", { ...state, loading: false });
    expect(heard).toEqual([["view-1", state]]);
  });

  it("exposes the shell's members as window.desktopShell, and nothing else", () => {
    const shell = shellOf(preload());
    expect(Object.keys(shell).sort()).toEqual([
      "clipboard",
      "credentialAccess",
      "deepLinks",
      "dialogs",
      "gh",
      "http",
      "installer",
      "localGrant",
      "network",
      "notifications",
      "openExternal",
      "preview",
      "ready",
      "secrets",
      "service",
      "system",
      "update",
      "webView",
      "window",
    ]);
    expect(Object.keys(shell["window"] ?? {}).sort()).toEqual(["close", "focus", "minimize", "onChange", "setBackgroundColour", "setBadge", "setTitle", "state", "toggleMaximize", "zoom"]);
    expect(Object.keys(shell["dialogs"] ?? {}).sort()).toEqual(["openDirectory", "openFile", "openFileContents", "save"]);
    expect(Object.keys(shell["clipboard"] ?? {}).sort()).toEqual(["readImage", "readText", "writeText"]);
    expect(Object.keys(shell["network"] ?? {})).toEqual(["allow"]);
    expect(Object.keys(shell["deepLinks"] ?? {})).toEqual(["onOpen"]);
    expect(Object.keys(shell["notifications"] ?? {}).sort()).toEqual(["onActivate", "show"]);
    expect(Object.keys(shell["secrets"] ?? {}).sort()).toEqual(["access", "delete", "get", "onAccess", "protection", "set"]);
    expect(Object.keys(shell["localGrant"] ?? {})).toEqual(["read"]);
    expect(Object.keys(shell["credentialAccess"] ?? {})).toEqual(["read"]);
    expect(Object.keys(shell["service"] ?? {}).sort()).toEqual(["applyUpdateNow", "install", "pendingUpdate", "start", "status"]);
    expect(Object.keys(shell["preview"] ?? {})).toEqual(["grant"]);
    expect(Object.keys(shell["update"] ?? {}).sort()).toEqual(["apply", "current"]);
    expect(Object.keys(shell["installer"] ?? {})).toEqual(["bundledServer", "reserveSpace"]);
    expect(Object.keys(shell["gh"] ?? {})).toEqual(["token"]);
    expect(shell).not.toHaveProperty("tray");
  });

  it("reaches each member's own channel, awaiting what answers and telling what does not", async () => {
    const loaded = preload({ "shell:dialogs.openFile": ["/home/milo/notes.md"], "shell:http": { status: 200, body: '{"protocol":1}' } });
    const shell = shellOf(loaded);

    expect(await shell["dialogs"]?.["openFile"]?.({ title: "Attach" })).toEqual(["/home/milo/notes.md"]);
    const response = (await shell["http"]?.("http://127.0.0.1:4777/.well-known/agent-harness/environment", { method: "GET" })) as {
      readonly status: number;
      json(): Promise<unknown>;
    };
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ protocol: 1 });
    shell["window"]?.["setTitle"]?.("desk");

    expect(loaded.asked).toEqual([
      ["shell:dialogs.openFile", { title: "Attach" }],
      ["shell:http", "http://127.0.0.1:4777/.well-known/agent-harness/environment", { method: "GET" }],
    ]);
    expect(loaded.told).toEqual([["shell:window.setTitle", "desk"]]);
  });

  it("hands a deep link to the page's listener as its string alone, the links held for it first", async () => {
    const loaded = preload({ "shell:deepLinks.listen": ["agent-harness://pair?code=K7Q2MXH4RT"] });
    const shell = shellOf(loaded);
    const heard: unknown[][] = [];
    shell["deepLinks"]?.["onOpen"]?.((...args: unknown[]) => heard.push(args));
    await new Promise((resolve) => setTimeout(resolve, 0));
    loaded.deliver("shell:deepLinks.opened", "agent-harness://open/desk/1");

    expect(heard).toEqual([["agent-harness://pair?code=K7Q2MXH4RT"], ["agent-harness://open/desk/1"]]);
  });
});
