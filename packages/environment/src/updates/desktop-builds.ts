import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { ContractError, type ReleaseAsset } from "@agent-harness/contracts";
import type { MethodHandler } from "../serve/methods.js";
import type { ChannelFailure, ChannelSettings, DownloadableAsset, ReleaseChannelReader } from "./channel.js";

/**
 * The desktop's builds, staged by its local environment (launcher-update
 * spec, "The desktop moves with its local environment"; ADR 0007; #354).
 * The desktop holds no forge token: `updates.desktop.stage`, from a local
 * client session only, has the environment resolve the desktop build for
 * the platform and format the desktop's shell reports, from the release the
 * environment's settings follow (the pin, else the channel's newest), so the
 * channel is the environment's by construction. The build is downloaded
 * through the ForgeService into `desktop-builds/<version>/` in the data
 * directory, checked against the manifest's size and SHA-256, and answered
 * with its path, version and SHA-256; one already staged there that still
 * matches is answered without a download. One is staged at a time. Once a
 * build is staged, every other entry of the desktop's builds is removed; a
 * removal that fails is said on standard error as a cleanup failure and
 * never fails the build staged, so it never reads as a release that could
 * not be read.
 */

/**
 * The folder of the data directory the desktop's builds are staged in, one
 * folder per version. Never the desktop's own data directory, `desktop`
 * (#394): everything in this folder but the build staged is removed, which
 * there would be the desktop's profile, tokens and log (#788).
 */
export const DESKTOP_BUILDS_DIRECTORY = "desktop-builds";

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

/** The fetch of a desktop build under way in each folder of builds: the next waits for it, so two never write the same folder. */
const queues = new Map<string, Promise<unknown>>();

/** Runs `work` once every fetch of a desktop build into `builds` before it has ended. */
const inTurn = <T>(builds: string, work: () => Promise<T>): Promise<T> => {
  const turn = (queues.get(builds) ?? Promise.resolve()).then(work);
  queues.set(
    builds,
    turn.catch(() => undefined),
  );
  return turn;
};

/**
 * Fetches `build`, a desktop build, into `desktop-builds/<version>/` of
 * `dataDir`, and answers its path; one already there that still matches its
 * size and SHA-256 is answered without a download. The desktop's stage and
 * the environment's update from the desktop build (#2196) both fetch through
 * it, one at a time, so a desktop machine downloads one file per update:
 * whichever asks second finds it there. It removes nothing else.
 */
export const fetchDesktopBuild = (
  dataDir: string,
  build: DownloadableAsset,
  download: ReleaseChannelReader["download"],
): Promise<{ readonly path: string } | ChannelFailure> => {
  const builds = join(dataDir, DESKTOP_BUILDS_DIRECTORY);
  return inTurn(builds, async () => {
    const { version, artefact } = build;
    // The name is the release's; one that is not a plain file name is no build this environment writes.
    if (basename(artefact.name) !== artefact.name || artefact.name.startsWith(".")) {
      return { outcome: "failed", reason: "manifest", message: `The release ${version} names its desktop build ${JSON.stringify(artefact.name)}, which is no file name.` } as const;
    }
    const path = join(builds, version, artefact.name);
    if (await matches(path, artefact)) return { path };
    await mkdir(builds, { recursive: true, mode: 0o700 });
    const partial = join(builds, `.${version}-${randomUUID()}.download`);
    try {
      const failed = await download(build, partial);
      if (failed !== null) return failed;
      await mkdir(join(builds, version), { recursive: true, mode: 0o700 });
      await rename(partial, path);
      return { path };
    } finally {
      // Gone once renamed into place; what a failed download left is a cleanup, which never fails the answer.
      await rm(partial, { force: true }).catch((error: unknown) => console.error(`Cleaning up the desktop build's download ${partial} failed:`, error));
    }
  });
};

export const desktopStage = (options: DesktopStageOptions): MethodHandler<"updates.desktop.stage"> => {
  const builds = join(options.dataDir, DESKTOP_BUILDS_DIRECTORY);
  /** The staging under way: the next waits for it, so two never stage at once. */
  let queue: Promise<unknown> = Promise.resolve();

  const stageBuild = async (platform: string, format: string) => {
    const build = await options.channel.desktopBuild(platform, format, options.settings());
    if ("code" in build) throw new ContractError(build);
    const { version, artefact } = build;
    const fetched = await fetchDesktopBuild(options.dataDir, build, (asset, destination) => options.channel.download(asset, destination));
    if ("outcome" in fetched) throw new ContractError({ code: "conflict", message: fetched.message, data: { reason: fetched.reason } });
    await removeOthers(builds, version);
    return { path: fetched.path, version, sha256: artefact.sha256 };
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
