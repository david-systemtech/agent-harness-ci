import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { GitCommit, SkillSourceBranch, checkSourceFolder, checkSourceUrl, type SkillSourceFollow } from "@agent-harness/contracts";
import { runGit } from "../workspace/git.js";

/**
 * A skill folder that is a git checkout, as Carry over offers it for a
 * source (skills spec, "The own directory and Carry over"; ADR 0021): the
 * working tree's remote stripped of any credential, the folder's path in
 * the repository, and what it follows, its branch or, at a detached `HEAD`,
 * a pin at its commit. What `skills.sources.add` takes.
 *
 * git is asked through the hardened runner (#124: hooks pointed at nothing,
 * the fsmonitor off, a scrubbed environment, no prompts, no optional
 * locks), and only asked to read. The branch is the upstream's on its
 * remote when the local one tracks one there, else the local one, and the
 * remote is that upstream's, else `origin`, else the only one, else the
 * first by name (the repository identity's choice). A folder in no working
 * tree, a working tree with no remote, a remote whose URL is not one a
 * source takes once its credential is gone (a local path, `http`), and a git
 * that fails all give none. What git printed is never logged, since a
 * remote's URL can hold a token.
 */

/** A skill folder's checkout, as a source would track it. */
export interface CheckoutSource {
  readonly url: string;
  readonly folder: string;
  readonly follow: SkillSourceFollow;
}

/** The most of a line, a listing or a URL read: far more than any. */
const LINE_BYTES = 64 * 1024;

const BRANCH_REF = "refs/heads/";

/** What git printed in `cwd` for `args`, trimmed; null when it failed or printed more than a line's worth. */
const ask = async (cwd: string, args: readonly string[]): Promise<string | null> => {
  const answer = await runGit(cwd, args, { maxBytes: LINE_BYTES });
  return answer.ok && !answer.truncated ? answer.stdout.toString("utf8").trim() : null;
};

/** A URL's scheme and its authority, then the rest. */
const URL_FORM = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/is;
/** git's scp form with a user: the user part, then `@` and the rest. */
const SCP_USER = /^([^@/]*)@(.*)$/s;

/**
 * `url` without a credential: an `https` or `http` URL loses its userinfo
 * (a forge takes a token as the user alone), and an ssh URL or scp form
 * keeps its user and loses any password.
 */
export const withoutCredential = (url: string): string => {
  const parts = URL_FORM.exec(url);
  if (parts !== null) {
    const [, scheme = "", authority = "", rest = ""] = parts;
    const at = authority.lastIndexOf("@");
    if (at < 0) return url;
    const user = authority.slice(0, at).split(":")[0] ?? "";
    const kept = /^https?$/i.test(scheme) || user === "" ? "" : `${user}@`;
    return `${scheme}://${kept}${authority.slice(at + 1)}${rest}`;
  }
  const scp = SCP_USER.exec(url);
  if (scp === null) return url;
  const [, user = "", rest = ""] = scp;
  return `${user.split(":")[0] ?? ""}@${rest}`;
};

/** The remote a working tree with no tracked upstream is read by: `origin`, else the only one, else the first by name. */
const chosenRemote = (names: readonly string[]): string | undefined => (names.includes("origin") ? "origin" : [...names].sort()[0]);

/** The remote and branch the checkout at `cwd` follows: the upstream's when its branch tracks one on a remote, else the chosen remote and the local branch (null when detached). */
const followed = async (cwd: string): Promise<{ readonly remote: string; readonly branch: string | null } | null> => {
  const ref = await ask(cwd, ["symbolic-ref", "--quiet", "HEAD"]);
  const branch = ref !== null && ref.startsWith(BRANCH_REF) ? ref : null;
  if (branch !== null) {
    const upstream = (await ask(cwd, ["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", branch])) ?? "";
    const [remote = "", remoteRef = ""] = upstream.split("\0");
    // A remote's name goes on git's command line: one that reads as an option is none, and `.` is a local upstream.
    if (remote !== "" && remote !== "." && !remote.startsWith("-") && remoteRef.startsWith(BRANCH_REF)) return { remote, branch: remoteRef.slice(BRANCH_REF.length) };
  }
  const listing = await ask(cwd, ["remote"]);
  const remote = listing === null ? undefined : chosenRemote(listing.split(/\r?\n/).filter((name) => name !== "" && !name.startsWith("-")));
  return remote === undefined ? null : { remote, branch: branch?.slice(BRANCH_REF.length) ?? null };
};

/** Where `path` leads, links resolved; null when it leads nowhere. */
const resolved = async (path: string): Promise<string | null> => {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
};

/** The source the skill folder at `folder` (links resolved) would be, when it lies in a git working tree with a remote a source takes; null otherwise. Never throws. */
export const readCheckoutSource = async (folder: string): Promise<CheckoutSource | null> => {
  const toplevel = await ask(folder, ["rev-parse", "--show-toplevel"]);
  const root = toplevel === null || toplevel === "" ? null : await resolved(toplevel);
  if (root === null) return null;
  const within = relative(root, folder);
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return null;
  const path = checkSourceFolder(within === "" ? "." : within.split(sep).join("/"));
  const tracked = await followed(folder);
  if (!path.ok || tracked === null) return null;
  const url = await ask(folder, ["remote", "get-url", tracked.remote]);
  const source = url === null ? null : checkSourceUrl(withoutCredential(url));
  if (source === null || !source.ok) return null;
  const branch = tracked.branch === null ? null : SkillSourceBranch.safeParse(tracked.branch);
  if (branch?.success === true) return { url: source.value, folder: path.value, follow: { kind: "branch", branch: branch.data } };
  // Detached, or on a branch no source can name: pinned where it stands.
  const commit = GitCommit.safeParse(await ask(folder, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]));
  return commit.success ? { url: source.value, folder: path.value, follow: { kind: "pinned", commit: commit.data } } : null;
};
