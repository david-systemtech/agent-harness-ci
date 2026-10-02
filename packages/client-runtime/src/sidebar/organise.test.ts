import type { SessionSummary } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { MergedGroupHeading, SessionRow } from "../projections/session-list.js";
import type { Commands } from "../outbox/outbox.js";
import { changeHeading, groupChoices, hasTag, snoozeStands, toggleOf } from "./organise.js";

/**
 * The organising rules a session's commands follow in both renderers
 * (docs/specs/tui.md, "The rail"; docs/specs/gui.md, "The window and the
 * sidebar"): which of a toggle's two commands a session takes, when a
 * snooze stands to be woken, whether a tag is held, which groups a session
 * can be moved into, and a merged heading's rename and delete as one
 * command per member group (#128).
 */

const NOW = new Date("2026-09-24T10:00:00.000Z");
const summary = (fields: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: "s1", archivedAt: null, pinnedAt: null, settledAt: null, snoozedUntil: null, tags: [], groupId: null, ...fields }) as SessionSummary;
const row = (environmentId: string, fields: Partial<SessionSummary> = {}, groupName: string | null = null): SessionRow => ({
  environmentId,
  summary: summary(fields),
  groupName,
  pending: false,
  awaitingReceipt: false,
});
const heading = (name: string, members: readonly [string, string, string?][]): MergedGroupHeading => ({
  key: name.toLowerCase(),
  name,
  groups: members.map(([environmentId, groupId, held]) => ({ environmentId, groupId, name: held ?? name })),
  shelves: { pinned: [], active: [], snoozed: [], settled: [], archived: [] },
  pending: false,
  awaitingReceipt: false,
});

describe("a toggle", () => {
  it("sends the command that turns it on while it is off, and the one that turns it off while it is on", () => {
    expect(toggleOf(summary(), "archive")).toEqual({ method: "sessions.archive", on: false });
    expect(toggleOf(summary({ archivedAt: NOW.toISOString() }), "archive")).toEqual({ method: "sessions.unarchive", on: true });
    expect(toggleOf(summary(), "pin")).toEqual({ method: "sessions.pin", on: false });
    expect(toggleOf(summary({ pinnedAt: NOW.toISOString() }), "pin")).toEqual({ method: "sessions.unpin", on: true });
    expect(toggleOf(summary(), "settle")).toEqual({ method: "sessions.settle", on: false });
    expect(toggleOf(summary({ settledAt: NOW.toISOString() }), "settle")).toEqual({ method: "sessions.unsettle", on: true });
  });
});

describe("a snooze", () => {
  it("stands while its wake time is after the environment's now, and not once it has passed", () => {
    expect(snoozeStands(summary(), NOW)).toBe(false);
    expect(snoozeStands(summary({ snoozedUntil: "2026-09-24T11:00:00.000Z" }), NOW)).toBe(true);
    expect(snoozeStands(summary({ snoozedUntil: "2026-09-24T10:00:00.000Z" }), NOW)).toBe(false);
  });
});

describe("a tag", () => {
  it("is held ignoring case and the white space around it", () => {
    expect(hasTag(summary({ tags: ["WIP"] }), " wip ")).toBe(true);
    expect(hasTag(summary({ tags: ["WIP"] }), "wipe")).toBe(false);
  });
});

describe("the groups a session can be moved into", () => {
  const groups = [heading("Meadowstudios", [["desk", "g1"], ["laptop", "g2", "meadowstudios"]]), heading("Ops", [["desk", "g3"]]), heading("Archery", [["laptop", "g4"]])];

  it("are every merged heading the typing matches, the one it is in marked, then a new one typed, then no group while it is in one", () => {
    const inBrand = row("laptop", { groupId: "g2" }, "meadowstudios");
    expect(groupChoices(groups, inBrand, "")).toEqual({
      listed: [
        { heading: groups[0], here: true },
        { heading: groups[1], here: false },
        { heading: groups[2], here: false },
      ],
      fresh: null,
      out: true,
    });
    expect(groupChoices(groups, inBrand, "  ar ")).toMatchObject({ listed: [{ heading: groups[2], here: false }], fresh: "ar", out: true });
  });

  it("offer a new group only for a name no heading has, ignoring case and white space, which is collapsed", () => {
    const loose = row("desk");
    expect(groupChoices(groups, loose, "  OPS ")).toMatchObject({ fresh: null, out: false });
    expect(groupChoices(groups, loose, " New   work ")).toMatchObject({ listed: [], fresh: "New work", out: false });
  });
});

describe("a merged heading's rename and delete", () => {
  it("are one command per member group, each on its own environment, answering each command's answer", async () => {
    const sent: unknown[] = [];
    const commands: Pick<Commands, "dispatch"> = {
      dispatch: (environmentId, method, params) => {
        sent.push({ environmentId, method, params });
        return Promise.resolve({ ok: false, commandId: null, error: { code: "unreachable", message: `${environmentId} said no.` } });
      },
    };
    const brand = heading("Meadowstudios", [["desk", "g1"], ["laptop", "g2", "meadowstudios"]]);
    const answers = await changeHeading(commands, brand, { rename: "Brand work" });
    expect(answers.map((answer) => !answer.ok && answer.error.message)).toEqual(["desk said no.", "laptop said no."]);
    await changeHeading(commands, brand, { delete: true });
    expect(sent).toEqual([
      { environmentId: "desk", method: "groups.rename", params: { groupId: "g1", name: "Brand work" } },
      { environmentId: "laptop", method: "groups.rename", params: { groupId: "g2", name: "Brand work" } },
      { environmentId: "desk", method: "groups.delete", params: { groupId: "g1" } },
      { environmentId: "laptop", method: "groups.delete", params: { groupId: "g2" } },
    ]);
  });
});
