import { randomBytes } from "node:crypto";
import { Ceiling, SCOPES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { manualClock } from "../../test/clock.js";
import type { ClientSessionRow, ClientSessionTable } from "../event-log/client-sessions.js";
import { TOKEN_LIFETIME_MS, TOP_CEILING, createClientSessions } from "./client-sessions.js";

const environmentId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

type Stored = { -readonly [K in keyof ClientSessionRow]: ClientSessionRow[K] };

/** A table in memory that counts its reads. */
const memoryTable = (rows: ClientSessionRow[] = []) => {
  const stored = new Map<string, Stored>(rows.map((row) => [row.id, { ...row }]));
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
    const sessions = createClientSessions({ table: memory.table, key: randomBytes(32), environmentId, clock });
    expect(memory.reads()).toBe(1);

    const local = sessions.issueLocal("desktop", "desktop");
    const narrow = sessions.issue({ kind: "program", label: "bot", scopes: ["read"], ceiling: Ceiling.parse("plan") });
    for (let i = 0; i < 5; i++) {
      expect(sessions.verify(local.token)).toMatchObject({ ok: true, session: { id: local.clientSessionId, local: true } });
      expect(sessions.verify(narrow.token)).toMatchObject({ ok: true, session: { scopes: ["read"], local: false } });
    }
    sessions.revoke(narrow.clientSessionId);
    expect(sessions.verify(narrow.token)).toMatchObject({ ok: false, reason: "revoked" });
    expect(memory.reads()).toBe(1);
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

  it("issue local sessions with every scope and the top ceiling, for 30 days", () => {
    const clock = manualClock();
    const sessions = createClientSessions({ table: memoryTable().table, key: randomBytes(32), environmentId, clock });
    const credential = sessions.issueLocal("tui", "t");
    expect(credential).toMatchObject({ scopes: [...SCOPES], ceiling: TOP_CEILING });
    expect(Date.parse(credential.expiresAt) - clock.now().getTime()).toBe(TOKEN_LIFETIME_MS);
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
    const sessions = createClientSessions({ table: memoryTable().table, key: randomBytes(32), environmentId, clock: manualClock() });
    const heard: string[] = [];
    sessions.onRevoked((id) => heard.push(id));
    const first = sessions.issueLocal("desktop", "one");
    const second = sessions.issueLocal("desktop", "two");
    expect(heard).toEqual([first.clientSessionId]);
    expect(sessions.revoke(second.clientSessionId)).toBe(true);
    expect(sessions.revoke(second.clientSessionId)).toBe(false);
    expect(heard).toEqual([first.clientSessionId, second.clientSessionId]);
  });
});
