import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  MANAGED_TOOL_NAMES,
  ManagedToolName,
  ManagedToolVersion,
  compareToolVersions,
  type ManagedToolInstallMethod,
} from "@agent-harness/contracts";
import type { Clock } from "../serve/clock.js";
import { writeFileAtomic } from "../serve/files.js";

/**
 * The latest version of each managed tool (key-managers spec, "Managed
 * tools"; ADR 0026; #374): fetched by the environment, never a client, at
 * most once a day per tool, from the source matching the tool's install
 * method (the Homebrew API for `homebrew`, WinGet's manifests for `winget`,
 * the npm registry for `npm`), else from the vendor's release feed, which
 * for `bao`, `doppler`, `bws` and `gh` is their GitHub releases. What was
 * fetched is cached in the data directory, so a restart keeps it and does
 * not fetch again within the day. A fetch that fails, or takes longer than
 * ten seconds on the environment's clock, leaves the last version known in
 * place, or none, and counts as the day's fetch.
 */

/** Where each kind of release source is read: an origin with any path prefix. Tests point every one at a loopback fake. */
export interface ReleaseOrigins {
  /** The Homebrew API: a formula's `formula/<name>.json`, a cask's `cask/<name>.json`. */
  readonly homebrew: string;
  /** The npm registry: `<package>/latest`. */
  readonly npm: string;
  /** GitHub's REST API: a repository's releases, and the contents of WinGet's manifests repository. */
  readonly github: string;
  /** Claude Code's release channels: `latest`, the version the channel points at. */
  readonly claude: string;
  /** 1Password's update feed. */
  readonly onePassword: string;
  /** HashiCorp's releases API. */
  readonly hashicorp: string;
}

/** The release sources' real origins. */
export const RELEASE_ORIGINS: ReleaseOrigins = {
  homebrew: "https://formulae.brew.sh/api",
  npm: "https://registry.npmjs.org",
  github: "https://api.github.com",
  claude: "https://downloads.claude.ai/claude-code-releases",
  onePassword: "https://app-updates.agilebits.com",
  hashicorp: "https://api.releases.hashicorp.com",
};

/** One place a tool's releases are published. */
export type ReleaseSource =
  | { readonly kind: "homebrew-formula"; readonly name: string }
  | { readonly kind: "homebrew-cask"; readonly name: string }
  | { readonly kind: "npm"; readonly name: string }
  | { readonly kind: "winget"; readonly id: string }
  /** A repository's GitHub releases whose tags are `prefix`, an optional `v`, and the version. */
  | { readonly kind: "github"; readonly repository: string; readonly prefix: string }
  | { readonly kind: "claude-channel"; readonly channel: "latest" }
  | { readonly kind: "onepassword"; readonly product: "CLI2" }
  | { readonly kind: "hashicorp"; readonly product: string };

/** Where a tool is published: for the methods whose own source can say, that source; and the vendor's release feed for every other method. */
interface ToolReleases {
  readonly homebrew?: ReleaseSource;
  readonly winget?: ReleaseSource;
  readonly npm?: ReleaseSource;
  readonly feed: ReleaseSource;
}

/**
 * Where each tool is published (the Homebrew names and WinGet ids are the
 * key-managers spec's command table's). `vault` left Homebrew's core when
 * its licence changed and WinGet's table here never installs it, so it is
 * HashiCorp's releases alone; `bws` is on neither.
 */
