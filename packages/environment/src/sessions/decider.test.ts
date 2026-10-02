import { describe, expect, it } from "vitest";
import { MAX_TAGS } from "@agent-harness/contracts";
import {
  DELETION_GRACE_MS,
  PURGED_STATE,
  decideArchive,
  decideCreate,
  decideDelete,
  decidePin,
  decidePurge,
  decideRestore,
  decideRename,
  decideReorderActive,
  decideReorderPinned,
  decideSetDraft,
  decideSetGroup,
  decideTag,
  decideUnarchive,
  decideUnpin,
  decideUntag,
  normaliseTags,
  sessionNotFound,
  tagKey,
  type CreateSession,
  type Decision,
  type SessionState,
} from "./decider.js";

/**
 * The session aggregate's decider on its own: pure, so each rule is a plain
 * call, the state in and the events or the typed refusal out.
 */

const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const groupId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

const command = (overrides: Partial<CreateSession> = {}): CreateSession => ({
  id,
  title: null,
  tags: [],
  groupId: null,
  workspace: { kind: "directory", path: "/work/repo" },
  repositoryIdentity: null,
  account: null,
  model: null,
  mode: null,
  browser: null,
  ...overrides,
});

/** A session that is not deleted, with the user title and any other fields given. */
const live = (userTitle: string | null = null, fields: Partial<SessionState> = {}): SessionState => ({
  ...PURGED_STATE,
  deleted: false,
  purged: false,
  userTitle,
  ...fields,
});

/** A deleted session in its grace period, with the fields given. */
const deleted = (fields: Partial<SessionState> = {}): SessionState => ({
  ...PURGED_STATE,
  purged: false,
  purgeAt: "2026-10-24T01:02:03.456Z",
  ...fields,
});

const at = "2026-09-24T01:02:03.456Z";
const later = "2026-09-24T02:00:00.000Z";

describe("deciding sessions.create", () => {
  it("creates a session that never existed: one session.created, no repository identity", () => {
    expect(decideCreate(null, command(), { groupExists: false })).toEqual({
      events: [
        {
          type: "session.created",
          payload: {
            title: null,
            tags: [],
            groupId: null,
            workspace: { kind: "directory", path: "/work/repo" },
            repositoryIdentity: null,
            account: null,
            model: null,
            mode: null,
          },
        },
      ],
    });
  });

  it("trims the title and normalises the tags", () => {
    const decision = decideCreate(null, command({ title: "  Hi  ", tags: ["b", " A", "a "] }), { groupExists: false });
    expect(decision).toMatchObject({ events: [{ payload: { title: "Hi", tags: ["a", "b"] } }] });
  });

  it("refuses an id already used, live, deleted or purged, conflict with reason exists", () => {
    for (const state of [live(), PURGED_STATE]) {
      expect(decideCreate(state, command(), { groupExists: true })).toMatchObject({
        rejected: { code: "conflict", data: { reason: "exists", sessionId: id } },
      });
    }
  });

  it("refuses a group that does not exist not_found, kind group, and takes one that does", () => {
    expect(decideCreate(null, command({ groupId }), { groupExists: false })).toMatchObject({
      rejected: { code: "not_found", data: { kind: "group", groupId } },
    });
    expect(decideCreate(null, command({ groupId }), { groupExists: true })).toMatchObject({ events: [{ payload: { groupId } }] });
  });
});

describe("deciding sessions.rename", () => {
  it("sets a trimmed user title with source user", () => {
    expect(decideRename(live(), { sessionId: id, title: "  New name " })).toEqual({
      events: [{ type: "session.title-set", payload: { title: "New name", source: "user" } }],
    });
    expect(decideRename(live("Old"), { sessionId: id, title: null })).toEqual({ events: [{ type: "session.title-set", payload: { title: null, source: "user" } }] });
  });

  it("changes nothing when the title is already the session's", () => {
    expect(decideRename(live("Same"), { sessionId: id, title: " Same" })).toEqual({ events: [] });
    expect(decideRename(live(), { sessionId: id, title: null })).toEqual({ events: [] });
  });

  it("refuses a session that does not exist, or is deleted, not_found, kind session", () => {
    for (const state of [null, deleted({ userTitle: "Gone" })]) {
      expect(decideRename(state, { sessionId: id, title: "x" })).toMatchObject({ rejected: { code: "not_found", data: { kind: "session", sessionId: id } } });
    }
  });
});

