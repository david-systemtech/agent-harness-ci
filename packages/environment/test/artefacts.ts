import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ARTEFACT_CLI_ENTRY, ARTEFACT_CLI_PACKAGE, artefactNode } from "@agent-harness/contracts";

/**
 * A server artefact of `version` unpacked into the folder `dir`, as the
 * desktop carries it: its Node for this platform, its CLI's entry and the
 * CLI package declaring the version, where a release lays them out, with
 * `bin/agent-harness` and a file naming the version at the top. None of it
 * runs: the tests' launcher is scripted.
 */
export const unpackedServerArtefact = (dir: string, version: string): string => {
  const file = (path: readonly string[], text: string, mode = 0o644) => {
    mkdirSync(dirname(join(dir, ...path)), { recursive: true });
    writeFileSync(join(dir, ...path), text, { mode });
  };
  file(artefactNode(process.platform), "#!/bin/sh\n", 0o755);
  file(ARTEFACT_CLI_ENTRY, "");
  file(ARTEFACT_CLI_PACKAGE, `${JSON.stringify({ name: "agent-harness", version, launcherProtocol: 1 })}\n`);
  file(["bin", "agent-harness"], "#!/bin/sh\n", 0o755);
  file(["VERSION"], `${version}\n`);
  return dir;
};

/**
 * A server artefact of `version` as a release publishes it, made in `dir`:
 * a gzipped tar of what `unpackedServerArtefact` lays out, at the top. What
 * `updates.apply` stages from a path on this machine.
 */
export const serverArtefact = (dir: string, version: string): string => {
  const root = unpackedServerArtefact(join(dir, "root"), version);
  const path = join(dir, `agent-harness-linux-x64-${version}.tar.gz`);
  execFileSync("tar", ["-czf", path, "-C", root, "."]);
  return path;
};
