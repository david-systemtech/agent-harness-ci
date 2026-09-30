import { openAsBlob, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPrerelease, RELEASE_MANIFEST_FILE, ReleaseManifest, releaseVersionOfTag } from "@agent-harness/contracts";
import { sha256OfFile } from "./archive.js";

/**
 * The release publisher (launcher-update spec, "The release"; #358): the
 * release workflow's last step, which puts the folder the build wrote on
 * the tag's Forgejo release. It checks the folder against its
 * `release.json` (read through the contracts' schema), uploads every file to
 * a draft, checks the draft holds them all, and publishes it last, so no
 * reader sees a partial release; a prerelease exactly when the version has a
 * prerelease part. A draft an earlier run of the tag left is replaced; a
 * published release is never touched.
 */

/** Publishing cannot go on: the message says why. A draft it made stays a draft. */
export class PublishError extends Error {
  override readonly name = "PublishError";
}

/** The repository a release is published on, and a token that can write its releases. */
export interface ReleaseRepository {
  /** The forge's origin: `https://git.systemtech.dev:5526`. */
  readonly server: string;
  /** `owner/name`. */
  readonly repository: string;
  readonly token: string;
}

/** What is published: the tag's release, from the folder the build wrote. */
export interface PublishOptions {
  readonly tag: string;
  readonly folder: string;
}

export interface PublishSeams {
  /** Where the publisher says what it does; preset: standard output. */
  readonly log?: (line: string) => void;
}

/** A release as the forge answers it, the parts read here. */
interface ForgeRelease {
  readonly id: number;
  readonly draft: boolean;
  readonly assets: readonly { readonly name: string; readonly size: number }[];
}

/** The version `tag` names, or a `PublishError`. */
const versionOf = (tag: string): string => {
  const version = releaseVersionOfTag(tag);
  if (version === null) throw new PublishError(`The tag ${JSON.stringify(tag)} is not v and a semantic version (v0.5.0, v1.0.0-beta.2): a release is published only from one.`);
  return version;
};

const releaseOf = (value: unknown): ForgeRelease => {
  const release = value as Partial<ForgeRelease> | null;
  if (typeof release?.id !== "number" || typeof release.draft !== "boolean" || !Array.isArray(release.assets)) {
    throw new PublishError(`The forge answered a release without its id, draft flag and assets: ${JSON.stringify(value).slice(0, 200)}`);
  }
  return release as ForgeRelease;
};

