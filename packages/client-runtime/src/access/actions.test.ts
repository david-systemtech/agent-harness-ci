import type { EventEnvelope, ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { RequestAnswer, Requests } from "../requests.js";
import { readAccessLog, revokeSession } from "./actions.js";

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

/** A `requests` that answers `access.sessions.revoke` with `answer`. */
const revokeAnswering = (answer: RequestAnswer<"access.sessions.revoke">) => ({ requests: { call: async () => answer } as unknown as Requests });

const ACCEPTED: RequestAnswer<"access.sessions.revoke"> = {
  ok: true,
  result: { receipt: { status: "accepted", sequence: 7, changed: true }, result: { revokedAt: "2026-10-08T21:34:37.000Z" } },
};
const LAPTOP = { id: "0199cc00-0000-7000-8000-000000000002", label: "laptop window" };
const MINE = { id: "0199cc00-0000-7000-8000-000000000001", label: "Chrome on Android (tab)" };
const COMMAND = "0199aa00-0000-7000-8000-0000000000aa";

/** The socket closing before the environment answered, with the `bye` it said if any (`requests.call`'s failure). */
const closedBefore = (bye?: "revoked" | "draining"): RequestAnswer<"access.sessions.revoke"> => ({
  ok: false,
  error: { code: "unreachable", message: `The socket closed (${bye ?? 1006}) before the environment answered.`, ...(bye && { bye }) },
});

describe("revoking a client session", () => {
  it("says another client session's revocation as before", async () => {
    expect(await revokeSession(revokeAnswering(ACCEPTED), "desk", LAPTOP, COMMAND)).toEqual({ ok: true, line: "Revoked laptop window: its token is refused from now on." });
  });

  it("counts this client's own socket closing with bye revoked before the answer as revoked (#1962)", async () => {
    expect(await revokeSession(revokeAnswering(closedBefore("revoked")), "phone", MINE, COMMAND, "paired")).toEqual({ ok: true, line: "Revoked this client. Pair again to reconnect." });
    expect(await revokeSession(revokeAnswering(ACCEPTED), "phone", MINE, COMMAND, "paired")).toEqual({ ok: true, line: "Revoked this client. Pair again to reconnect." });
    expect(await revokeSession(revokeAnswering(closedBefore("revoked")), "desk", MINE, COMMAND, "local")).toEqual({ ok: true, line: "Revoked this client. Try again to reconnect." });
  });

  it("still says Not revoked when the socket closes for another reason, or for another client's session", async () => {
    expect(await revokeSession(revokeAnswering(closedBefore()), "phone", MINE, COMMAND, "paired")).toEqual({ ok: false, line: "Not revoked: The socket closed (1006) before the environment answered." });
    expect(await revokeSession(revokeAnswering(closedBefore("draining")), "phone", MINE, COMMAND, "paired")).toEqual({ ok: false, line: "Not revoked: The socket closed (draining) before the environment answered." });
    expect(await revokeSession(revokeAnswering(closedBefore("revoked")), "phone", LAPTOP, COMMAND)).toEqual({ ok: false, line: "Not revoked: The socket closed (revoked) before the environment answered." });
  });

  it("still says Not revoked when the environment refuses", async () => {
    const refused: RequestAnswer<"access.sessions.revoke"> = { ok: false, error: { code: "forbidden", message: "The admin scope is needed." } };
    expect(await revokeSession(revokeAnswering(refused), "phone", MINE, COMMAND, "paired")).toEqual({ ok: false, line: "Not revoked: The admin scope is needed." });
  });
});
