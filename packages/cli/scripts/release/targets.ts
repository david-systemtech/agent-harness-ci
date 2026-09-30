import { PRODUCT_NAME, RELEASE_PLATFORMS, releaseVersionOfTag } from "@agent-harness/contracts";

/**
 * What the release build (launcher-update spec, "The release"; #356) builds:
 * one server artefact per platform, under #113's names, for the version the
 * release's tag names.
 */

/** The release build cannot go on: the message says why, and nothing it wrote is a release. */
export class BuildError extends Error {
  override readonly name = "BuildError";
}

/** One platform's server artefact: its platform as Node names it, how pnpm and Node's downloads name its OS and CPU, and its asset. */
export interface ArtefactTarget {
  /** `<os>-<arch>` as Node names them: `linux-x64`. */
  readonly platform: string;
  readonly os: "linux" | "darwin" | "win32";
  readonly cpu: "x64" | "arm64";
  /** The C library its native files are built for, where the OS has more than one: glibc on Linux. */
  readonly libc?: "glibc";
  /** How the asset is packed: a gzipped tar, or a zip on Windows, whose own `tar` reads it. */
  readonly format: "tar.gz" | "zip";
  /** The asset's file name on the release: `agent-harness-linux-x64.tar.gz`. */
  readonly name: string;
}

const target = (os: ArtefactTarget["os"], cpu: ArtefactTarget["cpu"]): ArtefactTarget => {
  const format = os === "win32" ? "zip" : "tar.gz";
  const platform = `${os}-${cpu}`;
  return { platform, os, cpu, ...(os === "linux" && { libc: "glibc" as const }), format, name: `${PRODUCT_NAME}-${platform}.${format}` };
};

/** Milestone 1's three artefacts (the contracts' `RELEASE_PLATFORMS`). */
const TARGETS: ReadonlyMap<string, ArtefactTarget> = new Map(
  [target("linux", "x64"), target("darwin", "arm64"), target("win32", "x64")].map((each) => [each.platform, each]),
);

/** The artefacts of `platforms` (preset: every platform a release publishes), each once; a platform no artefact is built for is a `BuildError`. */
export const artefactTargets = (platforms: readonly string[] = RELEASE_PLATFORMS): ArtefactTarget[] => {
  const found = [...new Set(platforms)].map((platform) => TARGETS.get(platform));
  const unknown = platforms.filter((platform) => !TARGETS.has(platform));
  if (unknown.length > 0) throw new BuildError(`No artefact is built for ${unknown.join(", ")}; the platforms are ${[...TARGETS.keys()].join(", ")}.`);
  return found.filter((each) => each !== undefined);
};

/** The version the tag `v<version>` names, which every package is stamped with; any other tag is a `BuildError`. */
export const versionOfTag = (tag: string): string => {
  const version = releaseVersionOfTag(tag);
  if (version === null) throw new BuildError(`The tag ${JSON.stringify(tag)} is not v and a semantic version (v0.5.0, v1.0.0-beta.2): a release is built only from one.`);
  return version;
};

/** The platform this build runs on, as a target names it. */
export const hostPlatform = (): string => `${process.platform}-${process.arch}`;
