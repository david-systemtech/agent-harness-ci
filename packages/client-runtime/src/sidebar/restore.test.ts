import type { DeletedSessionSummary } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { EnvironmentView } from "../projections/environments.js";
import type { RequestAnswer, Requests } from "../requests.js";
import { askRestorable, type Restorable } from "./restore.js";

/**
 * What can be restored (docs/specs/tui.md, "The rail": `/restore`;
 * docs/specs/gui.md, "The window and the sidebar": Restore): the sessions
 * each environment this client knows by name and has enabled deleted and
 * can still restore (`sessions.listDeleted`, a query, never queued), the
 * latest deletion first across environments, with each environment that
 * could not be asked and why, and how many are still being asked.
 */

const view = (environmentId: string, fields: Partial<EnvironmentView> = {}): EnvironmentView => ({ environmentId, name: environmentId, enabled: true, ...fields }) as EnvironmentView;
const deleted = (id: string, deletedAt: string): DeletedSessionSummary => ({ id, title: id, deletedAt, purgeAt: "2026-10-24T00:00:00.000Z" }) as DeletedSessionSummary;

describe("the sessions that can be restored", () => {
  it("are every named and enabled environment's, the latest deletion first, each environment that could not be asked said with why", async () => {
    const answers = new Map<string, (answer: RequestAnswer<"sessions.listDeleted">) => void>();
    const asked: string[] = [];
    const requests: Pick<Requests, "call"> = {
      call: ((environmentId: string, method: string) => {
        asked.push(`${environmentId} ${method}`);
        return new Promise((resolve) => answers.set(environmentId, resolve as never));
      }) as Requests["call"],
    };
    const seen: Restorable[] = [];
    const listing = askRestorable(requests, [view("desk"), view("laptop"), view("spare", { enabled: false }), view("new", { name: null }), view("away")]);
    listing.subscribe(() => seen.push(listing.read()));
    expect(asked).toEqual(["desk sessions.listDeleted", "laptop sessions.listDeleted", "away sessions.listDeleted"]);
    expect(listing.read()).toEqual({ found: [], failed: [], asking: 3 });

    answers.get("desk")?.({ ok: true, result: { sessions: [deleted("old", "2026-09-20T00:00:00.000Z"), deleted("newer", "2026-09-22T00:00:00.000Z")] } });
    answers.get("laptop")?.({ ok: true, result: { sessions: [deleted("mid", "2026-09-21T00:00:00.000Z")] } });
    answers.get("away")?.({ ok: false, error: { code: "unreachable", message: "away cannot be reached." } });
    await Promise.resolve();
    await Promise.resolve();
    expect(listing.read()).toEqual({
      found: [
        { environmentId: "desk", summary: expect.objectContaining({ id: "newer" }) },
        { environmentId: "laptop", summary: expect.objectContaining({ id: "mid" }) },
        { environmentId: "desk", summary: expect.objectContaining({ id: "old" }) },
      ],
      failed: [{ environmentId: "away", message: "away cannot be reached." }],
      asking: 0,
    });
    expect(seen.length).toBe(3);
  });
});
