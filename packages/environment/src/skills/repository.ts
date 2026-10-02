import { dirname, join, relative, sep } from "node:path";
import { SKILL_REPOSITORY_ROOTS, type SkillMember, type Workspace } from "@agent-harness/contracts";
import type { SkillSetScope } from "../adapter/seams.js";
import { worktreeCheckout } from "../adapters/claude/workspace.js";
import { repositoryRoot } from "../workspace/repository-key.js";
import { PROVENANCE_MANIFEST, readProvenanceManifest } from "./provenance.js";
import { occupied } from "./own-directory.js";
import { readCommandFolder, readSkillFolder } from "./reader.js";

/** The repository layer, read live only under trust (#998): see `repositorySkillPlaces`. */
export type RepositorySkillScope = Pick<SkillSetScope, "workspace" | "trust" | "nativeRoots">;

const from = (root: string, path: string): string => relative(root, path).split(sep).join("/") || ".";

/** Where a trusted repository's skill roots and commands are read: paths are from `root`; `directories` the nearest first. */
export interface RepositorySkillPlaces {
  readonly root: string;
  readonly directories: readonly string[];
}

/**
 * Where a trusted repository's skill roots and commands are read for a
 * workspace at `path` (skills spec, "The skill set"): the workspace
 * directory and each parent up to the root of the innermost repository
 * holding it, the scan Claude Code and Codex make; but for a workspace in
 * a linked worktree, at its root or below it, the main checkout's root
 * alone. A run there takes that checkout as `projectConfigRoot`, from which
 * Claude reads the `.claude` trees, so the main checkout supplies the
 * worktree's skills, as it does its settings and hooks, and a skill only
 * on the branch is not offered (David's decision on #998).
 */
export const repositorySkillPlaces = (path: string): RepositorySkillPlaces => {
  const checkout = worktreeCheckout(path);
  if (checkout !== null) return { root: checkout, directories: [checkout] };
  const root = repositoryRoot(path) ?? path;
  const directories: string[] = [];
  for (let directory = path; ; directory = dirname(directory)) {
    directories.push(directory);
    if (directory === root || dirname(directory) === directory) break;
  }
  return { root, directories };
};

/** Where a repository member's files lie: its path from the root its places were read from. */
export const repositorySkillTarget = (workspace: Workspace, member: SkillMember): string =>
  join(repositorySkillPlaces(workspace.path).root, ...member.path.split("/"));

export const isNativeMember = (scope: RepositorySkillScope, member: SkillMember): boolean =>
  member.layer.kind === "repository" && scope.nativeRoots.includes(member.layer.root);

export const readRepositorySkills = async (scope: RepositorySkillScope): Promise<SkillMember[]> => {
  if (scope.trust.decision !== "trusted" || scope.workspace.kind === "scratch") return [];
  const { root, directories } = repositorySkillPlaces(scope.workspace.path);
  const identity = scope.trust.key?.kind === "identity" ? scope.trust.key.value : null;
  const members: SkillMember[] = [];
  for (const directory of directories) {
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
    for (const { relative: command, ...member } of await readCommandFolder(join(directory, ".claude/commands"))) {
      const path = from(root, join(directory, ".claude/commands", command));
      members.push({ ...member, path, layer: { kind: "repository", root: ".claude/commands", directory: from(root, directory) }, origin: identity === null ? null : { kind: "repository", repository: identity, path } });
    }
  }
  return members;
};
