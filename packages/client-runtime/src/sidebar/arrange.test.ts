import { compareKeys, type SessionSummary } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { EnvironmentView } from "../projections/environments.js";
import type { MergedGroupHeading, SessionRow } from "../projections/session-list.js";
import { dropOnto, keysFor, stepIn, type Arrangement, type KeyMove } from "./arrange.js";
import type { EnvironmentHeading, FoldingHeading, SessionBlock } from "./headings.js";

/**
 * Arranging the sessions by hand (session-state spec, "Ordering: fractional
 * keys"; docs/specs/tui.md, "The rail"; docs/specs/gui.md, "The window and
 * the sidebar"): a move writes one key, between the drawn neighbours, to the
 * session moved, on its own environment, touching no neighbour; when a
 * neighbour has no key, or there is no room between, the section's keys are
 * spread evenly, one command per session whose key changes. The terminal
 * UI's Shift+↑ and Shift+↓ step a session one place; the window's drag
 * drops it onto a row or a heading: within its block it is reordered, onto
 * the pinned block it is pinned there, onto a group it moves into it, and a
 * shelf or a filtered list refuses it.
 */

let ids = 0;
const row = (environmentId: string, fields: Partial<SessionSummary> = {}, extra: Partial<SessionRow> = {}): SessionRow => ({
  environmentId,
  summary: { id: `s${++ids}`, title: `Session ${ids}`, pinnedAt: null, pinOrderKey: null, activeOrderKey: null, groupId: null, ...fields } as SessionSummary,
  groupName: null,
  pending: false,
  awaitingReceipt: false,
  ...extra,
});
const pin = (environmentId: string, key: string | null) => row(environmentId, { pinnedAt: "2026-09-24T00:00:00.000Z", pinOrderKey: key });
const active = (environmentId: string, key: string | null, extra: Partial<SessionRow> = {}) => row(environmentId, { activeOrderKey: key }, extra);

const block = (kind: SessionBlock["kind"], rows: readonly SessionRow[]): SessionBlock => ({ kind, rows });
const folding = (kind: FoldingHeading["kind"], rows: readonly SessionRow[], text = "Pinned", group: MergedGroupHeading | null = null, repository: string | null = null): FoldingHeading => {
  const of = block(kind === "pinned" ? "pinned" : kind === "group" || kind === "repository" ? "active" : kind === "archive" ? "archived" : kind, rows);
  return { kind, key: `${kind}:x`, text, block: of, rows: [], folded: false, pending: false, group, repository };
};
const environment = (environmentId: string, rows: readonly SessionRow[], holds: EnvironmentHeading["holds"] = "ungrouped"): EnvironmentHeading => ({
  kind: "environment",
  key: `environment:${environmentId}`,
  holds,
  block: block("active", rows),
  rows: [],
  environment: { environmentId, name: environmentId } as EnvironmentView,
  dim: false,
  list: undefined,
  empty: rows.length === 0,
});
const merged = (name: string, members: readonly [string, string][]): MergedGroupHeading => ({
  key: name.toLowerCase(),
  name,
  groups: members.map(([environmentId, groupId]) => ({ environmentId, groupId, name })),
  shelves: { pinned: [], active: [], snoozed: [], settled: [], archived: [] },
  pending: false,
  awaitingReceipt: false,
});

/** The keys a session ends with once the moves are written, in the section's new order. */
const keysAfter = (order: readonly SessionRow[], moves: readonly KeyMove[], keyOf: (r: SessionRow) => string | null) =>
  order.map((r) => moves.find((m) => m.sessionId === r.summary.id)?.key ?? keyOf(r));
const sorted = (keys: readonly (string | null)[]) => keys.every((key, i) => key !== null && (i === 0 || compareKeys(keys[i - 1] as string, key) < 0));
const movesOf = (arrangement: Arrangement | { readonly edge: string }): readonly KeyMove[] => ("moves" in arrangement ? arrangement.moves : []);

