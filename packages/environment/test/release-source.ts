import { randomUUID } from "node:crypto";
import { LAUNCHER_PROTOCOL, PROTOCOL_VERSION, RELEASE_MANIFEST_FILE, type ReleaseManifest, type ReleaseSource } from "@agent-harness/contracts";
import { MIGRATIONS } from "../src/event-log/migrations.js";
import { RUNNING_PLATFORM } from "../src/updates/channel.js";
import { startFakeForge, type FakeForge, type FakeForgeRequest } from "./fake-forge.js";
import { DAVID, TOKEN, pasted } from "./forge.js";
import type { WireClient } from "./wire-client.js";

/**
 * The fake release source (launcher-update spec, "Testing Decisions"; #346):
 * the fake forge answering the Gitea API's release list, releases by tag and
 * the web route an asset downloads from, as a Forgejo release source does,
 * with a manifest and assets per release. It answers the test's token, as
 * the forge account for its origin holds it; any other token is refused
 * 401, as the fake forge refuses one it does not know.
 */

/** The database schema of a test environment's database: the last migration, which every start applies. */
export const DATABASE_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

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

/** A whole manifest of `version`: this platform's artefact and a script, the database's schema. */
export const manifestOf = (version: string, fields: Partial<ReleaseManifest> = {}): ReleaseManifest => ({
  version,
  protocolVersion: PROTOCOL_VERSION,
  launcherProtocol: LAUNCHER_PROTOCOL,
  databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
  bundledClaudeCodeVersion: "2.1.0-test",
  assets: [
    { name: ARTEFACT, kind: "environment", platform: RUNNING_PLATFORM, format: "tar.gz", size: 12, sha256: "a".repeat(64) },
    { name: "install.sh", kind: "install-script", platform: null, format: null, size: 3, sha256: "b".repeat(64) },
  ],
  image: { reference: `git.example.com/david/agent-harness:${version}`, digest: `sha256:${"0".repeat(64)}` },
  ...fields,
});

const REPOSITORY = "david/agent-harness";
const API = `/api/v1/repos/${REPOSITORY}/releases`;
const DOWNLOAD = `/${REPOSITORY}/releases/download`;

/** Starts a fake release source on a fake forge of its own; the caller closes its forge. */
export const startFakeReleaseSource = async (): Promise<FakeReleaseSource> => {
  const forge = await startFakeForge();
  const caller = TOKEN;
  const published: { readonly id: number; readonly body: Record<string, unknown> }[] = [];

  forge.answer(caller, `GET ${API}`, () => ({ status: 200, body: published.map((release) => release.body).reverse() }));

  return {
    source: { origin: forge.origin, kind: "forgejo", repository: REPOSITORY },
    forge,
    publish(...releases) {
      for (const release of releases) {
        const id = published.length + 1;
        const tag = release.tag ?? `v${release.version}`;
        const manifest = release.manifest === undefined ? manifestOf(release.version) : release.manifest === null ? null : typeof release.manifest === "string" ? release.manifest : manifestOf(release.version, release.manifest);
        const text = manifest === null ? null : typeof manifest === "string" ? manifest : JSON.stringify(manifest);
        const names = [...(text === null ? [] : [RELEASE_MANIFEST_FILE]), ...(manifest === null || typeof manifest === "string" ? [ARTEFACT] : manifest.assets.map((asset) => asset.name))];
        const assets = names.map((name, index) => ({
          id: id * 100 + index,
          name,
          size: name === RELEASE_MANIFEST_FILE && text !== null ? Buffer.byteLength(text) : 12,
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
        forge.answer(caller, `GET ${API}/tags/${encodeURIComponent(tag)}`, { status: 200, body });
        if (text !== null) forge.answer(caller, `GET ${DOWNLOAD}/${encodeURIComponent(tag)}/${RELEASE_MANIFEST_FILE}`, { status: 200, raw: text });
      }
    },
    absent(version) {
      forge.answer(caller, `GET ${API}/tags/v${encodeURIComponent(version)}`, { status: 404, body: { message: "Not Found" } });
    },
    reads: () => forge.requests.filter((request) => request.path.startsWith(API) || request.path.startsWith(DOWNLOAD)),
    async grantAccess(client) {
      forge.user(TOKEN, DAVID);
      const answer = await client.request("forge.accounts.add", { commandId: randomUUID(), forgeAccountId: randomUUID(), url: forge.origin, kind: "forgejo", credential: pasted(TOKEN) });
      if (answer.result === undefined) throw new Error(`The forge account for the release origin was not added: ${JSON.stringify(answer.receipt)}`);
    },
  };
};
