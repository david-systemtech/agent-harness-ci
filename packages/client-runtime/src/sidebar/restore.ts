import type { DeletedSessionSummary } from "@agent-harness/contracts";
import { writable, type Observable } from "../observable.js";
import type { EnvironmentView } from "../projections/environments.js";
import type { Requests } from "../requests.js";

/**
 * What can be restored (docs/specs/tui.md, "The rail": `/restore`;
 * docs/specs/gui.md, "The window and the sidebar": Restore), which the
 * terminal UI's restore picker and the window's Restore dialog both list:
 * the sessions each environment deleted and can still restore, within the
 * thirty days' grace (`sessions.listDeleted`, a query, never queued, so an
 * environment that cannot be reached now is said as not asked). A restore
 * itself is `sessions.restore` through the outbox.
 */

/** A deleted session, and the environment that can restore it. */
export interface DeletedRow {
  readonly environmentId: string;
  readonly summary: DeletedSessionSummary;
}

export interface Restorable {
  /** Every environment's deleted sessions, the latest deletion first. */
  readonly found: readonly DeletedRow[];
  /** Each environment that could not be asked, and why, in the order they answered. */
  readonly failed: readonly { readonly environmentId: string; readonly message: string }[];
  /** How many environments have not answered yet. */
  readonly asking: number;
}

/**
 * Asks every environment listed that this client knows by name and has
 * enabled what it can restore, once, now; the observable holds what they
 * have answered so far.
 */
export const askRestorable = (requests: Pick<Requests, "call">, environments: readonly EnvironmentView[]): Observable<Restorable> => {
  const asked = environments.filter((view) => view.name !== null && view.enabled);
  const listing = writable<Restorable>({ found: [], failed: [], asking: asked.length });
  for (const { environmentId } of asked) {
    void requests.call(environmentId, "sessions.listDeleted", {}).then((answer) =>
      listing.update((now) => ({
        found: answer.ok
          ? [...now.found, ...answer.result.sessions.map((summary) => ({ environmentId, summary }))].sort((a, b) => Date.parse(b.summary.deletedAt) - Date.parse(a.summary.deletedAt))
          : now.found,
        failed: answer.ok ? now.failed : [...now.failed, { environmentId, message: answer.error.message }],
        asking: now.asking - 1,
      })),
    );
  }
  return listing;
};
