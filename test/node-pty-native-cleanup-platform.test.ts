import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const root = import.meta.dirname;
const simulate = (platform: string, compilerAvailable: boolean, missingCode = "ENOENT") => {
  const results: { name: string; skipped: boolean; error?: unknown }[] = [];
  const calls: string[] = [];
  const register = (name: string, body: () => void, skipped: boolean) => {
    const result: typeof results[number] = { name, skipped };
    if (!skipped) { try { body(); } catch (error) { result.error = error; } }
    results.push(result);
  };
  const test = Object.assign((name: string, body: () => void) => register(name, body, false), {
    skipIf: (condition: boolean) => (name: string, body: () => void) => register(name, body, condition),
  });
  const source = readFileSync(join(root, "node-pty-native-cleanup.test.ts"), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replaceAll("import.meta.dirname", JSON.stringify(root));
  runInNewContext(stripTypeScriptTypes(source), {
    createRequire, mkdtempSync, readFileSync, rmSync, writeFileSync, dirname, join, tmpdir,
    runInNewContext, expect, it: test, process: { platform },
    execFileSync: (file: string) => {
      calls.push(file);
      if (file === "c++") {
        if (!compilerAvailable) throw Object.assign(new Error("compiler is missing"), { code: missingCode });
        return Buffer.alloc(0);
      }
      return platform === "win32" ? "native ownership released exactly once\r\n" : "native ownership released exactly once\n";
    },
  });
  return { results, calls };
};

it("keeps the installer regression runnable on Windows without a Unix-style compiler", () => {
  const { results } = simulate("win32", false);
  expect(results[0]?.skipped).toBe(true);
  expect(results[1]).toMatchObject({ skipped: false });
  expect(results[1]?.error).toBeUndefined();
});

it("runs the compiled fixture on Windows when its compiler is available, with an executable and text-mode output", () => {
  const { results, calls } = simulate("win32", true);
  expect(results.every((result) => !result.skipped && result.error === undefined)).toBe(true);
  expect(calls.at(-1)).toMatch(/cleanup\.exe$/);
});

it("keeps the hosted Linux native regression mandatory when its compiler is missing", () => {
  const { results } = simulate("linux", false);
  expect(results[0]?.skipped).toBe(false);
  expect(results[0]?.error).toMatchObject({ code: "ENOENT" });
  expect(results[1]?.error).toBeUndefined();
});

it("reports a broken Windows compiler instead of treating it as unavailable", () => {
  expect(() => simulate("win32", false, "EACCES")).toThrow("compiler is missing");
});
