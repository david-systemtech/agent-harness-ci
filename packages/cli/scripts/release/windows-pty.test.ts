import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fixtureWindowsPty } from "../../test/release-fixtures.js";
import { exportWindowsPtyBuild, installWindowsPtyBuild } from "./windows-pty.js";

let scratch: string;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });
const fixture = () => {
  scratch = mkdtempSync(join(tmpdir(), "windows-pty-build-"));
  const build = fixtureWindowsPty(join(scratch, "input"));
  const pty = join(scratch, "node-pty");
  mkdirSync(join(pty, "src/win"), { recursive: true });
  writeFileSync(join(pty, "package.json"), JSON.stringify({ version: "1.1.0" }));
  writeFileSync(join(pty, "src/win/conpty.cc"), "patched native console ownership\n");
  mkdirSync(join(pty, "prebuilds/win32-x64"), { recursive: true });
  writeFileSync(join(pty, "prebuilds/win32-x64/conpty.node"), "old upstream addon");
  return { build, pty };
};

it("exports the compiled runtime with source and binary provenance, excluding debug symbols", () => {
  const { build, pty } = fixture();
  cpSync(join(build, "Release"), join(pty, "build/Release"), { recursive: true });
  writeFileSync(join(pty, "build/Release/conpty.pdb"), "debug symbols");
  const exported = join(scratch, "exported");
  exportWindowsPtyBuild(pty, exported);
  expect(JSON.parse(readFileSync(join(exported, "manifest.json"), "utf8"))).toEqual(JSON.parse(readFileSync(join(build, "manifest.json"), "utf8")));
  expect(existsSync(join(exported, "Release/conpty.pdb"))).toBe(false);
  installWindowsPtyBuild(exported, pty);
  expect(readFileSync(join(pty, "build/Release/conpty.node"))).toEqual(readFileSync(join(build, "Release/conpty.node")));
  expect(existsSync(join(pty, "prebuilds"))).toBe(false);
  expect(existsSync(join(pty, "build/Release/conpty.pdb"))).toBe(false);
});

it.each(["corrupt", "architecture", "missing-helper", "path"])("rejects a %s payload before replacing any installed runtime", (fault) => {
  const { build, pty } = fixture();
  const path = join(build, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { files: Record<string, string> };
  if (fault === "corrupt") writeFileSync(join(build, "Release/conpty.node"), "damaged");
  if (fault === "architecture") {
    const binary = readFileSync(join(build, "Release/conpty.node"));
    binary.writeUInt16LE(0xaa64, 68);
    writeFileSync(join(build, "Release/conpty.node"), binary);
    manifest.files["conpty.node"] = createHash("sha256").update(binary).digest("hex");
  }
  if (fault === "missing-helper") delete manifest.files["conpty_console_list.node"];
  if (fault === "path") manifest.files["../escape.node"] = "invalid-path";
  writeFileSync(path, JSON.stringify(manifest));
  expect(() => installWindowsPtyBuild(build, pty)).toThrow(/digest does not match|not a win32-x64 addon|missing conpty_console_list|invalid runtime path/);
  expect(readFileSync(join(pty, "prebuilds/win32-x64/conpty.node"), "utf8")).toBe("old upstream addon");
  expect(existsSync(join(pty, "build"))).toBe(false);
});