describe("refusing a session that is not there", () => {
  it("is one not_found, kind session, naming the id: what a command's receipt and sessions.get both carry", () => {
    expect(sessionNotFound(id)).toEqual({ code: "not_found", message: `No session ${id} is on this environment.`, data: { kind: "session", sessionId: id } });
  });
});

describe("normalising tags", () => {
  it("folds case one way for uniqueness and order, the key the session-tags table is unique on", () => {
    expect(tagKey("WiP")).toBe("wip");
  });

  it("trims, keeps one per spelling ignoring case with the latest casing, and sorts ignoring case", () => {
    expect(normaliseTags(["wip", " Milo", "review", "WIP", "milo "])).toEqual(["milo", "review", "WIP"]);
    expect(normaliseTags([])).toEqual([]);
    expect(normaliseTags(["b", "B", "a"])).toEqual(["a", "B"]);
  });
});

/** The event types a decision appends, or its refusal's code and reason. */
const outcome = (decision: Decision): string[] | { code: string; reason?: unknown } =>
  decision.rejected === undefined
    ? decision.events.map((event) => event.type)
    : { code: decision.rejected.code, ...("reason" in decision.rejected.data && { reason: decision.rejected.data.reason }) };

describe("deciding the filing commands on a session that is not there", () => {
  const sessionId = id;
  const every: [string, (state: SessionState | null) => Decision][] = [
    ["archive", (state) => decideArchive(state, { sessionId, at })],
    ["unarchive", (state) => decideUnarchive(state, { sessionId })],
    ["pin", (state) => decidePin(state, { sessionId, orderKey: null, at })],
    ["unpin", (state) => decideUnpin(state, { sessionId })],
    ["reorderPinned", (state) => decideReorderPinned(state, { sessionId, orderKey: "m" })],
    ["reorderActive", (state) => decideReorderActive(state, { sessionId, orderKey: "m" })],
    ["tag", (state) => decideTag(state, { sessionId, tag: "wip" })],
    ["untag", (state) => decideUntag(state, { sessionId, tag: "wip" })],
    ["setDraft", (state) => decideSetDraft(state, { sessionId, draft: "typed" })],
  ];

  it("refuses every one not_found, kind session, whether never created, deleted or purged", () => {
    for (const [name, decide] of every) {
      for (const state of [null, deleted({ pinnedAt: at, tags: ["wip"] }), PURGED_STATE]) {
        expect(decide(state), name).toEqual({ rejected: sessionNotFound(sessionId) });
      }
    }
  });
});

describe("deciding sessions.archive and sessions.unarchive", () => {
  it("archives at the time given, and unarchives an archived session", () => {
    expect(decideArchive(live(), { sessionId: id, at })).toEqual({ events: [{ type: "session.archived", payload: { archivedAt: at } }] });
    expect(decideUnarchive(live(null, { archivedAt: at }), { sessionId: id })).toEqual({ events: [{ type: "session.unarchived", payload: {} }] });
  });

  it("changes nothing on an archived session's archive, or an unarchived one's unarchive", () => {
    expect(decideArchive(live(null, { archivedAt: at }), { sessionId: id, at: later })).toEqual({ events: [] });
    expect(decideUnarchive(live(), { sessionId: id })).toEqual({ events: [] });
  });
});

