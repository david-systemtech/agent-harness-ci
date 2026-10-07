import { isPrerelease } from "@agent-harness/contracts";
import { versionOfTag } from "./targets.js";

/**
 * The identity and publishing policy shared by every job of a GitHub release run. A main merge's
 * smoke calls the workflow with the commit in `RELEASE_SMOKE_SHA` (#1769): GITHUB_EVENT_NAME is
 * then its caller's event, and the run is a dry run whatever that event is.
 */
export const releaseRunOf = (env: NodeJS.ProcessEnv): { tag: string; version: string; prerelease: boolean; publish: boolean } => {
  const event = env["GITHUB_EVENT_NAME"];
  const dryRun = event === "workflow_dispatch" || Boolean(env["RELEASE_SMOKE_SHA"]);
  let tag: string;
  const publish = event === "push" && !dryRun;
  if (dryRun) {
    const number = env["GITHUB_RUN_NUMBER"] ?? "";
    if (!/^[1-9][0-9]*$/.test(number)) throw new Error("A dry run needs GITHUB_RUN_NUMBER.");
    tag = `v0.0.0-ci.${number}`;
  } else if (publish && env["GITHUB_REF"]?.startsWith("refs/tags/v")) {
    tag = env["GITHUB_REF"].slice("refs/tags/".length);
  } else {
    throw new Error("A release runs only on a v tag's push, a manual dry run or a main merge's smoke.");
  }
  const version = versionOfTag(tag);
  if (version.includes("+") || version.length > 128) throw new Error("The release version must fit a Docker tag without build metadata.");
  return { tag, version, prerelease: isPrerelease(version), publish };
};
