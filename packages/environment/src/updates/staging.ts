import { removeTreeSync, requireCopyRoom } from "@agent-harness/filesystem";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { cp, open, realpath } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { join } from "node:path";
import { ARTEFACT_CLI_ENTRY, ARTEFACT_CLI_PACKAGE, artefactNode, DATABASE_FILE, INSTALL_RESERVE_BYTES, type DesktopEnvironment } from "@agent-harness/contracts";
import { stagingArea } from "../serve/launcher-files.js";

/**
 * Staging an artefact (launcher-update spec, "Staging"; #343, #347, #789):
 * the server artefact a path names (`update apply`'s, or the desktop's
 * bundled one), or one downloaded from its release into the staging area,
 * is put in the staging area, the one place in the data directory the
 * environment writes of the launcher's, as the folder `install?` names: an
 * archive unpacked, a folder an artefact is unpacked in (as the desktop
 * carries it) copied. The launcher moves an installed version out of it; a
 * version it refused is removed from it.
 */

/**
 * Unpacks the archive `archive` into the empty folder `into`, the
 * archive's top at the folder's; or, `within` a desktop build (#2196), only
 * the environment's folder inside it (inside its payload where it names
 * one), that folder's top at `into`'s, so the staged tree has an
 * environment asset's top level. Rejects saying why when it cannot.
 */
export type Unpack = (archive: string, into: string, within?: DesktopEnvironment) => Promise<void>;

/** How long an unpack may take before it is given up: a server artefact is a few hundred megabytes at most. */
export const UNPACK_TIMEOUT_MS = 5 * 60_000;

/** Runs `tar` with `args`, rejecting with what it said on standard error when it fails or outlasts `UNPACK_TIMEOUT_MS`. */
const tarOf = (args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("tar", args, { timeout: UNPACK_TIMEOUT_MS, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim() || error.message, { cause: error }));
      else resolve();
    });
  });

/**
 * The arguments that have `tar` unpack `archive` into `into`: whole; or,
 * `within` a desktop build, only the members under its path, that many
 * leading parts stripped. bsdtar (macOS's and Windows' `tar`) and GNU tar
 * read them alike.
 */
export const tarArguments = (archive: string, into: string, within?: Pick<DesktopEnvironment, "path">): string[] => {
  if (within === undefined) return ["-xf", archive, "-C", into];
  const parts = within.path.split("/");
  return ["-xf", archive, "-C", into, "--strip-components", String(parts.length), parts.join("/")];
};

/**
 * The preset unpack: the platform's `tar`, which reads a gzipped tar on
 * Linux and macOS and, as the `tar` Windows ships (bsdtar), a zip or a 7z
 * on Windows, telling the compression from the archive itself. A desktop
 * build's payload is carved out of it beside `into` first, and removed
 * once unpacked.
 */
export const tarUnpack: Unpack = async (archive, into, within) => {
  if (within?.payload === undefined) return tarOf(tarArguments(archive, into, within));
  const payload = `${into}.payload.7z`;
  try {
    await carveSevenZip(archive, payload);
    await tarOf(tarArguments(payload, into, within));
  } finally {
    rmSync(payload, { force: true });
  }
};

/** A 7z archive's signature, the first six bytes of its start header. */
const SEVEN_ZIP_SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
/** A 7z start header's length: signature, version, CRC, then the next header's offset, size and CRC. */
const SEVEN_ZIP_START_HEADER = 32;
/** How much of the file is read at a time while looking for the signature. */
const CARVE_CHUNK = 4 * 1024 * 1024;

/**
 * Copies the first 7z archive stored whole inside `file` to `destination`
 * (#2196): the Windows setup's `app-64.7z`, which electron-builder's NSIS
 * script stores uncompressed (`SetCompress off`), so its bytes lie in the
 * setup as they are. A candidate is the signature whose start header's CRC
 * holds and whose next header ends inside the file and matches its CRC;
 * the archive runs from the signature to the end of that header. Running the
 * setup instead would replace or kill a running desktop. Rejects when the
 * file holds no such archive.
 */
export const carveSevenZip = async (file: string, destination: string): Promise<void> => {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const read = async (position: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    for (let offset = 0; offset < size; offset += CARVE_CHUNK) {
      // Overlapping by a signature's length less one, so one across two chunks is still found.
      const chunk = await read(offset, CARVE_CHUNK + SEVEN_ZIP_SIGNATURE.length - 1);
      for (let at = chunk.indexOf(SEVEN_ZIP_SIGNATURE); at !== -1 && at < CARVE_CHUNK; at = chunk.indexOf(SEVEN_ZIP_SIGNATURE, at + 1)) {
        const start = offset + at;
        const length = await sevenZipLengthAt(read, start, size);
        if (length === undefined) continue;
        await copyRange(file, start, length, destination);
        return;
      }
    }
  } finally {
    await handle.close();
  }
  throw new Error(`${file} holds no 7z archive.`);
};

/** The length of the 7z archive whose start header is at `start` of a file of `size` bytes, or undefined when none is there whole. */
const sevenZipLengthAt = async (read: (position: number, length: number) => Promise<Buffer>, start: number, size: number): Promise<number | undefined> => {
  const header = await read(start, SEVEN_ZIP_START_HEADER);
  if (header.length < SEVEN_ZIP_START_HEADER || header.readUInt32LE(8) !== crc32(header.subarray(12, 32))) return undefined;
  const nextOffset = Number(header.readBigUInt64LE(12));
  const nextSize = Number(header.readBigUInt64LE(20));
  const length = SEVEN_ZIP_START_HEADER + nextOffset + nextSize;
  if (nextSize === 0 || !Number.isSafeInteger(length) || start + length > size) return undefined;
  const next = await read(start + SEVEN_ZIP_START_HEADER + nextOffset, nextSize);
  return next.length === nextSize && crc32(next) === header.readUInt32LE(28) ? length : undefined;
};

