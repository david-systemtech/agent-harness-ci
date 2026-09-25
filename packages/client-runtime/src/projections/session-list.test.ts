import { randomUUID } from "node:crypto";
import type { Group, SessionSummary } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { groupOf, summaryOf } from "../../test/events.js";
import type { ConnectionRecord } from "../connections/records.js";
import type { ListData } from "../streams/kinds.js";
import { writable } from "../observable.js";
import { cachedStream, emptyStream, type StreamState } from "../streams/stream.js";
import { MANUAL_CLOCK_START, manualClock } from "../testing/in-memory-platform.js";
import { searchRows } from "./search.js";
import { MAX_TIMER_MS, sessionListProjection, sessionListView, type SessionListInput, type SessionRow } from "./session-list.js";

/**
 * `projections.sessionList` and `projections.search` as pure functions of
 * the connection records and each environment's list stream
 * (docs/specs/client-runtime.md, "Projections"; session-state spec,
 * "Ordering" and "Merged groups by name"), with the expected orders the
 * session-state spec supplies.
 */

const [DESK, LAPTOP, TOWER] = ["env-desk", "env-laptop", "env-tower"];
const at = (minutes: number) => new Date(Date.parse(MANUAL_CLOCK_START) + minutes * 60_000).toISOString();

const record = (environmentId: string, enabled = true): ConnectionRecord =>
  ({ environmentId, enabled, phase: enabled ? "ready" : "disabled", descriptor: { name: environmentId } }) as ConnectionRecord;

const list = (sessions: SessionSummary[], groups: Group[] = []): StreamState<ListData> =>
  cachedStream(1, { sessions: new Map(sessions.map((s) => [s.id, s])), groups: new Map(groups.map((g) => [g.id, g])) });

const input = (lists: Record<string, StreamState<ListData>>, records = Object.keys(lists).map((id) => record(id))): SessionListInput => ({
  records,
  lists: new Map(Object.entries(lists)),
  now: () => new Date(MANUAL_CLOCK_START),
  pending: new Map(),
});

const named = (rows: readonly SessionRow[]) => rows.map((r) => r.summary.title);

