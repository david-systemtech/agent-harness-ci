import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHER_PROTOCOL,
  PRODUCT_NAME,
  RELEASE_MANIFEST_FILE,
  ReleaseManifest,
  ReleaseVersion,
  compareReleaseVersions,
  isPrerelease,
  releaseVersionOfTag,
  type ReleaseAsset,
  type ReleaseChannel,
  type ReleaseImage,
  type ReleaseSource,
  type UpdateBlockedReason,
  type UpdateCheckFailure,
  type UpdatePassOverReason,
  type UpdatePassedOver,
  type UpdateSettingsValues,
  type UpdateTarget,
} from "@agent-harness/contracts";
import type { ForgeService } from "../forge/forge-service.js";
import type { ForgeAnswer } from "../forge/operations.js";
import type { ForgeRelease, ForgeReleaseAsset } from "../forge/providers.js";

/**
 * Reading the release channel (launcher-update spec, "The release",
 * "Reading the channel" and "The target"; ADR 0007; #346). The release
 * source, an origin and a repository compiled into each build, is read
 * through the ForgeService anonymously for public releases, or with the
 * forge account for its origin when configured (a higher rate limit).
 *
 * - **The channel's newest.** The newest 50 releases that are not drafts,
 *   ordered by SemVer precedence, a tag that is not `v` and a release
 *   version passed over: `stable` takes the newest without a prerelease
 *   part, `beta` the newest of all.
 * - **The target.** The pinned version on either channel; else, with
 *   auto-update effective (on, and nothing pinned), the channel's newest
 *   when it is newer than what runs, so nothing moves backwards on its own.
 *   Its manifest is read and checked against its schema; a release whose
 *   database schema is below the database's, or that has no artefact for
 *   this platform, is passed over, and nothing of it is downloaded.
 * - **A failed version** (its trial or its watch failed, #344) is never
 *   the target, as the channel's newest or as the pin: the target is none
 *   until a release newer than it is published, which is taken as any
 *   channel's newest is; Update now may retry the failed one.
 * - **What is staged** (#347): the target, when the running launcher hosts
 *   the launcher protocol its manifest names; else the stepping stone, the
 *   newest release on the way (newer than what runs, on the channel, not
 *   failed) that the launcher hosts, whose handover brings the launcher the
 *   next check goes onward with. With none, and no handover due from the
 *   running version's own launcher, the target is blocked (`launcher`) until
 *   `service install` from its release installs its launcher. A failed
 *   handover to the running release is no longer due: the block names
 *   `service install` from that running release instead.
 * - **A pin** is checked the same way before it is set: refused when the
 *   release or this platform's artefact is missing, by the schema rule, or
 *   when the release cannot be read. **A requested version** (`updates.apply`
 *   by version, #347) is read the same way, and refused too when the running
 *   launcher cannot host it.
 */

/** The public GitHub release source this build reads (ADR 0007). */
export const RELEASE_SOURCE: ReleaseSource = { origin: "https://github.com", kind: "github", repository: "david-systemtech/agent-harness" };

/** This machine's platform as a release names one, `<os>-<arch>` as Node names them. */
export const RUNNING_PLATFORM = `${process.platform}-${process.arch}`;

/** How many of the newest releases a check reads. */
export const RELEASE_LIST_LIMIT = 50;

/** The largest manifest read (a chosen default): a manifest lists a release's assets, a few kilobytes. */
const MANIFEST_MAX_BYTES = 1024 * 1024;

/** What the forge operations say they are for: the missing-origin record and the key-manager registry name it. */
const PURPOSE = "read the release channel";

/** The update settings a reading follows. */
export interface ChannelSettings {
  readonly autoUpdate: boolean;
  readonly channel: ReleaseChannel;
  readonly pinnedVersion: string | null;
}

/** The settings a reading follows, of the update settings `values`. */
export const channelSettingsOf = (values: Pick<UpdateSettingsValues, "updates.autoUpdate" | "updates.channel" | "updates.pinnedVersion">): ChannelSettings => ({
  autoUpdate: values["updates.autoUpdate"],
  channel: values["updates.channel"],
  pinnedVersion: values["updates.pinnedVersion"],
});

/** What the channel is read with beside the settings: the running launcher's protocol, and the versions whose update failed. */
export interface ChannelContext {
  /** The launcher protocol the launcher running the environment speaks; null with no launcher, when no release is refused for it. */
  readonly launcherProtocol: number | null;
  /** The version whose launcher handover failed, if the launcher reports one. */
  readonly failedHandoverVersion?: string;
  /** The versions whose trial or watch failed (#344): never the target. */
  readonly failedVersions: readonly string[];
}

