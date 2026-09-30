import type { SessionSummary } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentView } from "../projections/environments.js";
import type { MergedGroupHeading, SessionListView, SessionRow } from "../projections/session-list.js";
import { activityOf, keepsFold, rowKey, sessionHeadings, type HeadingsInput, type SessionHeading } from "./headings.js";

/**
 * The headings a session list is drawn under, which the terminal UI's rail
 * and the window's sidebar both draw (docs/specs/tui.md, "The rail";
 * docs/specs/gui.md, "The window and the sidebar"), as a pure function of
 * `projections.sessionList` and `projections.environments`: the headings in
 * order, the fold state per heading name with the settled shelf and the
 * archive folded by default, each row's activity, pending marker and wake
 * time, a down environment's rows dim, and the filter over visible rows.
 */

const NOW = new Date("2026-09-24T10:00:00.000Z");
const view = (name: string, fields: Partial<EnvironmentView> = {}): EnvironmentView =>
  ({
    environmentId: name,
    kind: "paired",
    name,
    icon: null,
    colour: null,
    phase: "ready",
    enabled: true,
    unreachableSince: null,
    pendingCommands: 0,
    blocked: null,
    ...fields,
  }) as EnvironmentView;

let ids = 0;
const row = (environmentId: string, fields: Partial<SessionSummary> = {}, extra: Partial<SessionRow> = {}): SessionRow => ({
  environmentId,
  summary: {
    id: `s${++ids}`,
    title: `Session ${ids}`,
    tags: [],
    activity: { state: "idle", since: NOW.toISOString() },
    parkedPromptCount: 0,
    snoozedUntil: null,
    ...fields,
  } as SessionSummary,
  groupName: null,
  pending: false,
  awaitingReceipt: false,
  ...extra,
});

const listOf = (shelves: Partial<Pick<SessionListView, "pinned" | "active" | "snoozed" | "settled" | "archived" | "groups" | "environments">>): SessionListView => {
  const empty = { pinned: [], active: [], snoozed: [], settled: [], archived: [] };
  const all = { ...empty, groups: [], environments: [], ...shelves };
  return { ...all, rows: [...all.pinned, ...all.active, ...all.snoozed, ...all.settled, ...all.archived], repositories: [] };
};

const group = (key: string, name: string, active: SessionRow[], awaitingReceipt = false): MergedGroupHeading => ({
  key,
  name,
  groups: [],
  shelves: { pinned: [], active, snoozed: [], settled: [], archived: [] },
  pending: false,
  awaitingReceipt,
});

const input = (fields: Partial<HeadingsInput>): HeadingsInput => ({
  list: listOf({}),
  environments: [view("desk")],
  folded: {},
  matches: null,
  now: () => NOW,
  ...fields,
});

/** Each heading as a person reads it, then its rows: a folding heading's fold and count, a row's title and wake time. */
const read = (headings: readonly SessionHeading[]) =>
  headings.flatMap((heading) => [
    heading.kind === "environment" ? (heading.environment.name ?? "") : `${heading.folded ? "▸" : "▾"} ${heading.text}${heading.folded ? ` ${heading.block.rows.length}` : ""}`,
    ...heading.rows.map((line) => `  ${line.row.summary.title}${line.wake === null ? "" : ` ${line.wake}`}`),
  ]);

