import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanUp, scratch } from "../../test/harness.js";
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
    expect(readdirSync(outDir).sort()).toEqual(["assets", "index.html"]);
    const scripts = readdirSync(join(outDir, "assets")).filter((name) => name.endsWith(".js"));
    expect(scripts.some((name) => readFileSync(join(outDir, "assets", name), "utf8").includes("0.5.0-stamp.1"))).toBe(true);
  });
});
