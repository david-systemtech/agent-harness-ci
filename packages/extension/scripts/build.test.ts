import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { EXTENSION_MANIFEST_KEY, PORT_FILE_NAME } from "@agent-harness/contracts";
import { parseAst } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptedEnvironment } from "../test/scripted-environment.js";
import { buildExtension } from "./build.js";

/**
 * The extension's build (#549), run once into a scratch folder: what Chrome
 * finds in the folder it loads unpacked, that every script in it loads from
 * the folder alone, and that the built worker runs, on a thread of its own
 * with the fake `chrome` as its global, as Chrome runs it.
 */

/** Vite bundling the worker and the page under a loaded runner: a cap for a hang, not a budget. */
const BUILD_MS = 120_000;

const scratch = mkdtempSync(join(tmpdir(), "agent-harness-extension-build-"));
const built = join(scratch, "extension");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeAll(() => buildExtension({ outDir: built, version: "1.2.3-rc.1" }), BUILD_MS);

const read = (file: string): string => readFileSync(join(built, file), "utf8");

/** Every module a script loads: its imports and re-exports, and its dynamic imports, read off its syntax tree. */
const specifiersOf = (code: string): string[] => {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    const { type, source } = node as { readonly type?: unknown; readonly source?: { readonly value?: unknown } | null };
    const loads = ["ImportDeclaration", "ExportAllDeclaration", "ExportNamedDeclaration", "ImportExpression"].includes(String(type));
    if (loads && typeof source?.value === "string") found.push(source.value);
    Object.values(node).forEach(walk);
  };
  walk(parseAst(code));
  return found;
};

describe("the extension's build", () => {
  it("is the folder Chrome loads: the manifest, the worker, and the options page with its script", () => {
    const files = readdirSync(built);
    expect(files).toEqual(expect.arrayContaining(["manifest.json", "worker.js", "options.html", "options.js"]));
    // Anything else is a module the two scripts share.
    expect(files.filter((file) => !["manifest.json", "options.html"].includes(file)).every((file) => file.endsWith(".js"))).toBe(true);
  });

  it("writes the manifest of the version it was given: the fixed id's key, no host permission, the version as its version name", () => {
    const manifest = JSON.parse(read("manifest.json")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      manifest_version: 3,
      key: EXTENSION_MANIFEST_KEY,
      version: "1.2.3",
      version_name: "1.2.3-rc.1",
      background: { service_worker: "worker.js", type: "module" },
      options_ui: { page: "options.html" },
    });
    expect(manifest).not.toHaveProperty("host_permissions");
  });

  it("bundles what the scripts import: each loads only modules of the folder", () => {
    const scripts = readdirSync(built).filter((file) => file.endsWith(".js"));
    // The worker and the page share what they take of contracts through a module of the folder.
    expect(specifiersOf(read("worker.js"))).not.toEqual([]);
    for (const script of scripts) {
      for (const specifier of specifiersOf(read(script))) {
        expect(specifier, `${script} imports ${specifier}`).toMatch(/^\.\/[^/]+\.js$/);
        expect(existsSync(join(built, specifier)), `${script} imports ${specifier}`).toBe(true);
      }
    }
    expect(read("worker.js")).not.toMatch(/@agent-harness\//);
    // The worker takes the browser package's page driver, not its reader, which it never runs.
    expect(read("worker.js")).not.toMatch(/Readability/);
  });

  it("gives the options page its script from the folder, which the content policy admits", () => {
    expect(read("options.html")).toContain('<script type="module" src="options.js"></script>');
  });

  it("refuses a harness version the manifest cannot take, before it writes anything", async () => {
    const elsewhere = join(scratch, "refused");
    await expect(buildExtension({ outDir: elsewhere, version: "1.2" })).rejects.toThrow(/1\.2 is not a harness version/);
    expect(existsSync(elsewhere)).toBe(false);
  });

  it("runs as Chrome runs it: the built worker reads the port file from its folder and announces to the environment there", async () => {
    const environment = await scriptedEnvironment();
    writeFileSync(join(built, PORT_FILE_NAME), JSON.stringify(environment.portFile));
    const thread = runBuiltWorker();
    try {
      const socket = await environment.nextSocket();
      expect(await socket.next()).toEqual({ type: "announce", protocolVersion: 2, extensionVersion: "1.2.3-rc.1", name: "" });
      socket.send({ type: "announced", environmentId: environment.environmentId, environmentName: environment.environmentName });
      socket.send({ type: "ping" });
      expect(await socket.next()).toEqual({ type: "pong" });
    } finally {
      await thread.terminate();
      await environment.close();
      rmSync(join(built, PORT_FILE_NAME));
    }
  });
});

/**
 * The built `worker.js` on a thread of its own, whose timers and socket end
 * with it, as `test/built-worker-thread.ts` runs it: its global `chrome` the
 * fake (loaded from source through tsx), holding the built manifest, and its
 * `fetch` of the extension's own addresses reading the built folder.
 */
const runBuiltWorker = (): Worker => {
  const workerData = {
    tsxApi: pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href,
    entry: pathToFileURL(join(import.meta.dirname, "..", "test", "built-worker-thread.ts")).href,
    folder: built,
  };
  const thread = new Worker(
    `const { workerData } = require("node:worker_threads");
    import(workerData.tsxApi).then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`,
    { eval: true, workerData, execArgv: [...process.execArgv, "--conditions=@agent-harness/source"] },
  );
  thread.on("error", () => undefined);
  return thread;
};
