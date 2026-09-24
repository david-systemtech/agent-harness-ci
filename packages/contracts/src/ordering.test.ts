import { describe, expect, it } from "vitest";
import {
  OrderKey,
  compareKeys,
  isOrderKey,
  keyBetween,
  shelfOf,
  shelves,
  sortActive,
  sortArchived,
  sortGroups,
  sortPinned,
  sortSettled,
  sortSnoozed,
  spreadKeys,
  type ListedGroup,
  type ListedSession,
  type SortableSummary,
} from "./index.js";

/**
 * The order keys and the sort every client runs (session-state spec,
 * "Ordering: fractional keys"): one test per sentence of the spec, the
 * sentence quoted in the test's name where it can be.
 */

const t = (minute: number): string => new Date(Date.UTC(2026, 8, 24, 0, minute)).toISOString();

/** A summary with only what the sort reads, nothing pinned, keyed, settled, snoozed or archived. */
const summary = (id: string, fields: Partial<SortableSummary> = {}): SortableSummary => ({
  id,
  createdAt: t(0),
  lastActivityAt: null,
  unsettledAt: null,
  archivedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  settledAt: null,
  snoozedUntil: null,
  ...fields,
});

const on = (environmentId: string, id: string, fields: Partial<SortableSummary> = {}): ListedSession => ({
  environmentId,
  summary: summary(id, fields),
});
const row = (id: string, fields: Partial<SortableSummary> = {}): ListedSession => on("laptop", id, fields);

const ids = (rows: readonly ListedSession[]): string[] => rows.map((listed) => listed.summary.id);

/** The client's connection list: the laptop first, then SYSTEM-SERVER. */
const environments = ["laptop", "system-server"];

describe("order keys", () => {
  it("are strings over a to z, never empty and never ending in a", () => {
    for (const key of ["b", "n", "an", "zzz", "aab", "zb"]) {
      expect(isOrderKey(key), key).toBe(true);
      expect(OrderKey.safeParse(key).success, key).toBe(true);
    }
    for (const key of ["", "a", "ba", "aa", "B", "b1", "é", " b", "b "]) {
      expect(isOrderKey(key), JSON.stringify(key)).toBe(false);
      expect(OrderKey.safeParse(key).success, JSON.stringify(key)).toBe(false);
    }
  });

  it("compare as plain strings: a prefix first, then letter by letter", () => {
    expect(["n", "b", "nb", "an", "z", "nan"].sort(compareKeys)).toEqual(["an", "b", "n", "nan", "nb", "z"]);
    expect(compareKeys("b", "b")).toBe(0);
    expect(compareKeys("b", "bb")).toBeLessThan(0);
    expect(compareKeys("c", "bz")).toBeGreaterThan(0);
  });
});

describe("keyBetween: the key between the rendered neighbours", () => {
  it("makes a key for an empty section, before the first and after the last", () => {
    expect(keyBetween(null, null)).toBe("n");
    const first = keyBetween(null, "b");
    expect(compareKeys(first, "b")).toBeLessThan(0);
    const last = keyBetween("z", null);
    expect(compareKeys(last, "z")).toBeGreaterThan(0);
    for (const key of [first, last]) expect(isOrderKey(key), key).toBe(true);
  });

  it("makes a key strictly between two neighbours, however close", () => {
    for (const [before, after] of [
      ["b", "z"],
      ["b", "c"],
      ["n", "nb"],
      ["ab", "b"],
      ["y", "yab"],
      ["mzzz", "n"],
      ["b", "bab"],
    ] as const) {
      const key = keyBetween(before, after);
      expect(isOrderKey(key), `${before} < ${key} < ${after}`).toBe(true);
      expect(compareKeys(before, key), `${before} < ${key}`).toBeLessThan(0);
      expect(compareKeys(key, after), `${key} < ${after}`).toBeLessThan(0);
    }
  });

  it("can always make one more key before any key, since no key ends in a", () => {
    let first = "b";
    for (let i = 0; i < 200; i++) {
      const key = keyBetween(null, first);
      expect(isOrderKey(key), key).toBe(true);
      expect(compareKeys(key, first)).toBeLessThan(0);
      first = key;
    }
  });

  it("keeps a section in order and valid through many moves into random places", () => {
    // A seeded generator, so a failure reproduces.
    let seed = 115;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const keys: string[] = [];
    for (let i = 0; i < 500; i++) {
      const at = Math.floor(random() * (keys.length + 1));
      keys.splice(at, 0, keyBetween(keys[at - 1] ?? null, keys[at] ?? null));
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort(compareKeys)).toEqual(keys);
    for (const key of keys) expect(isOrderKey(key), key).toBe(true);
  });

  it("refuses neighbours out of order, equal, or not keys", () => {
    expect(() => keyBetween("c", "b")).toThrow(RangeError);
    expect(() => keyBetween("b", "b")).toThrow(RangeError);
    expect(() => keyBetween("ba", null)).toThrow(RangeError);
    expect(() => keyBetween(null, "")).toThrow(RangeError);
    expect(() => keyBetween("B", null)).toThrow(RangeError);
  });
});

