import { dirname, join, relative, sep } from "node:path";
import { SKILL_REPOSITORY_ROOTS, type SkillMember, type Workspace } from "@agent-harness/contracts";
import type { SkillSetScope } from "../adapter/seams.js";
import { worktreeCheckout } from "../adapters/claude/workspace.js";
import { repositoryRoot } from "../workspace/repository-key.js";
import { PROVENANCE_MANIFEST, readProvenanceManifest } from "./provenance.js";
import { occupied } from "./own-directory.js";
import { readCommandFolder, readSkillFolder } from "./reader.js";

/** The repository layer, read live only under trust, from the workspace up to its innermost repository. */
export type RepositorySkillScope = Pick<SkillSetScope, "workspace" | "trust" | "nativeRoots">;

const from = (root: string, path: string): string => relative(root, path).split(sep).join("/") || ".";

export const repositorySkillTarget = (workspace: Workspace, member: SkillMember): string => {
  const root = repositoryRoot(workspace.path) ?? workspace.path;
  const targetRoot = member.layer.kind === "repository" && member.layer.root === ".claude/commands" ? worktreeCheckout(root) ?? root : root;
  return join(targetRoot, ...member.path.split("/"));
};

export const isNativeMember = (scope: RepositorySkillScope, member: SkillMember): boolean => member.layer.kind === "repository" && scope.nativeRoots.includes(member.layer.root);

export const readRepositorySkills = async (scope: RepositorySkillScope): Promise<SkillMember[]> => {
  if (scope.trust.decision !== "trusted" || scope.workspace.kind === "scratch") return [];
  const root = repositoryRoot(scope.workspace.path) ?? scope.workspace.path;
  const settingsRoot = worktreeCheckout(root) ?? root;
  const identity = scope.trust.key?.kind === "identity" ? scope.trust.key.value : null;
  const members: SkillMember[] = [];
  const commandsIn = async (base: string, directory: string) => {
    for (const { relative: command, ...member } of await readCommandFolder(join(directory, ".claude/commands"))) {
      const path = from(base, join(directory, ".claude/commands", command));
      members.push({ ...member, path, layer: { kind: "repository", root: ".claude/commands", directory: from(base, directory) }, origin: identity === null ? null : { kind: "repository", repository: identity, path } });
    }
  };
  for (let directory = scope.workspace.path; ; directory = dirname(directory)) {
    for (const skills of SKILL_REPOSITORY_ROOTS) {
      const folder = join(directory, ...skills.split("/"));
      const beside = join(folder, PROVENANCE_MANIFEST);
      const manifest = await occupied(beside) ? beside : join(directory, skills.split("/")[0] ?? ".", PROVENANCE_MANIFEST);
      const [found, origins] = await Promise.all([
        readSkillFolder(folder, { sourceFolderSegment: "skills", repositorySegment: null }),
        readProvenanceManifest(manifest),
      ]);
      for (const { relative: pathInFolder, ...member } of found) {
        const path = from(root, pathInFolder === "." ? folder : join(folder, pathInFolder));
        members.push({
          ...member,
          path,
          layer: { kind: "repository", root: skills, directory: from(root, directory) },
          origin: origins.get(pathInFolder === "." ? "skills" : pathInFolder) ?? (identity === null ? null : { kind: "repository", repository: identity, path }),
        });
      }
    }
    if (settingsRoot === root) await commandsIn(root, directory);
    if (directory === root || dirname(directory) === directory) break;
  }
  // A linked worktree's projectConfigRoot is the main checkout, as in trust.get.
  if (settingsRoot !== root) await commandsIn(settingsRoot, settingsRoot);
  return members;
};
