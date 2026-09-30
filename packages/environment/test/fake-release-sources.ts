import type { EventFrame, ManagedToolRow } from "@agent-harness/contracts";
import type { ReleaseOrigins } from "../src/managed-tools/latest.js";
import { serveWeb, type WebAnswer, type WebServer } from "./web-server.js";
import type { WireClient } from "./wire-client.js";

/**
 * The managed tools' release sources, faked on one loopback server on port
 * 0 (key-managers spec, "Testing Decisions"; #374): the Homebrew API, the
 * npm registry, WinGet's manifests and GitHub releases through GitHub's
 * API, Claude Code's release channel, 1Password's update feed and
 * HashiCorp's releases API, each under a prefix of its own, answering what
 * the test publishes at the paths the real ones answer at. A path nothing
 * was published at answers 404; the test may make any path fail or hold
 * its answer. No test reaches the real sources.
 */

/** A GitHub release as the test publishes it: its tag, and whether it is a draft or a prerelease. */
export interface FakeGithubRelease {
  readonly tag: string;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
}

export interface FakeReleaseSources {
  /** The origins an environment is started with (`managedTools.releaseOrigins`). */
  readonly origins: ReleaseOrigins;
  readonly server: WebServer;
  /** Publishes a Homebrew formula's stable version; answers the path it is read at. */
  formula(name: string, version: string): string;
  /** Publishes a Homebrew cask's version. */
  cask(name: string, version: string): string;
  /** Publishes the version an npm package's `latest` tag names. */
  npm(name: string, version: string): string;
  /** Publishes a WinGet package's manifests: a directory per version, and `others` as files beside them. */
  winget(id: string, versions: readonly string[], others?: readonly string[]): string;
  /** Publishes a GitHub repository's releases, newest first. */
  github(repository: string, releases: readonly (string | FakeGithubRelease)[]): string;
  /** Publishes the version Claude Code's `latest` channel points at. */
  claude(version: string): string;
  /** Publishes the version 1Password's update feed offers its CLI. */
  onePassword(version: string): string;
  /** Publishes a HashiCorp product's latest version. */
  hashicorp(product: string, version: string): string;
  /** Answers `path` with a server error from now on. */
  fail(path: string): void;
  /** Holds every request of `path` unanswered from now on. */
  hold(path: string): void;
  /** How many times `path` has been read. */
  reads(path: string): number;
  close(): Promise<void>;
}

const json = (body: unknown): WebAnswer => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Starts the fake release sources; the caller closes them. */
export const startFakeReleaseSources = async (): Promise<FakeReleaseSources> => {
  const server = await serveWeb();
  const publish = (path: string, answer: WebAnswer): string => {
    server.route(path, answer);
    return path;
  };
  return {
    server,
    origins: {
      homebrew: server.url("/homebrew"),
      npm: server.url("/npm"),
      github: server.url("/github"),
      claude: server.url("/claude"),
      onePassword: server.url("/onepassword"),
      hashicorp: server.url("/hashicorp"),
    },
    formula: (name, version) => publish(`/homebrew/formula/${name}.json`, json({ name, versions: { stable: version, head: "HEAD", bottle: true } })),
    cask: (name, version) => publish(`/homebrew/cask/${name}.json`, json({ token: name, version })),
    npm: (name, version) => publish(`/npm/${name.replace("/", "%2F")}/latest`, json({ name, version })),
    winget: (id, versions, others = []) => {
      const [publisher = "", ...rest] = id.split(".");
      const directory = `manifests/${publisher.charAt(0).toLowerCase()}/${[publisher, ...rest].join("/")}`;
      const entries = [...versions.map((name) => ({ name, type: "dir" })), ...others.map((name) => ({ name, type: "file" }))];
      return publish(`/github/repos/microsoft/winget-pkgs/contents/${directory}`, json(entries.map((entry) => ({ ...entry, path: `${directory}/${entry.name}` }))));
    },
    github: (repository, releases) =>
      publish(
        `/github/repos/${repository}/releases?per_page=30`,
        json(releases.map((release) => (typeof release === "string" ? { tag_name: release, draft: false, prerelease: false } : { tag_name: release.tag, draft: release.draft ?? false, prerelease: release.prerelease ?? false }))),
      ),
    claude: (version) => publish("/claude/latest", { headers: { "content-type": "text/plain" }, body: `${version}\n` }),
    onePassword: (version) => publish("/onepassword/check/1/0/CLI2/en/2.0.0/N", json({ available: "1", version })),
    hashicorp: (product, version) => publish(`/hashicorp/v1/releases/${product}/latest`, json({ name: product, version, is_prerelease: false, license_class: "oss" })),
    fail: (path) => server.route(path, { status: 500, headers: { "content-type": "text/plain" }, body: "Internal Server Error" }),
    hold: (path) => server.route(path, "held"),
    reads: (path) => server.requests.filter((request) => request.path === path).length,
    close: () => server.close(),
  };
};

/** The rows a `tools.updated` carried. */
export const noticedRows = (event: { readonly payload: unknown }): ManagedToolRow[] => (event.payload as { tools: ManagedToolRow[] }).tools;

/**
 * The rows of the first `tools.updated` after `afterSequence` that carries
 * `tool` with a latest version, waiting for it if the log holds none yet:
 * the notice of a fetch of the latest versions, not of a probe.
 */
export const latestNoticed = async (client: WireClient, afterSequence: number, tool: string): Promise<ManagedToolRow[]> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence });
  const frame = await client.next(
    (f) =>
      "subscription" in f &&
      f.subscription === subscription &&
      f.type === "event" &&
      (f as EventFrame).event.type === "tools.updated" &&
      noticedRows((f as EventFrame).event).some((row) => row.tool === tool && row.latest !== null),
  );
  return noticedRows((frame as EventFrame).event);
};