describe("spreadKeys: evenly spread keys for a section when a neighbour has none", () => {
  it("gives count keys, ascending, valid and distinct", () => {
    expect(spreadKeys(0)).toEqual([]);
    for (const count of [1, 2, 3, 24, 25, 26, 27, 100, 1000]) {
      const keys = spreadKeys(count);
      expect(keys, `${count}`).toHaveLength(count);
      expect(new Set(keys).size).toBe(count);
      expect([...keys].sort(compareKeys)).toEqual(keys);
      for (const key of keys) expect(isOrderKey(key), key).toBe(true);
    }
  });

  it("spreads them evenly over the whole key space, with room before the first and after the last", () => {
    expect(spreadKeys(1)).toEqual(["n"]);
    expect(spreadKeys(25)).toEqual("bcdefghijklmnopqrstuvwxyz".split(""));
    expect(spreadKeys(3)).toEqual(["g", "n", "t"]);
    // Two letters once one is too few; each gap between neighbours the same to within one step.
    const keys = spreadKeys(100);
    expect(keys.every((key) => key.length <= 2)).toBe(true);
    const value = (key: string) => (key.charCodeAt(0) - 97) * 26 + (key.length > 1 ? key.charCodeAt(1) - 97 : 0);
    const gaps = keys.slice(1).map((key, i) => value(key) - value(keys[i] as string));
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it("refuses a count that is not a whole number of zero or more", () => {
    expect(() => spreadKeys(-1)).toThrow(RangeError);
    expect(() => spreadKeys(1.5)).toThrow(RangeError);
  });
});

describe("shelf membership", () => {
  const now = new Date(t(30));

  it("is hidden if deleted; else archived; else settled; else snoozed; else pinned; else active", () => {
    const everything = { archivedAt: t(1), settledAt: t(2), snoozedUntil: t(60), pinnedAt: t(3) };
    expect(shelfOf({ ...summary("s", everything), deletedAt: t(4) }, now)).toBe("hidden");
    expect(shelfOf(summary("s", everything), now)).toBe("archived");
    expect(shelfOf(summary("s", { ...everything, archivedAt: null }), now)).toBe("settled");
    expect(shelfOf(summary("s", { ...everything, archivedAt: null, settledAt: null }), now)).toBe("snoozed");
    expect(shelfOf(summary("s", { pinnedAt: t(3) }), now)).toBe("pinned");
    expect(shelfOf(summary("s"), now)).toBe("active");
    expect(shelfOf({ ...summary("s"), deletedAt: null }, now)).toBe("active");
  });

  it("counts a session snoozed only while snoozedUntil is in the future by the environment's time", () => {
    expect(shelfOf(summary("s", { snoozedUntil: t(31) }), now)).toBe("snoozed");
    // A past snoozedUntil is awake, covering the sweep's latency; at the instant itself it has woken.
    expect(shelfOf(summary("s", { snoozedUntil: t(30) }), now)).toBe("active");
    expect(shelfOf(summary("s", { snoozedUntil: t(29), pinnedAt: t(1) }), now)).toBe("pinned");
  });

  it("sorts each shelf by its own rule in shelves(), with the hidden sessions left out", () => {
    const rows = [
      row("active-old", { lastActivityAt: t(1) }),
      row("pinned", { pinnedAt: t(2) }),
      row("archived", { archivedAt: t(3) }),
      row("active-new", { lastActivityAt: t(5) }),
      row("settled", { settledAt: t(4) }),
      row("snoozed", { snoozedUntil: t(90) }),
      { ...row("deleted"), summary: { ...summary("deleted"), deletedAt: t(6) } },
    ];
    expect(Object.fromEntries(Object.entries(shelves(rows, environments, now)).map(([shelf, listed]) => [shelf, ids(listed)]))).toEqual({
      pinned: ["pinned"],
      active: ["active-new", "active-old"],
      snoozed: ["snoozed"],
      settled: ["settled"],
      archived: ["archived"],
    });
  });
});

describe("the pinned block", () => {
  it("puts keyed sessions first, ascending by pinOrderKey", () => {
    const rows = [row("m", { pinnedAt: t(1), pinOrderKey: "m" }), row("c", { pinnedAt: t(2), pinOrderKey: "c" }), row("x", { pinnedAt: t(0), pinOrderKey: "x" })];
    expect(ids(sortPinned(rows, environments))).toEqual(["c", "m", "x"]);
  });

  it("then keyless sessions by pinnedAt ascending, the oldest pin first", () => {
    const rows = [
      row("new-pin", { pinnedAt: t(9) }),
      row("keyed", { pinnedAt: t(20), pinOrderKey: "z" }),
      row("old-pin", { pinnedAt: t(1) }),
    ];
    expect(ids(sortPinned(rows, environments))).toEqual(["keyed", "old-pin", "new-pin"]);
  });

  it("breaks a tie by the environment's position in the connection list, then by id", () => {
    const rows = [
      on("system-server", "a", { pinnedAt: t(1), pinOrderKey: "m" }),
      on("laptop", "c", { pinnedAt: t(1), pinOrderKey: "m" }),
      on("laptop", "b", { pinnedAt: t(1), pinOrderKey: "m" }),
      on("system-server", "d", { pinnedAt: t(2) }),
      on("laptop", "e", { pinnedAt: t(2) }),
    ];
    expect(ids(sortPinned(rows, environments))).toEqual(["b", "c", "a", "e", "d"]);
  });
});

describe("the active list", () => {
  it("puts keyless sessions first, newest first by the latest of lastActivityAt, unsettledAt and createdAt", () => {
    const rows = [
      row("active-at-5", { createdAt: t(0), lastActivityAt: t(5) }),
      row("unsettled-at-7", { createdAt: t(0), lastActivityAt: t(2), unsettledAt: t(7) }),
      row("created-at-6", { createdAt: t(6) }),
      row("created-at-1", { createdAt: t(1) }),
    ];
    expect(ids(sortActive(rows, environments))).toEqual(["unsettled-at-7", "created-at-6", "active-at-5", "created-at-1"]);
  });

  it("then keyed sessions ascending by activeOrderKey, so new and unsettled sessions appear above the arranged run", () => {
    const rows = [
      row("arranged-second", { activeOrderKey: "t", lastActivityAt: t(50) }),
      row("new", { createdAt: t(1) }),
      row("arranged-first", { activeOrderKey: "g", lastActivityAt: t(40) }),
      row("unsettled", { unsettledAt: t(2) }),
    ];
    expect(ids(sortActive(rows, environments))).toEqual(["unsettled", "new", "arranged-first", "arranged-second"]);
  });

  it("breaks a tie by the environment's position in the connection list, then by id; an environment not in the list goes last", () => {
    const rows = [
      on("elsewhere", "a", { createdAt: t(3) }),
      on("system-server", "b", { createdAt: t(3) }),
      on("laptop", "d", { createdAt: t(3) }),
      on("laptop", "c", { createdAt: t(3) }),
      on("system-server", "e", { activeOrderKey: "n" }),
      on("laptop", "f", { activeOrderKey: "n" }),
    ];
    expect(ids(sortActive(rows, environments))).toEqual(["c", "d", "b", "a", "f", "e"]);
  });
});

describe("the shelves", () => {
  it("sorts the settled shelf by settledAt, newest first", () => {
    const rows = [row("first", { settledAt: t(1) }), row("third", { settledAt: t(9) }), row("second", { settledAt: t(4) })];
    expect(ids(sortSettled(rows, environments))).toEqual(["third", "second", "first"]);
  });

  it("sorts the snoozed shelf by snoozedUntil, soonest first", () => {
    const rows = [row("friday", { snoozedUntil: t(500) }), row("tuesday", { snoozedUntil: t(100) }), row("wednesday", { snoozedUntil: t(200) })];
    expect(ids(sortSnoozed(rows, environments))).toEqual(["tuesday", "wednesday", "friday"]);
  });

  it("sorts the archive by archivedAt, newest first", () => {
    const rows = [row("old", { archivedAt: t(1) }), row("new", { archivedAt: t(8) }), row("mid", { archivedAt: t(3) })];
    expect(ids(sortArchived(rows, environments))).toEqual(["new", "mid", "old"]);
  });

  it("breaks a tie on every shelf by the environment's position, then by id", () => {
    const tied = (fields: Partial<SortableSummary>) => [on("system-server", "a", fields), on("laptop", "c", fields), on("laptop", "b", fields)];
    expect(ids(sortSettled(tied({ settledAt: t(1) }), environments))).toEqual(["b", "c", "a"]);
    expect(ids(sortSnoozed(tied({ snoozedUntil: t(1) }), environments))).toEqual(["b", "c", "a"]);
    expect(ids(sortArchived(tied({ archivedAt: t(1) }), environments))).toEqual(["b", "c", "a"]);
  });

  it("compares instants as instants, not as strings of different precision", () => {
    const rows = [row("later", { settledAt: "2026-09-24T00:00:00.5Z" }), row("earlier", { settledAt: "2026-09-24T00:00:00.100Z" })];
    expect(ids(sortSettled(rows, environments))).toEqual(["later", "earlier"]);
  });

  it("returns a new array and leaves the one given alone", () => {
    const rows = [row("b", { archivedAt: t(1) }), row("a", { archivedAt: t(2) })];
    const sorted = sortArchived(rows, environments);
    expect(ids(sorted)).toEqual(["a", "b"]);
    expect(ids(rows)).toEqual(["b", "a"]);
  });
});

describe("group order", () => {
  const group = (environmentId: string, id: string, orderKey: string | null, createdAt: string): ListedGroup => ({
    environmentId,
    group: { id, orderKey, createdAt },
  });

  it("puts keyed groups first, ascending by key, then keyless groups by createdAt", () => {
    const rows = [
      group("laptop", "keyless-new", null, t(9)),
      group("laptop", "keyed-m", "m", t(20)),
      group("laptop", "keyless-old", null, t(1)),
      group("laptop", "keyed-c", "c", t(30)),
    ];
    expect(sortGroups(rows, environments).map((listed) => listed.group.id)).toEqual(["keyed-c", "keyed-m", "keyless-old", "keyless-new"]);
  });

  it("breaks a tie by the environment's position, then by id", () => {
    const rows = [
      group("system-server", "a", "m", t(1)),
      group("laptop", "c", "m", t(1)),
      group("laptop", "b", "m", t(1)),
      group("system-server", "d", null, t(1)),
      group("laptop", "e", null, t(1)),
    ];
    expect(sortGroups(rows, environments).map((listed) => listed.group.id)).toEqual(["b", "c", "a", "e", "d"]);
  });
});
