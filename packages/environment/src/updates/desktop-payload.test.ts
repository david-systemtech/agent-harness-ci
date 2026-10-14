import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { carveSevenZip, tarArguments } from "./staging.js";

/**
 * Unpacking the environment out of a desktop build (#2196): the members
 * `tar` is asked for, and the 7z the Windows setup stores carved out of it.
 */

const { tempDir } = useCleanups();

/** A 7z archive's bytes as its start header frames them: a body and a next header, with both CRCs right unless `broken`. */
const sevenZip = (body: Uint8Array, next: Uint8Array, broken = false): Buffer => {
  const header = Buffer.alloc(32);
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]).copy(header);
  header.writeBigUInt64LE(BigInt(body.byteLength), 12);
  header.writeBigUInt64LE(BigInt(next.byteLength), 20);
  header.writeUInt32LE(crc32(next), 28);
  header.writeUInt32LE(broken ? 0 : crc32(header.subarray(12, 32)), 8);
  return Buffer.concat([header, body, next]);
};

describe("a desktop build's environment", () => {
  it("is unpacked by tar from its path alone, that many leading parts stripped; an archive that is the environment is unpacked whole", () => {
    expect(tarArguments("build.zip", "into", { path: "agent-harness.app/Contents/Resources/server" })).toEqual([
      "-xf",
      "build.zip",
      "-C",
      "into",
      "--strip-components",
      "4",
      "agent-harness.app/Contents/Resources/server",
    ]);
    expect(tarArguments("payload.7z", "into", { path: "resources/server" })).toEqual(["-xf", "payload.7z", "-C", "into", "--strip-components", "2", "resources/server"]);
    expect(tarArguments("artefact.tar.gz", "into")).toEqual(["-xf", "artefact.tar.gz", "-C", "into"]);
  });

  it("is carved out of the setup as the 7z stored in it whole, past a signature whose start header does not hold", async () => {
    const dir = tempDir("agent-harness-carve-");
    const archive = sevenZip(randomBytes(70_000), randomBytes(300));
    const setup = join(dir, "setup.exe");
    writeFileSync(setup, Buffer.concat([Buffer.from("MZ"), randomBytes(5_000), sevenZip(randomBytes(10), randomBytes(5), true), randomBytes(3_000), archive, randomBytes(2_000)]));

    await carveSevenZip(setup, join(dir, "app-64.7z"));

    expect(readFileSync(join(dir, "app-64.7z")).equals(archive)).toBe(true);
  });

  it("is refused when the setup stores no 7z whole: one cut short is none", async () => {
    const dir = tempDir("agent-harness-carve-");
    const setup = join(dir, "setup.exe");
    writeFileSync(setup, Buffer.concat([Buffer.from("MZ"), randomBytes(1_000), sevenZip(randomBytes(500), randomBytes(50)).subarray(0, 400)]));
    await expect(carveSevenZip(setup, join(dir, "app-64.7z"))).rejects.toThrow("holds no 7z archive");
  });
});