describe("the session list", () => {
  it("lists every summary across enabled environments with its environment id and a pending flag, and each environment's freshness", () => {
    const a = summaryOf(randomUUID(), { title: "a" });
    const b = summaryOf(randomUUID(), { title: "b" });
    const hidden = summaryOf(randomUUID(), { title: "on a disabled environment" });
    const view = sessionListView(input({ [DESK]: list([a]), [LAPTOP]: list([b]), [TOWER]: list([hidden]) }, [record(DESK), record(LAPTOP), record(TOWER, false)]));
    expect(view.rows).toEqual([
      { environmentId: DESK, summary: a, groupName: null, pending: false },
      { environmentId: LAPTOP, summary: b, groupName: null, pending: false },
    ]);
    expect(view.environments).toEqual([
      { environmentId: DESK, freshness: "cached", fault: null },
      { environmentId: LAPTOP, freshness: "cached", fault: null },
    ]);
  });

  it("marks a row, and a heading over a group, pending when the outbox says a command about it waits", () => {
    const a = summaryOf(randomUUID());
    const b = summaryOf(randomUUID());
    const groupId = randomUUID();
    const pending = new Map([[DESK, { sessions: new Set([a.id]), groups: new Set([groupId]) }]]);
    const view = sessionListView({ ...input({ [DESK]: list([a, b], [groupOf(groupId, "Brand")]) }), pending });
    expect(view.rows.map((r) => [r.summary.id, r.pending])).toEqual([
      [a.id, true],
      [b.id, false],
    ]);
    expect(view.groups.map((h) => [h.name, h.pending])).toEqual([["Brand", true]]);
  });

  it("shows an environment with nothing cached as empty", () => {
    expect(sessionListView(input({ [DESK]: emptyStream() })).environments).toEqual([{ environmentId: DESK, freshness: "empty", fault: null }]);
  });

  it("puts each session on its shelf and sorts every shelf, merging environments by order key, ties by environment order then id", () => {
    const view = sessionListView(
      input({
        [DESK]: list([
          summaryOf(randomUUID(), { title: "pinned m", pinnedAt: at(1), pinOrderKey: "m" }),
          summaryOf(randomUUID(), { title: "active new", lastActivityAt: at(30) }),
          summaryOf(randomUUID(), { title: "arranged c", activeOrderKey: "c" }),
          summaryOf(randomUUID(), { title: "archived", archivedAt: at(5) }),
          summaryOf(randomUUID(), { title: "settled", settledAt: at(6) }),
          summaryOf(randomUUID(), { title: "snoozed late", snoozedUntil: at(600) }),
        ]),
        [LAPTOP]: list([
          summaryOf(randomUUID(), { title: "pinned c", pinnedAt: at(2), pinOrderKey: "c" }),
          summaryOf(randomUUID(), { title: "pinned m laptop", pinnedAt: at(2), pinOrderKey: "m" }),
          summaryOf(randomUUID(), { title: "active old", lastActivityAt: at(10) }),
          summaryOf(randomUUID(), { title: "arranged b", activeOrderKey: "b" }),
          summaryOf(randomUUID(), { title: "snoozed soon", snoozedUntil: at(60) }),
          summaryOf(randomUUID(), { title: "snoozed past", snoozedUntil: at(-1), lastActivityAt: at(20) }),
        ]),
      }),
    );
    expect(named(view.pinned)).toEqual(["pinned c", "pinned m", "pinned m laptop"]);
    expect(named(view.active)).toEqual(["active new", "snoozed past", "active old", "arranged b", "arranged c"]);
    expect(named(view.snoozed)).toEqual(["snoozed soon", "snoozed late"]);
    expect(named(view.settled)).toEqual(["settled"]);
    expect(named(view.archived)).toEqual(["archived"]);
  });

  it("wakes for a snooze further off than a timer can wait by looking again at the longest wait, never at once", () => {
    const clock = manualClock();
    const delays: number[] = [];
    const recorded = { ...clock, setTimeout: (callback: () => void, ms: number) => (delays.push(ms), clock.setTimeout(callback, ms)) };
    const far = MAX_TIMER_MS + 60 * 60_000;
    const due = summaryOf(randomUUID(), { title: "in a month", snoozedUntil: new Date(Date.parse(MANUAL_CLOCK_START) + far).toISOString() });
    const projection = sessionListProjection({
      records: writable([record(DESK)]),
      lists: writable(new Map([[DESK, list([due])]])),
      now: () => clock.now(),
      clock: recorded,
      pending: writable(new Map()),
    });
    const snoozed = () => named(projection.view.read().snoozed);
    expect(snoozed()).toEqual(["in a month"]);
    expect(delays).toEqual([MAX_TIMER_MS]);
    clock.advance(MAX_TIMER_MS);
    expect(snoozed()).toEqual(["in a month"]);
    expect(delays).toEqual([MAX_TIMER_MS, far - MAX_TIMER_MS]);
    clock.advance(far - MAX_TIMER_MS);
    expect(snoozed()).toEqual([]);
    projection.stop();
  });

  it("reads a snooze against each environment's own clock", () => {
    const due = summaryOf(randomUUID(), { title: "due at 30", snoozedUntil: at(30) });
    const view = sessionListView({ ...input({ [DESK]: list([due]), [LAPTOP]: list([{ ...due, id: randomUUID() }]) }), now: (id) => new Date(at(id === DESK ? 60 : 0)) });
    expect(view.active.map((r) => r.environmentId)).toEqual([DESK]);
    expect(view.snoozed.map((r) => r.environmentId)).toEqual([LAPTOP]);
  });
});

