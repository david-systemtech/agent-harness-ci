import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ContractError,
  GitCommit,
  PRODUCT_NAME,
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
  type SkillSourceFollow,
  type SkillsProbeResult,
} from "@agent-harness/contracts";
import type { ForgeGitAnswer, ForgeGitRequest } from "../forge/harness-git.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { MethodHandler } from "../serve/methods.js";
import { gitComplaint, runGit } from "../workspace/git.js";
import { findLicenceFile, findSkillFolders, readSkillFolder, sourceRootNaming, type RootNaming } from "./reader.js";

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
 *
 * `skills.sources.add` reads a source's folder from a checkout at what the
 * source follows (#498): the kept probe's when it cloned the same
 * repository at that, held from removal while the add reads it; else one of
 * its own beside the probes', cloned the same way (or, for a pin, fetched
 * at the commit), removed once read.
 */

/** Where the probes' checkouts lie, from the data directory. */
const PROBES_DIRECTORY = join("skills", "probes");

/** How long a probe's clone may take (a chosen default: the sync's sixty-second fetch). */
const PROBE_CLONE_TIMEOUT_MS = 60_000;

/** The prefix of an add's own checkout among the probes'. */
const ADD_CHECKOUT = "add-";

/** A probe's checkout while it is kept. */
interface KeptProbe {
  readonly identity: string;
  /** The branch the probe was asked for; null for the remote's default. */
  readonly asked: string | null;
  readonly branch: string;
  readonly commit: GitCommit;
  readonly timer: Timer;
  /** How many adds read it now. */
  holders: number;
  /** Whether its thirty minutes are up, so the last add to release it removes it. */
  expired: boolean;
}

/** What a source's checkout is asked for: the URL as entered, what the source follows, the probe whose checkout to reuse, and what stops its git. */
export interface SourceCheckoutRequest {
  readonly url: string;
  readonly follow: SkillSourceFollow;
  readonly probeId?: string;
  readonly signal?: AbortSignal;
}

/** A checkout whose working tree is at the commit a source follows, released once read. */
export interface SourceCheckout {
  readonly path: string;
  readonly commit: GitCommit;
  release(): void;
}

export interface SkillProbes {
  readonly probe: MethodHandler<"skills.probe">;
  /**
   * A checkout of `url` at what `follow` names: the kept probe `probeId`'s
   * when it cloned the same repository at that, held from removal until
   * released; else a fresh one, removed once released. A repository it
   * cannot reach throws `conflict`, reason `unreachable`, as the probe does.
   */
  checkout(request: SourceCheckoutRequest): Promise<SourceCheckout>;
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
  /** This environment's name, as a refusal names the computer git is missing on. */
  readonly environmentName: () => string;
}

/** What git says, untranslated, when the forge refused a credential or there was none to give. */
const AUTHENTICATION = /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied|Host key verification failed|returned error: 40[13]\b|Access denied/i;
/** What git says when there is no such repository or branch. */
const NOT_FOUND = /not found|does not exist|does not appear to be a git repository|couldn't find remote ref|returned error: 404\b/i;
/** What git says when a fetch names a commit the remote does not hold. */
const NOT_OUR_REF = /not our ref/;
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

/** Where a refusal happened: the repository's origin, and the computer git ran on. */
interface Reach {
  readonly origin: string;
  readonly computer: string;
}

/** An origin's host as a person reads it: no scheme, no user. */
const hostOf = (origin: string): string => origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]*@/, "");

/** What each problem tells the person (setup-copy.md §5.9); what git said stays in the data's line, for Details. */
const PROBLEM_LINES: { readonly [Problem in SkillProbeProblem]: (reach: Reach) => string } = {
  authentication: ({ origin }) => `This repository is private. Add a forge for ${hostOf(origin)} first.`,
  not_found: () => `${PRODUCT_NAME} found no repository at this address.`,
  network: ({ origin }) => `${hostOf(origin)} did not answer in time. Try again.`,
  git_missing: ({ computer }) => `Git is not installed on ${computer}. Install Git, then try again.`,
  git_failed: () => `${PRODUCT_NAME} could not read this repository. Try again.`,
};

