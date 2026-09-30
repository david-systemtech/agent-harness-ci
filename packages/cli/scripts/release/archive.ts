import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { BuildError } from "./targets.js";

/**
 * The release build's archives and checksums (#356): a server artefact packed
 * as a gzipped tar or a zip with its folder's contents at the archive's top,
 * as the environment's staging and the install script unpack it, and the
 * `.sha256` sidecar beside every asset, in #113's format.
 */

const run = promisify(execFile);

/** The SHA-256 of the file at `path`, as 64 lowercase hexadecimal digits. */
export const sha256OfFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

/**
 * Writes the sidecar of the asset at `path`, `<asset>.sha256`, in #113's
 * format (`sha256sum`'s line: the digest, two spaces, the asset's name), and
 * answers the digest.
 */
export const writeSidecar = async (path: string): Promise<string> => {
  const digest = await sha256OfFile(path);
  writeFileSync(`${path}.sha256`, `${digest}  ${basename(path)}\n`);
  return digest;
};

/** Packs the contents of `folder` into the gzipped tar `archive` with the platform's `tar`, which keeps each file's mode. */
export const packTarGz = async (folder: string, archive: string): Promise<void> => {
  await run("tar", ["-czf", archive, "-C", folder, ...readdirSync(folder).sort()]);
};

/** A zip's record signatures and the version of the format it needs (2.0: folders and deflate). */
const LOCAL_FILE = 0x04034b50;
const CENTRAL_FILE = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const VERSION = 20;
/** The flag saying names are UTF-8. */
const UTF8_NAMES = 0x0800;
/** Made by Unix, so a reader on Linux or macOS takes each file's mode from its external attributes. */
const MADE_BY_UNIX = (3 << 8) | VERSION;
const [STORED, DEFLATED] = [0, 8];
/** The most a zip without its 64-bit extension counts or addresses. */
const [MOST_ENTRIES, MOST_BYTES] = [0xffff, 0xffffffff];

/** A time as a zip records it: MS-DOS's time and date, to the two seconds, in local time. */
const dosTime = (at: Date): { time: number; date: number } => ({
  time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
  date: (Math.max(at.getFullYear() - 1980, 0) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
});

/**
 * Packs the contents of `folder` into the zip `archive`: every folder and
 * file under it, sorted, named in UTF-8 with forward slashes, each file
 * deflated unless that does not make it smaller, with its mode kept for a
 * reader on Linux or macOS. It writes no 64-bit extension: an artefact
 * needing one (65,535 entries or 4 GiB) is a `BuildError`.
 */
export const packZip = (folder: string, archive: string): void => {
  const entries = readdirSync(folder, { recursive: true, encoding: "utf8" }).sort();
  if (entries.length > MOST_ENTRIES) throw new BuildError(`${basename(archive)} would hold ${entries.length} entries, more than a zip holds without its 64-bit extension.`);
  const fd = openSync(archive, "w");
  let offset = 0;
  const put = (bytes: Buffer): void => {
    writeSync(fd, bytes);
    offset += bytes.length;
  };
  const central: Buffer[] = [];
  try {
    for (const entry of entries) {
      const stat = statSync(join(folder, entry));
      const folderEntry = stat.isDirectory();
      const name = Buffer.from(`${entry.split(sep).join("/")}${folderEntry ? "/" : ""}`);
      const data = folderEntry ? Buffer.alloc(0) : readFileSync(join(folder, entry));
      const deflated = deflateRawSync(data);
      const [method, body] = deflated.length < data.length ? [DEFLATED, deflated] : [STORED, data];
      if (offset > MOST_BYTES || data.length >= MOST_BYTES) throw new BuildError(`${basename(archive)} would pass 4 GiB, which a zip does not address without its 64-bit extension.`);
      const { time, date } = dosTime(stat.mtime);
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_FILE, 0);
      local.writeUInt16LE(VERSION, 4);
      local.writeUInt16LE(UTF8_NAMES, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_FILE, 0);
      header.writeUInt16LE(MADE_BY_UNIX, 4);
      header.writeUInt16LE(VERSION, 6);
      header.writeUInt16LE(UTF8_NAMES, 8);
      header.writeUInt16LE(method, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(body.length, 20);
      header.writeUInt32LE(data.length, 24);
      header.writeUInt16LE(name.length, 28);
      // The high half holds the Unix mode, file type included; the low half's 0x10 is MS-DOS's folder flag.
      header.writeUInt32LE((((stat.mode & 0xffff) << 16) | (folderEntry ? 0x10 : 0)) >>> 0, 38);
      header.writeUInt32LE(offset, 42);
      central.push(header, name);
      put(local);
      put(name);
      put(body);
    }
    const start = offset;
    for (const bytes of central) put(bytes);
    if (offset > MOST_BYTES) throw new BuildError(`${basename(archive)} would pass 4 GiB, which a zip does not address without its 64-bit extension.`);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - start, 12);
    end.writeUInt32LE(start, 16);
    put(end);
  } finally {
    closeSync(fd);
  }
};

/**
 * The bytes of the file `member` in the zip `zip`, found through its central
 * directory, stored or deflated; one it does not hold is a `BuildError`.
 */
export const readZipMember = (zip: Buffer, member: string): Buffer => {
  const signature = Buffer.alloc(4);
  signature.writeUInt32LE(END_OF_CENTRAL);
  const end = zip.lastIndexOf(signature);
  if (end === -1) throw new BuildError(`That is not a zip: it has no end of central directory.`);
  let at = zip.readUInt32LE(end + 16);
  for (let left = zip.readUInt16LE(end + 10); left > 0; left--) {
    if (zip.readUInt32LE(at) !== CENTRAL_FILE) throw new BuildError("That zip's central directory is damaged.");
    const [method, size, nameLength] = [zip.readUInt16LE(at + 10), zip.readUInt32LE(at + 20), zip.readUInt16LE(at + 28)];
    if (zip.toString("utf8", at + 46, at + 46 + nameLength) === member) {
      const local = zip.readUInt32LE(at + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const body = zip.subarray(start, start + size);
      if (method === STORED) return Buffer.from(body);
      if (method === DEFLATED) return inflateRawSync(body);
      throw new BuildError(`${member} is packed with method ${method}, which the build does not read.`);
    }
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  throw new BuildError(`That zip holds no ${member}.`);
};

/**
 * Writes the file `member` of the archive at `archive`, a gzipped tar or a
 * zip, to `to`; an archive that holds no such file is a `BuildError`.
 */
export const extractMember = async (archive: string, format: "tar.gz" | "zip", member: string, to: string): Promise<void> => {
  mkdirSync(dirname(to), { recursive: true });
  const holdsNo = (why: string) => new BuildError(`${basename(archive)} holds no ${member}: ${why}`);
  if (format === "zip") {
    try {
      writeFileSync(to, readZipMember(readFileSync(archive), member));
    } catch (error) {
      throw holdsNo(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  const scratch = mkdtempSync(join(dirname(to), ".extract-"));
  try {
    await run("tar", ["-xzf", archive, "-C", scratch, member]);
    renameSync(join(scratch, member), to);
  } catch (error) {
    throw holdsNo(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
