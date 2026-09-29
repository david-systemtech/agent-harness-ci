import { z } from "zod";
import { LauncherProtocol, ProtocolVersion } from "./flags.js";
import { ForgeOrigin } from "./forge.js";
import { RELEASE_VERSION_PATTERN } from "./launcher.js";

/**
 * A release (launcher-update spec, "The release"): what one version publishes
 * on the project's Forgejo, tagged `v<version>`.
 */

/**
 * A release's version as a person names it: its semantic version without the
 * tag's `v` (`0.4.2`, `1.0.0-beta.2`). A version with a prerelease part is a
 * prerelease, which only the beta channel follows.
 */
export const ReleaseVersion = z.string().regex(RELEASE_VERSION_PATTERN).meta({
  description:
    "A release's version: a semantic version without the tag's v (0.4.2, 1.0.0-beta.2); one with a prerelease part is a prerelease, which only the beta channel follows.",
});
export type ReleaseVersion = z.infer<typeof ReleaseVersion>;

/** The release version a release's tag names (`v0.5.0`), or null for a tag that is not `v` and a release version. */
export const releaseVersionOfTag = (tag: string): string | null => {
  const version = tag.startsWith("v") ? tag.slice(1) : null;
  return version !== null && RELEASE_VERSION_PATTERN.test(version) ? version : null;
};

/**
 * Where an environment reads its releases (launcher-update spec, "The
 * release"): the forge's origin and kind, and the repository on it. Compiled
 * into each build, so a move to GitHub changes it in one release (ADR 0007);
 * the environment reads it through the ForgeService with the forge account
 * for that origin.
 */
export const ReleaseSource = z
  .object({
    origin: ForgeOrigin,
    kind: z.enum(["github", "forgejo", "gitea"]).meta({ description: "The kind of forge the origin is, which the releases are read with." }),
    repository: z
      .string()
      .regex(/^(?!\.\.?\/)[A-Za-z0-9._-]+\/(?!\.\.?$)[A-Za-z0-9._-]+$/)
      .meta({ description: "The repository the releases are published on, owner/name." }),
  })
  .meta({ description: "Where the environment reads its releases: the forge's origin and kind, and the repository, owner/name; compiled into each build." });
export type ReleaseSource = z.infer<typeof ReleaseSource>;

/** The release manifest's file name among the release's assets. */
export const RELEASE_MANIFEST_FILE = "release.json";

/**
 * The kinds of asset this version publishes: the environment's self-contained
 * artefact per platform, the desktop builds, the install scripts, the compose
 * file, the host-side updater and the contracts' JSON Schema export. A later
 * release may publish another kind, which a reader passes over.
 */
export const RELEASE_ASSET_KINDS = ["environment", "desktop", "install-script", "compose", "host-updater", "schema"] as const;

/** The platforms milestone 1 publishes for, as Node names an OS and an architecture. A later release may add others. */
export const RELEASE_PLATFORMS = ["linux-x64", "darwin-arm64", "win32-x64"] as const;

/** A SHA-256 digest as 64 lowercase hexadecimal digits, the `.sha256` sidecar's format. */
export const Sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .meta({ description: "A SHA-256 digest: 64 lowercase hexadecimal digits." });
export type Sha256 = z.infer<typeof Sha256>;

/**
 * What an asset is. Open, so a manifest a later release publishes with a kind
 * this version does not know still reads: an environment picks the assets it
 * knows and passes over the rest.
 */
export const ReleaseAssetKind = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .meta({
    description: `What an asset is: ${RELEASE_ASSET_KINDS.join(", ")} (environment being the environment's self-contained artefact for one platform); a kind the reader does not know is a later release's, and is passed over.`,
  });

/** A platform, `<os>-<arch>` as Node names them. Open for the same reason as the kind. */
export const ReleasePlatform = z
  .string()
  .regex(/^[a-z0-9]+-[a-z0-9]+$/)
  .meta({ description: `A platform, <os>-<arch> as Node names them: ${RELEASE_PLATFORMS.join(", ")}; a later release may add others.` });
export type ReleasePlatform = z.infer<typeof ReleasePlatform>;

/** How an asset is packed, where it is an archive or an installer: the desktop is staged by the format its shell installs. */
export const AssetFormat = z
  .string()
  .regex(/^[a-z0-9]+(?:\.[a-z0-9]+)*$/)
  .meta({
    description:
      "How an asset is packed: tar.gz or zip for the environment's artefacts, zip (a macOS bundle), nsis (a Windows setup) or pacman (an Arch package) for the desktop's, as its shell reports the format it installs.",
  });
export type AssetFormat = z.infer<typeof AssetFormat>;

/** One asset of a release, as the manifest lists it. */
export const ReleaseAsset = z
  .object({
    name: z.string().min(1).meta({ description: "The asset's file name on the release: agent-harness-linux-x64.tar.gz." }),
    kind: ReleaseAssetKind,
    platform: ReleasePlatform.nullable().meta({ description: "The platform it is built for; null for one any platform takes, such as a script." }),
    format: AssetFormat.nullable().meta({ description: "How it is packed; null for a plain file." }),
    size: z.int().nonnegative().meta({ description: "Its size in bytes, checked with its SHA-256 before it is unpacked." }),
    sha256: Sha256,
  })
  .meta({ description: "One asset of a release: its name, kind, platform, format, size and SHA-256." });
export type ReleaseAsset = z.infer<typeof ReleaseAsset>;

/** The container image a release publishes, by its exact reference and digest: never a moving tag. */
export const ReleaseImage = z
  .object({
    reference: z.string().min(1).meta({ description: "The image's reference, tagged with the exact version: git.systemtech.dev:5526/david/agent-harness:0.5.0." }),
    digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .meta({ description: "The image's digest, sha256: then 64 lowercase hexadecimal digits: a pull is checked against it." }),
  })
  .meta({ description: "The release's container image: its exact version reference and its digest." });
export type ReleaseImage = z.infer<typeof ReleaseImage>;

/**
 * The release manifest, `release.json` (the glossary's Release manifest):
 * what an environment reads of a release before it downloads anything of
 * it. Written by the release build (#356), read by the update coordinator
 * and the host-side updater. A later release only ever adds to it: a field,
 * an asset kind or a platform an older reader does not know is passed over.
 */
export const ReleaseManifest = z
  .object({
    version: ReleaseVersion,
    protocolVersion: ProtocolVersion,
    launcherProtocol: LauncherProtocol.meta({ description: "The launcher protocol the release's environment needs; a launcher that speaks a lower one refuses to install it." }),
    databaseSchemaVersion: z.int().nonnegative().meta({
      description: "The number of the release's last database migration: a release below the database's is never a target.",
    }),
    bundledClaudeCodeVersion: z.string().min(1).meta({ description: "The version of Claude Code the release bundles, which updates with the environment." }),
    assets: z.array(ReleaseAsset).meta({ description: "Every asset the release publishes but the manifest itself and the .sha256 sidecars." }),
    image: ReleaseImage,
  })
  .meta({
    description:
      "The release manifest, release.json: the release's version, protocol version, launcher protocol, database schema version and bundled Claude Code version, its assets, and its container image.",
  });
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;
