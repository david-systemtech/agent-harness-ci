import { createHash, randomUUID } from "node:crypto";
import { LAUNCHER_PROTOCOL, PROTOCOL_VERSION, RELEASE_MANIFEST_FILE, type ReleaseAsset, type ReleaseManifest, type ReleaseSource } from "@agent-harness/contracts";
import { DATABASE_SCHEMA_VERSION } from "../src/event-log/migrations.js";
import { RUNNING_PLATFORM } from "../src/updates/channel.js";
import { startFakeForge, type FakeForge, type FakeForgeRequest, type FakeForgeScript } from "./fake-forge.js";
import { DAVID, TOKEN, pasted } from "./forge.js";
import type { WireClient } from "./wire-client.js";

/**
 * The fake release source (launcher-update spec, "Testing Decisions"; #346):
 * the fake forge answering the Gitea API's release list, releases by tag and
 * the web route an asset downloads from, as a Forgejo release source does,
 * or GitHub's releases and asset API via the fake forge's fetch mapping.
 * GitHub reads answer anonymously as well as with the test token,
 * with a manifest and assets per release, and this platform's artefact's
 * bytes where a release is given them (#347), and the desktop builds a
 * release is given (#354). It answers the test's token, as
 * the forge account for its origin holds it; any other token is refused
 * 401, as the fake forge refuses one it does not know.
 */

/** The database schema of a test environment's database: the last migration, which every start applies. */
export { DATABASE_SCHEMA_VERSION };

/** The name of this platform's artefact, as a release publishes it. */
export const ARTEFACT = `agent-harness-${RUNNING_PLATFORM}.tar.gz`;

/** A release as a test publishes it. */
export interface FakeRelease {
  /** Its version: the tag is `v` and it, unless `tag` names another. */
  readonly version: string;
  /** A tag that is not `v` and the version. */
  readonly tag?: string;
  readonly draft?: boolean;
  /**
   * What its `release.json` holds: fields over a whole manifest of the
   * version (this platform's artefact, the database's schema), text sent as
   * it is, or null for a release that publishes none.
   */
  readonly manifest?: Partial<ReleaseManifest> | string | null;
  /**
   * The bytes of this platform's artefact, which the release then serves
   * for download and its manifest lists with their size and SHA-256 (unless
   * `manifest` names the assets itself). Without them the artefact is listed
   * and not served.
   */
  readonly artefact?: Uint8Array;
  /** Desktop builds the release publishes and serves, each listed in its manifest (after the assets it names otherwise). */
  readonly desktop?: readonly FakeDesktopBuild[];
}

/** A desktop build a release publishes: its name, platform, format and bytes, listed in the manifest with their size and SHA-256 unless `listed` says otherwise. */
export interface FakeDesktopBuild {
  readonly name: string;
  readonly platform: string;
  readonly format: string;
  readonly bytes: Uint8Array;
  /** Fields of its manifest entry over those its bytes give: a SHA-256 its bytes do not have, say. */
  readonly listed?: Partial<ReleaseAsset>;
}

export interface FakeReleaseSource {
  /** The release source an environment is started with. */
  readonly source: ReleaseSource;
  readonly forge: FakeForge;
  /** Publishes releases, each after the one before: the forge lists the last published first. */
  publish(...releases: readonly FakeRelease[]): void;
  /** Answers a read of `version`'s tag 404, as a forge answers a tag it holds no release for. */
  absent(version: string): void;
  /** Every request of the release routes so far, in order. */
  reads(): FakeForgeRequest[];
  /** Adds the forge account for the release origin with the test's token, through the wire. */
  grantAccess(client: WireClient): Promise<void>;
}

/** The SHA-256 of `bytes`, as a manifest lists an asset's. */
export const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A whole manifest of `version`: this platform's artefact (of `artefact`'s size and SHA-256, when given) and a script, the database's schema. */
export const manifestOf = (version: string, fields: Partial<ReleaseManifest> = {}, artefact?: Uint8Array): ReleaseManifest => ({
  version,
  protocolVersion: PROTOCOL_VERSION,
  launcherProtocol: LAUNCHER_PROTOCOL,
  databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
  bundledClaudeCodeVersion: "2.1.0-test",
  assets: [
    {
      name: ARTEFACT,
      kind: "environment",
      platform: RUNNING_PLATFORM,
      format: "tar.gz",
      size: artefact?.byteLength ?? 12,
      sha256: artefact === undefined ? "a".repeat(64) : sha256Of(artefact),
    },
    { name: "install.sh", kind: "install-script", platform: null, format: null, size: 3, sha256: "b".repeat(64) },
  ],
  image: { reference: `git.example.com/david/agent-harness:${version}`, digest: `sha256:${"0".repeat(64)}` },
  ...fields,
});