export const TOOL_RELEASES: Readonly<Record<ManagedToolName, ToolReleases>> = {
  claude: {
    homebrew: { kind: "homebrew-cask", name: "claude-code" },
    winget: { kind: "winget", id: "Anthropic.ClaudeCode" },
    npm: { kind: "npm", name: "@anthropic-ai/claude-code" },
    feed: { kind: "claude-channel", channel: "latest" },
  },
  bao: {
    homebrew: { kind: "homebrew-formula", name: "openbao" },
    winget: { kind: "winget", id: "OpenBao.OpenBao" },
    feed: { kind: "github", repository: "openbao/openbao", prefix: "" },
  },
  vault: { feed: { kind: "hashicorp", product: "vault" } },
  doppler: {
    homebrew: { kind: "homebrew-formula", name: "doppler" },
    winget: { kind: "winget", id: "Doppler.doppler" },
    feed: { kind: "github", repository: "DopplerHQ/cli", prefix: "" },
  },
  op: {
    homebrew: { kind: "homebrew-cask", name: "1password-cli" },
    winget: { kind: "winget", id: "AgileBits.1Password.CLI" },
    feed: { kind: "onepassword", product: "CLI2" },
  },
  bws: { feed: { kind: "github", repository: "bitwarden/sdk-sm", prefix: "bws-" } },
  gh: {
    homebrew: { kind: "homebrew-formula", name: "gh" },
    winget: { kind: "winget", id: "GitHub.cli" },
    feed: { kind: "github", repository: "cli/cli", prefix: "" },
  },
};

/** The source a tool installed by `method` reads its latest version from: its method's own, else the vendor's feed. */
export const releaseSourceOf = (tool: ManagedToolName, method: ManagedToolInstallMethod): ReleaseSource => {
  const releases = TOOL_RELEASES[tool];
  const own = method === "homebrew" ? releases.homebrew : method === "winget" ? releases.winget : method === "npm" ? releases.npm : undefined;
  return own ?? releases.feed;
};

/** A source as the cache names it, so a version fetched from one source never stands for another's. */
const keyOf = (source: ReleaseSource): string => {
  switch (source.kind) {
    case "homebrew-formula":
    case "homebrew-cask":
    case "npm":
      return `${source.kind} ${source.name}`;
    case "winget":
      return `winget ${source.id}`;
    case "github":
      return `github ${source.repository} ${source.prefix}`.trimEnd();
    case "claude-channel":
      return `claude-channel ${source.channel}`;
    case "onepassword":
    case "hashicorp":
      return `${source.kind} ${source.product}`;
  }
};

/** A version a source published, with an optional leading `v`; null when it is not one, or is a prerelease. */
const releaseVersion = (text: unknown): string | null => {
  if (typeof text !== "string") return null;
  const version = text.trim().replace(/^v/, "");
  return ManagedToolVersion.safeParse(version).success && !version.includes("-") ? version : null;
};

/** The newest of `versions`, passing over any that is not a release version; null for none. */
const newest = (versions: readonly unknown[]): string | null =>
  versions
    .map(releaseVersion)
    .filter((version): version is string => version !== null)
    .reduce<string | null>((best, version) => (best === null || compareToolVersions(version, best) > 0 ? version : best), null);

/** A field of a JSON object, or undefined. */
const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined);

/** Reads `url`: its body as text, or why not. */
type Get = (url: string, accept: string) => Promise<string>;

const JSON_TYPE = "application/json";
const GITHUB_TYPE = "application/vnd.github+json";

/** WinGet's manifests of `id` (`Publisher.Name...`): `manifests/<publisher's first letter>/<Publisher>/<Name>/...`. */
const wingetDirectory = (id: string): string => {
  const parts = id.split(".");
  return `manifests/${(parts[0] ?? "").charAt(0).toLowerCase()}/${parts.join("/")}`;
};

