import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanUp, scratch } from "../../test/harness.js";
import { CREDENTIAL_HELPER_ARGUMENT, macCredentialProcess } from "../../src/mac-credentials.js";
import { mainBundleConfig, rendererBuildConfig } from "./bundle.js";

/**
 * The packaged app's code (#423), built as the desktop build builds it and
 * read as text, never run. The main process loads Electron; a packaged app
 * carries no `node_modules`, so its bundle may import Electron and Node's
 * built-ins and nothing else. The `gui` build reports the client version it
 * is stamped with.
 */

let outDir: string;
beforeAll(async () => {
  outDir = scratch();
  await build(mainBundleConfig(outDir));
});
afterAll(cleanUp);

/** The module specifiers `code`, an ES module, imports, statically or dynamically. */
const specifiers = (code: string): string[] => [
  ...new Set([...code.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*["']([^"']+)["']/gm), ...code.matchAll(/^\s*import\s*["']([^"']+)["']/gm), ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] ?? "")),
];

describe("the packaged main process", () => {
  it.each(["agent-harness", "agent-harness credentials 00000000-0000-4000-8000-000000000001"])("runs the packaged credential entry for %s over private IPC without starting the desktop", async (name) => {
    const helperDir = scratch();
    writeFileSync(join(helperDir, "main.js"), readFileSync(join(outDir, "main.js")));
    const electron = join(helperDir, "node_modules", "electron");
    mkdirSync(electron, { recursive: true });
    writeFileSync(join(helperDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(electron, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
    writeFileSync(join(electron, "index.js"), `
let identity, profile;
export const app = {
  setName: value => { if (value !== ${JSON.stringify(name)}) throw new Error('Wrong OS item identity'); identity = value; },
  setPath: (key, path) => {
    if (key !== 'userData' || !path.endsWith('credential-provider/' + encodeURIComponent(${JSON.stringify(name)}))) throw new Error('Wrong helper profile');
    profile = path;
  },
  whenReady: async () => { if (!identity || !profile) throw new Error('OS identity must be set before ready'); }, dock: { hide: () => {} },
  requestSingleInstanceLock: () => { throw new Error('Helper must not claim the desktop lock'); },
};
export const safeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => Buffer.from('ciphertext-for-tests:' + value),
  decryptStringAsync: async value => ({ result: value.toString().slice('ciphertext-for-tests:'.length) }),
};
export const BrowserWindow = () => { throw new Error('Helper must not open a window'); };
export const WebContentsView = BrowserWindow;
export const Menu = {
  buildFromTemplate: () => { throw new Error('Helper must not build a menu'); },
  setApplicationMenu: () => { throw new Error('Helper must not install a menu'); },
};
export const clipboard = {}, dialog = {}, ipcMain = {}, nativeTheme = {}, Notification = {}, protocol = {}, shell = {};
`);
    const boot = join(helperDir, "helper-test.mjs");
    writeFileSync(boot, "Object.defineProperty(process, 'platform', { value: 'darwin' });\nawait import('./main.js');\n");
    const provider = macCredentialProcess(() => spawn(process.execPath, [boot, CREDENTIAL_HELPER_ARGUMENT, `--credential-store=${name}`], { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
    try {
      const signal = new AbortController().signal;
      expect(await provider.available(signal)).toBe(true);
      const kept = await provider.encrypt("token-for-tests", signal);
      expect(await provider.decrypt(kept, signal)).toBe("token-for-tests");
    } finally { provider.close(); }
  });

  it("is one ES module, main.js, which imports Electron and Node's built-ins and nothing else", () => {
    expect(readdirSync(outDir)).toEqual(["main.js"]);
    const imported = specifiers(readFileSync(join(outDir, "main.js"), "utf8"));
    expect(imported).toContain("electron");
    expect(imported.filter((specifier) => specifier !== "electron" && !isBuiltin(specifier))).toEqual([]);
  });
});

describe("the packaged gui build", () => {
  it("is the page and its script, stamped with the desktop's version, the client version the window reports", async () => {
    const outDir = join(scratch(), "renderer");
    await build(rendererBuildConfig(outDir, "0.5.0-stamp.1"));
    expect(readdirSync(outDir).sort()).toEqual(["assets", "index.html", "manifest.webmanifest", "phone-icons", "service-worker.js", "version.json"]);
    expect(JSON.parse(readFileSync(join(outDir, "version.json"), "utf8"))).toEqual({ version: "0.5.0-stamp.1" });
    const scripts = readdirSync(join(outDir, "assets")).filter((name) => name.endsWith(".js"));
    expect(scripts.some((name) => readFileSync(join(outDir, "assets", name), "utf8").includes("0.5.0-stamp.1"))).toBe(true);
  });
});
