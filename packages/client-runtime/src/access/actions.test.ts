import type { EventEnvelope, ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { Requests } from "../requests.js";
import { readAccessLog } from "./actions.js";

/**
 * Reading the whole access log (#417): `access.log.list` answers at most a
 * thousand events after a cursor, oldest first, so the log is read a page
 * at a time until a page comes back short, and answered newest first.
 * Driven over a `requests` that answers as the environment's method does.
 */

/** An access event at `sequence`. */
const eventAt = (sequence: number): EventEnvelope => ({
  sequence,
  eventId: `0199ac00-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
  streamKind: "access",
  streamId: "0199aa00-0000-7000-8000-000000000001",
  streamVersion: sequence,
  type: "socket.closed",
  occurredAt: "2026-09-30T08:00:00.000Z",
  commandId: null,
  causationId: null,
  correlationId: null,
  actor: { kind: "system", id: "test" },
  payload: { clientSessionId: "0199cc00-0000-7000-8000-000000000001", socketId: `socket-${sequence}` },
  metadata: {},
});

/** A `requests` over an access log of `count` events, which fails the page after `failAfter` with `unreachable`, and what it was asked. */
const logOf = (count: number, failAfter?: number) => {
  const log = Array.from({ length: count }, (_, index) => eventAt(index + 1));
  const asked: ParamsOf<"access.log.list">[] = [];
  const requests = {
    call: async (_environmentId: string, method: string, params: ParamsOf<"access.log.list">) => {
      expect(method).toBe("access.log.list");
      asked.push(params);
      if (failAfter !== undefined && asked.length > failAfter) return { ok: false, error: { code: "unreachable", message: "The socket closed." } };
      const after = params.afterSequence ?? 0;
      return { ok: true, result: { events: log.filter((event) => event.sequence > after).slice(0, params.limit ?? 100) } };
    },
  } as unknown as Requests;
  return { runtime: { requests }, asked };
};

describe("reading the access log", () => {
  it("reads page after page until one comes back short, and answers the whole log newest first", async () => {
    const { runtime, asked } = logOf(2050);
    const read = await readAccessLog(runtime, "desk");
    expect(read.ok && read.events.map((event) => event.sequence)).toEqual(Array.from({ length: 2050 }, (_, index) => 2050 - index));
    expect(asked).toEqual([{ limit: 1000 }, { limit: 1000, afterSequence: 1000 }, { limit: 1000, afterSequence: 2000 }]);
  });

  it("asks once more after a full last page, and reads an empty log as empty", async () => {
    const full = logOf(1000);
    expect(await readAccessLog(full.runtime, "desk")).toMatchObject({ ok: true, events: { length: 1000 } });
    expect(full.asked).toEqual([{ limit: 1000 }, { limit: 1000, afterSequence: 1000 }]);
    expect(await readAccessLog(logOf(0).runtime, "desk")).toEqual({ ok: true, events: [] });
  });

  it("says why when a page cannot be read", async () => {
    const { runtime } = logOf(1500, 1);
    expect(await readAccessLog(runtime, "desk")).toEqual({ ok: false, line: "The access log could not be read: The socket closed." });
  });
});