/** The latest version `source` publishes, read from `origins`; null when its answer holds none. Rejects when it cannot be read. */
const fetchLatest = async (source: ReleaseSource, origins: ReleaseOrigins, get: Get): Promise<string | null> => {
  const readJson = async (url: string, accept = JSON_TYPE): Promise<unknown> => JSON.parse(await get(url, accept)) as unknown;
  switch (source.kind) {
    case "homebrew-formula":
      return releaseVersion(field(field(await readJson(`${origins.homebrew}/formula/${source.name}.json`), "versions"), "stable"));
    case "homebrew-cask": {
      // A cask's version may carry a build after a comma (`2.30.0,1234`).
      const version = field(await readJson(`${origins.homebrew}/cask/${source.name}.json`), "version");
      return releaseVersion(typeof version === "string" ? version.split(",")[0] : version);
    }
    case "npm":
      return releaseVersion(field(await readJson(`${origins.npm}/${source.name.replace("/", "%2F")}/latest`), "version"));
    case "winget": {
      const entries = await readJson(`${origins.github}/repos/microsoft/winget-pkgs/contents/${wingetDirectory(source.id)}`, GITHUB_TYPE);
      if (!Array.isArray(entries)) return null;
      return newest(entries.filter((entry) => field(entry, "type") === "dir").map((entry) => field(entry, "name")));
    }
    case "github": {
      const releases = await readJson(`${origins.github}/repos/${source.repository}/releases?per_page=30`, GITHUB_TYPE);
      if (!Array.isArray(releases)) return null;
      return newest(
        releases
          .filter((release) => field(release, "draft") === false && field(release, "prerelease") === false)
          .map((release) => field(release, "tag_name"))
          .filter((tag): tag is string => typeof tag === "string" && tag.startsWith(source.prefix))
          .map((tag) => tag.slice(source.prefix.length)),
      );
    }
    case "claude-channel":
      return releaseVersion(await get(`${origins.claude}/${source.channel}`, "text/plain"));
    case "onepassword":
      // The feed offers the newest to a version older than every release.
      return releaseVersion(field(await readJson(`${origins.onePassword}/check/1/0/${source.product}/en/2.0.0/N`), "version"));
    case "hashicorp":
      return releaseVersion(field(await readJson(`${origins.hashicorp}/v1/releases/${source.product}/latest`), "version"));
  }
};

/** How often a tool's latest version is fetched at most. */
export const LATEST_INTERVAL_MS = 24 * 60 * 60_000;

/** How long one fetch may take on the environment's clock (ADR 0031's ten seconds). */
export const LATEST_TIMEOUT_MS = 10_000;

/** The largest answer a source is read to; past it the fetch fails. */
const ANSWER_CAP = 4 * 1024 * 1024;

/** The file in the data directory the latest versions are cached in. */
export const LATEST_FILE = "managed-tools-latest.json";

/** One tool's cached latest: the source it was fetched from, the version (null while none was read) and when it was last fetched. */
const CachedLatest = z.object({ source: z.string(), version: ManagedToolVersion.nullable(), fetchedAt: z.iso.datetime() });
type CachedLatest = z.infer<typeof CachedLatest>;

const LatestCache = z.object({ tools: z.record(z.string(), z.unknown()) });

/** An installed tool as the latest fetch reads it: the tool and how it was installed. */
export interface InstalledTool {
  readonly tool: ManagedToolName;
  readonly method: ManagedToolInstallMethod;
}

export interface LatestVersionsOptions {
  readonly clock: Clock;
  /** Where the cache is kept, so a restart keeps it. */
  readonly file: string;
  /** Preset `RELEASE_ORIGINS`; tests point each at a fake. */
  readonly origins?: Partial<ReleaseOrigins>;
  /** Preset `LATEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Aborted when the environment closes: every fetch under way stops. */
  readonly signal: AbortSignal;
}

export interface LatestVersions {
  /** The latest version known of `tool` installed by `method`: the cached one, when it came from the source that method reads; else null. */
  known(tool: ManagedToolName, method: ManagedToolInstallMethod): string | null;
  /**
   * Fetches the latest version of each of `installed` that is due: never
   * fetched, fetched from another source, or last fetched a day or more ago.
   * Resolves once every fetch has answered, failed or run out of time, true
   * when a latest version known changed. Never rejects.
   */
  refresh(installed: readonly InstalledTool[]): Promise<boolean>;
}