/** Why the channel could not be read, or a release's artefact downloaded, for `updates.status` and a refused pin or update. */
export interface ChannelFailure {
  readonly outcome: "failed";
  readonly reason: Extract<UpdateCheckFailure, "no_release_access" | "unreachable" | "manifest" | "artefact">;
  readonly message: string;
}

/** One asset of a release that can be downloaded: the release's version, and the asset as the forge lists it and as the manifest does. */
export interface DownloadableAsset {
  readonly version: string;
  /** The asset's record on the forge: what is downloaded. */
  readonly asset: ForgeReleaseAsset;
  /** The asset as the manifest lists it: what the download is checked against. */
  readonly artefact: ReleaseAsset;
}

/** A release that can be staged: its version, this platform's artefact as the forge lists it and as its manifest does, the launcher protocol it needs, and its image. */
export interface StageableRelease extends DownloadableAsset {
  /** The launcher protocol the release's environment needs. */
  readonly launcherProtocol: number;
  /** The release's image as its manifest names it: what a container's update goes to, which the host-side updater pulls (#348). */
  readonly image: ReleaseImage;
}

/** Why a target cannot be reached by itself: its reason, the target, the release whose installer unblocks it, and the launcher's words for it. */
export interface ChannelBlock {
  readonly reason: UpdateBlockedReason;
  readonly toVersion: string;
  /** The release whose `service install` brings the launcher the target needs: the target's, or the running version's own newer launcher. */
  readonly installVersion: string;
  readonly message: string;
}

/** What a check found: the channel's newest, the target, a release that would be the target and is not, what to stage now, and a block. */
export interface ChannelReading {
  readonly outcome: "read";
  readonly newest: string | null;
  readonly target: UpdateTarget | null;
  readonly passedOver: UpdatePassedOver | null;
  /** The release to stage for the target: the target itself, or the stepping stone on the way to it; null for none. */
  readonly stage: StageableRelease | null;
  /** The target needs a newer launcher than runs, and no release the launcher hosts leads there; null otherwise. */
  readonly blocked: ChannelBlock | null;
}

/** Why a release is refused to a pin or an update, as `updates.settings.set` and `updates.apply` answer it. */
export type ReleaseRefusal =
  | { readonly code: "not_found"; readonly message: string; readonly data: Record<string, never> }
  | { readonly code: "conflict"; readonly message: string; readonly data: { readonly reason: ChannelFailure["reason"] | "schema" | "launcher" | "current" } };

/** The release `updates.apply` asked for, or why not, and what reading the channel for it found. */
export interface RequestedRelease {
  readonly release: StageableRelease | ReleaseRefusal;
  readonly reading: ChannelReading | ChannelFailure;
}

export interface ReleaseChannelReader {
  /** Reads the channel as `settings` follow it: its newest, the target and what to stage for it. */
  read(settings: ChannelSettings, context: ChannelContext): Promise<ChannelReading | ChannelFailure>;
  /** Why `version` cannot be pinned, or null when it can. */
  pinRefusal(version: string): Promise<ReleaseRefusal | null>;
  /**
   * The release `updates.apply` asks for by `version`, or with none the
   * newest on the channel `settings` follow (current when nothing newer is
   * published), ready to stage under the launcher `context` names, or for a
   * container's host-side updater to pull with none (null, #348); or why it
   * cannot be. Beside it, what reading the channel for it found, as `read`
   * finds it, so `updates.status` shows the newest the request was resolved
   * against (#1774).
   */
  requested(version: string | undefined, settings: ChannelSettings, context: ChannelContext): Promise<RequestedRelease>;
  /**
   * The desktop build for `platform` in `format` (#354), from the release
   * the desktop follows under `settings`: the pinned version, else the
   * channel's newest; or why there is none to download.
   */
  desktopBuild(platform: string, format: string, settings: Pick<ChannelSettings, "channel" | "pinnedVersion">): Promise<DownloadableAsset | ReleaseRefusal>;
  /**
   * Downloads the asset `release` names into the file `destination` and
   * checks its size and SHA-256 against the manifest: null once it matches,
   * else why not. What it wrote stays for the caller to remove.
   */
  download(release: DownloadableAsset, destination: string): Promise<ChannelFailure | null>;
}

