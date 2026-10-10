import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

const REQUIRED = ["pty.node", "conpty.node", "conpty_console_list.node", "winpty-agent.exe", "winpty.dll", "conpty/conpty.dll", "conpty/OpenConsole.exe"];
const hash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Windows node-pty build metadata is not an object.");
  return value as Record<string, unknown>;
};
const version = (pty: string): unknown => object(JSON.parse(readFileSync(join(pty, "package.json"), "utf8"))).version;
const runtimeFile = (name: string): boolean => /\.(node|dll|exe)$/i.test(name) && name.split("/").every((part) => /^[\w.-]+$/.test(part) && part !== "." && part !== "..");

const checkFiles = (release: string, files: Record<string, unknown>): void => {
  for (const name of REQUIRED) if (typeof files[name] !== "string") throw new Error(`Windows node-pty build is missing ${name}.`);
  for (const [name, digest] of Object.entries(files)) {
    if (!runtimeFile(name)) throw new Error(`Windows node-pty build has an invalid runtime path: ${name}.`);
    const path = join(release, name);
    if (digest !== hash(path)) throw new Error(`Windows node-pty build digest does not match ${name}.`);
    if (name.endsWith(".node")) {
      const binary = readFileSync(path);
      const header = binary.length >= 64 ? binary.readUInt32LE(60) : binary.length;
      if (binary.toString("ascii", 0, 2) !== "MZ" || header + 6 > binary.length || binary.toString("ascii", header, header + 4) !== "PE\0\0" || binary.readUInt16LE(header + 4) !== 0x8664) {
        throw new Error(`Windows node-pty build is not a win32-x64 addon: ${name}.`);
      }
    }
  }
};

/** Export only the freshly compiled Windows runtime, with its pinned source and file digests. */
export const exportWindowsPtyBuild = (pty: string, destination: string): void => {
  const release = join(pty, "build/Release");
  const files = Object.fromEntries(readdirSync(release, { recursive: true, encoding: "utf8" })
    .map((name) => name.split(sep).join("/")).filter(runtimeFile).map((name) => [name, hash(join(release, name))]));
  checkFiles(release, files);
  for (const name of Object.keys(files)) {
    const into = join(destination, "Release", name);
    mkdirSync(dirname(into), { recursive: true });
    copyFileSync(join(release, name), into);
  }
  writeFileSync(join(destination, "manifest.json"), JSON.stringify({ platform: "win32-x64", version: version(pty), sourceSha256: hash(join(pty, "src/win/conpty.cc")), files }, null, 2) + "\n");
};

/** Reject stale/corrupt/cross-architecture inputs before replacing the upstream prebuild. */
export const installWindowsPtyBuild = (build: string, pty: string): void => {
  const manifest = object(JSON.parse(readFileSync(join(build, "manifest.json"), "utf8")));
  if (manifest.platform !== "win32-x64" || manifest.version !== version(pty) || manifest.sourceSha256 !== hash(join(pty, "src/win/conpty.cc"))) {
    throw new Error("Windows node-pty build does not match the installed pinned source and platform.");
  }
  const files = object(manifest.files);
  checkFiles(join(build, "Release"), files);
  rmSync(join(pty, "prebuilds"), { recursive: true, force: true });
  rmSync(join(pty, "build"), { recursive: true, force: true });
  for (const name of Object.keys(files)) {
    const into = join(pty, "build/Release", name);
    mkdirSync(dirname(into), { recursive: true });
    copyFileSync(join(build, "Release", name), into);
  }
};
