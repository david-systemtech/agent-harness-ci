import { randomBytes } from "node:crypto";
import { Ceiling, SCOPES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { manualClock } from "../../test/clock.js";
import type { ClientSessionRow, ClientSessionTable } from "../event-log/client-sessions.js";
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
    insert: (row, revoke) => {
      for (const id of revoke) {
        const existing = stored.get(id);
        if (existing) existing.revokedAt = row.createdAt;
      }
      stored.set(row.id, { ...row });
    },
    revoke: (id, at) => {
      const existing = stored.get(id);
      if (existing) existing.revokedAt = at;
    },
    touch: (id, at) => {
      const existing = stored.get(id);
      if (existing) existing.lastSeenAt = at;
    },
  };
  return { table, stored, reads: () => reads };
};

describe("client sessions", () => {
  it("verify a token with no read of the table after they are loaded", () => {
    const clock = manualClock();
    const memory = memoryTable();
    const clientSessions = createClientSessions({ table: memory.table, key: randomBytes(32), environmentId, clock });
    expect(memory.reads()).toBe(1);

    const local = clientSessions.issueLocal("desktop", "desktop");
    const narrow = clientSessions.issue({ kind: "program", label: "bot", scopes: ["read"], ceiling: Ceiling.parse("plan") });
    for (let i = 0; i < 5; i++) {
      expect(clientSessions.verify(local.token)).toMatchObject({ ok: true, clientSession: { id: local.clientSessionId, local: true } });
      expect(clientSessions.verify(narrow.token)).toMatchObject({ ok: true, clientSession: { scopes: ["read"], local: false } });
    }
    clientSessions.revoke(narrow.clientSessionId);
    expect(clientSessions.verify(narrow.token)).toMatchObject({ ok: false, reason: "revoked" });
    expect(memory.reads()).toBe(1);
  });

  it("take kind, scopes, ceiling, the local flag and expiry from the table, not the token", () => {
    const clock = manualClock();
    const key = randomBytes(32);
    const memory = memoryTable();
    const first = createClientSessions({ table: memory.table, key, environmentId, clock });
    const narrow = first.issue({ kind: "program", label: "bot", scopes: ["read"], ceiling: Ceiling.parse("plan") });
    const stored = memory.stored.get(narrow.clientSessionId);
    if (!stored) throw new Error("the client session was not stored");
    stored.scopes = ["read", "admin"];
    stored.ceiling = Ceiling.parse("auto");
    stored.kind = "web";

    const second = createClientSessions({ table: memory.table, key, environmentId, clock });
    expect(second.verify(narrow.token)).toMatchObject({
      ok: true,
      clientSession: { kind: "web", scopes: ["read", "admin"], ceiling: "auto", local: false },
    });

    stored.expiresAt = clock.now().toISOString();
    const third = createClientSessions({ table: memory.table, key, environmentId, clock });
    expect(third.verify(narrow.token)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("load what the table holds, revocations included", () => {
    const clock = manualClock();
    const key = randomBytes(32);
    const memory = memoryTable();
    const first = createClientSessions({ table: memory.table, key, environmentId, clock });
    const kept = first.issueLocal("tui", "kept");
    const gone = first.issueLocal("tui", "gone");
    first.revoke(gone.clientSessionId);

    const second = createClientSessions({ table: memory.table, key, environmentId, clock });
    expect(second.verify(kept.token)).toMatchObject({ ok: true });
    expect(second.verify(gone.token)).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("issue local client sessions with every scope and the top ceiling, for 30 days", () => {
    const clock = manualClock();
    const clientSessions = createClientSessions({ table: memoryTable().table, key: randomBytes(32), environmentId, clock });
    const credential = clientSessions.issueLocal("tui", "t");
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
    const other = createClientSessions({ table: memory.table, key, environmentId: "0f8fad5b-d9cb-469f-a165-70867728950e", clock });
    const credential = other.issueLocal("tui", "elsewhere");
    const here = createClientSessions({ table: memory.table, key, environmentId, clock });
    expect(here.verify(credential.token)).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("tell listeners of a revocation once", () => {
    const clientSessions = createClientSessions({ table: memoryTable().table, key: randomBytes(32), environmentId, clock: manualClock() });
    const heard: string[] = [];
    clientSessions.onRevoked((id) => heard.push(id));
    const first = clientSessions.issueLocal("desktop", "one");
    const second = clientSessions.issueLocal("desktop", "two");
    expect(heard).toEqual([first.clientSessionId]);
    expect(clientSessions.revoke(second.clientSessionId)).toBe(true);
    expect(clientSessions.revoke(second.clientSessionId)).toBe(false);
    expect(heard).toEqual([first.clientSessionId, second.clientSessionId]);
  });

  it("count open sockets per client session for the tui sweep", () => {
    const clock = manualClock();
    const clientSessions = createClientSessions({ table: memoryTable().table, key: randomBytes(32), environmentId, clock });
    const tui = clientSessions.issueLocal("tui", "t");
    clientSessions.socketOpened(tui.clientSessionId);
    clientSessions.socketOpened(tui.clientSessionId);
    clientSessions.socketClosed(tui.clientSessionId);
    clock.advance(2 * 60 * 60 * 1000);
    clientSessions.sweep();
    expect(clientSessions.verify(tui.token)).toMatchObject({ ok: true });
    clientSessions.socketClosed(tui.clientSessionId);
    clock.advance(60 * 60 * 1000);
    clientSessions.sweep();
    expect(clientSessions.verify(tui.token)).toMatchObject({ ok: false, reason: "revoked" });
  });
});