export interface ReleaseChannelOptions {
  /** The ForgeService: its forge accounts, and its release reads and downloads. */
  readonly forge: Pick<ForgeService, "releases" | "list">;
  readonly source: ReleaseSource;
  /** The version running: the channel's newest is a target only when newer. */
  readonly harnessVersion: string;
  /** The platform whose artefact a target needs; preset `RUNNING_PLATFORM`. */
  readonly platform?: string;
  /** The database's schema version, the last migration applied: a release below it is never a target. */
  readonly databaseSchemaVersion: () => number;
  /** The launcher protocol the running version's own launcher speaks, which a handover to it brings; preset `LAUNCHER_PROTOCOL`, this build's. */
  readonly ownLauncherProtocol?: number;
}

/** A release as the channel reads it: the version its tag names, and the forge's record. */
interface Versioned {
  readonly version: string;
  readonly release: ForgeRelease;
}

/** What a release that would be the target came to: the target, ready to stage, passed over with why, or a failure to read it. */
type Examined =
  | { readonly outcome: "target"; readonly release: StageableRelease }
  | { readonly outcome: "passed-over"; readonly reason: UpdatePassOverReason; readonly message: string }
  | ChannelFailure;

/** What the release of a version, among those listed, comes to. */
type Examiner = (version: string) => Promise<Examined>;

const failed = (reason: ChannelFailure["reason"], message: string): ChannelFailure => ({ outcome: "failed", reason, message });

/** The statuses by which a forge that answered, with the forge account or anonymously, refuses what the environment may read. */
const REFUSING: ReadonlySet<number> = new Set([401, 403, 404]);

/** A forge answer that is no value, as a check's failure: missing access, or a forge that did not answer or failed. */
const failureOf = (answer: Exclude<ForgeAnswer<unknown>, { readonly outcome: "done" }>): ChannelFailure => {
  switch (answer.outcome) {
    case "refused":
      return failed("no_release_access", answer.error.message);
    case "failed":
      return failed(REFUSING.has(answer.status) ? "no_release_access" : "unreachable", answer.message);
    case "unreachable":
      return failed("unreachable", answer.message);
  }
};

/** Why the artefact did not download: the release access refused (the token, or a sign-in proxy in front of the forge, #476), else the artefact itself. */
const downloadFailureOf = (version: string, answer: Exclude<ForgeAnswer<unknown>, { readonly outcome: "done" }>): ChannelFailure => {
  const access = answer.outcome === "refused" || (answer.outcome === "failed" && (answer.status === 401 || answer.status === 403));
  const why = answer.outcome === "refused" ? answer.error.message : answer.message;
  return failed(access ? "no_release_access" : "artefact", `The artefact of ${version} did not download: ${why}`);
};

/** What unblocks a target that needs a newer launcher, for people. */
const launcherMessage = (version: string, needs: number, speaks: number, installVersion = version): string =>
  `${version} needs launcher protocol ${needs}, and the launcher running this environment speaks ${speaks}: run \`${PRODUCT_NAME} service install\` from the ${installVersion} release to install its launcher.`;

