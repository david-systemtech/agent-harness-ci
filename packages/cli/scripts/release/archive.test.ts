import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packZip, readZipMember, writeSidecar } from "./archive.js";

/**
 * The release build's zip and sidecars (#356). The Windows artefact is a zip,
 * which Windows' own `tar` unpacks, and Node's Windows archive is one too; no
 * zip tool is on the Linux runner, so the build writes and reads zips itself.
 * Python's zipfile (on every CI runner) is the independent reader and writer
 * these tests check it against.
 */

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "release-archive-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const python = (script: string, ...args: string[]): string => execFileSync("python3", ["-c", script, ...args], { encoding: "utf8" });

const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

describe("the build's zip", () => {
  it("is read back whole by Python's zipfile: every file's bytes (compressible or not, empty or not, named in UTF-8) and every folder, each file's CRC checked", () => {
    const folder = join(base, "artefact");
    const files: Record<string, Buffer> = {
      "bin/agent-harness.cmd": Buffer.from("@echo off\r\nrem runs node\r\n".repeat(50)),
      "node/node.exe": randomBytes(300_000),
      "node_modules/zod/package.json": Buffer.from('{ "name": "zod" }\n'),
      "node_modules/zod/empty.txt": Buffer.alloc(0),
      "node_modules/@scope/naïve-ünïcode/índex.js": Buffer.from("export {};\n"),
    };
    for (const [path, data] of Object.entries(files)) {
      mkdirSync(join(folder, path, ".."), { recursive: true });
      writeFileSync(join(folder, path), data);
    }
    mkdirSync(join(folder, "logs"));
    const zip = join(base, "artefact.zip");
    packZip(folder, zip);
    const read = JSON.parse(
      python(
        "import sys,json,zipfile,hashlib\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({i.filename: (None if i.is_dir() else hashlib.sha256(z.read(i)).hexdigest()) for i in z.infolist()}))",
        zip,
      ),
    ) as Record<string, string | null>;
    const expected: Record<string, string | null> = { "logs/": null };
    for (const [path, data] of Object.entries(files)) expected[path] = sha(data);
    for (const path of Object.keys(files)) for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) expected[path.slice(0, at + 1)] = null;
    expect(read).toEqual(expected);
  });

  it("keeps each file's mode for an unpack on Linux or macOS, and compresses what compresses", () => {
    const folder = join(base, "artefact");
    mkdirSync(join(folder, "bin"), { recursive: true });
    writeFileSync(join(folder, "bin", "tool"), "#!/bin/sh\n".repeat(1000));
    chmodSync(join(folder, "bin", "tool"), 0o755);
    writeFileSync(join(folder, "bin", "notes.txt"), "notes\n");
    chmodSync(join(folder, "bin", "notes.txt"), 0o644);
    const zip = join(base, "artefact.zip");
    packZip(folder, zip);
    const read = JSON.parse(
      python("import sys,json,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({i.filename: [oct((i.external_attr >> 16) & 0o777), i.compress_size < i.file_size] for i in z.infolist() if not i.is_dir()}))", zip),
    ) as Record<string, [string, boolean]>;
    expect(read).toEqual({ "bin/notes.txt": ["0o644", false], "bin/tool": ["0o755", true] });
  });

  it("reads one file out of a zip another program wrote, deflated or stored, and names what it lacks", () => {
    const zip = join(base, "node.zip");
    const binary = randomBytes(50_000);
    writeFileSync(join(base, "node.exe"), binary);
    python(
      "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],'w')\nz.write(sys.argv[2],'node-v24/node.exe',compress_type=zipfile.ZIP_STORED)\nz.writestr('node-v24/LICENSE','Node.js licence\\n'*100,compress_type=zipfile.ZIP_DEFLATED)\nz.close()",
      zip,
      join(base, "node.exe"),
    );
    const data = readFileSync(zip);
    expect(readZipMember(data, "node-v24/node.exe").equals(binary)).toBe(true);
    expect(readZipMember(data, "node-v24/LICENSE").toString()).toBe("Node.js licence\n".repeat(100));
    expect(() => readZipMember(data, "node-v24/npm")).toThrow(/holds no node-v24\/npm/);
  });
});

describe("a sidecar", () => {
  it("is <asset>.sha256 in #113's format, sha256sum's line, which the install script reads the first word of", async () => {
    const asset = join(base, "agent-harness-linux-x64.tar.gz");
    writeFileSync(asset, "an artefact\n");
    const digest = await writeSidecar(asset);
    expect(readFileSync(`${asset}.sha256`, "utf8")).toBe(`${digest}  agent-harness-linux-x64.tar.gz\n`);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(execFileSync("sha256sum", ["-c", "agent-harness-linux-x64.tar.gz.sha256"], { cwd: base, encoding: "utf8" })).toBe("agent-harness-linux-x64.tar.gz: OK\n");
  });
});