describe("deciding sessions.pin and sessions.unpin", () => {
  it("pins at the time given, with the key or none", () => {
    expect(decidePin(live(), { sessionId: id, orderKey: null, at })).toEqual({
      events: [{ type: "session.pinned", payload: { pinnedAt: at, pinOrderKey: null } }],
    });
    expect(decidePin(live(), { sessionId: id, orderKey: "m", at })).toEqual({
      events: [{ type: "session.pinned", payload: { pinnedAt: at, pinOrderKey: "m" } }],
    });
  });

  it("pins a settled session and unsettles it, a snoozed one and wakes it, in one decision; an archived one with session.pinned alone", () => {
    const pin = (fields: Partial<SessionState>) => {
      const decision = decidePin(live(null, fields), { sessionId: id, orderKey: null, at: later });
      return decision.rejected === undefined ? [decision.events.map((event) => event.type), decision.companions?.map((event) => event.type)] : decision;
    };
    expect(pin({ settledAt: at })).toEqual([["session.pinned"], ["session.unsettled"]]);
    expect(pin({ snoozedUntil: later })).toEqual([["session.pinned"], ["session.unsnoozed"]]);
    expect(pin({ archivedAt: at })).toEqual([["session.pinned"], undefined]);
  });

  it("changes nothing on a pinned session given no key or its own; another key moves it in the block, keeping the pin's time", () => {
    const pinned = live(null, { pinnedAt: at, pinOrderKey: "m" });
    expect(decidePin(pinned, { sessionId: id, orderKey: null, at: later })).toEqual({ events: [] });
    expect(decidePin(pinned, { sessionId: id, orderKey: "m", at: later })).toEqual({ events: [] });
    expect(decidePin(pinned, { sessionId: id, orderKey: "c", at: later })).toEqual({
      events: [{ type: "session.pin-reordered", payload: { pinOrderKey: "c" } }],
    });
    expect(decidePin(live(null, { pinnedAt: at }), { sessionId: id, orderKey: "c", at: later })).toEqual({
      events: [{ type: "session.pin-reordered", payload: { pinOrderKey: "c" } }],
    });
  });

  it("unpins a pinned session, and changes nothing on one that is not", () => {
    expect(decideUnpin(live(null, { pinnedAt: at, pinOrderKey: "m" }), { sessionId: id })).toEqual({
      events: [{ type: "session.unpinned", payload: {} }],
    });
    expect(decideUnpin(live(), { sessionId: id })).toEqual({ events: [] });
  });
});

describe("deciding sessions.reorderPinned", () => {
  it("moves a pinned session to the key, and changes nothing at its own key", () => {
    const pinned = live(null, { pinnedAt: at, pinOrderKey: "m" });
    expect(decideReorderPinned(pinned, { sessionId: id, orderKey: "c" })).toEqual({
      events: [{ type: "session.pin-reordered", payload: { pinOrderKey: "c" } }],
    });
    expect(decideReorderPinned(pinned, { sessionId: id, orderKey: "m" })).toEqual({ events: [] });
    expect(outcome(decideReorderPinned(live(null, { pinnedAt: at }), { sessionId: id, orderKey: "m" }))).toEqual(["session.pin-reordered"]);
  });

  it("refuses a session that is not pinned conflict, reason not_pinned", () => {
    expect(decideReorderPinned(live(), { sessionId: id, orderKey: "c" })).toMatchObject({
      rejected: { code: "conflict", data: { reason: "not_pinned", sessionId: id } },
    });
  });
});

describe("deciding sessions.reorderActive", () => {
  it("arranges an active session, and changes nothing at its own key", () => {
    expect(decideReorderActive(live(), { sessionId: id, orderKey: "g" })).toEqual({
      events: [{ type: "session.active-reordered", payload: { activeOrderKey: "g" } }],
    });
    expect(decideReorderActive(live(null, { activeOrderKey: "g" }), { sessionId: id, orderKey: "g" })).toEqual({ events: [] });
  });

  it("refuses a pinned, settled or archived session conflict, reason not_active", () => {
    for (const fields of [{ pinnedAt: at }, { settledAt: at }, { archivedAt: at }]) {
      expect(outcome(decideReorderActive(live(null, fields), { sessionId: id, orderKey: "g" })), JSON.stringify(fields)).toEqual({
        code: "conflict",
        reason: "not_active",
      });
    }
  });

  it("arranges a snoozed session, which keeps its active slot for when it wakes", () => {
    expect(outcome(decideReorderActive(live(null, { snoozedUntil: later }), { sessionId: id, orderKey: "g" }))).toEqual([
      "session.active-reordered",
    ]);
  });
});

