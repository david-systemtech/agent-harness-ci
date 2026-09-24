import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "../../test/clock.js";
import { openEventLog, type EventLog } from "../event-log/event-log.js";
import { SYSTEM, createAccessLog } from "./access-log.js";
import { createClientSessions, type ClientSessions } from "./client-sessions.js";
import { createPairings } from "./pairings.js";

const environmentId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

let logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs) log.close();
  logs = [];
});

describe("a pairing exchange that fails part way", () => {
  it("rolls the whole exchange back: no row, no event, and no client session in memory for verify to take", () => {
    const log = openEventLog({ path: ":memory:" });
    logs.push(log);
    const clock = manualClock();
    const accessLog = createAccessLog(log, environmentId);
    const clientSessions = createClientSessions({ table: log.clientSessions, accessLog, key: randomBytes(32), environmentId, clock });
    const tokens: string[] = [];
    const recording: Pick<ClientSessions, "issue"> = {
      issue: (tx, request, origin) => {
        const credential = clientSessions.issue(tx, request, origin);
        tokens.push(credential.token);
        return credential;
      },
    };
    // The last write of the exchange fails, after the client session was issued in the same transaction.
    const failing = {
      ...log.pairings,
      exchange: () => {
        throw new Error("the disk is full");
      },
    };
    const pairings = createPairings({ table: failing, clientSessions: recording, accessLog, clock, link: (code) => `http://127.0.0.1:7433/pair#${code}` });
    const { code } = log.atomically((tx) => pairings.create(tx, {}, SYSTEM.owner));

    expect(() => log.atomically((tx) => pairings.exchange(tx, code, { kind: "web", label: "phone" }))).toThrow("the disk is full");
    expect(tokens).toHaveLength(1);
    expect(clientSessions.verify(tokens[0] ?? "")).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(clientSessions.list({ live: false })).toEqual([]);
    expect(log.clientSessions.all()).toEqual([]);
    expect(accessLog.list(0, 100).map((event) => event.type)).toEqual(["pairing.created"]);
    // The code was not spent: a second attempt reaches the same failing write rather than pairing_used.
    expect(() => log.atomically((tx) => pairings.exchange(tx, code, { kind: "web", label: "phone" }))).toThrow("the disk is full");
  });
});