export const createReleaseChannel = (options: ReleaseChannelOptions): ReleaseChannelReader => {
  const { forge, source, harnessVersion } = options;
  const platform = options.platform ?? RUNNING_PLATFORM;
  const ownLauncherProtocol = options.ownLauncherProtocol ?? LAUNCHER_PROTOCOL;
  const where = { origin: source.origin, kind: source.kind, repository: source.repository, purpose: PURPOSE };

  /**
   * The newest releases that are not drafts, by precedence, newest first; a
   * tag that is no version is passed over. The forge service uses the origin
   * account when present, and otherwise reads anonymously.
   */
  const list = async (): Promise<readonly Versioned[] | ChannelFailure> => {
    const answer = await forge.releases.list({ ...where, limit: RELEASE_LIST_LIMIT });
    if (answer.outcome !== "done") return failureOf(answer);
    const versioned = answer.value.flatMap((release) => {
      const version = releaseVersionOfTag(release.tag);
      return version === null ? [] : [{ version, release }];
    });
    // Stable: two tags equal in precedence (build metadata apart) keep the forge's order, the newer first.
    return versioned.sort((a, b) => compareReleaseVersions(b.version, a.version));
  };

  /** Reads `release`'s manifest: its asset downloaded to a temporary file and checked against its schema, naming `version`. */
  const manifestOf = async (version: string, release: ForgeRelease): Promise<ReleaseManifest | ChannelFailure> => {
    const asset = release.assets.find((candidate) => candidate.name === RELEASE_MANIFEST_FILE);
    if (asset === undefined) return failed("manifest", `The release ${version} publishes no ${RELEASE_MANIFEST_FILE}.`);
    if (asset.size > MANIFEST_MAX_BYTES) return failed("manifest", `The release ${version}'s ${RELEASE_MANIFEST_FILE} is ${asset.size} bytes, more than a manifest holds.`);
    const folder = await mkdtemp(join(tmpdir(), "agent-harness-manifest-"));
    try {
      const destination = join(folder, RELEASE_MANIFEST_FILE);
      const answer = await forge.releases.download({ ...where, asset, destination });
      if (answer.outcome !== "done") return failureOf(answer);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(destination, "utf8"));
      } catch {
        return failed("manifest", `The release ${version}'s ${RELEASE_MANIFEST_FILE} is not JSON.`);
      }
      const manifest = ReleaseManifest.safeParse(parsed);
      if (!manifest.success) return failed("manifest", `The release ${version}'s ${RELEASE_MANIFEST_FILE} is not a release manifest: ${manifest.error.issues[0]?.message ?? "it does not match its schema"}.`);
      if (manifest.data.version !== version) return failed("manifest", `The release ${version}'s ${RELEASE_MANIFEST_FILE} names the version ${manifest.data.version}.`);
      return manifest.data;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };

  /** This platform's artefact of the release, as its manifest lists it and as the release publishes it; null for none. */
  const artefactOf = (manifest: ReleaseManifest, release: ForgeRelease): Pick<StageableRelease, "artefact" | "asset"> | null => {
    for (const artefact of manifest.assets) {
      if (artefact.kind !== "environment" || artefact.platform !== platform) continue;
      const asset = release.assets.find((published) => published.name === artefact.name);
      if (asset !== undefined) return { artefact, asset };
    }
    return null;
  };

  /** Whether `version`'s release may be the target: its manifest read, this platform's artefact in it, its schema not below the database's. */
  const examine = async ({ version, release }: Versioned): Promise<Examined> => {
    const manifest = await manifestOf(version, release);
    if ("outcome" in manifest) return manifest;
    const artefact = artefactOf(manifest, release);
    if (artefact === null) return { outcome: "passed-over", reason: "artefact", message: `The release ${version} has no artefact for ${platform}.` };
    const database = options.databaseSchemaVersion();
    if (manifest.databaseSchemaVersion < database) {
      return {
        outcome: "passed-over",
        reason: "schema",
        message: `The release ${version}'s database schema, ${manifest.databaseSchemaVersion}, is below this database's, ${database}: it cannot open the database.`,
      };
    }
    return { outcome: "target", release: { version, ...artefact, launcherProtocol: manifest.launcherProtocol, image: manifest.image } };
  };

  /** The pinned or requested `version`'s release: among those listed, else read by its tag; null when there is none that is not a draft. */
  const pinnedRelease = async (version: string, listed: readonly Versioned[]): Promise<Versioned | null | ChannelFailure> => {
    const found = listed.find((candidate) => candidate.version === version);
    if (found !== undefined) return found;
    const answer = await forge.releases.byTag({ ...where, tag: `v${version}` });
    // The list answered, so the release source can be read: a 404 here is no such release, or a draft.
    if (answer.outcome === "failed" && answer.status === 404) return null;
    if (answer.outcome !== "done") return failureOf(answer);
    return { version, release: answer.value };
  };

  const missing = (version: string) => ({ outcome: "passed-over", reason: "missing", message: `No release ${version} is published, or it is a draft.` }) as const;

  /** What the pinned or requested `version` comes to, read after the list. */
  const examineVersion = async (version: string, listed: readonly Versioned[]): Promise<Examined> => {
    const release = await pinnedRelease(version, listed);
    if (release === null) return missing(version);
    if ("outcome" in release) return release;
    return examine(release);
  };

  /** Examines the releases `listed` by version, each at most once however often it is asked for: one read of the channel reads a manifest once. */
  const examinerOf = (listed: readonly Versioned[]): Examiner => {
    const examined = new Map<string, Promise<Examined>>();
    return (version) => {
      const known = examined.get(version) ?? examineVersion(version, listed);
      examined.set(version, known);
      return known;
    };
  };

  // A running version that is no release version (a development build's) runs no release, and none is newer than it.
  const runsRelease = ReleaseVersion.safeParse(harnessVersion).success;
  const runsOn = (version: string): boolean => runsRelease && compareReleaseVersions(version, harnessVersion) === 0;
  const newerThanRunning = (version: string): boolean => runsRelease && compareReleaseVersions(version, harnessVersion) > 0;

  /** The newest release `channel` follows: `stable` the newest without a prerelease part, `beta` the newest of all. */
  const newestOn = (listed: readonly Versioned[], channel: ReleaseChannel): Versioned | null =>
    (channel === "stable" ? listed.find((candidate) => !isPrerelease(candidate.version)) : listed[0]) ?? null;

  /**
   * The stepping stone to `target`: the newest release below it and newer
   * than what runs, on `channel` and not failed, that a launcher speaking
   * `launcherProtocol` hosts; null for none. A release passed over, or whose
   * manifest is not one, is no stepping stone; a forge that cannot be read
   * fails the check.
   */
  const steppingStone = async (
    listed: readonly Versioned[],
    target: string,
    { channel, failed, launcherProtocol }: { readonly channel: ReleaseChannel; readonly failed: ReadonlySet<string>; readonly launcherProtocol: number },
    examineOf: Examiner,
  ): Promise<StageableRelease | null | ChannelFailure> => {
    for (const candidate of listed) {
      if (!newerThanRunning(candidate.version)) break;
      if (compareReleaseVersions(candidate.version, target) >= 0 || failed.has(candidate.version)) continue;
      if (channel === "stable" && isPrerelease(candidate.version)) continue;
      const examined = await examineOf(candidate.version);
      if (examined.outcome === "failed" && examined.reason !== "manifest") return examined;
      if (examined.outcome === "target" && examined.release.launcherProtocol <= launcherProtocol) return examined.release;
    }
    return null;
  };

  /** What a read of the channel under `settings` and `context` finds in the releases `listed`. */
  const readingOf = async (listed: readonly Versioned[], settings: ChannelSettings, context: ChannelContext, examineOf: Examiner): Promise<ChannelReading | ChannelFailure> => {
    const newest = newestOn(listed, settings.channel);
    const reading = (found: Partial<Pick<ChannelReading, "target" | "passedOver" | "stage" | "blocked">> = {}): ChannelReading => ({
      outcome: "read",
      newest: newest?.version ?? null,
      target: null,
      passedOver: null,
      stage: null,
      blocked: null,
      ...found,
    });
    const failed = new Set(context.failedVersions);

    // What would be the target: the pin, unless it runs or failed; else, with auto-update effective, the channel's newest when newer and not failed.
    const { pinnedVersion } = settings;
    const choice =
      pinnedVersion !== null
        ? runsOn(pinnedVersion) || failed.has(pinnedVersion)
          ? null
          : { target: { version: pinnedVersion, source: "pin" } as const, examine: () => examineOf(pinnedVersion) }
        : settings.autoUpdate && newest !== null && newerThanRunning(newest.version) && !failed.has(newest.version)
          ? { target: { version: newest.version, source: "channel" } as const, examine: () => examineOf(newest.version) }
          : null;
    if (choice === null) return reading();
    const examined = await choice.examine();
    if (examined.outcome === "failed") return examined;
    const { target } = choice;
    if (examined.outcome === "passed-over") return reading({ passedOver: { ...target, reason: examined.reason, message: examined.message } });

    // Staged itself when the running launcher hosts it, or no launcher runs (which stages nothing); else through its stepping stone.
    const { launcherProtocol } = context;
    const { release } = examined;
    if (launcherProtocol === null || release.launcherProtocol <= launcherProtocol) return reading({ target, stage: release });
    const stone = await steppingStone(listed, target.version, { channel: settings.channel, failed, launcherProtocol }, examineOf);
    if (stone !== null && "outcome" in stone) return stone;
    if (stone !== null) return reading({ target, stage: stone });
    // A handover to the running version's newer launcher is due unless it already failed.
    if (ownLauncherProtocol > launcherProtocol && context.failedHandoverVersion !== harnessVersion) return reading({ target });
    const installVersion = ownLauncherProtocol > launcherProtocol ? harnessVersion : target.version;
    const message = launcherMessage(target.version, release.launcherProtocol, launcherProtocol, installVersion);
    return reading({ target, blocked: { reason: "launcher", toVersion: target.version, installVersion, message } });
  };

  /** The release `updates.apply` asks for, by `asked` or the newest on `channel`, among the releases `listed`; or why it cannot be. */
  const requestedOf = async (
    asked: string | undefined,
    listed: readonly Versioned[],
    { channel, launcherProtocol, examineOf }: { readonly channel: ReleaseChannel; readonly launcherProtocol: number | null; readonly examineOf: Examiner },
  ): Promise<StageableRelease | ReleaseRefusal> => {
    if (asked !== undefined && runsOn(asked)) return { code: "conflict", message: `This environment runs ${asked} already.`, data: { reason: "current" } };
    const version = asked ?? newestOn(listed, channel)?.version;
    if (version === undefined || (asked === undefined && !newerThanRunning(version))) {
      return { code: "conflict", message: `This environment runs ${harnessVersion}, and nothing newer is published on the ${channel} channel.`, data: { reason: "current" } };
    }
    const examined = await examineOf(version);
    switch (examined.outcome) {
      case "failed":
        return { code: "conflict", message: `The release ${version} cannot be read: ${examined.message}`, data: { reason: examined.reason } };
      case "passed-over":
        return examined.reason === "schema"
          ? { code: "conflict", message: `Cannot update to ${version}: ${examined.message}`, data: { reason: "schema" } }
          : { code: "not_found", message: `Cannot update to ${version}: ${examined.message}`, data: {} };
      case "target": {
        const needs = examined.release.launcherProtocol;
        if (launcherProtocol === null || needs <= launcherProtocol) return examined.release;
        return { code: "conflict", message: `Cannot update to ${version}: ${launcherMessage(version, needs, launcherProtocol)}`, data: { reason: "launcher" } };
      }
    }
  };

  return {
    async read(settings, context) {
      const listed = await list();
      return "outcome" in listed ? listed : readingOf(listed, settings, context, examinerOf(listed));
    },

    async pinRefusal(version) {
      const listed = await list();
      const examined = "outcome" in listed ? listed : await examineVersion(version, listed);
      switch (examined.outcome) {
        case "target":
          return null;
        case "failed":
          return { code: "conflict", message: `The release ${version} cannot be read to pin it: ${examined.message}`, data: { reason: examined.reason } };
        case "passed-over":
          return examined.reason === "schema"
            ? { code: "conflict", message: `${version} cannot be pinned: ${examined.message}`, data: { reason: "schema" } }
            : { code: "not_found", message: `${version} cannot be pinned: ${examined.message}`, data: {} };
      }
    },

    async requested(asked, settings, context) {
      const listed = await list();
      if ("outcome" in listed) return { release: { code: "conflict", message: listed.message, data: { reason: listed.reason } }, reading: listed };
      // Read as a check reads it, so the newest the request is resolved against is the one updates.status shows; a manifest both need is read once.
      const examineOf = examinerOf(listed);
      const reading = await readingOf(listed, settings, context, examineOf);
      return { release: await requestedOf(asked, listed, { channel: settings.channel, launcherProtocol: context.launcherProtocol, examineOf }), reading };
    },

    async desktopBuild(platform, format, { channel, pinnedVersion }) {
      const listed = await list();
      if ("outcome" in listed) return { code: "conflict", message: listed.message, data: { reason: listed.reason } };
      const version = pinnedVersion ?? newestOn(listed, channel)?.version;
      if (version === undefined) return { code: "not_found", message: `No release is published on the ${channel} channel.`, data: {} };
      const found = await pinnedRelease(version, listed);
      if (found === null) return { code: "not_found", message: missing(version).message, data: {} };
      if ("outcome" in found) return { code: "conflict", message: `The release ${version} cannot be read: ${found.message}`, data: { reason: found.reason } };
      const manifest = await manifestOf(version, found.release);
      if ("outcome" in manifest) return { code: "conflict", message: `The release ${version} cannot be read: ${manifest.message}`, data: { reason: manifest.reason } };
      for (const artefact of manifest.assets) {
        if (artefact.kind !== "desktop" || artefact.platform !== platform || artefact.format !== format) continue;
        const asset = found.release.assets.find((published) => published.name === artefact.name);
        if (asset !== undefined) return { version, asset, artefact };
      }
      return { code: "not_found", message: `The release ${version} has no desktop build for ${platform} as ${format}.`, data: {} };
    },

    async download(release, destination) {
      const answer = await forge.releases.download({ ...where, asset: release.asset, destination });
      if (answer.outcome !== "done") return downloadFailureOf(release.version, answer);
      const { name, size, sha256 } = release.artefact;
      if (answer.value.size !== size) return failed("artefact", `The artefact ${name} of ${release.version} is ${answer.value.size} bytes, and its manifest lists ${size}.`);
      if (answer.value.sha256 !== sha256) return failed("artefact", `The artefact ${name} of ${release.version} does not match the SHA-256 its manifest lists.`);
      return null;
    },
  };
};
