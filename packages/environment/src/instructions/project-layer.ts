import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstructionScope } from "../adapter/seams.js";
import { repositoryRoot } from "../workspace/repository-key.js";
import type { LayerPart } from "./composer.js";

/**
 * The project layer (skills spec, "Standing instructions and the composer":
 * the project layer is native for Claude; #500): a trusted repository's own
 * instructions. Claude loads them itself through the `project` settings
 * source, beside the appended text, so an adapter that says it does
 * (`nativeProjectInstructions`) is handed nothing here. An adapter that
 * loads no project instructions itself (the local loop, milestone 2) is
 * handed the repository's `AGENTS.md`, else its `CLAUDE.md`, read from the
 * root of the repository holding the workspace (a workspace in none is its
 * own root), as the file holds it: one part, named by the file. An
 * untrusted or undecided repository, and a scratch workspace, give none.
 */

/** The files an adapter without native project instructions is handed, the first that is there. */
const PROJECT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export const projectParts = async (scope: InstructionScope): Promise<readonly LayerPart[]> => {
  if (scope.nativeProjectInstructions || scope.trust.decision !== "trusted") return [];
  const root = repositoryRoot(scope.workspace.path) ?? scope.workspace.path;
  for (const file of PROJECT_FILES) {
    let text: string;
    try {
      text = await readFile(join(root, file), "utf8");
    } catch {
      continue;
    }
    return [{ id: file, version: null, title: file, text }];
  }
  return [];
};
