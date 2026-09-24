import { describe, expect, it } from "vitest";
import { decideCreate, decideRename, normaliseTags, sessionNotFound, tagKey, type CreateSession, type SessionState } from "./decider.js";

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
  account: null,
  model: null,
  mode: null,
  ...overrides,
});

const live = (userTitle: string | null = null): SessionState => ({ deleted: false, userTitle });

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
    for (const state of [live(), { deleted: true, userTitle: null }]) {
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
    for (const state of [null, { deleted: true, userTitle: "Gone" }]) {
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
    expect(normaliseTags(["wip", " Seth", "review", "WIP", "seth "])).toEqual(["review", "seth", "WIP"]);
    expect(normaliseTags([])).toEqual([]);
    expect(normaliseTags(["b", "B", "a"])).toEqual(["a", "B"]);
  });
});
