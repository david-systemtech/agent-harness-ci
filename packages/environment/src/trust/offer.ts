import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { SKILL_REPOSITORY_ROOTS, type TrustOffer, type TrustOfferSkillRoot, type Workspace } from "@agent-harness/contracts";
import { hooksOf, mcpServerNames, readJsonObject, rulesIn } from "../adapters/claude/settings-file.js";
import { worktreeCheckout } from "../adapters/claude/workspace.js";
import { readSkillFolder } from "../skills/reader.js";
import { repositorySkillPlaces, type RepositorySkillPlaces } from "../skills/repository.js";
import { repositoryRoot } from "../workspace/repository-key.js";

/**
 * What trusting a repository would load, counted (skills spec, "The trust
 * gate", Asking): what `trust.get` answers beside the decision, so a client
 * says what it asks David to admit. Read from the files alone, never by
 * running anything, and never a local file (`CLAUDE.local.md`,
 * `.claude/settings.local.json`), which trust never loads.
 *
 * - The **repository's root** is the innermost repository's holding the
 *   workspace (a worktree's own); a workspace in none is its own root.
 * - **Instruction files** are read in the workspace directory and each
 *   parent up to the root, as Claude Code and Codex scan them: `CLAUDE.md`,
 *   `.claude/CLAUDE.md` and `AGENTS.md` from the root down.
 * - **Skill roots**, `.claude/skills` and `.agents/skills`, are read where
 *   the run's skill set reads them (`repositorySkillPlaces`): the same
 *   directories, the nearest first, or for a linked worktree its main
 *   checkout's root (#998).
 * - The rest is read where the provider takes a trusted repository's
 *   project settings: the root, or for a linked worktree of a checkout the
 *   checkout (`projectConfigRoot`), so what a branch carries is not what is
 *   counted: `.claude/rules` (instruction files too), `.claude/commands`,
 *   `.claude/agents`, the hooks and permission rules of
 *   `.claude/settings.json`, and the servers of `.mcp.json`, marked not
 *   loaded.
 */

/** The instruction files read in each directory from the root to the workspace. */
const INSTRUCTION_FILES = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "AGENTS.md"] as const;

/** How deep a tree of rules, commands or subagents is read. */
const TREE_DEPTH = 8;

/** A Markdown file's extension. */
const MARKDOWN = ".md";

/** `path` from `root`, with `/` between its segments; `.` for the root itself. */
const from = (root: string, path: string): string => relative(root, path).split(sep).join("/") || ".";

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** The directories from `root` down to `workspace`, the root first; the workspace alone when it lies outside the root. */
const chain = (root: string, workspace: string): string[] => {
  const directories: string[] = [];
  for (let directory = workspace; ; directory = dirname(directory)) {
    directories.unshift(directory);
    if (directory === root || dirname(directory) === directory) break;
  }
  return directories[0] === root ? directories : [workspace];
};

/** The Markdown files under `folder`, a link to one counted, as paths from `root`, in name order; none for a folder that is not there. */
const markdownUnder = async (root: string, folder: string, depth = 0): Promise<string[]> => {
  let entries: Dirent[];
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = join(folder, entry.name);
    if (entry.isDirectory() && depth < TREE_DEPTH) found.push(...(await markdownUnder(root, path, depth + 1)));
    else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(MARKDOWN)) found.push(from(root, path));
  }
  return found;
};

/** The skill roots where a trusted run reads them (`repositorySkillPlaces`), the nearest first and `.claude/skills` before `.agents/skills`, each holding a skill. */
const skillRootsIn = async ({ root, directories }: RepositorySkillPlaces): Promise<TrustOfferSkillRoot[]> => {
  const found: TrustOfferSkillRoot[] = [];
  for (const directory of directories) {
    for (const skills of SKILL_REPOSITORY_ROOTS) {
      const members = await readSkillFolder(join(directory, ...skills.split("/")), { sourceFolderSegment: null, repositorySegment: null });
      if (members.length > 0) found.push({ root: skills, directory: from(root, directory), members: members.length });
    }
  }
  return found;
};

/** What trusting the repository `workspace` lies in would load, counted: see the module comment. */
export const readTrustOffer = async (workspace: Workspace): Promise<TrustOffer> => {
  const root = repositoryRoot(workspace.path) ?? workspace.path;
  const settingsRoot = worktreeCheckout(root) ?? root;
  const directories = chain(root, workspace.path);
  const instructionFiles: string[] = [];
  for (const directory of directories) {
    for (const file of INSTRUCTION_FILES) if (await isFile(join(directory, file))) instructionFiles.push(from(root, join(directory, file)));
  }
  const claude = join(settingsRoot, ".claude");
  const [rules, commands, subagents, skillRoots, settings, mcp] = await Promise.all([
    markdownUnder(settingsRoot, join(claude, "rules")),
    markdownUnder(settingsRoot, join(claude, "commands")),
    markdownUnder(settingsRoot, join(claude, "agents")),
    skillRootsIn(repositorySkillPlaces(workspace.path)),
    readJsonObject(join(claude, "settings.json")),
    readJsonObject(join(settingsRoot, ".mcp.json")),
  ]);
  const shared = settings ?? {};
  return {
    instructionFiles: [...instructionFiles, ...rules],
    skillRoots,
    commands: commands.length,
    hooks: hooksOf(shared),
    permissionRules: { allow: rulesIn(shared, "allow"), ask: rulesIn(shared, "ask"), deny: rulesIn(shared, "deny") },
    subagents: subagents.length,
    mcpServers: mcpServerNames(mcp ?? {}).map((name) => ({ name, loaded: false as const })),
  };
};