/** The release API of `forge`'s repository, each call answering one of the statuses it expects or failing with the forge's answer, never the token. */
const releasesOf = (forge: ReleaseRepository) => {
  const api = `${forge.server.replace(/\/+$/, "")}/api/v1/repos/${forge.repository}/releases`;
  const call = async (method: string, path: string, expected: readonly number[], body?: FormData | object): Promise<Response> => {
    const json = body !== undefined && !(body instanceof FormData);
    const response = await fetch(`${api}${path}`, {
      method,
      headers: { authorization: `token ${forge.token}`, accept: "application/json", ...(json && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: json ? JSON.stringify(body) : (body as FormData) }),
    }).catch((error: unknown) => {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      throw new PublishError(`${method} ${api}${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    if (!expected.includes(response.status)) {
      const answer = (await response.text()).trim().slice(0, 300);
      throw new PublishError(`${method} ${api}${path} answered ${response.status}${answer === "" ? "" : `: ${answer}`}`);
    }
    return response;
  };
  return {
    /** The tag's release, a draft included (the token can write), or null when the tag has none. */
    ofTag: async (tag: string): Promise<ForgeRelease | null> => {
      const response = await call("GET", `/tags/${encodeURIComponent(tag)}`, [200, 404]);
      return response.status === 404 ? null : releaseOf(await response.json());
    },
    get: async (id: number): Promise<ForgeRelease> => releaseOf(await (await call("GET", `/${id}`, [200])).json()),
    createDraft: async (tag: string, prerelease: boolean): Promise<ForgeRelease> =>
      releaseOf(await (await call("POST", "", [201], { tag_name: tag, name: tag, body: "", draft: true, prerelease })).json()),
    /** Deletes the release `id`; Forgejo keeps its tag and drops its assets. */
    remove: async (id: number): Promise<void> => void (await call("DELETE", `/${id}`, [204])),
    upload: async (id: number, name: string, path: string): Promise<void> => {
      const form = new FormData();
      form.set("attachment", await openAsBlob(path), name);
      await call("POST", `/${id}/assets?name=${encodeURIComponent(name)}`, [201], form);
    },
    publish: async (id: number): Promise<ForgeRelease> => releaseOf(await (await call("PATCH", `/${id}`, [200], { draft: false })).json()),
  };
};

/** The sidecar line of the file `name` whose SHA-256 is `sha256`: `sha256sum`'s, as the build writes it. */
const sidecarLine = (sha256: string, name: string): string => `${sha256}  ${name}\n`;

/**
 * The files the release publishes from `folder`, in upload order (each
 * asset `release.json` lists then its sidecar, `release.json` and its
 * sidecar last), after checking that the manifest is one the schema reads
 * for the tag's version, that the folder holds those files and nothing else,
 * that each asset is the file listed, and that each sidecar names its file's
 * SHA-256. Any other is a `PublishError`.
 */
const releaseFiles = async (folder: string, tag: string, version: string): Promise<{ name: string; size: number }[]> => {
  let text: string;
  try {
    text = readFileSync(join(folder, RELEASE_MANIFEST_FILE), "utf8");
  } catch {
    throw new PublishError(`${folder} holds no ${RELEASE_MANIFEST_FILE}: the build writes it last.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PublishError(`${RELEASE_MANIFEST_FILE} is not a release manifest: it is not JSON.`);
  }
  const manifest = ReleaseManifest.safeParse(parsed);
  if (!manifest.success) throw new PublishError(`${RELEASE_MANIFEST_FILE} is not a release manifest: ${manifest.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}.`);
  if (manifest.data.version !== version) throw new PublishError(`${RELEASE_MANIFEST_FILE} names the version ${manifest.data.version}, not ${tag}'s ${version}.`);
  const listed = [...manifest.data.assets.map((asset) => asset.name), RELEASE_MANIFEST_FILE];
  const names = listed.flatMap((name) => [name, `${name}.sha256`]);
  const present = new Set(readdirSync(folder));
  for (const name of listed) if (!present.has(name)) throw new PublishError(`${name}, which ${RELEASE_MANIFEST_FILE} lists, is not in ${folder}.`);
  for (const name of names) if (!present.has(name)) throw new PublishError(`${name} is not in ${folder}: every asset is published with its .sha256 sidecar.`);
  for (const name of present) if (!names.includes(name)) throw new PublishError(`${folder} holds ${name}, which ${RELEASE_MANIFEST_FILE} does not list: the release publishes every file it holds, and lists them all.`);
  for (const asset of manifest.data.assets) {
    const path = join(folder, asset.name);
    if (statSync(path).size !== asset.size || (await sha256OfFile(path)) !== asset.sha256) {
      throw new PublishError(`${asset.name} is not the file ${RELEASE_MANIFEST_FILE} lists: its size or SHA-256 differs.`);
    }
  }
  for (const name of listed) {
    if (readFileSync(join(folder, `${name}.sha256`), "utf8") !== sidecarLine(await sha256OfFile(join(folder, name)), name)) {
      throw new PublishError(`${name}.sha256 does not hold ${name}'s SHA-256 as sha256sum writes it.`);
    }
  }
  return names.map((name) => ({ name, size: statSync(join(folder, name)).size }));
};

/** The release of `tag` on `forge` when it may be published over, else a `PublishError`: a published one is never replaced. */
const unpublishedRelease = async (releases: ReturnType<typeof releasesOf>, tag: string): Promise<ForgeRelease | null> => {
  const release = await releases.ofTag(tag);
  if (release !== null && !release.draft) throw new PublishError(`${tag} is already published: a published release is never replaced, so tag a new version instead.`);
  return release;
};

/**
 * Checks, before a tag's run builds or pushes anything, that its release is
 * not yet published: none, or a draft an earlier run left, which the
 * publish step replaces. A published one is a `PublishError`.
 */
export const checkUnpublished = async (tag: string, forge: ReleaseRepository, seams: PublishSeams = {}): Promise<void> => {
  const log = seams.log ?? ((line: string) => console.log(line));
  versionOf(tag);
  const release = await unpublishedRelease(releasesOf(forge), tag);
  log(release === null ? `${tag} has no release yet.` : `${tag} has a draft release, which this run replaces.`);
};

/** Publishes the tag's release from the folder the build wrote (see the module's comment); any failure is a `PublishError` or the error that stopped it. */
export const publishRelease = async ({ tag, folder }: PublishOptions, forge: ReleaseRepository, seams: PublishSeams = {}): Promise<void> => {
  const log = seams.log ?? ((line: string) => console.log(line));
  const version = versionOf(tag);
  const files = await releaseFiles(folder, tag, version);
  const releases = releasesOf(forge);
  const earlier = await unpublishedRelease(releases, tag);
  if (earlier !== null) {
    await releases.remove(earlier.id);
    log(`${tag}: removed the draft an earlier run left`);
  }
  const prerelease = isPrerelease(version);
  const draft = await releases.createDraft(tag, prerelease);
  log(`${tag}: created a draft${prerelease ? " prerelease" : ""}`);
  for (const file of files) {
    await releases.upload(draft.id, file.name, join(folder, file.name));
    log(`${tag}: uploaded ${file.name} (${file.size} bytes)`);
  }
  const held = new Map((await releases.get(draft.id)).assets.map((asset) => [asset.name, asset.size]));
  const differences = [
    ...files.filter((file) => held.get(file.name) !== file.size).map((file) => (held.has(file.name) ? `${file.name} of ${held.get(file.name)} bytes, not ${file.size}` : `missing ${file.name}`)),
    ...[...held.keys()].filter((name) => !files.some((file) => file.name === name)).map((name) => `${name} never uploaded`),
  ];
  if (differences.length > 0) throw new PublishError(`The draft of ${tag} holds ${held.size} files, not the ${files.length} uploaded (${differences.join("; ")}), so it stays a draft.`);
  const published = await releases.publish(draft.id);
  if (published.draft) throw new PublishError(`The forge still answers ${tag} as a draft after publishing it.`);
  log(`${tag}: published${prerelease ? " as a prerelease" : ""}, ${files.length} files`);
};
