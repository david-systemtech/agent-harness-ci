import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const require = createRequire(join(import.meta.dirname, "../packages/environment/package.json"));
const dependency = dirname(require.resolve("node-pty/package.json"));

// Hosted suites compile this fixture on Linux. Windows installs use MSVC for the actual addon;
// keep this separate portable C++ fixture optional only when Windows has no c++ driver.
const nativeCompilerAvailable = (): boolean => {
  if (process.platform !== "win32") return true;
  try { execFileSync("c++", ["--version"], { stdio: "pipe" }); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};

it.skipIf(!nativeCompilerAvailable())("keeps the native console owned through natural exit and closes it exactly once on either exit path", () => {
  const native = readFileSync(join(dependency, "src/win/conpty.cc"), "utf8");
  // Compile the pinned implementation, replacing only Windows/Napi boundaries.
  const declarations = native.slice(native.indexOf("struct pty_baton"), native.indexOf("void SetupExitCallback"));
  const callbackStart = native.indexOf("auto callback =");
  const callback = native.slice(callbackStart, native.indexOf("\n    };", callbackStart) + 7);
  const waitStart = native.indexOf("ExitEvent *exit_event = new ExitEvent;");
  const wait = native.slice(waitStart, native.indexOf("auto status = tsfn.BlockingCall", waitStart));
  const kill = native.slice(native.indexOf("static Napi::Value PtyKill"), native.indexOf("/**\n* Init"));
  const fixture = readFileSync(join(import.meta.dirname, "fixtures/node-pty-native-cleanup.cc"), "utf8");
  const scratch = mkdtempSync(join(tmpdir(), "pty-native-cleanup-"));
  try {
    const input = join(scratch, "cleanup.cc");
    const binary = join(scratch, process.platform === "win32" ? "cleanup.exe" : "cleanup");
    writeFileSync(input, fixture.replace("// NATIVE DECLARATIONS", declarations).replace("// NATIVE KILL", kill)
      .replace("// NATIVE CALLBACK", callback).replace("// NATIVE WAIT", wait));
    execFileSync("c++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", input, "-o", binary], { stdio: "pipe" });
    expect(execFileSync(binary, [], { encoding: "utf8" }).replaceAll("\r\n", "\n")).toBe("native ownership released exactly once\n");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("rejects stale Windows prebuilds so production installs compile the repaired native lifecycle", () => {
  const removed: string[] = [];
  const codes: number[] = [];
  expect(() => runInNewContext(readFileSync(join(dependency, "scripts/prebuild.js"), "utf8"), {
    __dirname: join(dependency, "scripts"), console: { log() {} },
    process: { platform: "win32", arch: "x64", env: {}, exit: (code: number) => { codes.push(code); throw new Error("installer exit"); } },
    require: (name: string) => name === "path" ? require("node:path") : {
      existsSync: () => true, rmSync: (path: string) => removed.push(path),
    },
  })).toThrow("installer exit");
  expect(codes).toEqual([1]);
  expect(removed).toEqual([join(dependency, "prebuilds")]);
});