/** `conflict`, reason `unreachable`: the problem's plain line, with the problem, what git said and the origin. */
const unreachable = (problem: SkillProbeProblem, line: string, reach: Reach): ContractError => {
  const data: SkillProbeUnreachable = { reason: "unreachable", problem, line, origin: reach.origin };
  return new ContractError({ code: "conflict", message: PROBLEM_LINES[problem](reach), data: { ...data } });
};

/** What git printed in `cwd` for `args`, trimmed; null when it failed. */
const ask = async (cwd: string, args: readonly string[]): Promise<string | null> => {
  const answer = await runGit(cwd, args, { maxBytes: 64 * 1024 });
  return answer.ok && !answer.truncated ? answer.stdout.toString("utf8").trim() : null;
};

/** Throws what kept git from the repository: refused for want of a forge account, git missing from the computer, else the problem its output names. */
const reached = (answer: ForgeGitAnswer, reach: Reach): void => {
  if (answer.outcome === "refused") throw unreachable("authentication", answer.error.message, { ...reach, origin: answer.error.data.origin });
  if (answer.git.ok) return;
  if (answer.git.missing) throw unreachable("git_missing", answer.git.stderr, reach);
  const noSsh = NO_SSH.exec(answer.git.stderr);
  if (noSsh !== null) throw unreachable("git_failed", noSsh[0].trim(), reach);
  // Stopped at its time, git has said nothing of why: the line says what stopped it.
  const line = answer.git.timedOut ? `git was stopped after ${PROBE_CLONE_TIMEOUT_MS / 1000} seconds.` : gitComplaint(answer.git.stderr);
  throw unreachable(problemOf(answer.git.stderr, answer.git.timedOut), line, reach);
};

