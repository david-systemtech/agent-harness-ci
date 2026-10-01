import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ContractError,
  GitCommit,
  SKILL_PROBE_DEPTH,
  SKILL_PROBE_KEPT_MS,
  SKILL_PROBE_MAX_DIRECTORIES,
  SKILL_PROBE_SKIPPED,
  SkillSourceBranch,
  normaliseRemote,
  repositoryIdentityOf,
  type ForgeAccountOrigins,
  type SkillProbeFolder,
  type SkillProbeProblem,
  type SkillProbeUnreachable,
  type SkillsProbeResult,
} from "@agent-harness/contracts";
import type { ForgeGitAnswer, ForgeGitRequest } from "../forge/harness-git.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { MethodHandler } from "../serve/methods.js";
import { gitComplaint, runGit } from "../workspace/git.js";
import { findLicenceFile, findSkillFolders, readSkillFolder, type RootNaming } from "./reader.js";

/**
 * The probe (skills spec, "Skill sources"; ADR 0029, ADR 0020): a
 * repository URL's skill folders, so a person adding a source ticks folders
 * the environment found. `skills.probe` shallow-clones the branch, else the
 * remote's default, through the ForgeService's git, which never prompts: the
 * forge account for the URL's origin authenticates it, an origin with none
 * is read anonymously, and an ssh URL on a host no forge account covers is
 * read over ssh with the user's own keys. The checkout is walked for the
 * root when it is itself a skill and every folder up to four levels down
 * whose children hold `SKILL.md`, each read by the reader as a source on it
 * would be. It lies under the data directory, in a folder named by the
 * probe's id, and is kept thirty minutes for an add to reuse, then removed;
 * a checkout left by an environment that stopped is removed at start.
 */

/** Where the probes' checkouts lie, from the data directory. */
const PROBES_DIRECTORY = join("skills", "probes");

/** How long a probe's clone may take (a chosen default: the sync's sixty-second fetch). */
const PROBE_CLONE_TIMEOUT_MS = 60_000;

export interface SkillProbes {
  readonly probe: MethodHandler<"skills.probe">;
  /** Removes every kept checkout. */
  close(): void;
}

export interface SkillProbesOptions {
  readonly dataDir: string;
  readonly clock: Clock;
  /** The ForgeService's git (#314). */
  readonly git: (request: ForgeGitRequest) => Promise<ForgeGitAnswer>;
  /** The forge accounts' canonical origins and verified aliases, which the repository identity reads. */
  readonly forgeAccounts: () => readonly ForgeAccountOrigins[];
}

/** What git says, untranslated, when the forge refused a credential or there was none to give. */
const AUTHENTICATION = /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied|Host key verification failed|returned error: 40[13]\b|Access denied/i;
/** What git says when there is no such repository or branch. */
const NOT_FOUND = /not found|does not exist|does not appear to be a git repository|couldn't find remote ref|returned error: 404\b/i;
/** The shell's line when git could not run ssh at all (dash's `ssh: not found`, bash's `ssh: command not found`), which would otherwise read as not found. */
const NO_SSH = /^.*\bssh: (?:command )?not found$/m;
/** What git says when the host could not be reached. */
const NETWORK = /Could not resolve (?:host|hostname|proxy)|Failed to connect|Connection (?:refused|reset|timed out|closed)|Network is unreachable|No route to host|Operation timed out|timed out after|SSL|TLS/i;

/** Why git could not clone, from what it said and whether it was stopped. */
const problemOf = (stderr: string, timedOut: boolean): SkillProbeProblem => {
  if (timedOut) return "network";
  if (AUTHENTICATION.test(stderr)) return "authentication";
  if (NOT_FOUND.test(stderr)) return "not_found";
  if (NETWORK.test(stderr)) return "network";
  return "git_failed";
};

/** What each problem tells the person, before what git said. */
const PROBLEM_MESSAGES: Record<SkillProbeProblem, string> = {
  authentication: "The repository asked for a credential the environment could not give: add a forge account for its origin in Set up, Forges, or check your ssh keys.",
  not_found: "There is no such repository or branch, or it is private and needs a forge account.",
  network: "The repository's host could not be reached in time.",
  git_failed: "git could not clone the repository.",
};

/** `conflict`, reason `unreachable`, with the problem, what git said and the origin. */
const unreachable = (problem: SkillProbeProblem, line: string, origin: string): ContractError => {
  const data: SkillProbeUnreachable = { reason: "unreachable", problem, line, origin };
  return new ContractError({ code: "conflict", message: `${PROBLEM_MESSAGES[problem]} ${line}`, data: { ...data } });
};

