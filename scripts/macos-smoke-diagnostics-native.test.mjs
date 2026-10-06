import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectMacosSmokeDiagnostics, collectRendererSmokeDiagnostics, executeDiagnostic, executeSwift } from "./macos-smoke-diagnostics.mjs";

// Apple SDK contracts are exercised on a hosted Mac, without Electron or credentials.
const native = { skip: process.platform !== "darwin", timeout: 180_000 };
const fixture = fileURLToPath(new globalThis.URL("../test/fixtures/macos-smoke-image.swift", import.meta.url));
const redactor = fileURLToPath(new globalThis.URL("./redact-macos-smoke-screen.swift", import.meta.url));

test("captures a real CoreGraphics window array through JXA", native, async () => {
  const work = mkdtempSync(join(tmpdir(), "native-window-evidence-"));
  const directory = join(work, "upload");
  const privateDirectory = join(work, "private");
  mkdirSync(privateDirectory, { mode: 0o700 });
  try {
    await collectMacosSmokeDiagnostics({ directory, privateDirectory,
      error: new Error("fixture timeout"), execute: (command, args) => {
        if (command.endsWith("osascript")) return executeDiagnostic(command, args);
        return Promise.reject(new Error("only window capture requested"));
      } });
    assert.equal(existsSync(join(directory, "windows.json.error.txt")), false);
    const windows = JSON.parse(readFileSync(join(directory, "windows.json"), "utf8"));
    assert.ok(Array.isArray(windows));
    for (const window of windows) {
      if (window.owner !== undefined) assert.equal(typeof window.owner, "string");
      assert.equal(typeof window.pid, "number");
      assert.equal(typeof window.bounds.Width, "number");
      assert.equal(typeof window.bounds.Height, "number");
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("both collectors mask a text fixture with a cold Swift module cache", native, async () => {
  const work = mkdtempSync(join(tmpdir(), "native-collector-redaction-"));
  const directory = join(work, "upload");
  const privateDirectory = join(work, "private");
  const raw = join(work, "fixture.png");
  mkdirSync(privateDirectory, { mode: 0o700 });
  try {
    await executeSwift([fixture, "text", raw]);
    const execute = async (command, args, options) => {
      if (command.endsWith("screencapture")) {
        writeFileSync(args.at(-1), readFileSync(raw));
        return { stdout: "", stderr: "" };
      }
      if (command.endsWith("swift")) {
        // Fixture generation warmed the default cache. Give the concurrently
        // started redactors the cold cache used by a fresh release runner.
        return executeDiagnostic(command, ["-module-cache-path", join(work, "swift-cache"), ...args], options);
      }
      return { stdout: "[]", stderr: "" };
    };
    await Promise.all([
      collectMacosSmokeDiagnostics({ directory, privateDirectory, error: new Error("fixture timeout"), execute }),
      collectRendererSmokeDiagnostics({ directory, privateDirectory, execute,
        cdp: { errors: () => [], diagnostic: async method => {
          if (method === "Page.captureScreenshot") return { data: readFileSync(raw).toString("base64") };
          if (method === "Runtime.evaluate") return { result: { value: {} } };
          return { nodes: [] };
        } },
      }),
    ]);
    for (const name of ["screenshot.png", "renderer-screenshot.png"]) {
      if (!existsSync(join(directory, name))) {
        const suffix = name.startsWith("renderer") ? ".error.json" : ".error.txt";
        assert.fail(readFileSync(join(directory, name + suffix), "utf8"));
      }
      const after = JSON.parse((await executeSwift([fixture, "inspect", join(directory, name)])).stdout);
      assert.deepEqual(after.text, [], name + " contains no readable credential");
      assert.deepEqual([after.width, after.height], [1024, 512]);
    }
    assert.equal(existsSync(join(privateDirectory, "runner-screen.png")), false);
    assert.equal(existsSync(join(privateDirectory, "renderer-screen.png")), false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("compiles the image tool and masks readable text while retaining non-text geometry", native, async () => {
  const work = mkdtempSync(join(tmpdir(), "native-screen-redaction-"));
  const raw = join(work, "raw.png");
  const sanitized = join(work, "sanitized.png");
  const inspect = async path => JSON.parse((await executeSwift([fixture, "inspect", path])).stdout);
  try {
    await executeSwift([fixture, "text", raw]);
    const original = readFileSync(raw);
    const before = await inspect(raw);
    assert.match(before.text.join(" "), /TOKEN-FOR-TESTS-KEPT/);
    await executeSwift([redactor, raw, sanitized]);
    const after = await inspect(sanitized);
    assert.deepEqual([after.width, after.height], [1024, 512]);
    assert.deepEqual(after.text, [], "no recognized text remains in the uploaded image");
    assert.deepEqual(after.marker, before.marker, "the non-text blue marker is retained");
    assert.notDeepEqual(readFileSync(sanitized), original);
    assert.deepEqual(readFileSync(raw), original, "the private source image is unchanged");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("omits image output when the native OCR finds no text to mask", native, async () => {
  const work = mkdtempSync(join(tmpdir(), "native-screen-no-text-"));
  const raw = join(work, "raw.png");
  const sanitized = join(work, "sanitized.png");
  try {
    await executeSwift([fixture, "blank", raw]);
    await assert.rejects(executeSwift([redactor, raw, sanitized]));
    assert.equal(existsSync(sanitized), false);
    assert.ok(existsSync(raw));
  } finally { rmSync(work, { recursive: true, force: true }); }
});