describe("the headings", () => {
  const zone = process.env["TZ"];
  afterEach(() => {
    if (zone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = zone;
  });

  it("come pinned, the merged groups, each environment's ungrouped sessions, snoozed with wake times, then settled and the archive folded", () => {
    const pinned = row("laptop", { title: "Pinned on the laptop" });
    const grouped = [row("desk", { title: "Brand on the desk" }, { groupName: "Brandsolidate" }), row("laptop", { title: "Brand on the laptop" }, { groupName: "brandsolidate" })];
    const loose = row("desk", { title: "Loose" });
    const snoozed = row("desk", { title: "Later", snoozedUntil: "2026-09-24T14:00:00.000Z" });
    const settled = row("desk", { title: "Done" });
    const archived = row("laptop", { title: "Old" });
    const headings = sessionHeadings(
      input({
        environments: [view("desk"), view("laptop")],
        list: listOf({
          pinned: [pinned],
          active: [...grouped, loose],
          snoozed: [snoozed],
          settled: [settled],
          archived: [archived],
          groups: [group("brandsolidate", "Brandsolidate", grouped)],
        }),
      }),
    );
    expect(read(headings)).toEqual([
      "▾ Pinned",
      "  Pinned on the laptop",
      "▾ Brandsolidate",
      "  Brand on the desk",
      "  Brand on the laptop",
      "desk",
      "  Loose",
      "laptop",
      "▾ Snoozed",
      // Four hours on from the environment's now: the same day on this machine's calendar in any zone but those it crosses midnight in.
      expect.stringMatching(/^ {2}Later (\d\d:\d\d|\w{3} \d\d:\d\d)$/),
      "▸ Settled 1",
      "▸ Archive 1",
    ]);
    expect(headings.map((heading) => heading.key)).toEqual([
      "block:pinned",
      "group:brandsolidate",
      "environment:desk",
      "environment:laptop",
      "shelf:snoozed",
      "shelf:settled",
      "shelf:archive",
    ]);
  });

  it("say a snoozed row's wake time from its own environment's now, a clock time on this machine's calendar", () => {
    // Read in UTC, whatever zone the runner is in.
    process.env["TZ"] = "UTC";
    const later = row("desk", { title: "Later", snoozedUntil: "2026-09-24T10:30:00.000Z" });
    const [snoozed] = sessionHeadings(input({ list: listOf({ snoozed: [later] }), now: () => new Date("2026-09-24T10:00:00.000Z") })).filter((h) => h.kind === "snoozed");
    expect(snoozed?.rows[0]?.wake).toBe("10:30");
  });

  it("leave out an empty shelf and a group with no active session, but keep every environment's heading, saying it has no session", () => {
    const headings = sessionHeadings(input({ environments: [view("desk"), view("laptop")], list: listOf({ groups: [group("idle", "Idle", [])] }) }));
    expect(read(headings)).toEqual(["desk", "laptop"]);
    expect(headings.map((heading) => heading.kind === "environment" && heading.empty)).toEqual([true, true]);
  });

  it("fold and open by heading name, over the defaults", () => {
    const grouped = row("desk", { title: "In a group" }, { groupName: "Brand" });
    const settled = row("desk", { title: "Done" });
    const headings = sessionHeadings(
      input({
        list: listOf({ active: [grouped], settled: [settled], groups: [group("brand", "Brand", [grouped])] }),
        folded: { "group:brand": true, "shelf:settled": false },
      }),
    );
    expect(read(headings)).toEqual(["▸ Brand 1", "desk", "▾ Settled", "  Done"]);
  });

  it("say pending while the runtime says a command about one of their groups awaits its receipt, or, folded, one about a row they hide", () => {
    const [renamed, quiet] = [row("desk", { title: "In a renamed group" }, { groupName: "Brand" }), row("desk", { title: "In a quiet group" }, { groupName: "Jams" })];
    const archived = row("desk", { title: "Archiving" }, { awaitingReceipt: true });
    const headings = sessionHeadings(
      input({ list: listOf({ active: [renamed, quiet], archived: [archived], groups: [group("brand", "Brand", [renamed], true), group("jams", "Jams", [quiet])] }) }),
    );
    expect(headings.flatMap((h) => (h.kind === "environment" ? [] : [[h.text, h.pending]]))).toEqual([
      ["Brand", true],
      ["Jams", false],
      ["Archive", true],
    ]);
  });

  it("carry each environment's list freshness and fault on its heading", () => {
    const headings = sessionHeadings(
      input({
        environments: [view("desk"), view("laptop")],
        list: listOf({ environments: [{ environmentId: "desk", freshness: "live", fault: null }, { environmentId: "laptop", freshness: "cached", fault: "the list could not be read" }] }),
      }),
    );
    expect(headings.map((h) => (h.kind === "environment" ? h.list : undefined))).toEqual([
      { environmentId: "desk", freshness: "live", fault: null },
      { environmentId: "laptop", freshness: "cached", fault: "the list could not be read" },
    ]);
  });
});

describe("a row", () => {
  it("carries its activity with the parked count, and pending while the runtime says a command about it awaits its receipt, whatever the phase", () => {
    // Unreachable: the runtime's row is pending and awaiting. Reachable: awaiting only.
    const parked = row("laptop", { title: "Asking", activity: { state: "parked", since: NOW.toISOString() }, parkedPromptCount: 2 }, { pending: true, awaitingReceipt: true });
    const waiting = row("desk", { title: "Waiting", activity: { state: "running", since: NOW.toISOString() } }, { awaitingReceipt: true });
    const quiet = row("desk", { title: "Quiet" });
    const headings = sessionHeadings(input({ environments: [view("desk"), view("laptop")], list: listOf({ active: [waiting, quiet, parked] }) }));
    expect(headings.flatMap((h) => h.rows).map((r) => [r.row.summary.title, r.activity, r.pending])).toEqual([
      ["Waiting", { state: "running", parked: 0 }, true],
      ["Quiet", { state: "idle", parked: 0 }, false],
      ["Asking", { state: "parked", parked: 2 }, true],
    ]);
  });

  it("is dim when its environment cannot be reached, as its environment's heading is, wherever the row is drawn", () => {
    const cached = row("laptop", { title: "Cached" });
    const headings = sessionHeadings(
      input({
        environments: [view("desk"), view("laptop", { phase: "backoff", unreachableSince: "2026-09-24T09:41:00.000Z", pendingCommands: 2 })],
        list: listOf({ pinned: [cached] }),
      }),
    );
    expect(headings.flatMap((h) => h.rows)).toEqual([expect.objectContaining({ key: rowKey(cached), dim: true })]);
    expect(headings.flatMap((h) => (h.kind === "environment" ? [[h.environment.name, h.dim]] : []))).toEqual([
      ["desk", false],
      ["laptop", true],
    ]);
  });

  it("names the block it is in, in its drawn order, for a manual move", () => {
    const [a, b] = [row("desk", { title: "a" }), row("laptop", { title: "b" })];
    const [pinned] = sessionHeadings(input({ environments: [view("desk"), view("laptop")], list: listOf({ pinned: [a, b] }) }));
    expect(pinned?.rows[0]?.block).toEqual({ kind: "pinned", rows: [a, b] });
  });
});

describe("the activity", () => {
  it("is parked with the count whenever a prompt is parked, whatever the activity says, else starting, running or idle", () => {
    const at = NOW.toISOString();
    expect(activityOf({ activity: { state: "idle", since: at }, parkedPromptCount: 0 })).toEqual({ state: "idle", parked: 0 });
    expect(activityOf({ activity: { state: "starting", since: at }, parkedPromptCount: 0 })).toEqual({ state: "starting", parked: 0 });
    expect(activityOf({ activity: { state: "running", since: at }, parkedPromptCount: 0 })).toEqual({ state: "running", parked: 0 });
    expect(activityOf({ activity: { state: "running", since: at }, parkedPromptCount: 3 })).toEqual({ state: "parked", parked: 3 });
    expect(activityOf({ activity: { state: "parked", since: at }, parkedPromptCount: 0 })).toEqual({ state: "parked", parked: 0 });
  });
});

describe("the filter", () => {
  it("keeps only matching visible rows and the headings over them", () => {
    const [fix, other, done] = [row("desk", { title: "Fix the rail" }), row("desk", { title: "Other" }), row("desk", { title: "Fix, settled" })];
    const headings = sessionHeadings(input({ list: listOf({ active: [fix, other], settled: [done] }), matches: new Set([rowKey(fix), rowKey(done)]) }));
    expect(read(headings)).toEqual(["desk", "  Fix the rail"]);
  });
});

describe("the folds kept", () => {
  it("are every heading's but a merged group's the list no longer holds", () => {
    const keep = keepsFold(listOf({ groups: [group("brand", "Brand", [])] }));
    expect(["group:brand", "group:gone", "shelf:settled", "block:pinned"].filter(keep)).toEqual(["group:brand", "shelf:settled", "block:pinned"]);
  });
});