/** The commit the checkout at `path` stands at, its branch when on one; unreachable `not_found` when it has none. */
const headOf = async (path: string, reach: Reach): Promise<{ readonly commit: GitCommit; readonly branch: SkillSourceBranch | undefined }> => {
  const commit = GitCommit.safeParse(await ask(path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]));
  if (!commit.success) throw unreachable("not_found", "The repository has no commit on that branch.", reach);
  return { commit: commit.data, branch: SkillSourceBranch.safeParse(await ask(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).data };
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
  /** Each checkout kept, by the probe's id: what it cloned, its removal timer, how many adds hold it, and whether its time is up. */
  const kept = new Map<string, KeptProbe>();

  const reachOf = (origin: string): Reach => ({ origin, computer: options.environmentName() });

  const remove = (probeId: string): void => {
    kept.get(probeId)?.timer.cancel();
    kept.delete(probeId);
    rmSync(join(root, probeId), { recursive: true, force: true });
  };

  /** Clones `url` at `branch`, else the remote's default, into `directory` under the probes' folder, depth one, as the probe does; git stops when `signal` aborts. */
  const clone = async (url: string, branch: string | undefined, directory: string, purpose: string, reach: Reach, signal?: AbortSignal): Promise<void> => {
    mkdirSync(root, { recursive: true });
    const cloned = await options.git({
      operation: "clone",
      repository: url,
      cwd: root,
      directory,
      depth: 1,
      ...(branch !== undefined && { branch }),
      purpose,
      timeoutMs: PROBE_CLONE_TIMEOUT_MS,
      ...(signal !== undefined && { signal }),
      sshAsWritten: true,
    });
    reached(cloned, reach);
  };

  /** Fetches `commit` of `url`, depth one, into a new repository at `path`, and checks it out there; git stops when `signal` aborts. */
  const fetchCommit = async (url: string, commit: GitCommit, path: string, reach: Reach, signal?: AbortSignal): Promise<void> => {
    mkdirSync(path, { recursive: true });
    const made = await runGit(path, ["init", "--quiet"], { maxBytes: 64 * 1024 });
    if (made.missing) throw unreachable("git_missing", made.stderr, reach);
    if (!made.ok) throw unreachable("git_failed", "git could not make a repository to fetch the pinned commit into.", reach);
    const fetched = await options.git({
      operation: "fetch",
      repository: url,
      cwd: path,
      refspecs: [commit],
      depth: 1,
      purpose: "fetch a skill source's pinned commit",
      timeoutMs: PROBE_CLONE_TIMEOUT_MS,
      ...(signal !== undefined && { signal }),
      sshAsWritten: true,
    });
    // A commit the remote does not have, which a clone, asking for refs alone, never meets.
    if (fetched.outcome === "ran" && !fetched.git.ok && NOT_OUR_REF.test(fetched.git.stderr)) throw unreachable("not_found", gitComplaint(fetched.git.stderr), reach);
    reached(fetched, reach);
    const checkedOut = await runGit(path, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", commit], { maxBytes: 64 * 1024 });
    if (!checkedOut.ok) throw unreachable("git_failed", gitComplaint(checkedOut.stderr), reach);
  };

  /** The kept probe `probeId` names, held, when it cloned `identity` at what `follow` names; null otherwise. */
  const borrow = (probeId: string | undefined, identity: string, follow: SkillSourceFollow): SourceCheckout | null => {
    const found = probeId === undefined ? undefined : kept.get(probeId);
    if (probeId === undefined || found === undefined || found.expired || found.identity !== identity) return null;
    const matches = follow.kind === "pinned" ? found.commit === follow.commit : follow.branch === null ? found.asked === null : found.branch === follow.branch;
    if (!matches) return null;
    found.holders += 1;
    let released = false;
    return {
      path: join(root, probeId),
      commit: found.commit,
      release: () => {
        if (released) return;
        released = true;
        found.holders -= 1;
        if (found.holders === 0 && found.expired && kept.get(probeId) === found) remove(probeId);
      },
    };
  };

  /** Removes a probe's checkout once its time is up, or, while an add holds it, once the last releases it. */
  const expire = (probeId: string): void => {
    const found = kept.get(probeId);
    if (found === undefined) return;
    if (found.holders > 0) found.expired = true;
    else remove(probeId);
  };

  const probe: MethodHandler<"skills.probe"> = async ({ url, branch }) => {
    const remote = normaliseRemote(url);
    const identity = repositoryIdentityOf(url, options.forgeAccounts());
    if (remote === null || identity === null) throw new Error("A URL the source URL rule takes has an identity.");
    const probeId = randomUUID();
    const path = join(root, probeId);
    const reach = reachOf(remote.origin);
    try {
      await clone(url, branch, probeId, "probe a skill repository", reach);
      const head = await headOf(path, reach);
      const cloneBranch = branch ?? head.branch;
      if (cloneBranch === undefined) throw unreachable("git_failed", "The remote's default branch has no name a source can follow.", reach);

      const found = await findSkillFolders(path, { depth: SKILL_PROBE_DEPTH, maxDirectories: SKILL_PROBE_MAX_DIRECTORIES, skipped: SKILL_PROBE_SKIPPED });
      const answer: SkillsProbeResult = {
        probeId,
        identity,
        branch: cloneBranch,
        commit: head.commit,
        root: found.rootIsSkill ? await probeFolder(path, ".", sourceRootNaming(identity, ".")) : null,
        folders: await Promise.all(found.folders.map((folder) => probeFolder(path, folder, sourceRootNaming(identity, folder)))),
        truncated: found.truncated,
      };
      const timer = options.clock.setTimeout(() => expire(probeId), SKILL_PROBE_KEPT_MS);
      kept.set(probeId, { identity, asked: branch ?? null, branch: cloneBranch, commit: head.commit, timer, holders: 0, expired: false });
      return answer;
    } catch (error) {
      remove(probeId);
      throw error;
    }
  };

  const checkout = async ({ url, follow, probeId, signal }: SourceCheckoutRequest): Promise<SourceCheckout> => {
    const remote = normaliseRemote(url);
    const identity = repositoryIdentityOf(url, options.forgeAccounts());
    if (remote === null || identity === null) throw new Error("A URL the source URL rule takes has an identity.");
    const borrowed = borrow(probeId, identity, follow);
    if (borrowed !== null) return borrowed;
    // A checkout of the add's own, beside the probes' so a start removes what a stopped environment left.
    const directory = `${ADD_CHECKOUT}${randomUUID()}`;
    const path = join(root, directory);
    const release = (): void => rmSync(path, { recursive: true, force: true });
    const reach = reachOf(remote.origin);
    try {
      if (follow.kind === "pinned") await fetchCommit(url, follow.commit, path, reach, signal);
      else await clone(url, follow.branch ?? undefined, directory, "read a skill source", reach, signal);
      return { path, commit: (await headOf(path, reach)).commit, release };
    } catch (error) {
      release();
      throw error;
    }
  };

  return {
    probe,
    checkout,
    close: () => {
      for (const probeId of [...kept.keys()]) remove(probeId);
    },
  };
};