/** Copies `length` bytes of `file` from `start` to a new file at `destination`. */
const copyRange = (file: string, start: number, length: number, destination: string): Promise<void> =>
  pipeline(createReadStream(file, { start, end: start + length - 1 }), createWriteStream(destination, { mode: 0o600 }));

/**
 * An artefact could not be staged: the path names neither a file nor a
 * folder (`missing`); or the file did not unpack, or the folder holds no
 * artefact of the version or did not copy (`unusable`).
 */
export class StagingError extends Error {
  readonly kind: "missing" | "unusable";

  constructor(kind: StagingError["kind"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StagingError";
    this.kind = kind;
  }
}

/** A fresh file in the staging area of `dataDir` that `version`'s artefact is downloaded into before it is unpacked; the area is made when missing. */
export const downloadDestination = (dataDir: string, version: string): string => {
  const area = stagingArea(dataDir);
  mkdirSync(area, { recursive: true, mode: 0o700 });
  return join(area, `.${version}-${randomUUID()}.download`);
};

/** What a path names: an archive (a file), the folder an artefact is unpacked in, or neither. */
const shapeAt = (path: string): "archive" | "folder" | undefined => {
  try {
    const stats = statSync(path);
    return stats.isFile() ? "archive" : stats.isDirectory() ? "folder" : undefined;
  } catch {
    return undefined;
  }
};

/** Whether `path` is a file that is there now. */
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The version the CLI package of the artefact unpacked in `folder` declares, or undefined when it names none: missing, not JSON, or no string there. */
const declaredVersion = (folder: string): string | undefined => {
  try {
    const { version } = JSON.parse(readFileSync(join(folder, ...ARTEFACT_CLI_PACKAGE), "utf8")) as { readonly version?: unknown };
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Why `folder` holds no server artefact of `version` unpacked, or undefined
 * when it holds one: this platform's Node, the CLI's entry, and the CLI
 * package declaring that version, as a release lays them out. Read before
 * anything is copied, so a folder of anything else is never copied into the
 * staging area; the launcher's `install?` checks the copy again, whole.
 */
const notArtefactOf = (folder: string, version: string): string | undefined => {
  const node = join(folder, ...artefactNode(process.platform));
  if (!isFile(node)) return `it has no Node at ${node}`;
  const entry = join(folder, ...ARTEFACT_CLI_ENTRY);
  if (!isFile(entry)) return `it has no CLI entry at ${entry}`;
  const declared = declaredVersion(folder);
  if (declared !== version) return `its CLI package ${join(folder, ...ARTEFACT_CLI_PACKAGE)} ${declared === undefined ? "declares no release version" : `declares ${declared}`}`;
  return undefined;
};

/** The folder in the staging area of `dataDir` that `version` is staged in. */
export const stagedVersion = (dataDir: string, version: string): string => join(stagingArea(dataDir), version);

/**
 * Puts the artefact at `artefact`, of `version`, in the staging area of
 * `dataDir`, and answers the folder it is in, `staging/<version>`. An
 * archive is unpacked, and a folder an artefact is unpacked in copied (its
 * links kept as the links they are, as `tar` keeps them), into a fresh
 * folder beside it, which is moved into place whole, replacing whatever an
 * earlier attempt left there, so the folder `install?` names is never half
 * a version; the folder copied from is left as it was. Throws a
 * `StagingError` when the path names nothing to stage, or what it names
 * does not unpack, holds no artefact of `version` or does not copy, leaving
 * nothing.
 */
export const stageArtefact = async (options: {
  readonly dataDir: string;
  readonly version: string;
  readonly artefact: string;
  readonly unpack: Unpack;
  /** Where the environment is inside the archive, when it is a desktop build (#2196): only that is unpacked. */
  readonly within?: DesktopEnvironment;
}): Promise<string> => {
  const { dataDir, version, artefact } = options;
  const shape = shapeAt(artefact);
  if (shape === undefined) throw new StagingError("missing", `No artefact is at ${artefact} on this machine.`);
  const unusable = shape === "folder" ? notArtefactOf(artefact, version) : undefined;
  if (unusable !== undefined) throw new StagingError("unusable", `${artefact} is not a server artefact of ${version}: ${unusable}.`);
  const area = stagingArea(dataDir);
  mkdirSync(area, { recursive: true, mode: 0o700 });
  if (shape === "folder") {
    try {
      requireCopyRoom(artefact, dataDir, DATABASE_FILE, INSTALL_RESERVE_BYTES);
    } catch (cause) {
      throw new StagingError("unusable", cause instanceof Error ? cause.message : String(cause), { cause });
    }
  }
  const partial = join(area, `.${version}-${randomUUID()}`);
  mkdirSync(partial, { mode: 0o700 });
  try {
    if (shape === "archive") await (options.within === undefined ? options.unpack(artefact, partial) : options.unpack(artefact, partial, options.within));
    else await cp(await realpath(artefact), partial, { recursive: true, verbatimSymlinks: true });
  } catch (error) {
    removeTreeSync(partial);
    const failed = shape === "archive" ? "did not unpack" : "did not copy";
    throw new StagingError("unusable", `The artefact at ${artefact} ${failed}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const staged = stagedVersion(dataDir, version);
  try {
    removeTreeSync(staged);
    renameSync(partial, staged);
  } catch (error) {
    removeTreeSync(partial);
    throw error;
  }
  return staged;
};

/** Removes `version` from the staging area of `dataDir`: the launcher refused it. */
export const unstage = (dataDir: string, version: string): void => removeTreeSync(stagedVersion(dataDir, version));
