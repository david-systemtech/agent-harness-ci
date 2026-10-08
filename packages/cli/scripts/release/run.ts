import { compareReleaseVersions, isPrerelease, releaseVersionOfTag } from "@agent-harness/contracts";
import { versionOfTag } from "./targets.js";

/**
 * A dry run's tag (#1880): a `ci.<run number>` prerelease of the patch after the newest release among `publishedTags`
 * (by SemVer precedence, a prerelease included), so the build sorts above every release its channel could offer and,
 * as a tag's build does, takes none as its update; `v0.0.0-ci.<run number>` while none is published. A tag that names
 * no release version is passed over.
 */
export const syntheticTag = (publishedTags: readonly string[], runNumber: string): string => {
  const newest = publishedTags
    .map(releaseVersionOfTag)
    .filter((version) => version !== null)
    .sort(compareReleaseVersions)
    .at(-1);
  if (newest === undefined) return `v0.0.0-ci.${runNumber}`;
  const [major, minor, patch] = newest.split(/[-+]/, 1)[0]!.split(".");
  return `v${major}.${minor}.${BigInt(patch!) + 1n}-ci.${runNumber}`;
};

/** The tag names in `git ls-remote --tags` output: its `refs/tags/` lines. */
export const publishedTagsOf = (listed: string): string[] =>
  listed.split("\n").flatMap((line) => {
    const ref = line.split("\t")[1];
    return ref?.startsWith("refs/tags/") ? [ref.slice("refs/tags/".length)] : [];
  });

/**
 * The identity and publishing policy shared by every job of a GitHub release run. A main merge's
 * smoke calls the workflow with the commit in `RELEASE_SMOKE_SHA` (#1769): GITHUB_EVENT_NAME is
 * then its caller's event, and the run is a dry run whatever that event is. Only a dry run reads
 * `published`, the tags of the releases the build's channel offers, for its synthetic tag (#1880);
 * one it cannot read fails the run before any build.
 */
export const releaseRunOf = (
  env: NodeJS.ProcessEnv,
  published: () => readonly string[],
): { tag: string; version: string; prerelease: boolean; publish: boolean } => {
  const event = env["GITHUB_EVENT_NAME"];
  const dryRun = event === "workflow_dispatch" || Boolean(env["RELEASE_SMOKE_SHA"]);
  let tag: string;
  const publish = event === "push" && !dryRun;
  if (dryRun) {
    const number = env["GITHUB_RUN_NUMBER"] ?? "";
    if (!/^[1-9][0-9]*$/.test(number)) throw new Error("A dry run needs GITHUB_RUN_NUMBER.");
    tag = syntheticTag(published(), number);
  } else if (publish && env["GITHUB_REF"]?.startsWith("refs/tags/v")) {
    tag = env["GITHUB_REF"].slice("refs/tags/".length);
  } else {
    throw new Error("A release runs only on a v tag's push, a manual dry run or a main merge's smoke.");
  }
  const version = versionOfTag(tag);
  if (version.includes("+") || version.length > 128) throw new Error("The release version must fit a Docker tag without build metadata.");
  return { tag, version, prerelease: isPrerelease(version), publish };
};