describe("deciding sessions.tag and sessions.untag", () => {
  it("adds a tag trimmed", () => {
    expect(decideTag(live(null, { tags: ["wip"] }), { sessionId: id, tag: "  review " })).toEqual({
      events: [{ type: "session.tagged", payload: { tag: "review" } }],
    });
  });

  it("changes nothing for a tag held in the same casing; a new casing is tagged again, so the latest casing is kept", () => {
    expect(decideTag(live(null, { tags: ["wip"] }), { sessionId: id, tag: " wip" })).toEqual({ events: [] });
    expect(decideTag(live(null, { tags: ["wip"] }), { sessionId: id, tag: "WIP" })).toEqual({
      events: [{ type: "session.tagged", payload: { tag: "WIP" } }],
    });
  });

  it(`refuses a tag past ${MAX_TAGS} conflict, reason too_many_tags, while a casing of one held is still taken`, () => {
    const full = live(null, { tags: Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`) });
    expect(decideTag(full, { sessionId: id, tag: "one-more" })).toMatchObject({
      rejected: { code: "conflict", data: { reason: "too_many_tags", sessionId: id, limit: MAX_TAGS } },
    });
    expect(outcome(decideTag(full, { sessionId: id, tag: "T0" }))).toEqual(["session.tagged"]);
    const almost = live(null, { tags: Array.from({ length: MAX_TAGS - 1 }, (_, i) => `t${i}`) });
    expect(outcome(decideTag(almost, { sessionId: id, tag: "one-more" }))).toEqual(["session.tagged"]);
  });

  it("removes a tag matched ignoring case, naming it as the session held it; one not held changes nothing", () => {
    expect(decideUntag(live(null, { tags: ["review", "Milo"] }), { sessionId: id, tag: " MILO " })).toEqual({
      events: [{ type: "session.untagged", payload: { tag: "Milo" } }],
    });
    expect(decideUntag(live(null, { tags: ["review"] }), { sessionId: id, tag: "Milo" })).toEqual({ events: [] });
  });
});

describe("deciding sessions.setDraft", () => {
  it("replaces the draft with the value sent, as it is", () => {
    expect(decideSetDraft(live(), { sessionId: id, draft: "  typed \n" })).toEqual({
      events: [{ type: "session.draft-set", payload: { draft: "  typed \n" } }],
    });
    expect(decideSetDraft(live(null, { draft: "old" }), { sessionId: id, draft: "new" })).toEqual({
      events: [{ type: "session.draft-set", payload: { draft: "new" } }],
    });
  });

  it("clears it with null or an empty string", () => {
    for (const draft of [null, ""]) {
      expect(decideSetDraft(live(null, { draft: "old" }), { sessionId: id, draft })).toEqual({
        events: [{ type: "session.draft-set", payload: { draft: null } }],
      });
    }
  });

  it("changes nothing when the draft is already the one sent, or there is none to clear", () => {
    expect(decideSetDraft(live(null, { draft: "same" }), { sessionId: id, draft: "same" })).toEqual({ events: [] });
    expect(decideSetDraft(live(), { sessionId: id, draft: null })).toEqual({ events: [] });
    expect(decideSetDraft(live(), { sessionId: id, draft: "" })).toEqual({ events: [] });
  });
});

describe("deciding deletion", () => {
  const purgeAt = "2026-10-24T01:02:03.456Z";
  /** A session deleted and in its grace period until `purgeAt`. */
  const inGrace = deleted({ purgeAt });

  it("keeps a deleted session thirty days, as a constant", () => {
    expect(DELETION_GRACE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("deletes a live session: session.deleted at `at`, purgeAt thirty days on, and the transcript flag as asked", () => {
    for (const deleteProviderTranscript of [false, true]) {
      expect(decideDelete(live(), { sessionId: id, at, deleteProviderTranscript })).toEqual({
        events: [{ type: "session.deleted", payload: { deletedAt: at, purgeAt: new Date(Date.parse(at) + DELETION_GRACE_MS).toISOString(), deleteProviderTranscript } }],
      });
    }
  });

  it("refuses to delete a session that does not exist, is deleted or is purged not_found, as every command but restore and purge", () => {
    for (const state of [null, inGrace, PURGED_STATE]) {
      expect(decideDelete(state, { sessionId: id, at, deleteProviderTranscript: false })).toEqual({ rejected: sessionNotFound(id) });
    }
  });

  it("refuses every other command on a deleted session not_found", () => {
    const decisions: Decision[] = [
      decideRename(inGrace, { sessionId: id, title: "x" }),
      decideArchive(inGrace, { sessionId: id, at }),
      decideUnarchive(deleted({ purgeAt, archivedAt: at }), { sessionId: id }),
      decidePin(inGrace, { sessionId: id, orderKey: null, at }),
      decideUnpin(deleted({ purgeAt, pinnedAt: at }), { sessionId: id }),
      decideReorderPinned(deleted({ purgeAt, pinnedAt: at }), { sessionId: id, orderKey: "g" }),
      decideReorderActive(inGrace, { sessionId: id, orderKey: "g" }),
      decideTag(inGrace, { sessionId: id, tag: "wip" }),
      decideUntag(deleted({ purgeAt, tags: ["wip"] }), { sessionId: id, tag: "wip" }),
      decideSetDraft(inGrace, { sessionId: id, draft: "x" }),
      decideSetGroup(inGrace, { sessionId: id, groupId: null }, { groupExists: false }),
    ];
    for (const decision of decisions) expect(decision).toEqual({ rejected: sessionNotFound(id) });
  });

  it("restores a deleted session before its purgeAt: one session.restored", () => {
    expect(decideRestore(inGrace, { sessionId: id, at })).toEqual({ events: [{ type: "session.restored", payload: {} }] });
    const lastInstant = new Date(Date.parse(purgeAt) - 1).toISOString();
    expect(decideRestore(inGrace, { sessionId: id, at: lastInstant })).toEqual({ events: [{ type: "session.restored", payload: {} }] });
  });

  it("reads a purged session as deleted, purged, with no purgeAt", () => {
    expect(PURGED_STATE).toMatchObject({ deleted: true, purged: true, purgeAt: null });
  });

  it("refuses to restore once purgeAt has come, even before the sweep purges it, not_found", () => {
    for (const now of [purgeAt, "2026-11-01T00:00:00.000Z"]) {
      expect(decideRestore(inGrace, { sessionId: id, at: now })).toEqual({ rejected: sessionNotFound(id) });
    }
  });

  it("refuses to restore a session that does not exist or is purged not_found; one not deleted is unchanged", () => {
    for (const state of [null, PURGED_STATE]) expect(decideRestore(state, { sessionId: id, at })).toEqual({ rejected: sessionNotFound(id) });
    expect(decideRestore(live(), { sessionId: id, at })).toEqual({ events: [] });
  });

  it("purges only a deleted session: one not deleted is a conflict, not_deleted; one that does not exist or is purged not_found", () => {
    expect(decidePurge(inGrace, { sessionId: id })).toEqual({ purge: true });
    expect(decidePurge(live(), { sessionId: id })).toMatchObject({ rejected: { code: "conflict", data: { reason: "not_deleted", sessionId: id } } });
    for (const state of [null, PURGED_STATE]) expect(decidePurge(state, { sessionId: id })).toEqual({ rejected: sessionNotFound(id) });
  });
});

describe("deciding sessions.setGroup", () => {
  it("sets the group or null; the group it is in is unchanged", () => {
    expect(decideSetGroup(live(), { sessionId: id, groupId }, { groupExists: true })).toEqual({
      events: [{ type: "session.group-set", payload: { groupId } }],
    });
    expect(decideSetGroup(live(null, { groupId }), { sessionId: id, groupId: null }, { groupExists: false })).toEqual({
      events: [{ type: "session.group-set", payload: { groupId: null } }],
    });
    expect(decideSetGroup(live(null, { groupId }), { sessionId: id, groupId }, { groupExists: true })).toEqual({ events: [] });
    expect(decideSetGroup(live(), { sessionId: id, groupId: null }, { groupExists: false })).toEqual({ events: [] });
  });

  it("refuses a session not there before a group not there, each not_found with its kind", () => {
    for (const state of [null, PURGED_STATE]) {
      expect(decideSetGroup(state, { sessionId: id, groupId }, { groupExists: false })).toMatchObject({
        rejected: { code: "not_found", data: { kind: "session", sessionId: id } },
      });
    }
    expect(decideSetGroup(live(), { sessionId: id, groupId }, { groupExists: false })).toMatchObject({
      rejected: { code: "not_found", data: { kind: "group", groupId } },
    });
  });
});
