import { compareKeys } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { movesFor } from "./reorder.js";

/**
 * `Shift+↑` and `Shift+↓` (session-state spec, "Ordering: fractional keys"):
 * a move writes one key, between the rendered neighbours, to the session
 * moved; when a neighbour has no key the section's keys are spread evenly,
 * one command per session whose key changes.
 */

interface Row {
  readonly environmentId: string;
  readonly summary: { readonly id: string; readonly key: string | null };
}
const row = (id: string, key: string | null, environmentId = "desk"): Row => ({ environmentId, summary: { id, key } });
const keyOf = (r: Row) => r.summary.key;

describe("a move within a keyed section", () => {
  const section = [row("a", "d"), row("b", "h", "laptop"), row("c", "p")];

  it("gives the session moved up a key between its new neighbours, and touches no other", () => {
    const answer = movesFor(section, 2, -1, keyOf);
    expect("moves" in answer && answer.moves).toHaveLength(1);
    const [move] = "moves" in answer ? answer.moves : [];
    expect(move).toMatchObject({ environmentId: "desk", sessionId: "c" });
    expect(compareKeys("d", move?.key ?? "")).toBeLessThan(0);
    expect(compareKeys(move?.key ?? "", "h")).toBeLessThan(0);
  });

  it("gives the session moved to the top a key before the first, on its own environment", () => {
    const answer = movesFor(section, 1, -1, keyOf);
    const [move] = "moves" in answer ? answer.moves : [];
    expect(move).toMatchObject({ environmentId: "laptop", sessionId: "b" });
    expect(compareKeys(move?.key ?? "", "d")).toBeLessThan(0);
  });

  it("gives the session moved to the bottom a key after the last", () => {
    const answer = movesFor(section, 1, 1, keyOf);
    const [move] = "moves" in answer ? answer.moves : [];
    expect(compareKeys("p", move?.key ?? "")).toBeLessThan(0);
  });

  it("answers the edge at either end", () => {
    expect(movesFor(section, 0, -1, keyOf)).toEqual({ edge: "top" });
    expect(movesFor(section, 2, 1, keyOf)).toEqual({ edge: "bottom" });
  });
});

describe("a move next to a neighbour with no key", () => {
  it("spreads keys over the section in its new order, one move per session whose key changes", () => {
    const section = [row("a", null), row("b", null, "laptop"), row("c", "m")];
    const answer = movesFor(section, 1, -1, keyOf);
    const moves = "moves" in answer ? answer.moves : [];
    expect(moves.map((m) => m.sessionId)).toEqual(["b", "a", "c"].filter((id) => moves.some((m) => m.sessionId === id)));
    const keys = new Map(moves.map((m) => [m.sessionId, m.key]));
    const final = ["b", "a", "c"].map((id) => keys.get(id) ?? section.find((r) => r.summary.id === id)?.summary.key ?? "");
    expect([...final].sort(compareKeys)).toEqual(final);
    expect(moves.find((m) => m.sessionId === "b")?.environmentId).toBe("laptop");
  });

  it("spreads when two neighbours hold the same key", () => {
    const section = [row("a", "m"), row("b", "m", "laptop"), row("c", "t")];
    const answer = movesFor(section, 2, -1, keyOf);
    const moves = "moves" in answer ? answer.moves : [];
    expect(moves.length).toBeGreaterThan(1);
  });
});
