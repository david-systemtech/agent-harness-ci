import type { SessionSummary } from "@agent-harness/contracts";
import type { ClientPreferences } from "../connections/records.js";
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
 * Hiding one is client-local presentation (`hiddenDirectories`, beside
 * `environments.lastUsed`), undone when a session uses it again.
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

/** Whether a directory hidden as of `hiddenAt` (its last use when hidden) stays hidden: no session has used it since. */
const stillHidden = (directory: KnownDirectory, hiddenAt: string | undefined): boolean =>
  hiddenAt !== undefined && Date.parse(directory.lastUsedAt) <= Date.parse(hiddenAt);

/** The environment's known directories: those used, less those hidden on this client and not used since, at most the limit. */
export const knownDirectories = (sessions: Iterable<SessionSummary>, hidden: Readonly<Record<string, string>>): readonly KnownDirectory[] =>
  directoriesUsed(sessions)
    .filter((directory) => !stillHidden(directory, hidden[directory.path]))
    .slice(0, KNOWN_DIRECTORY_LIMIT);

export interface KnownDirectoriesHost {
  /** Each environment's list, with the outbox's overlay laid over it. */
  readonly lists: Observable<ReadonlyMap<string, StreamState<ListData>>>;
  readonly preferences: Observable<ClientPreferences>;
  /** Writes the hiding to the client-local preferences. */
  readonly hide: (environmentId: string, path: string, lastUsedAt: string) => Promise<void>;
}

const sessionsOf = (lists: ReadonlyMap<string, StreamState<ListData>>, environmentId: string): Iterable<SessionSummary> =>
  lists.get(environmentId)?.data?.sessions.values() ?? [];

export const knownDirectoriesProjection = (host: KnownDirectoriesHost, environmentId: string): Observable<readonly KnownDirectory[]> =>
  derived([host.lists, host.preferences] as const, (lists, preferences) =>
    knownDirectories(sessionsOf(lists, environmentId), preferences.hiddenDirectories[environmentId] ?? {}),
  );

/**
 * Hides the environment's directory at `path` on this client: as of its last
 * use, so the first session to use it after that brings it back. Rejects
 * with a `RangeError` when no session of the environment uses it.
 */
export const hideKnownDirectory = async (host: KnownDirectoriesHost, environmentId: string, path: string): Promise<void> => {
  const used = directoriesUsed(sessionsOf(host.lists.read(), environmentId)).find((directory) => directory.path === path);
  if (used === undefined) throw new RangeError(`No session of environment ${environmentId} uses ${path}.`);
  await host.hide(environmentId, path, used.lastUsedAt);
};
