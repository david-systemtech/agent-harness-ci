import { execFile } from "node:child_process";
import { existsSync, mkdirSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { artefactNode } from "@agent-harness/contracts/launcher";
import { bundledInstaller } from "../../src/installer.js";
import { DesktopBuildError, type DesktopTarget } from "./targets.js";

/**
 * The server artefact a desktop build carries (#423): the release build's
 * artefact of the build's platform (#356), unpacked as a machine unpacks it,
 * and checked to be that platform's and the build's version before anything
 * is packed around it.
 */

const run = promisify(execFile);

const ELF_MACHINES: Readonly<Record<number, string>> = { 0x3e: "x64", 0xb7: "arm64" };
const MACH_O_CPUS: Readonly<Record<number, string>> = { 0x0100000c: "arm64", 0x01000007: "x64" };
const PE_MACHINES: Readonly<Record<number, string>> = { 0x8664: "x64", 0xaa64: "arm64" };

const platformOf = (os: string, arch: string | undefined): string | undefined => (arch === undefined ? undefined : `${os}-${arch}`);

/**
 * The platform an executable is built for, `<os>-<arch>`, from its first
 * bytes: a 64-bit little-endian ELF is Linux's, a 64-bit Mach-O macOS's, a
 * PE Windows's, each with its machine. Undefined for any other.
 */
export const executablePlatform = (header: Buffer): string | undefined => {
  if (header.length >= 20 && header.readUInt32BE(0) === 0x7f454c46 && header[4] === 2 && header[5] === 1) return platformOf("linux", ELF_MACHINES[header.readUInt16LE(18)]);
  if (header.length >= 8 && header.readUInt32LE(0) === 0xfeedfacf) return platformOf("darwin", MACH_O_CPUS[header.readUInt32LE(4)]);
  if (header.length >= 0x40 && header.toString("latin1", 0, 2) === "MZ") {
    const pe = header.readUInt32LE(0x3c);
    if (header.length >= pe + 6 && header.toString("latin1", pe, pe + 4) === "PE\0\0") return platformOf("win32", PE_MACHINES[header.readUInt16LE(pe + 4)]);
  }
  return undefined;
};

/** The first bytes of the file at `path`: enough for a PE's header, whose place the first bytes give. */
const headerOf = (path: string): Buffer => {
  const header = Buffer.alloc(4096);
  const file = openSync(path, "r");
  try {
    return header.subarray(0, readSync(file, header, 0, header.length, 0));
  } finally {
    closeSync(file);
  }
};

/**
 * How the build running on `host` unpacks `archive` into `into`: with the
 * host's `tar`, which reads a gzipped tar everywhere and a zip on Windows and
 * macOS; a zip on Linux (the Windows artefact, when the setup is built there)
 * with Python's zipfile, since GNU tar reads none and node-gyp has Python on
 * every runner that builds the release.
 */
const unpackCommand = (archive: string, into: string, host: string): [string, string[]] =>
  host.startsWith("linux-") && archive.endsWith(".zip") ? ["python3", ["-m", "zipfile", "-e", archive, into]] : ["tar", ["-xf", archive, "-C", into]];

/**
 * Unpacks the server artefact `archive` into `into`, as the build running on
 * `host` can (`unpackCommand`), and checks it: its Node is where `target`'s
 * platform keeps it and is built for that platform, and its CLI names
 * `version`, as `bundledServer()` reads it.
 */
export const stageServer = async (archive: string, into: string, target: DesktopTarget, version: string, host: string): Promise<void> => {
  mkdirSync(into, { recursive: true });
  const [command, args] = unpackCommand(archive, into, host);
  await run(command, args).catch((error: unknown) => {
    throw new DesktopBuildError(`The server artefact ${archive} did not unpack: ${error instanceof Error ? error.message : String(error)}`);
  });
  const node = artefactNode(target.os);
  if (!existsSync(join(into, ...node))) throw new DesktopBuildError(`The server artefact ${archive} is not a ${target.platform} artefact: it has no ${node.join("/")}.`);
  const built = executablePlatform(headerOf(join(into, ...node)));
  if (built !== target.platform) {
    throw new DesktopBuildError(
      built === undefined
        ? `The server artefact ${archive} is not ${target.platform}'s: its Node is no executable of ${target.platform}.`
        : `The server artefact ${archive} is ${built}'s, not ${target.platform}'s: its Node is built for ${built}.`,
    );
  }
  const carried = await bundledInstaller(into)
    .bundledServer()
    .catch(() => {
      throw new DesktopBuildError(`The server artefact ${archive} names no release version in its CLI's package.json.`);
    });
  if (carried?.version !== version) {
    throw new DesktopBuildError(`The server artefact ${archive} is ${carried?.version ?? "no version"}, not ${version}: a desktop carries the server artefact of its own version.`);
  }
};
