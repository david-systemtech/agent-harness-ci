import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELEASE_MANIFEST_FILE,
  normaliseRemote,
  ReleaseManifest,
  ReleaseVersion,
  compareReleaseVersions,
  isPrerelease,
  releaseVersionOfTag,
  type ReleaseAsset,
  type ReleaseChannel,
  type ReleaseSource,
  type UpdateCheckFailure,
  type UpdatePassOverReason,
  type UpdatePassedOver,
  type UpdateTarget,
} from "@agent-harness/contracts";
import type { ForgeService } from "../forge/forge-service.js";
import { servingAccount } from "../forge/git-helper.js";
import type { ForgeAnswer } from "../forge/operations.js";
import type { ForgeRelease } from "../forge/providers.js";

/**
 * Reading the release channel (launcher-update spec, "The release",
 * "Reading the channel" and "The target"; ADR 0007; #346). The release
 * source, an origin and a repository compiled into each build, is read
 * through the ForgeService with the forge account for its origin, since
 * every Forgejo repository is private: with none, the channel is not read
 * at all, anonymously or otherwise, and reads as `no_release_access`
 * (`update credential --stdin` gives it one).
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
 * - **A pin** is checked the same way before it is set: refused when the
 *   release or this platform's artefact is missing, by the schema rule, or
 *   when the release cannot be read.
 */

/** The release source this build reads: the project's Forgejo (ADR 0007); a move to GitHub changes it in one release. */
export const RELEASE_SOURCE: ReleaseSource = { origin: "https://git.systemtech.dev:5526", kind: "forgejo", repository: "david/agent-harness" };

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

/** Why the channel could not be read, for `updates.status` and a refused pin. */
export interface ChannelFailure {
  readonly outcome: "failed";
  readonly reason: Extract<UpdateCheckFailure, "no_release_access" | "unreachable" | "manifest">;
  readonly message: string;
}

/** What a check found: the channel's newest, the target, and a release that would be the target and is not. */
export interface ChannelReading {
  readonly outcome: "read";
  readonly newest: string | null;
  readonly target: UpdateTarget | null;
  readonly passedOver: UpdatePassedOver | null;
}

/** Why a pin is refused, as `updates.settings.set` answers it. */
export type PinRefusal =
  | { readonly code: "not_found"; readonly message: string; readonly data: Record<string, never> }
  | { readonly code: "conflict"; readonly message: string; readonly data: { readonly reason: ChannelFailure["reason"] | "schema" } };

export interface ReleaseChannelReader {
  /** Reads the channel as `settings` follow it: its newest and the target. */
  read(settings: ChannelSettings): Promise<ChannelReading | ChannelFailure>;
  /** Why `version` cannot be pinned, or null when it can. */
  pinRefusal(version: string): Promise<PinRefusal | null>;
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
}

/** A release as the channel reads it: the version its tag names, and the forge's record. */
interface Versioned {
  readonly version: string;
  readonly release: ForgeRelease;
}

/** What a release that would be the target came to: the target, passed over with why, or a failure to read it. */
type Examined = { readonly outcome: "target" } | { readonly outcome: "passed-over"; readonly reason: UpdatePassOverReason; readonly message: string } | ChannelFailure;

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

export const createReleaseChannel = (options: ReleaseChannelOptions): ReleaseChannelReader => {
  const { forge, source, harnessVersion } = options;
  const platform = options.platform ?? RUNNING_PLATFORM;
  const where = { origin: source.origin, kind: source.kind, repository: source.repository, purpose: PURPOSE };

  /**
   * The newest releases that are not drafts, by precedence, newest first; a
   * tag that is no version is passed over. Read only with a forge account
   * for the release origin, never anonymously.
   */
  const list = async (): Promise<readonly Versioned[] | ChannelFailure> => {
    const remote = normaliseRemote(source.origin);
    if (remote === null || servingAccount(remote, forge.list()) === null) {
      return failed(
        "no_release_access",
        `No forge account on this environment covers ${source.origin}, where its releases are published: give it the release token with \`update credential --stdin\`, or add one in Set up, Forges.`,
      );
    }
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

  /** This platform's artefact of the release, as its manifest lists it and the release publishes it; null for none. */
  const artefactOf = (manifest: ReleaseManifest, release: ForgeRelease): ReleaseAsset | null =>
    manifest.assets.find((asset) => asset.kind === "environment" && asset.platform === platform && release.assets.some((published) => published.name === asset.name)) ?? null;

  /** Whether `version`'s release may be the target: its manifest read, this platform's artefact in it, its schema not below the database's. */
  const examine = async ({ version, release }: Versioned): Promise<Examined> => {
    const manifest = await manifestOf(version, release);
    if ("outcome" in manifest) return manifest;
    if (artefactOf(manifest, release) === null) return { outcome: "passed-over", reason: "artefact", message: `The release ${version} has no artefact for ${platform}.` };
    const database = options.databaseSchemaVersion();
    if (manifest.databaseSchemaVersion < database) {
      return {
        outcome: "passed-over",
        reason: "schema",
        message: `The release ${version}'s database schema, ${manifest.databaseSchemaVersion}, is below this database's, ${database}: it cannot open the database.`,
      };
    }
    return { outcome: "target" };
  };

  /** The pinned `version`'s release: among those listed, else read by its tag; null when there is none that is not a draft. */
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

  /** What the pinned `version` comes to, read after the list. */
  const examinePin = async (version: string, listed: readonly Versioned[]): Promise<Examined> => {
    const release = await pinnedRelease(version, listed);
    if (release === null) return missing(version);
    if ("outcome" in release) return release;
    return examine(release);
  };

  // A running version that is no release version (a development build's) runs no release, and none is newer than it.
  const runsRelease = ReleaseVersion.safeParse(harnessVersion).success;
  const runsOn = (version: string): boolean => runsRelease && compareReleaseVersions(version, harnessVersion) === 0;

  return {
    async read(settings) {
      const listed = await list();
      if ("outcome" in listed) return listed;
      const newest = (settings.channel === "stable" ? listed.find((candidate) => !isPrerelease(candidate.version)) : listed[0]) ?? null;
      const reading = (target: UpdateTarget | null, passedOver: UpdatePassedOver | null): ChannelReading => ({ outcome: "read", newest: newest?.version ?? null, target, passedOver });

      let candidate: { readonly version: string; readonly source: UpdateTarget["source"] } | null = null;
      let examined: Examined | undefined;
      if (settings.pinnedVersion !== null) {
        candidate = { version: settings.pinnedVersion, source: "pin" };
        if (runsOn(candidate.version)) return reading(null, null);
        examined = await examinePin(candidate.version, listed);
      } else if (settings.autoUpdate && newest !== null && runsRelease && compareReleaseVersions(newest.version, harnessVersion) > 0) {
        candidate = { version: newest.version, source: "channel" };
        examined = await examine(newest);
      }
      if (candidate === null || examined === undefined) return reading(null, null);
      if (examined.outcome === "failed") return examined;
      if (examined.outcome === "passed-over") return reading(null, { ...candidate, reason: examined.reason, message: examined.message });
      return reading(candidate, null);
    },

    async pinRefusal(version) {
      const listed = await list();
      const examined = "outcome" in listed ? listed : await examinePin(version, listed);
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
  };
};