describe("merged groups", () => {
  it("merges names equal after trimming, collapsing white space and ignoring case into one heading with the primary environment's casing and group order", () => {
    const [deskBrand, deskJams, laptopBrand, laptopOther, towerJams] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const inDesk = summaryOf(randomUUID(), { title: "desk brand", groupId: deskBrand });
    const inLaptop = summaryOf(randomUUID(), { title: "laptop brand", groupId: laptopBrand, lastActivityAt: at(5) });
    const jams = summaryOf(randomUUID(), { title: "tower jams", groupId: towerJams });
    const view = sessionListView(
      input({
        [DESK]: list([inDesk], [groupOf(deskJams, "Cool Jams", { orderKey: "b" }), groupOf(deskBrand, "Brandsolidate", { orderKey: "m" })]),
        // The laptop orders them the other way round and spells them its own way; the desk is primary.
        [LAPTOP]: list([inLaptop], [groupOf(laptopBrand, "brandSOLIDATE", { orderKey: "a" }), groupOf(laptopOther, "Receipts", { orderKey: "z" })]),
        [TOWER]: list([jams], [groupOf(towerJams, "cool   JAMS")]),
      }),
    );
    expect(view.groups.map((h) => h.name)).toEqual(["Cool Jams", "Brandsolidate", "Receipts"]);
    const brand = view.groups[1];
    expect(brand?.key).toBe("brandsolidate");
    expect(brand?.groups).toEqual([
      { environmentId: DESK, groupId: deskBrand, name: "Brandsolidate" },
      { environmentId: LAPTOP, groupId: laptopBrand, name: "brandSOLIDATE" },
    ]);
    expect(named(brand?.shelves.active ?? [])).toEqual(["laptop brand", "desk brand"]);
    expect(brand?.pending).toBe(false);
    expect(view.groups[0]?.groups.map((g) => g.environmentId)).toEqual([DESK, TOWER]);
    expect(named(view.groups[0]?.shelves.active ?? [])).toEqual(["tower jams"]);
    expect(view.rows.find((r) => r.summary.id === inLaptop.id)?.groupName).toBe("brandSOLIDATE");
  });

  it("takes the casing of the first environment in order that has the name when the primary has not", () => {
    const [laptopGroup, towerGroup] = [randomUUID(), randomUUID()];
    const view = sessionListView(
      input({ [DESK]: list([]), [LAPTOP]: list([], [groupOf(laptopGroup, "wip")]), [TOWER]: list([], [groupOf(towerGroup, "WIP", { orderKey: "a" })]) }),
    );
    expect(view.groups.map((h) => [h.name, h.groups.length])).toEqual([["wip", 2]]);
  });

  it("orders the headings the primary environment has by its group order, then the rest by key, whatever the other environments' order", () => {
    const view = sessionListView(
      input({
        [DESK]: list([], [groupOf(randomUUID(), "Receipts", { orderKey: "m" })]),
        // The laptop comes first of the others and keeps Zulu before mike; neither decides where a heading goes.
        [LAPTOP]: list([], [groupOf(randomUUID(), "Zulu", { orderKey: "a" }), groupOf(randomUUID(), "mike", { orderKey: "b" })]),
        [TOWER]: list([], [groupOf(randomUUID(), "  Alpha "), groupOf(randomUUID(), "receipts")]),
      }),
    );
    expect(view.groups.map((h) => [h.key, h.name])).toEqual([
      ["receipts", "Receipts"],
      ["alpha", "  Alpha "],
      ["mike", "mike"],
      ["zulu", "Zulu"],
    ]);
  });

  it("splits a heading when one environment renames its group", () => {
    const [deskGroup, laptopGroup] = [randomUUID(), randomUUID()];
    const merged = sessionListView(input({ [DESK]: list([], [groupOf(deskGroup, "Brandsolidate")]), [LAPTOP]: list([], [groupOf(laptopGroup, "brandsolidate")]) }));
    expect(merged.groups.map((h) => h.groups.length)).toEqual([2]);
    const split = sessionListView(input({ [DESK]: list([], [groupOf(deskGroup, "Brandsolidate")]), [LAPTOP]: list([], [groupOf(laptopGroup, "Brand")]) }));
    expect(split.groups.map((h) => [h.name, h.groups.map((g) => g.groupId)])).toEqual([
      ["Brandsolidate", [deskGroup]],
      ["Brand", [laptopGroup]],
    ]);
  });
});

describe("by repository identity", () => {
  it("heads the sessions of one repository together across environments, leaving out those outside any repository", () => {
    const url = "https://git.systemtech.dev/david/agent-harness";
    const view = sessionListView(
      input({
        [DESK]: list([summaryOf(randomUUID(), { title: "desk", repositoryIdentity: url }), summaryOf(randomUUID(), { title: "scratch" })]),
        [LAPTOP]: list([summaryOf(randomUUID(), { title: "laptop", repositoryIdentity: url, lastActivityAt: at(3) }), summaryOf(randomUUID(), { title: "cool", repositoryIdentity: "https://github.com/x/cool-jams" })]),
      }),
    );
    expect(view.repositories.map((h) => [h.repositoryIdentity, named(h.shelves.active)])).toEqual([
      [url, ["laptop", "desk"]],
      ["https://github.com/x/cool-jams", ["cool"]],
    ]);
  });
});

describe("search", () => {
  it("matches a case-insensitive substring of titles, tags, group names and repository identity", () => {
    const group = randomUUID();
    const view = sessionListView(
      input({
        [DESK]: list(
          [
            summaryOf(randomUUID(), { title: "Invoices for March" }),
            summaryOf(randomUUID(), { title: "tagged", tags: ["Review"] }),
            summaryOf(randomUUID(), { title: "grouped", groupId: group }),
            summaryOf(randomUUID(), { title: "repo", repositoryIdentity: "https://github.com/x/cool-jams" }),
            summaryOf(randomUUID(), { title: "unrelated", draft: "invoices in the draft are not searched" }),
          ],
          [groupOf(group, "Brandsolidate")],
        ),
      }),
    );
    expect(named(searchRows(view, "INVOICES"))).toEqual(["Invoices for March"]);
    expect(named(searchRows(view, "revi"))).toEqual(["tagged"]);
    expect(named(searchRows(view, "solid"))).toEqual(["grouped"]);
    expect(named(searchRows(view, "COOL-jams"))).toEqual(["repo"]);
    expect(searchRows(view, "nothing like it")).toEqual([]);
    expect(searchRows(view, "  ")).toHaveLength(5);
  });
});
