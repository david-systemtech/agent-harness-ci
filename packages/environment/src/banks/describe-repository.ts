import { mkdir, rename, rm, mkdtemp } from "node:fs/promises";
import { basename, join } from "node:path";
import { hashedName } from "../workspace/directory-names.js";
import { runGit, type GitAnswer } from "../workspace/git.js";
import { identityRemote } from "../workspace/identity.js";
import { WORKTREES_DIRECTORY } from "../workspace/roots.js";

/** Safe git diagnostics: neither output nor command arguments can reveal a remote credential. */
export class DescribeGitError extends Error {
  readonly diagnostic: string;

  constructor(readonly operation: string, answer: GitAnswer) {
    super("git could not prepare the bank's describe repository.");
    this.diagnostic = answer.missing ? "unavailable" : answer.timedOut ? "timed_out" : answer.truncated ? "truncated" : answer.code === null ? "not_started" : `exit_${answer.code}`;
  }
}

/** Describe sessions share their own objects and refs, never the read-only attached checkout's. */
export const describeRepositoryAt = (dataDir: string, checkout: string): string =>
  join(dataDir, WORKTREES_DIRECTORY, "bank-describe", hashedName(basename(checkout), checkout, "bank"));

/**
 * Seed a bare repository without hardlinks or alternates to the checkout.
 * Refresh only main from the BankService's checkout; authored branches survive.
 * Its origin is the bank's remote, so a run pushes through the usual review
 * path rather than writing to the attached checkout. A local-only bank has
 * no origin: its describe artefacts are for the environment-owned Lander.
 */
const prepare = async (dataDir: string, checkout: string): Promise<string> => {
  const repository = describeRepositoryAt(dataDir, checkout);
  const git = async (cwd: string, args: readonly string[]): Promise<Buffer> => {
    const answer = await runGit(cwd, args, { maxBytes: 64 * 1024 });
    // A remote may contain credentials; never include git's output in this error.
    if (!answer.ok || answer.truncated) throw new DescribeGitError(args[0] ?? "unknown", answer);
    return answer.stdout;
  };
  await mkdir(join(dataDir, WORKTREES_DIRECTORY, "bank-describe"), { recursive: true, mode: 0o700 });
  const exists = await runGit(repository, ["rev-parse", "--is-bare-repository"], { maxBytes: 1024 });
  if (!exists.ok) {
    const staging = await mkdtemp(`${repository}-`);
    try {
      await git(staging, ["clone", "--bare", "--no-local", "--branch", "main", "--", checkout, join(staging, "repository")]);
      const remote = identityRemote((await git(checkout, ["remote", "--verbose"])).toString("utf8"));
      if (remote === undefined) await git(join(staging, "repository"), ["remote", "remove", "origin"]);
      else await git(join(staging, "repository"), ["remote", "set-url", "origin", remote]);
      await rename(join(staging, "repository"), repository);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } else {
    await git(repository, ["fetch", "--no-tags", "--", checkout, "+refs/heads/main:refs/heads/main"]);
  }
  return repository;
};

/** One environment serializes creation and main refresh for each shared describe repository. */
const preparing = new Map<string, Promise<string>>();

export const prepareDescribeRepository = async (dataDir: string, checkout: string): Promise<string> => {
  const repository = describeRepositoryAt(dataDir, checkout);
  const previous = preparing.get(repository);
  const next = (previous === undefined ? Promise.resolve() : previous.catch(() => undefined)).then(() => prepare(dataDir, checkout));
  preparing.set(repository, next);
  try {
    return await next;
  } finally {
    if (preparing.get(repository) === next) preparing.delete(repository);
  }
};
