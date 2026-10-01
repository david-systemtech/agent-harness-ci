import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RoutineDefinitionInput } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { end } from "../../environment/test/fake-adapter.js";
import { routineEvents, written } from "../../environment/test/routines.js";
import { holds, originOf, useHarness } from "../test/harness.js";
import { reachable } from "./outbox/overlay.js";
import type { RoutineGroup } from "./projections/routines.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

/**
 * The routines' projections and commands against two in-process
 * environments (#532; docs/specs/client-runtime.md, "Testing Decisions", the
 * primary seam): real sockets, real routine stores, real receipts. One
 * runtime follows both environments' routines; one environment is stopped,
 * its list kept stale and its routine commands queued and shown pending, and
 * started again on the same data directory, where they apply in order.
 */

const harness = useHarness();

/** A definition as a client sends it: what has a preset filled in, fired only when run now. */
const definition = (name: string) => RoutineDefinitionInput.parse(written({ name, schedule: { kind: "manual" } }));

describe("routines across two environments, one stopped and started again", () => {
  it("lists both, keeps the stopped one's list stale, queues its routine commands pending, and delivers them in order once it is back", async () => {
    const desk = await harness.environment({ name: "desk" });
    const dataDir = join(harness.tempDir("agent-harness-routines-sync-"), "data");
    const laptop = await harness.environment({ name: "laptop", dataDir });
    const runtime = harness.runtime(inMemoryPlatform());
    await runtime.start();
    for (const t of [desk, laptop]) await runtime.connections.add({ link: (await t.createPairing()).link });
    const [deskId, laptopId] = [desk.env.id, laptop.env.id];
    const record = (environmentId: string) => runtime.connections.list.read().find((r) => r.environmentId === environmentId);

    const [watch, backup, triage] = [randomUUID(), randomUUID(), randomUUID()];
    expect(await runtime.commands.dispatch(deskId, "routines.create", { routineId: watch, definition: definition("Upstream watch") })).toMatchObject({ ok: true });
    expect(await runtime.commands.dispatch(laptopId, "routines.create", { routineId: backup, definition: definition("Backup check") })).toMatchObject({ ok: true });

    const routines = runtime.projections.routines;
    const stop = routines.subscribe(() => undefined);
    const group = (environmentId: string): RoutineGroup | undefined => routines.read().groups.find((g) => g.environmentId === environmentId);
    const names = (environmentId: string) => group(environmentId)?.routines.map((row) => row.definition.name).join(", ");
    await holds(routines, () => names(deskId) === "Upstream watch" && names(laptopId) === "Backup check");
    expect(routines.read().groups.map(({ environmentId, name, icon, colour, stale }) => ({ environmentId, name, icon, colour, stale }))).toEqual(
      [deskId, laptopId].map((environmentId) => {
        const { descriptor } = record(environmentId) ?? {};
        return { environmentId, name: descriptor?.name, icon: descriptor?.icon, colour: descriptor?.colour, stale: false };
      }),
    );
    expect(group(laptopId)?.routines).toEqual([{ environmentId: laptopId, routineId: backup, definition: expect.objectContaining({ name: "Backup check" }), listed: expect.objectContaining({ state: expect.objectContaining({ id: backup }) }), pending: false }]);
    const fetchedAt = group(laptopId)?.fetchedAt;

    // The laptop stops: its list stays, stale, as fetched.
    await laptop.close();
    await holds(runtime.connections.list, () => !reachable(record(laptopId)));
    await holds(routines, () => group(laptopId)?.stale === true);
    expect(group(laptopId)).toMatchObject({ fetchedAt, routines: [{ routineId: backup, pending: false }] });
    expect(group(deskId)).toMatchObject({ stale: false, routines: [{ routineId: watch }] });

    // Its routine commands wait in the outbox, each routine they name pending, the new one shown from the definition sent.
    const answers = [
      runtime.commands.dispatch(laptopId, "routines.update", { routineId: backup, fields: { name: "Backup check, nightly" } }),
      runtime.commands.dispatch(laptopId, "routines.create", { routineId: triage, definition: definition("Nightly triage") }),
      runtime.commands.dispatch(laptopId, "routines.disable", { routineId: triage }),
    ];
    await holds(routines, () => group(laptopId)?.routines.length === 2);
    expect(group(laptopId)?.routines).toEqual([
      expect.objectContaining({ routineId: backup, definition: expect.objectContaining({ name: "Backup check" }), pending: true }),
      { environmentId: laptopId, routineId: triage, definition: definition("Nightly triage"), listed: null, pending: true },
    ]);
    // Run now never waits: it fails at once.
    expect(await runtime.commands.dispatch(laptopId, "routines.runNow", { routineId: backup })).toMatchObject({ ok: false, error: { code: "unreachable" } });

    // The laptop starts again on its data directory: the commands apply in the order they were made, and the list is fetched again.
    const back = await harness.environment({ name: "laptop", dataDir, clock: laptop.clock });
    await runtime.connections.setAddress(laptopId, originOf(back.address));
    expect(await Promise.all(answers)).toMatchObject([{ ok: true }, { ok: true }, { ok: true }]);
    expect(routineEvents(back).map(({ type }) => type)).toEqual(["routine.created", "routine.edited", "routine.created", "routine.disabled"]);
    await holds(routines, () => names(laptopId) === "Backup check, nightly, Nightly triage" && group(laptopId)?.routines.every((row) => row.listed !== null) === true);
    expect(group(laptopId)).toMatchObject({
      stale: false,
      routines: [
        { routineId: backup, pending: false },
        { routineId: triage, definition: { name: "Nightly triage", enabled: false }, pending: false },
      ],
    });

    // Run now on the environment that is back: the firing heads the routine's history.
    back.adapter.nextScripts.push(() => [end("completed", { resultText: "Every backup ran." })]);
    const ran = await runtime.commands.dispatch(laptopId, "routines.runNow", { routineId: backup });
    if (!ran.ok || ran.result === undefined) throw new Error(`routines.runNow was not applied: ${JSON.stringify(ran)}`);
    const history = runtime.projections.routineHistory(laptopId, backup);
    const stopHistory = history.subscribe(() => undefined);
    const firing = (await holds(history, (view) => view.entries[0]?.kind === "firing" && view.entries[0].endedAt !== null)).entries[0];
    expect(firing).toMatchObject({ id: ran.result.entryId, trigger: "run-now", outcome: "succeeded" });
    expect(history.read()).toMatchObject({ environmentId: laptopId, routineId: backup, complete: true, error: null });
    stopHistory();
    stop();
  });
});
