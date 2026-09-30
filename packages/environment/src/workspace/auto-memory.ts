import { join } from "node:path";
import { carryMemory, type CarryOutcome, type MemorySource } from "./carry-memory.js";
import { hashedName } from "./directory-names.js";
import { repositoryKey, type RepositoryPlace } from "./repository-key.js";

/**
 * Auto memory's key (workspace-picker spec, "Repository identity", Auto
 * memory; ADR 0018; #121's key, refined by #329): the environment keeps one
 * auto-memory directory per key under `<data dir>/auto-memory/`, which every
 * account's runs share. The key is the session's repository key
 * (`repository-key.ts`, which the trust gate keys on too): its repository
 * identity; else its repository's main checkout, so the worktrees of a
 * repository with no remote share one directory, as Claude Code keys memory
 * by repository; else its workspace path. A scratch workspace has no
 * repository key, and every scratch workspace shares one directory.
 *
 * When a session's key changes (an identity pass gives it an identity or
 * moves its host, #329; `sessions.setWorkspace` gives it a new workspace,
 * #328), its old directory is copied into the new one by ADR 0021's
 * carry-over rule (`carry-memory.ts`) and left where it is. Carry over's
 * import copies an adopted directory's memory folders in by the same rule
 * (#580), in the same queue.
 */

/** A session's place, as the key reads it. */
export type MemoryPlace = RepositoryPlace;

/** The auto-memory directory every scratch workspace shares, under the root: never a name `hashedName` gives, which ends in a hash. */
export const SCRATCH_MEMORY_DIRECTORY = "scratch";

/** A place's key: its repository key's value (its identity, else its main checkout, else its workspace path); null for a scratch workspace, which shares one directory. */
const keyOf = (place: MemoryPlace): string | null => repositoryKey(place)?.value ?? null;

/** The directory name of the key `key`: named for a person reading the directory, and hashed so two keys never share one. */
const nameOf = (key: string): string => hashedName(key, key, "workspace");

/** The name of `place`'s auto-memory directory under the root. */
export const autoMemoryName = (place: MemoryPlace): string => {
  const key = keyOf(place);
  return key === null ? SCRATCH_MEMORY_DIRECTORY : nameOf(key);
};

/**
 * The directories `place`'s memory may be in, each with its key: its key's,
 * then, for a directory or worktree with no identity, the one #121 keyed by
 * the workspace path before the key was refined, where a session in a
 * subdirectory or a worktree kept its memory until then.
 */
const sourcesOf = (place: MemoryPlace): { readonly name: string; readonly key: string }[] => {
  const key = keyOf(place);
  const sources = [key === null ? { name: SCRATCH_MEMORY_DIRECTORY, key: "the scratch workspaces" } : { name: nameOf(key), key }];
  const { workspace } = place;
  if (place.repositoryIdentity === null && workspace.kind !== "scratch" && workspace.path !== key) sources.push({ name: nameOf(workspace.path), key: workspace.path });
  return sources;
};

export interface AutoMemory {
  /**
   * A session's key changed from `before` to `after`: the old key's
   * directory, and the one #121 keyed by the workspace path when that is
   * another, are copied into the new key's by the carry-over rule, and stay. Carries run one at a time, in the order asked, so two for one
   * key never interleave; one that fails is said and never rejects. Settles
   * once this one has run.
   */
  carry(before: MemoryPlace, after: MemoryPlace): Promise<void>;
  /**
   * Copies the memory directory `source`, from outside the root (an
   * adopted directory's, #580), into the directory of the repository key
   * `key` (its value: an identity, a main checkout or a workspace path) by
   * the carry-over rule, in the queue the key changes use; answers what the
   * copy did, or with `dryRun` would do, writing nothing. Rejects when the
   * copy fails; the queue goes on.
   */
  carryIn(source: MemorySource, key: string, options?: { readonly dryRun?: boolean }): Promise<CarryOutcome>;
}

/** The environment's auto memory, whose directories live under `root` (`<data dir>/auto-memory`). */
export const createAutoMemory = (root: string): AutoMemory => {
  let queue: Promise<void> = Promise.resolve();
  /** Runs `work` once every carry asked before it has run; what it answers, or its rejection, is its own, and the queue goes on. */
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const done = queue.then(work);
    queue = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  };
  const carryNow = async (before: MemoryPlace, after: MemoryPlace): Promise<void> => {
    const to = autoMemoryName(after);
    for (const source of sourcesOf(before)) {
      if (source.name !== to) await carryMemory({ directory: join(root, source.name), name: source.name, label: source.key }, join(root, to));
    }
  };
  return {
    carry: (before, after) =>
      inTurn(() =>
        carryNow(before, after).catch((error: unknown) => console.error("Copying a session's auto memory to its new key failed; the old directory stays:", error)),
      ),
    carryIn: (source, key, options = {}) => inTurn(() => carryMemory(source, join(root, nameOf(key)), options)),
  };
};
