import { describe, expect, it } from "vitest";
import {
  DELETED_GROUP,
  decideCreateGroup,
  decideDeleteGroup,
  decideRenameGroup,
  decideReorderGroup,
  groupNameKey,
  normaliseGroupName,
  type GroupState,
} from "./group-decider.js";

/**
 * The group decider on its own: pure, so each rule is a plain call, the
 * state in and the events or the typed refusal out.
 */

const groupId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const otherId = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";

const group = (fields: Partial<GroupState> = {}): GroupState => ({ deleted: false, name: "Brandsolidate", orderKey: null, ...fields });
const free = { nameHeldBy: null };
const heldBy = (id: string, name: string) => ({ nameHeldBy: { id, name } });

describe("group names", () => {
  it("keeps a name trimmed with every run of white space one space, and keys it lowercased", () => {
    expect(normaliseGroupName("  Cool \t Jams\n\n and  friends ")).toBe("Cool Jams and friends");
    expect(groupNameKey("  COOL   jams ")).toBe("cool jams");
  });
});

describe("deciding group commands", () => {
  it("creates a group never seen, its name normalised; an id used before is exists, a name held is name_taken", () => {
    expect(decideCreateGroup(null, { id: groupId, name: " A  b ", orderKey: "m" }, free)).toEqual({
      events: [{ type: "group.created", payload: { name: "A b", orderKey: "m" } }],
    });
    for (const state of [group(), DELETED_GROUP]) {
      expect(decideCreateGroup(state, { id: groupId, name: "A", orderKey: null }, free)).toMatchObject({
        rejected: { code: "conflict", data: { reason: "exists", groupId } },
      });
    }
    expect(decideCreateGroup(null, { id: groupId, name: " a ", orderKey: null }, heldBy(otherId, "A"))).toEqual({
      rejected: {
        code: "conflict",
        message: `The group ${otherId} is named "A", which is "a" ignoring case.`,
        data: { reason: "name_taken", name: "a", heldName: "A", groupId: otherId },
      },
    });
  });

  it("renames: its own name normalised is unchanged, its own name in another case is a rename, another group's is name_taken", () => {
    expect(decideRenameGroup(group(), { groupId, name: " Brandsolidate " }, heldBy(groupId, "Brandsolidate"))).toEqual({ events: [] });
    expect(decideRenameGroup(group(), { groupId, name: "BRANDSOLIDATE" }, heldBy(groupId, "Brandsolidate"))).toEqual({
      events: [{ type: "group.renamed", payload: { name: "BRANDSOLIDATE" } }],
    });
    expect(decideRenameGroup(group(), { groupId, name: "other" }, heldBy(otherId, "Other"))).toMatchObject({
      rejected: { code: "conflict", data: { reason: "name_taken", name: "other", heldName: "Other", groupId: otherId } },
    });
  });

  it("reorders to a new key; its own key is unchanged", () => {
    expect(decideReorderGroup(group({ orderKey: "m" }), { groupId, orderKey: "m" })).toEqual({ events: [] });
    expect(decideReorderGroup(group(), { groupId, orderKey: "m" })).toEqual({ events: [{ type: "group.reordered", payload: { orderKey: "m" } }] });
  });

  it("deletes with one ungrouping per member, in the members' order", () => {
    expect(decideDeleteGroup(group(), { groupId }, ["s1", "s2"])).toEqual({
      events: [{ type: "group.deleted", payload: {} }],
      ungroupings: [
        { sessionId: "s1", event: { type: "session.group-set", payload: { groupId: null } } },
        { sessionId: "s2", event: { type: "session.group-set", payload: { groupId: null } } },
      ],
    });
  });

  it("refuses rename, reorder and delete of a group never created or deleted not_found, kind group", () => {
    for (const state of [null, DELETED_GROUP]) {
      const notFound = { rejected: { code: "not_found", message: expect.any(String), data: { kind: "group", groupId } } };
      expect(decideRenameGroup(state, { groupId, name: "A" }, free)).toEqual(notFound);
      expect(decideReorderGroup(state, { groupId, orderKey: "m" })).toEqual(notFound);
      expect(decideDeleteGroup(state, { groupId }, [])).toEqual(notFound);
    }
  });
});