/** A desktop build as a manifest lists it: kind `desktop`, its platform and format, the size and SHA-256 of its bytes. */
export const desktopEntry = (build: FakeDesktopBuild): ReleaseAsset => ({
  name: build.name,
  kind: "desktop",
  platform: build.platform,
  format: build.format,
  size: build.bytes.byteLength,
  sha256: sha256Of(build.bytes),
  ...build.listed,
});

const REPOSITORY = "david/agent-harness";

/** Starts a fake release source on a fake forge of its own; the caller closes its forge. */
export const startFakeReleaseSource = async (kind: "forgejo" | "github" = "forgejo"): Promise<FakeReleaseSource> => {
  const forge = await startFakeForge();
  const source: ReleaseSource = kind === "github"
    ? { origin: "https://github.com", kind, repository: "david-systemtech/agent-harness" }
    : { origin: forge.origin, kind, repository: REPOSITORY };
  const API = `/${kind === "github" ? "api/v3" : "api/v1"}/repos/${source.repository}/releases`;
  const DOWNLOAD = `/${source.repository}/releases/download`;
  const callers = kind === "github" ? [TOKEN, null] : [TOKEN];
  const answer = (route: string, reply: FakeForgeScript) => {
    for (const caller of callers) forge.answer(caller, route, reply);
  };
  const published: { readonly id: number; readonly body: Record<string, unknown> }[] = [];

  answer(`GET ${API}`, () => ({ status: 200, body: published.map((release) => release.body).reverse() }));

  return {
    source,
    forge,
    publish(...releases) {
      for (const release of releases) {
        const id = published.length + 1;
        const tag = release.tag ?? `v${release.version}`;
        const desktop = release.desktop ?? [];
        const described =
          release.manifest === null ? null : typeof release.manifest === "string" ? release.manifest : manifestOf(release.version, { ...(kind === "github" && { image: { reference: `ghcr.io/david-systemtech/agent-harness:${release.version}`, digest: `sha256:${"0".repeat(64)}` } }), ...release.manifest }, release.artefact);
        const manifest =
          described === null || typeof described === "string"
            ? described
            : { ...described, assets: [...described.assets, ...desktop.map((build) => desktopEntry(build))] };
        const text = manifest === null ? null : typeof manifest === "string" ? manifest : JSON.stringify(manifest);
        const names = [...(text === null ? [] : [RELEASE_MANIFEST_FILE]), ...(manifest === null || typeof manifest === "string" ? [ARTEFACT] : manifest.assets.map((asset) => asset.name))];
        const assets = names.map((name, index) => ({
          id: id * 100 + index,
          name,
          size:
            name === RELEASE_MANIFEST_FILE && text !== null
              ? Buffer.byteLength(text)
              : name === ARTEFACT && release.artefact !== undefined
                ? release.artefact.byteLength
                : (desktop.find((build) => build.name === name)?.bytes.byteLength ?? 12),
          uuid: randomUUID(),
          browser_download_url: `${forge.origin}${DOWNLOAD}/${encodeURIComponent(tag)}/${name}`,
        }));
        const body = {
          id,
          tag_name: tag,
          name: tag,
          draft: release.draft === true,
          prerelease: release.version.includes("-"),
          published_at: release.draft === true ? null : "2026-09-23T00:00:00Z",
          assets,
        };
        published.push({ id, body });
        answer(`GET ${API}/tags/${encodeURIComponent(tag)}`, { status: 200, body });
        const assetRoute = (name: string) => kind === "github" ? `${API}/assets/${assets.find((asset) => asset.name === name)!.id}` : `${DOWNLOAD}/${encodeURIComponent(tag)}/${name}`;
        if (text !== null) answer(`GET ${assetRoute(RELEASE_MANIFEST_FILE)}`, { status: 200, raw: text });
        if (release.artefact !== undefined) answer(`GET ${assetRoute(ARTEFACT)}`, { status: 200, raw: release.artefact });
        for (const build of desktop) answer(`GET ${assetRoute(build.name)}`, { status: 200, raw: build.bytes });
      }
    },
    absent(version) {
      answer(`GET ${API}/tags/v${encodeURIComponent(version)}`, { status: 404, body: { message: "Not Found" } });
    },
    reads: () => forge.requests.filter((request) => request.path.startsWith(API) || request.path.startsWith(DOWNLOAD)),
    async grantAccess(client) {
      forge.user(TOKEN, DAVID);
      const answer = await client.request("forge.accounts.add", { commandId: randomUUID(), forgeAccountId: randomUUID(), url: source.origin, kind, credential: pasted(TOKEN) });
      if (answer.result === undefined) throw new Error(`The forge account for the release origin was not added: ${JSON.stringify(answer.receipt)}`);
    },
  };
};