/** What git printed in `cwd` for `args`, trimmed; null when it failed. */
const ask = async (cwd: string, args: readonly string[]): Promise<string | null> => {
  const answer = await runGit(cwd, args, { maxBytes: 64 * 1024 });
  return answer.ok && !answer.truncated ? answer.stdout.toString("utf8").trim() : null;
};

/** The folder at `folder` (from the checkout's root) as the probe answers it, its members read by the reader. */
const probeFolder = async (checkout: string, folder: string, naming: RootNaming): Promise<SkillProbeFolder> => {
  const path = folder === "." ? checkout : join(checkout, ...folder.split("/"));
  const members = await readSkillFolder(path, naming);
  const licence = await findLicenceFile(checkout, path);
  return {
    folder,
    members: members.map(({ name, relative, description, invocation, problems }) => ({ name, path: relative, description, invocation, problems })),
    count: members.filter((member) => member.problems.length === 0).length,
    licence: licence === null ? null : folder === "." ? licence : `${folder}/${licence}`,
  };
};

export const createSkillProbes = (options: SkillProbesOptions): SkillProbes => {
  const root = join(options.dataDir, PROBES_DIRECTORY);
  // A probe lives in memory alone: what an environment that stopped left is no one's.
  rmSync(root, { recursive: true, force: true });
  /** The removal timer of each checkout kept, by the probe's id. */
  const kept = new Map<string, Timer>();

  const remove = (probeId: string): void => {
    kept.get(probeId)?.cancel();
    kept.delete(probeId);
    rmSync(join(root, probeId), { recursive: true, force: true });
  };

  const probe: MethodHandler<"skills.probe"> = async ({ url, branch }) => {
    const remote = normaliseRemote(url);
    const identity = repositoryIdentityOf(url, options.forgeAccounts());
    if (remote === null || identity === null) throw new Error("A URL the source URL rule takes has an identity.");
    const probeId = randomUUID();
    const path = join(root, probeId);
    mkdirSync(root, { recursive: true });
    try {
      const cloned = await options.git({
        operation: "clone",
        repository: url,
        cwd: root,
        directory: probeId,
        depth: 1,
        ...(branch !== undefined && { branch }),
        purpose: "probe a skill repository",
        timeoutMs: PROBE_CLONE_TIMEOUT_MS,
        sshAsWritten: true,
      });
      if (cloned.outcome === "refused") throw unreachable("authentication", cloned.error.message, cloned.error.data.origin);
      if (!cloned.git.ok) {
        const noSsh = NO_SSH.exec(cloned.git.stderr);
        if (noSsh !== null) throw unreachable("git_failed", noSsh[0].trim(), remote.origin);
        throw unreachable(problemOf(cloned.git.stderr, cloned.git.timedOut), gitComplaint(cloned.git.stderr), remote.origin);
      }

      const commit = GitCommit.safeParse(await ask(path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]));
      if (!commit.success) throw unreachable("not_found", "The repository has no commit on that branch.", remote.origin);
      const cloneBranch = branch ?? SkillSourceBranch.safeParse(await ask(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).data;
      if (cloneBranch === undefined) throw unreachable("git_failed", "The remote's default branch has no name a source can follow.", remote.origin);

      const found = await findSkillFolders(path, { depth: SKILL_PROBE_DEPTH, maxDirectories: SKILL_PROBE_MAX_DIRECTORIES, skipped: SKILL_PROBE_SKIPPED });
      const naming: RootNaming = { sourceFolderSegment: null, repositorySegment: identity.slice(identity.lastIndexOf("/") + 1) };
      const answer: SkillsProbeResult = {
        probeId,
        identity,
        branch: cloneBranch,
        commit: commit.data,
        root: found.rootIsSkill ? await probeFolder(path, ".", naming) : null,
        folders: await Promise.all(found.folders.map((folder) => probeFolder(path, folder, { ...naming, sourceFolderSegment: folder.slice(folder.lastIndexOf("/") + 1) }))),
        truncated: found.truncated,
      };
      kept.set(probeId, options.clock.setTimeout(() => remove(probeId), SKILL_PROBE_KEPT_MS));
      return answer;
    } catch (error) {
      remove(probeId);
      throw error;
    }
  };

  return {
    probe,
    close: () => {
      for (const probeId of [...kept.keys()]) remove(probeId);
    },
  };
};
