import type { SessionSummary } from "@agent-harness/contracts";
import { derived, type Observable } from "../observable.js";
import type { ListData } from "../streams/kinds.js";
import type { StreamState } from "../streams/stream.js";

/**
 * `projections.knownDirectories(environmentId)` (workspace-picker spec, "The
 * picker in the client runtime"; ADR 0027's recent directories): the
 * directories an environment's sessions use, derived from its session list
 * and stored nowhere, so it reads offline from the list's cache as the list
 * does. A `directory` workspace uses its path, a `worktree` its `repository`
 * (the main checkout it was made from); a scratch workspace uses none.
 */

/** How many known directories an environment lists, the most recently used. A chosen default (workspace-picker spec). */
export const KNOWN_DIRECTORY_LIMIT = 20;

/** One directory the environment's sessions use. */
export interface KnownDirectory {
  /** The directory, as the environment's operating system writes it. */
  readonly path: string;
  /** The repository identity of the most recently used session there; null when it records none. */
  readonly repositoryIdentity: string | null;
  /** When a session last used it: the latest of its sessions' last activity, a session with none counting its creation. */
  readonly lastUsedAt: string;
  /**
   * Since when the environment has found it gone: the missing mark of the
   * most recently used session whose workspace is the directory itself; null
   * while present, and for a repository only worktrees name, whose own
   * marks say nothing of it.
   */
  readonly missingSince: string | null;
}

/** When a session last used its workspace: its last activity, else its creation. */
const lastUse = (summary: SessionSummary): string => summary.lastActivityAt ?? summary.createdAt;

/** The directory a session's workspace uses, and whether the workspace is that directory itself; none for scratch. */
const usedBy = (summary: SessionSummary): { readonly path: string; readonly itself: boolean } | null => {
  const { workspace } = summary;
  if (workspace.kind === "scratch") return null;
  if (workspace.kind === "worktree") return { path: workspace.repository, itself: false };
  return { path: workspace.path, itself: true };
};

/** Most recent first; ties in code-unit order of the tie-breaker. */
const byRecency = <T>(time: (item: T) => string, tie: (item: T) => string) => (a: T, b: T): number =>
  Date.parse(time(b)) - Date.parse(time(a)) || (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0);

/** Every directory the sessions use, most recent first, ties in code-unit order of the path. */
export const directoriesUsed = (sessions: Iterable<SessionSummary>): KnownDirectory[] => {
  const known = new Map<string, { directory: KnownDirectory; marked: boolean }>();
  // The most recent session first: the first to name a directory gives its identity and last use, the first whose workspace
  // it is its mark.
  for (const summary of [...sessions].sort(byRecency(lastUse, (s) => s.id))) {
    const used = usedBy(summary);
    if (used === null) continue;
    const held = known.get(used.path);
    const missingSince = used.itself ? summary.workspaceMissingSince : null;
    if (held === undefined) {
      const directory = { path: used.path, repositoryIdentity: summary.repositoryIdentity, lastUsedAt: lastUse(summary), missingSince };
      known.set(used.path, { directory, marked: used.itself });
    } else if (!held.marked && used.itself) {
      known.set(used.path, { directory: { ...held.directory, missingSince }, marked: true });
    }
  }
  return [...known.values()].map(({ directory }) => directory).sort(byRecency((d) => d.lastUsedAt, (d) => d.path));
};

export const knownDirectoriesProjection = (lists: Observable<ReadonlyMap<string, StreamState<ListData>>>, environmentId: string): Observable<readonly KnownDirectory[]> =>
  derived([lists] as const, (all) => directoriesUsed(all.get(environmentId)?.data?.sessions.values() ?? []).slice(0, KNOWN_DIRECTORY_LIMIT));
