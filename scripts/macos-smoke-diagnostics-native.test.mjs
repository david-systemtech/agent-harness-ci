import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectMacosSmokeDiagnostics, executeDiagnostic } from "./macos-smoke-diagnostics.mjs";

// Apple SDK contracts are exercised on a hosted Mac, without Electron or credentials.
const native = { skip: process.platform !== "darwin", timeout: 90_000 };
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

test("compiles the image tool and masks readable text while retaining non-text geometry", native, async () => {
  const work = mkdtempSync(join(tmpdir(), "native-screen-redaction-"));
  const raw = join(work, "raw.png");
  const sanitized = join(work, "sanitized.png");
  const inspect = async path => JSON.parse((await executeDiagnostic("/usr/bin/swift", [fixture, "inspect", path])).stdout);
  try {
    await executeDiagnostic("/usr/bin/swift", [fixture, "text", raw]);
    const original = readFileSync(raw);
    const before = await inspect(raw);
    assert.match(before.text.join(" "), /TOKEN-FOR-TESTS-KEPT/);
    await executeDiagnostic("/usr/bin/swift", [redactor, raw, sanitized]);
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
    await executeDiagnostic("/usr/bin/swift", [fixture, "blank", raw]);
    await assert.rejects(executeDiagnostic("/usr/bin/swift", [redactor, raw, sanitized]));
    assert.equal(existsSync(sanitized), false);
    assert.ok(existsSync(raw));
  } finally { rmSync(work, { recursive: true, force: true }); }
});
