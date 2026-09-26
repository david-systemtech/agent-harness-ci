import type { EnvironmentView, MergedGroupHeading, SessionListView, SessionRow } from "@agent-harness/client-runtime";
import type { SessionSummary } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { badgesOf } from "./badge.js";
import { railLines, rowKey, type RailInput, type RailLine } from "./model.js";
import { wakeWords } from "./when.js";

/**
 * The rail as a pure function of `projections.sessionList` and
 * `projections.environments` (docs/specs/tui.md, "The rail"): the headings
 * in order, the fold state per heading name with the settled shelf and the
 * archive folded by default, each row's badge, glyph, tags and pending
 * marker, a down environment's rows dim under its "unreachable since", and
 * the filter over visible rows.
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

const listOf = (shelves: Partial<Pick<SessionListView, "pinned" | "active" | "snoozed" | "settled" | "archived" | "groups">>): SessionListView => {
  const empty = { pinned: [], active: [], snoozed: [], settled: [], archived: [] };
  const all = { ...empty, groups: [], ...shelves };
  return { ...all, environments: [], rows: [...all.pinned, ...all.active, ...all.snoozed, ...all.settled, ...all.archived], repositories: [] };
};

const heading = (key: string, name: string, active: SessionRow[], awaitingReceipt = false): MergedGroupHeading => ({
  key,
  name,
  groups: [],
  shelves: { pinned: [], active, snoozed: [], settled: [], archived: [] },
  pending: false,
  awaitingReceipt,
});

const input = (fields: Partial<RailInput>): RailInput => ({
  list: listOf({}),
  environments: [view("desk")],
  badges: badgesOf(fields.environments ?? [view("desk")]),
  folded: {},
  matches: null,
  startingService: false,
  now: () => NOW,
  ...fields,
});

/** Each line as a person reads it: a heading's text and count, a row's title, a note's text. */
const read = (lines: readonly RailLine[]) =>
  lines.map((line) =>
    line.kind === "heading"
      ? `${line.folded === null ? "" : line.folded ? "▸ " : "▾ "}${line.text}${line.folded ? ` ${line.count}` : ""}`
      : line.kind === "row"
        ? `  ${line.row.summary.title}${line.wake ? ` ${line.wake}` : ""}`
        : `  (${line.text})`,
  );

describe("the headings", () => {
  it("come pinned, the merged groups, each environment's ungrouped sessions, snoozed with wake times, then settled and the archive folded", () => {
    const pinned = row("laptop", { title: "Pinned on the laptop" });
    const grouped = [row("desk", { title: "Brand on the desk" }, { groupName: "Brandsolidate" }), row("laptop", { title: "Brand on the laptop" }, { groupName: "brandsolidate" })];
    const loose = row("desk", { title: "Loose" });
    const snoozed = row("desk", { title: "Later", snoozedUntil: "2026-09-24T18:00:00.000Z" });
    const settled = row("desk", { title: "Done" });
    const archived = row("laptop", { title: "Old" });
    const lines = railLines(
      input({
        environments: [view("desk"), view("laptop")],
        list: listOf({
          pinned: [pinned],
          active: [...grouped, loose],
          snoozed: [snoozed],
          settled: [settled],
          archived: [archived],
          groups: [heading("brandsolidate", "Brandsolidate", grouped)],
        }),
      }),
    );
    const wake = new Date("2026-09-24T18:00:00.000Z");
    expect(read(lines)).toEqual([
      "▾ Pinned",
      "  Pinned on the laptop",
      "▾ Brandsolidate",
      "  Brand on the desk",
      "  Brand on the laptop",
      "desk",
      "  Loose",
      "laptop",
      "▾ Snoozed",
      `  Later ${wakeWords(wake, NOW)}`,
      "▸ Settled 1",
      "▸ Archive 1",
    ]);
  });

  it("leave out an empty shelf and a group with no active session, but keep every environment's heading", () => {
    const lines = railLines(input({ environments: [view("desk"), view("laptop")], list: listOf({ groups: [heading("idle", "Idle", [])] }) }));
    expect(read(lines)).toEqual(["desk", "  (no sessions)", "laptop", "  (no sessions)"]);
  });

  it("fold and open by heading name, over the defaults", () => {
    const grouped = row("desk", { title: "In a group" }, { groupName: "Brand" });
    const settled = row("desk", { title: "Done" });
    const lines = railLines(
      input({
        list: listOf({ active: [grouped], settled: [settled], groups: [heading("brand", "Brand", [grouped])] }),
        folded: { "group:brand": true, "shelf:settled": false },
      }),
    );
    expect(read(lines)).toEqual(["▸ Brand 1", "desk", "▾ Settled", "  Done"]);
  });

  it("say pending while the runtime says a command about one of their groups awaits its receipt, or, folded, one about a row they hide", () => {
    const [renamed, quiet] = [row("desk", { title: "In a renamed group" }, { groupName: "Brand" }), row("desk", { title: "In a quiet group" }, { groupName: "Jams" })];
    const archived = row("desk", { title: "Archiving" }, { awaitingReceipt: true });
    const lines = railLines(
      input({ list: listOf({ active: [renamed, quiet], archived: [archived], groups: [heading("brand", "Brand", [renamed], true), heading("jams", "Jams", [quiet])] }) }),
    );
    const pending = lines.flatMap((l) => (l.kind === "heading" ? [[l.text, l.pending]] : []));
    expect(pending).toEqual([
      ["Brand", true],
      ["Jams", false],
      ["desk", false],
      ["Archive", true],
    ]);
  });
});

