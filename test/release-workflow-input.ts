import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Published snapshots install the hosted workflow and omit Forgejo's private inputs. */
export const releaseWorkflowInput = (root: string) => {
  const privateTree = existsSync(join(root, ".forgejo"));
  const installed = join(root, ".github", "workflows");
  if (privateTree && existsSync(installed)
    && readdirSync(installed, { recursive: true, withFileTypes: true }).some((entry) => entry.isFile())) {
    throw new Error("The private root must contain no GitHub workflow files");
  }
  return {
    hosted: readFileSync(join(root, privateTree
      ? "public/.github-workflows/release.yml"
      : ".github/workflows/release.yml"), "utf8"),
    recovery: privateTree ? readFileSync(join(root, ".forgejo/workflows/release.yml"), "utf8") : undefined,
  };
};
