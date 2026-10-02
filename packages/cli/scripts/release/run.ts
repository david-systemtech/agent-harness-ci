import { isPrerelease } from "@agent-harness/contracts";
import { versionOfTag } from "./targets.js";

/** The identity and publishing policy shared by every job of a GitHub release run. */
export const releaseRunOf = (env: NodeJS.ProcessEnv): { tag: string; version: string; prerelease: boolean; publish: boolean } => {
  const event = env["GITHUB_EVENT_NAME"];
  let tag: string;
  const publish = event === "push";
  if (event === "workflow_dispatch") {
    const number = env["GITHUB_RUN_NUMBER"] ?? "";
    if (!/^[1-9][0-9]*$/.test(number)) throw new Error("A dry run needs GITHUB_RUN_NUMBER.");
    tag = `v0.0.0-ci.${number}`;
  } else if (publish && env["GITHUB_REF"]?.startsWith("refs/tags/v")) {
    tag = env["GITHUB_REF"].slice("refs/tags/".length);
  } else {
    throw new Error("A release runs only on a v tag's push or a manual dry run.");
  }
  const version = versionOfTag(tag);
  if (version.includes("+") || version.length > 128) throw new Error("The release version must fit a Docker tag without build metadata.");
  return { tag, version, prerelease: isPrerelease(version), publish };
};