describe("a row", () => {
  it("carries its environment's badge, its activity glyph, its tags, and pending while the runtime says a command about it awaits its receipt, whatever the phase", () => {
    // Unreachable: the runtime's row is pending and awaiting. Reachable: awaiting only.
    const parked = row("laptop", { title: "Asking", tags: ["review", "wip"], activity: { state: "parked", since: NOW.toISOString() }, parkedPromptCount: 2 }, { pending: true, awaitingReceipt: true });
    const waiting = row("desk", { title: "Waiting" }, { awaitingReceipt: true });
    const quiet = row("desk", { title: "Quiet" });
    const lines = railLines(input({ environments: [view("desk"), view("laptop")], list: listOf({ active: [waiting, quiet, parked] }) }));
    const rows = lines.flatMap((l) => (l.kind === "row" ? [l] : []));
    expect(rows.map((r) => [r.row.summary.title, r.badge.abbreviation, r.glyph.text, r.tags, r.pending])).toEqual([
      ["Waiting", "DE", "·", [], true],
      ["Quiet", "DE", "·", [], false],
      ["Asking", "LA", "?2", ["review", "wip"], true],
    ]);
  });

  it("is dim when its environment cannot be reached, under a heading that says since when and how many commands wait", () => {
    const since = "2026-09-24T09:41:00.000Z";
    const cached = row("laptop", { title: "Cached" });
    const lines = railLines(
      input({
        environments: [view("desk"), view("laptop", { phase: "backoff", unreachableSince: since, pendingCommands: 2 })],
        list: listOf({ pinned: [cached] }),
      }),
    );
    const laptop = lines.find((l) => l.kind === "heading" && l.text === "laptop");
    expect(laptop).toMatchObject({ dim: true, pendingCommands: 2 });
    const at = new Date(since);
    expect(lines).toContainEqual(expect.objectContaining({ kind: "note", text: `unreachable since ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` }));
    expect(lines.find((l) => l.kind === "row")).toMatchObject({ dim: true });
    expect(lines.find((l) => l.kind === "heading" && l.text === "desk")).toMatchObject({ dim: false });
  });

  it("names the block it is in, in its rendered order, for the reorder keys", () => {
    const [a, b] = [row("desk", { title: "a" }), row("laptop", { title: "b" })];
    const lines = railLines(input({ environments: [view("desk"), view("laptop")], list: listOf({ pinned: [a, b] }) }));
    const first = lines.find((l) => l.kind === "row");
    expect(first?.kind === "row" && first.block).toEqual({ kind: "pinned", rows: [a, b] });
  });
});

describe("the filter", () => {
  it("keeps only matching visible rows and the headings over them", () => {
    const [fix, other, done] = [row("desk", { title: "Fix the rail" }), row("desk", { title: "Other" }), row("desk", { title: "Fix, settled" })];
    const lines = railLines(input({ list: listOf({ active: [fix, other], settled: [done] }), matches: new Set([rowKey(fix), rowKey(done)]) }));
    expect(read(lines)).toEqual(["desk", "  Fix the rail"]);
  });
});
