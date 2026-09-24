import { afterEach, describe, expect, it, vi } from "vitest";
import { manualClock } from "../../test/clock.js";
import { openEventLog, type EventLog, type Projector } from "../event-log/event-log.js";
import { settingsProjector } from "../settings/settings-store.js";
import { sessionListProjector } from "./session-list.js";
import { readSummary, type Reader } from "./session-reads.js";
import { createSettleSweep } from "./settle-sweep.js";

/**
 * The sweep at the lower seam, where an append can be made to fail: one
 * session that fails is rolled back and logged by its id, and every other
 * session is still woken or settled in the same pass.
 */

let logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs) log.close();
  logs = [];
  vi.restoreAllMocks();
});

const DAY = 24 * 60 * 60 * 1000;
const [failing, snoozed, idle] = ["0f8fad5b-d9cb-469f-a165-70867728950e", "7c9e6679-7425-40de-944b-e07fc1f90ae7", "1b4e28ba-2fa1-41d2-883f-0016d3cca427"];
const created = {
  type: "session.created",
  payload: { title: null, tags: [], groupId: null, workspace: { kind: "directory", path: "/work" }, repositoryIdentity: null, account: null, model: null, mode: null },
};
const snooze = { type: "session.snoozed", payload: { snoozedUntil: "2026-09-25T00:00:00.000Z", snoozedAt: "2026-09-24T00:00:00.000Z" } };

/** A projector that fails every append to the failing session after its creation, as a bug or a full disk would. */
const breaking: Projector = {
  name: "breaking",
  tables: {},
  apply(event) {
    if (event.streamId === failing && event.type !== "session.created" && event.type !== "session.snoozed") throw new Error("the disk is full");
  },
};

describe("a sweep with one session failing", () => {
  it("rolls that session back and logs its id, and wakes and settles every other one in the same pass", () => {
    const clock = manualClock();
    const log = openEventLog({ path: ":memory:", projectors: [sessionListProjector, settingsProjector, breaking], clock: () => clock.now() });
    logs.push(log);
    for (const id of [failing, snoozed]) log.append({ kind: "session", id }, [created, snooze], { actor: "system:test" });
    log.append({ kind: "session", id: idle }, [created], { actor: "system:test" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    clock.advance(15 * DAY);

    const outcome = createSettleSweep({ log, clock }).sweep();

    expect(outcome.woken).toEqual([snoozed]);
    expect(outcome.settled).toEqual([{ sessionId: idle, by: "auto-idle" }]);
    expect(outcome.failed).toEqual([failing]);
    expect(errors).toHaveBeenCalledWith(`The settle sweep failed on session ${failing}:`, expect.objectContaining({ message: "the disk is full" }));
    const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
    expect(readSummary(reader, failing)).toMatchObject({ snoozedUntil: "2026-09-25T00:00:00.000Z", settledAt: null });
    expect(readSummary(reader, snoozed)).toMatchObject({ snoozedUntil: null, settledAt: null });
    expect(readSummary(reader, idle)).toMatchObject({ settledBy: "auto-idle" });
  });
});