describe("keysFor: the keys that hold a session where it is put", () => {
  const pinKey = (r: SessionRow) => r.summary.pinOrderKey;

  it("gives it one key between its keyed neighbours, and touches no other", () => {
    const [a, b, c] = [pin("desk", "d"), pin("laptop", "h"), pin("desk", "p")];
    const moves = keysFor([a, c, b], 1, pinKey);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ environmentId: "desk", sessionId: c.summary.id });
    expect(sorted(keysAfter([a, c, b], moves, pinKey))).toBe(true);
  });

  it("gives it a key before the first, or after the last, at either end", () => {
    const [a, b] = [pin("desk", "d"), pin("laptop", "h")];
    const first = keysFor([b, a], 0, pinKey);
    expect(first).toEqual([{ environmentId: "laptop", sessionId: b.summary.id, key: expect.any(String) }]);
    expect(compareKeys(first[0]?.key ?? "", "d")).toBeLessThan(0);
    const last = keysFor([b, a], 1, pinKey);
    expect(compareKeys("h", last[0]?.key ?? "")).toBeLessThan(0);
  });

  it("spreads keys over the section when a neighbour has none, one move per session whose key changes, each on its own environment", () => {
    const [a, b, c] = [pin("desk", null), pin("laptop", null), pin("desk", "m")];
    const order = [b, a, c];
    const moves = keysFor(order, 0, pinKey);
    expect(moves.length).toBeGreaterThan(1);
    expect(sorted(keysAfter(order, moves, pinKey))).toBe(true);
    expect(moves.find((m) => m.sessionId === b.summary.id)?.environmentId).toBe("laptop");
  });

  it("spreads when there is no room between two neighbours holding the same key", () => {
    const [a, b, c] = [pin("desk", "m"), pin("laptop", "m"), pin("desk", "t")];
    const order = [a, c, b];
    const moves = keysFor(order, 1, pinKey);
    expect(moves.length).toBeGreaterThan(1);
    expect(sorted(keysAfter(order, moves, pinKey))).toBe(true);
  });
});

describe("stepIn: a session one place up or down its block", () => {
  it("moves within the pinned block, or among a heading's active sessions, with one key between the new neighbours", () => {
    const rows = [active("desk", "d"), active("laptop", "h"), active("desk", "p")];
    const up = stepIn(block("active", rows), 2, -1);
    expect(up).toMatchObject({ kind: "reorder", block: "active" });
    expect(movesOf(up)).toHaveLength(1);
    expect(sorted(keysAfter([rows[0], rows[2], rows[1]] as SessionRow[], movesOf(up), (r) => r.summary.activeOrderKey))).toBe(true);
  });

  it("answers the edge at either end", () => {
    const rows = [pin("desk", "d"), pin("desk", "h")];
    expect(stepIn(block("pinned", rows), 0, -1)).toEqual({ edge: "top" });
    expect(stepIn(block("pinned", rows), 1, 1)).toEqual({ edge: "bottom" });
  });

  it("is refused on a shelf, which has no manual order", () => {
    const rows = [row("desk"), row("desk")];
    expect(stepIn(block("snoozed", rows), 1, -1)).toEqual({ kind: "refused", why: "shelf", shelf: "snoozed" });
  });
});

