import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { ContractError, type ReleaseAsset } from "@agent-harness/contracts";
import type { MethodHandler } from "../serve/methods.js";
import type { ChannelSettings, ReleaseChannelReader } from "./channel.js";

/**
 * The desktop's builds, staged by its local environment (launcher-update
 * spec, "The desktop moves with its local environment"; ADR 0007; #354).
 * The desktop holds no forge token: `updates.desktop.stage`, from a local
 * client session only, has the environment resolve the desktop build for
 * the platform and format the desktop's shell reports, from the release the
 * environment's settings follow (the pin, else the channel's newest), so the
 * channel is the environment's by construction. The build is downloaded
 * through the ForgeService into `desktop/<version>/` in the data directory,
 * checked against the manifest's size and SHA-256, and answered with its
 * path, version and SHA-256; one already staged there that still matches
 * is answered without a download. One is staged at a time. Once a build is
 * staged, every other folder of the desktop's builds is removed; a removal
 * that fails is said on standard error as a cleanup failure and never fails
 * the build staged, so it never reads as a release that could not be read.
 */

/** The folder of the data directory the desktop's builds are staged in, one folder per version. */
export const DESKTOP_BUILDS_DIRECTORY = "desktop";

export interface DesktopStageOptions {
  readonly dataDir: string;
  /** The release channel: the desktop build of the release followed, and its download. */
  readonly channel: Pick<ReleaseChannelReader, "desktopBuild" | "download">;
  /** The update settings the release followed is read from, as they are now. */
  readonly settings: () => ChannelSettings;
}

/** Whether the file at `path` is `artefact`, by its size and SHA-256. */
const matches = async (path: string, artefact: ReleaseAsset): Promise<boolean> => {
  try {
    const found = await stat(path);
    if (!found.isFile() || found.size !== artefact.size) return false;
  } catch {
    return false;
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex") === artefact.sha256;
};

/** Removes every entry of `folder` but `kept`, saying each that cannot be removed as a cleanup failure. */
const removeOthers = async (folder: string, kept: string): Promise<void> => {
  for (const entry of await readdir(folder)) {
    if (entry === kept) continue;
    try {
      await rm(join(folder, entry), { recursive: true, force: true });
    } catch (error) {
      console.error(`Cleaning up the staged desktop build ${join(folder, entry)} failed; the build staged stands:`, error);
    }
  }
};

export const desktopStage = (options: DesktopStageOptions): MethodHandler<"updates.desktop.stage"> => {
  const builds = join(options.dataDir, DESKTOP_BUILDS_DIRECTORY);
  /** The staging under way: the next waits for it, so two never write the same folder. */
  let queue: Promise<unknown> = Promise.resolve();

  const stageBuild = async (platform: string, format: string) => {
    const build = await options.channel.desktopBuild(platform, format, options.settings());
    if ("code" in build) throw new ContractError(build);
    const { version, artefact } = build;
    // The name is the release's; one that is not a plain file name is no build this environment writes.
    if (basename(artefact.name) !== artefact.name || artefact.name.startsWith(".")) {
      throw new ContractError({ code: "conflict", message: `The release ${version} names its desktop build ${JSON.stringify(artefact.name)}, which is no file name.`, data: { reason: "manifest" } });
    }
    const path = join(builds, version, artefact.name);
    if (!(await matches(path, artefact))) {
      await mkdir(builds, { recursive: true, mode: 0o700 });
      const download = join(builds, `.${version}-${randomUUID()}.download`);
      try {
        const failed = await options.channel.download(build, download);
        if (failed !== null) throw new ContractError({ code: "conflict", message: failed.message, data: { reason: failed.reason } });
        await mkdir(join(builds, version), { recursive: true, mode: 0o700 });
        await rename(download, path);
      } finally {
        // Gone once renamed into place; what a failed download left is a cleanup, which never fails the answer.
        await rm(download, { force: true }).catch((error: unknown) => console.error(`Cleaning up the desktop build's download ${download} failed:`, error));
      }
    }
    await removeOthers(builds, version);
    return { path, version, sha256: artefact.sha256 };
  };

  return ({ platform, format }, context) => {
    if (!context.clientSession.local) {
      throw new ContractError({
        code: "forbidden",
        message: "Only a local client session may stage the desktop's build: the environment writes it on its own machine.",
        data: { scope: "admin", reason: "local" },
      });
    }
    const staged = queue.then(() => stageBuild(platform, format));
    queue = staged.catch(() => undefined);
    return staged;
  };
};
