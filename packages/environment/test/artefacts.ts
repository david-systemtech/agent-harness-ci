import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A server artefact of `version` as a release publishes it, made in `dir`:
 * a gzipped tar holding `bin/agent-harness` and a file naming the version,
 * at the top. What `updates.apply` stages from a path on this machine.
 */
export const serverArtefact = (dir: string, version: string): string => {
  const root = join(dir, "root");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "agent-harness"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(root, "VERSION"), `${version}\n`);
  const path = join(dir, `agent-harness-linux-x64-${version}.tar.gz`);
  execFileSync("tar", ["-czf", path, "-C", root, "."]);
  return path;
};