describe("dropOnto: a session dropped on a row or a heading", () => {
  it("reorders within its block, taking the place of the row it lands on", () => {
    const rows = [pin("desk", "d"), pin("laptop", "h"), pin("desk", "p")];
    const heading = folding("pinned", rows);
    const [a, b, c] = rows as [SessionRow, SessionRow, SessionRow];
    const down = dropOnto(a, { kind: "row", heading, at: 2 });
    expect(down).toMatchObject({ kind: "reorder", block: "pinned" });
    expect(sorted(keysAfter([b, c, a], movesOf(down), (r) => r.summary.pinOrderKey))).toBe(true);
    expect(dropOnto(b, { kind: "row", heading, at: 1 })).toEqual({ kind: "unchanged" });
  });

  it("pins a session dropped into the pinned block where it lands, and one dropped on the block's heading at its end", () => {
    const rows = [pin("desk", "d"), pin("laptop", "h")];
    const heading = folding("pinned", rows);
    const loose = active("laptop", null);
    const placed = dropOnto(loose, { kind: "row", heading, at: 1 });
    expect(placed).toMatchObject({ kind: "pin", row: loose, moves: [] });
    const key = placed.kind === "pin" ? placed.key : null;
    expect(key !== null && compareKeys("d", key) < 0 && compareKeys(key, "h") < 0).toBe(true);

    expect(dropOnto(loose, { kind: "heading", heading })).toEqual({ kind: "pin", row: loose, key: null, moves: [] });
    expect(dropOnto(loose, { kind: "pinned" })).toEqual({ kind: "pin", row: loose, key: null, moves: [] });
    expect(dropOnto(rows[0] as SessionRow, { kind: "heading", heading })).toEqual({ kind: "unchanged" });
  });

  it("pins with keys spread over the block when the pins it lands among have none", () => {
    const rows = [pin("desk", null), pin("laptop", null)];
    const loose = active("desk", null);
    const placed = dropOnto(loose, { kind: "row", heading: folding("pinned", rows), at: 1 });
    expect(placed.kind).toBe("pin");
    if (placed.kind !== "pin") return;
    expect(placed.key).not.toBeNull();
    const order = [rows[0], loose, rows[1]] as SessionRow[];
    const keys = order.map((r) => (r === loose ? placed.key : (placed.moves.find((m) => m.sessionId === r.summary.id)?.key ?? r.summary.pinOrderKey)));
    expect(sorted(keys)).toBe(true);
  });

  it("moves a session dropped on a group, its heading or its rows, into it; one already in it stays", () => {
    const inside = row("laptop", { groupId: "g-laptop" }, { groupName: "brandsolidate" });
    const heading = folding("group", [inside], "Brandsolidate", merged("Brandsolidate", [["desk", "g-desk"], ["laptop", "g-laptop"]]));
    const loose = active("desk", null);
    expect(dropOnto(loose, { kind: "heading", heading })).toEqual({ kind: "group", row: loose, name: "Brandsolidate" });
    expect(dropOnto(loose, { kind: "row", heading, at: 0 })).toEqual({ kind: "group", row: loose, name: "Brandsolidate" });
    // In the group and pinned: it is in the group already, and a drop moves nothing.
    const pinnedInside = row("desk", { groupId: "g-desk", pinnedAt: "2026-09-24T00:00:00.000Z" }, { groupName: "Brandsolidate" });
    expect(dropOnto(pinnedInside, { kind: "heading", heading })).toEqual({ kind: "unchanged" });
  });

  it("takes a session dropped on its own environment's heading out of its group, and refuses one from another environment", () => {
    const grouped = row("desk", { groupId: "g-ops" }, { groupName: "Ops" });
    expect(dropOnto(grouped, { kind: "heading", heading: environment("desk", []) })).toEqual({ kind: "group", row: grouped, name: null });
    expect(dropOnto(active("desk", null), { kind: "heading", heading: environment("desk", []) })).toEqual({ kind: "unchanged" });
    expect(dropOnto(grouped, { kind: "heading", heading: environment("laptop", []) })).toEqual({ kind: "refused", why: "environment", environmentId: "desk" });
  });

  it("refuses a session dropped on a repository's heading or its rows from outside it, a repository not being a group; one of it stays, and moves within it", () => {
    const SITE = "https://github.com/david/site";
    const inside = [row("desk", { repositoryIdentity: SITE }), row("laptop", { repositoryIdentity: SITE })] as const;
    const heading = folding("repository", inside, "david/site", null, SITE);
    const elsewhere = row("desk", { repositoryIdentity: "https://github.com/david/other" });
    const none = active("desk", null);
    for (const dragged of [elsewhere, none]) {
      expect(dropOnto(dragged, { kind: "heading", heading })).toEqual({ kind: "refused", why: "repository" });
      expect(dropOnto(dragged, { kind: "row", heading, at: 0 })).toEqual({ kind: "refused", why: "repository" });
    }
    // Of the repository and pinned: it is under the repository already, and a drop moves nothing.
    const pinnedInside = row("desk", { repositoryIdentity: SITE, pinnedAt: "2026-09-24T00:00:00.000Z" });
    expect(dropOnto(pinnedInside, { kind: "heading", heading })).toEqual({ kind: "unchanged" });
    expect(dropOnto(inside[0], { kind: "heading", heading })).toEqual({ kind: "unchanged" });
    expect(dropOnto(inside[0], { kind: "row", heading, at: 1 })).toMatchObject({ kind: "reorder", block: "active" });
  });

  it("by repository, refuses a session with a repository dropped on its environment's heading, and leaves one with none where it is", () => {
    const grouped = row("desk", { groupId: "g-ops", repositoryIdentity: "https://github.com/david/site" }, { groupName: "Ops" });
    const unidentified = row("desk", { groupId: "g-ops", repositoryIdentity: null }, { groupName: "Ops" });
    expect(dropOnto(grouped, { kind: "heading", heading: environment("desk", [], "unidentified") })).toEqual({ kind: "refused", why: "repository" });
    expect(dropOnto(unidentified, { kind: "heading", heading: environment("desk", [], "unidentified") })).toEqual({ kind: "unchanged" });
    expect(dropOnto(unidentified, { kind: "heading", heading: environment("laptop", [], "unidentified") })).toEqual({ kind: "refused", why: "environment", environmentId: "desk" });
  });

  it("refuses a drop on a shelf, its heading or its rows, and any drop in a filtered list", () => {
    const shelved = [row("desk"), row("desk")];
    const loose = active("desk", null);
    for (const kind of ["snoozed", "settled", "archive"] as const) {
      const shelf = kind === "archive" ? "archived" : kind;
      expect(dropOnto(loose, { kind: "heading", heading: folding(kind, shelved) })).toEqual({ kind: "refused", why: "shelf", shelf });
      expect(dropOnto(shelved[0] as SessionRow, { kind: "row", heading: folding(kind, shelved), at: 1 })).toEqual({ kind: "refused", why: "shelf", shelf });
    }
    expect(dropOnto(loose, { kind: "filtered" })).toEqual({ kind: "refused", why: "filtered" });
  });
});
