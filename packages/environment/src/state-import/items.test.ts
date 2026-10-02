import { afterEach, describe, expect, it, vi } from "vitest";
import { openEventLog, type EventLog } from "../event-log/event-log.js";
import type { CommandAnswer, MethodContext } from "../serve/methods.js";
import { applyItems, derivedUuid, stateImportProjector, type ImportItem } from "./items.js";

/**
 * The state import's item protocol (switch-over spec, "Preview, application
 * and re-run"; #1165) over a log in memory, each item's owning service a
 * scripted one that appends its target's event, refuses, or throws: every
 * kind an import carries meets these rules. What is asserted is what
 * `applyItems` answers and what the log holds.
 */

const IMPORT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const caller: MethodContext = { clientSession: { id: "cs-import", kind: "tui", scopes: ["admin"], ceiling: "auto", local: true, expiresAt: 0 } };
const ACTOR = "client_session:cs-import";
/** Where the scripted owning service appends its targets' events: a stream of a kind the log knows, of a type no projector reads. */
const TARGETS = { kind: "instructions", id: "env-1" } as const;

let log: EventLog;
afterEach(() => log.close());

/** What the scripted owning service does with an item: makes its target, refuses it, or throws. */
type Owner = "makes" | "refuses" | "throws";

const scripted = (sourceId: string, owner: Owner, applied: string[]): ImportItem => ({
  sourceKey: "/source",
  store: "instructions",
  sourceId,
  kind: "instruction",
  label: `Instruction ${sourceId}`,
  apply: (context): CommandAnswer<{ readonly targetId: string }> => {
    applied.push(sourceId);
    if (owner === "throws") throw new Error(`The owner of ${sourceId} failed.`);
    if (owner === "refuses") return { aggregate: TARGETS, rejected: { code: "conflict", message: `The owner refuses ${sourceId}.` } };
    const targetId = `target-${sourceId}`;
    log.append(TARGETS, [{ type: "test.target-made", payload: { targetId } }], { tx: context.tx, actor: context.actor, commandId: context.commandId });
    return { aggregate: TARGETS, result: { targetId } };
  },
});

const apply = (items: readonly ImportItem[], importId = IMPORT) => applyItems(items, { log, environmentId: "env-1", importId, caller, actor: ACTOR });

describe("applying an import's items", () => {
  it("carries each in a command of its own, its target's events and its mapping together, and fails what its owner refuses or throws on alone", async () => {
    log = openEventLog({ path: ":memory:", projectors: [stateImportProjector] });
    const applied: string[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await apply([scripted("a", "makes", applied), scripted("b", "refuses", applied), scripted("c", "throws", applied), scripted("d", "makes", applied)]);
    logged.mockRestore();
    expect(applied).toEqual(["a", "b", "c", "d"]);
    expect(result.carried.map((item) => item.sourceId)).toEqual(["a", "d"]);
    expect(result.failed).toEqual([
      { label: "Instruction b", message: "The owner refuses b." },
      { label: "Instruction c", message: "The environment failed while carrying it: a re-run tries it again." },
    ]);
    const events = log.readStream({ kinds: ["instructions", "state-import"] });
    expect(events.map((event) => [event.type, (event.payload as { targetId: string }).targetId])).toEqual([
      ["test.target-made", "target-a"],
      ["state-import.item-carried", "target-a"],
      ["test.target-made", "target-d"],
      ["state-import.item-carried", "target-d"],
    ]);
    const [madeA, carriedA, madeD, carriedD] = events;
    expect(carriedA?.commandId).toBe(madeA?.commandId);
    expect(carriedD?.commandId).toBe(madeD?.commandId);
    expect(carriedA?.commandId).not.toBe(carriedD?.commandId);
    expect([carriedA?.commandId, carriedD?.commandId]).not.toContain(IMPORT);
    expect([carriedA?.correlationId, carriedD?.correlationId]).toEqual([IMPORT, IMPORT]);
  });

  it("leaves a mapped item alone under any import, answers a refused one from its receipt under the same import, and tries again one that threw", async () => {
    log = openEventLog({ path: ":memory:", projectors: [stateImportProjector] });
    const first: string[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await apply([scripted("a", "makes", first), scripted("b", "refuses", first), scripted("c", "throws", first)]);

    const retried: string[] = [];
    const retry = await apply([scripted("a", "makes", retried), scripted("b", "refuses", retried), scripted("c", "makes", retried)]);
    expect(retried).toEqual(["c"]);
    expect(retry.carried.map((item) => item.sourceId)).toEqual(["c"]);
    expect(retry.failed).toEqual([{ label: "Instruction b", message: "The owner refuses b." }]);

    const fresh: string[] = [];
    const rerun = await apply([scripted("a", "makes", fresh), scripted("b", "makes", fresh), scripted("c", "makes", fresh)], "5d6a1f3e-2b4c-4e8f-9a1b-3c5d7e9f1a2b");
    logged.mockRestore();
    expect(fresh).toEqual(["b"]);
    expect(rerun).toMatchObject({ failed: [] });
    expect(rerun.carried.map((item) => item.sourceId)).toEqual(["b"]);
    expect(log.readStream({ kinds: ["instructions"] })).toHaveLength(3);
    // The projection is rebuilt from the evidence alone.
    log.rebuildProjections();
    const again: string[] = [];
    await apply([scripted("a", "makes", again), scripted("b", "makes", again), scripted("c", "makes", again)], "7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b");
    expect(again).toEqual([]);
  });

  it("derives one version 4 UUID from the same parts, and another from others", () => {
    const id = derivedUuid("state-import.item", IMPORT, "p1");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(derivedUuid("state-import.item", IMPORT, "p1")).toBe(id);
    expect(derivedUuid("state-import.item", IMPORT, "p2")).not.toBe(id);
  });
});
