import { randomBytes, randomUUID } from "node:crypto";
import { Ceiling, SCOPES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { manualClock, type ManualClock } from "../../test/clock.js";
import type { ClientSessionRow, ClientSessionTable } from "../event-log/client-sessions.js";
import type { Tx } from "../event-log/event-log.js";
import { SYSTEM, type AccessLog } from "./access-log.js";
import { TOKEN_LIFETIME_MS, TOP_CEILING, createClientSessions } from "./client-sessions.js";

const environmentId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

type Stored = { -readonly [K in keyof ClientSessionRow]: ClientSessionRow[K] };

/** A table in memory that counts its reads. */
const memoryTable = () => {
  const stored = new Map<string, Stored>();
  let reads = 0;
  const table: ClientSessionTable = {
    all: () => {
      reads++;
      return [...stored.values()].map((row) => ({ ...row }));
    },
    insert: (_tx, row, revoke) => {
      for (const id of revoke) {
        const existing = stored.get(id);
        if (existing) existing.revokedAt = row.createdAt;
      }
      stored.set(row.id, { ...row });
    },
    revoke: (_tx, id, at) => {
      const existing = stored.get(id);
      if (existing) existing.revokedAt = at;
    },
    touch: (_tx, id, at) => {
      const existing = stored.get(id);
      if (existing) existing.lastSeenAt = at;
    },
    extend: (_tx, id, expiresAt) => {
      const existing = stored.get(id);
      if (existing) existing.expiresAt = expiresAt;
    },
    setAccess: (_tx, id, scopes, ceiling) => {
      const existing = stored.get(id);
      if (existing) { existing.scopes = [...scopes]; existing.ceiling = ceiling; }
    },
    setCeiling: (_tx, id, ceiling) => {
      const existing = stored.get(id);
      if (existing) existing.ceiling = ceiling;
    },
  };
  return { table, stored, reads: () => reads };
};

/** An access log that keeps what it is told, in memory. */
const memoryAccessLog = () => {
  const recorded: { type: string; payload: unknown }[] = [];
  const accessLog: Pick<AccessLog, "record"> = {
    record: (_tx, type, payload) => void recorded.push({ type, payload }),
  };
  return { accessLog, recorded };
};

/** A transaction as the tests stand in for one: the work, then its after-commit callbacks, unless the work throws. */
const commit = <T>(work: (tx: Tx) => T): T => {
  const committed: (() => void)[] = [];
  const result = work({ afterCommit: (callback) => void committed.push(callback) });
  for (const callback of committed) callback();
  return result;
};

const owner = SYSTEM.owner;

/** Client sessions over `table`, recording into a fresh in-memory access log. */
const sessions = (table: ClientSessionTable, key: Buffer, clock: ManualClock, id = environmentId) =>
  createClientSessions({ table, key, environmentId: id, clock, accessLog: memoryAccessLog().accessLog });

describe("client sessions", () => {
  it("verify a token with no read of the table after they are loaded", () => {
    const clock = manualClock();
    const memory = memoryTable();
    const clientSessions = sessions(memory.table, randomBytes(32), clock);
    expect(memory.reads()).toBe(1);

    const local = commit((tx) => clientSessions.issueLocal(tx, "desktop", "desktop"));
    const narrow = commit((tx) => clientSessions.issue(tx, { kind: "program", label: "bot", scopes: ["read"], ceiling: Ceiling.parse("plan") }, { id: randomUUID(), pairingId: "p-1" }));
    for (let i = 0; i < 5; i++) {
      expect(clientSessions.verify(local.token)).toMatchObject({ ok: true, clientSession: { id: local.clientSessionId, local: true } });
      expect(clientSessions.verify(narrow.token)).toMatchObject({ ok: true, clientSession: { scopes: ["read"], local: false } });
    }
    commit((tx) => clientSessions.revoke(tx, narrow.clientSessionId, "requested", owner));
    expect(clientSessions.verify(narrow.token)).toMatchObject({ ok: false, reason: "revoked" });
    expect(memory.reads()).toBe(1);
  });

  it("take kind, scopes, ceiling, the local flag and expiry from the table, not the token", () => {
    const clock = manualClock();
    const key = randomBytes(32);
    const memory = memoryTable();
    const first = sessions(memory.table, key, clock);
    const narrow = commit((tx) => first.issue(tx, { kind: "program", label: "bot", scopes: ["read"], ceiling: Ceiling.parse("plan") }, { id: randomUUID(), pairingId: "p-1" }));
    const stored = memory.stored.get(narrow.clientSessionId);
    if (!stored) throw new Error("the client session was not stored");
    stored.scopes = ["read", "admin"];
    stored.ceiling = Ceiling.parse("auto");
    stored.kind = "web";

    const second = sessions(memory.table, key, clock);
    expect(second.verify(narrow.token)).toMatchObject({
      ok: true,
      clientSession: { kind: "web", scopes: ["read", "admin"], ceiling: "auto", local: false },
    });

    stored.expiresAt = clock.now().toISOString();
    const third = sessions(memory.table, key, clock);
    expect(third.verify(narrow.token)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("load what the table holds, revocations included", () => {
    const clock = manualClock();
    const key = randomBytes(32);
    const memory = memoryTable();
    const first = sessions(memory.table, key, clock);
    const kept = commit((tx) => first.issueLocal(tx, "tui", "kept"));
    const gone = commit((tx) => first.issueLocal(tx, "tui", "gone"));
    commit((tx) => first.revoke(tx, gone.clientSessionId, "requested", owner));

    const second = sessions(memory.table, key, clock);
    expect(second.verify(kept.token)).toMatchObject({ ok: true });
    expect(second.verify(gone.token)).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("issue local client sessions with every scope and the top ceiling, for 30 days", () => {
    const clock = manualClock();
    const clientSessions = sessions(memoryTable().table, randomBytes(32), clock);
    const credential = commit((tx) => clientSessions.issueLocal(tx, "tui", "t"));
    expect(credential).toMatchObject({ scopes: [...SCOPES], ceiling: TOP_CEILING });
    expect(Date.parse(credential.expiresAt) - clock.now().getTime()).toBe(TOKEN_LIFETIME_MS);
    clock.advance(TOKEN_LIFETIME_MS - 1);
    expect(clientSessions.verify(credential.token)).toMatchObject({ ok: true });
    clock.advance(1);
    expect(clientSessions.verify(credential.token)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("refuse a token another environment signed with the same key", () => {
    const key = randomBytes(32);
    const clock = manualClock();
    const memory = memoryTable();
    const other = sessions(memory.table, key, clock, "0f8fad5b-d9cb-469f-a165-70867728950e");
    const credential = commit((tx) => other.issueLocal(tx, "tui", "elsewhere"));
    const here = sessions(memory.table, key, clock);
    expect(here.verify(credential.token)).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("tell listeners of a revocation once", () => {
    const clientSessions = sessions(memoryTable().table, randomBytes(32), manualClock());
    const heard: string[] = [];
    clientSessions.onRevoked((id) => heard.push(id));
    const first = commit((tx) => clientSessions.issueLocal(tx, "desktop", "one"));
    const second = commit((tx) => clientSessions.issueLocal(tx, "desktop", "two"));
    expect(heard).toEqual([first.clientSessionId]);
    expect(commit((tx) => clientSessions.revoke(tx, second.clientSessionId, "requested", owner))).toMatchObject({ changed: true });
    expect(commit((tx) => clientSessions.revoke(tx, second.clientSessionId, "requested", owner))).toMatchObject({ changed: false });
    expect(heard).toEqual([first.clientSessionId, second.clientSessionId]);
  });

  it("count open sockets per client session for the tui sweep", () => {
    const clock = manualClock();
    const clientSessions = sessions(memoryTable().table, randomBytes(32), clock);
    const tui = commit((tx) => clientSessions.issueLocal(tx, "tui", "t"));
    commit((tx) => clientSessions.socketOpened(tx, tui.clientSessionId, { socketId: "s" }));
    commit((tx) => clientSessions.socketOpened(tx, tui.clientSessionId, { socketId: "s" }));
    commit((tx) => clientSessions.socketClosed(tx, tui.clientSessionId, { socketId: "s" }));
    clock.advance(2 * 60 * 60 * 1000);
    commit((tx) => clientSessions.sweep(tx));
    expect(clientSessions.verify(tui.token)).toMatchObject({ ok: true });
    commit((tx) => clientSessions.socketClosed(tx, tui.clientSessionId, { socketId: "s" }));
    clock.advance(60 * 60 * 1000);
    commit((tx) => clientSessions.sweep(tx));
    expect(clientSessions.verify(tui.token)).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("keep nothing in memory from a transaction that rolls back", () => {
    const clientSessions = sessions(memoryTable().table, randomBytes(32), manualClock());
    const issued: string[] = [];
    // The work runs, then the transaction fails: its after-commit callbacks never run.
    expect(() => {
      issued.push(clientSessions.issueLocal({ afterCommit: () => undefined }, "tui", "never committed").token);
      throw new Error("the commit failed");
    }).toThrow("the commit failed");
    expect(clientSessions.verify(issued[0] ?? "")).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(clientSessions.list({ live: false })).toEqual([]);
  });
});