export const createLatestVersions = (options: LatestVersionsOptions): LatestVersions => {
  const { clock, signal } = options;
  const origins: ReleaseOrigins = { ...RELEASE_ORIGINS, ...options.origins };
  const timeoutMs = options.timeoutMs ?? LATEST_TIMEOUT_MS;
  const cache = new Map<ManagedToolName, CachedLatest>();

  // The cache as the last run left it; one it cannot read is started again, being a cache.
  try {
    const parsed = LatestCache.parse(JSON.parse(readFileSync(options.file, "utf8")));
    for (const [tool, entry] of Object.entries(parsed.tools)) {
      const name = ManagedToolName.safeParse(tool);
      const cached = CachedLatest.safeParse(entry);
      if (name.success && cached.success) cache.set(name.data, cached.data);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`${options.file} could not be read, so no tool's latest version is known until they are fetched again:`, error instanceof Error ? error.message : error);
    }
  }

  const keep = (): void => {
    const tools = Object.fromEntries(MANAGED_TOOL_NAMES.flatMap((tool) => (cache.has(tool) ? [[tool, cache.get(tool)]] : [])));
    try {
      writeFileAtomic(options.file, `${JSON.stringify({ tools }, null, 2)}\n`, 0o600);
    } catch (error) {
      console.error(`Keeping the managed tools' latest versions in ${options.file} failed; the environment holds them until it stops:`, error);
    }
  };

  /** `url`'s body within the timeout on the environment's clock, the environment's close stopping it too. */
  const get: Get = async (url, accept) => {
    const stop = new AbortController();
    const timer = clock.setTimeout(() => stop.abort(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
    const abort = (): void => stop.abort(new Error("the environment is closing"));
    signal.addEventListener("abort", abort);
    try {
      const response = await fetch(url, { headers: { accept, "user-agent": "agent-harness" }, signal: stop.signal, redirect: "follow" });
      if (!response.ok) {
        // Not awaited: a cancelled body settles when the connection lets it, which the answer does not wait for.
        response.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${response.status}`);
      }
      return await readCapped(response);
    } catch (error) {
      throw stop.signal.aborted && stop.signal.reason instanceof Error ? stop.signal.reason : error;
    } finally {
      timer.cancel();
      signal.removeEventListener("abort", abort);
    }
  };

  const known = (tool: ManagedToolName, method: ManagedToolInstallMethod): string | null => {
    const cached = cache.get(tool);
    return cached !== undefined && cached.source === keyOf(releaseSourceOf(tool, method)) ? cached.version : null;
  };

  const refresh = async (installed: readonly InstalledTool[]): Promise<boolean> => {
    const now = clock.now();
    const due = installed.filter(({ tool, method }) => {
      const cached = cache.get(tool);
      return cached === undefined || cached.source !== keyOf(releaseSourceOf(tool, method)) || now.getTime() - Date.parse(cached.fetchedAt) >= LATEST_INTERVAL_MS;
    });
    if (due.length === 0 || signal.aborted) return false;
    const failures: string[] = [];
    const answers = await Promise.all(
      due.map(async ({ tool, method }) => {
        const source = releaseSourceOf(tool, method);
        try {
          const version = await fetchLatest(source, origins, get);
          if (version === null) failures.push(`${tool} (${keyOf(source)}: no version in its answer)`);
          return { tool, method, source, version };
        } catch (error) {
          failures.push(`${tool} (${keyOf(source)}: ${whyNot(error)})`);
          return { tool, method, source, version: null };
        }
      }),
    );
    if (signal.aborted) return false;
    let changed = false;
    for (const { tool, method, source, version } of answers) {
      const before = known(tool, method);
      // A fetch that read nothing leaves the last version known from this source, or none.
      cache.set(tool, { source: keyOf(source), version: version ?? before, fetchedAt: now.toISOString() });
      if (known(tool, method) !== before) changed = true;
    }
    keep();
    if (failures.length > 0) console.error(`The latest version of ${failures.join(", ")} could not be fetched; each row keeps the one last known.`);
    return changed;
  };

  return { known, refresh };
};

/** Why a fetch failed, in a few words: `fetch` says only "fetch failed", and its cause's code says why (`ECONNREFUSED`). */
const whyNot = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ((error.cause as NodeJS.ErrnoException).code ?? error.cause.message) : undefined;
  return cause === undefined ? error.message : `${error.message} (${cause})`;
};

/** A response's body as text, refusing one larger than the cap. */
const readCapped = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ANSWER_CAP) {
      reader.cancel().catch(() => undefined);
      throw new Error(`its answer is larger than ${ANSWER_CAP / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};
