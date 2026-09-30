import { randomUUID } from "node:crypto";
import { RoutineDefinitionInput } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { end } from "../../environment/test/fake-adapter.js";
import { written } from "../../environment/test/routines.js";
import { holds, useHarness } from "../test/harness.js";
import type { Notice } from "./notices.js";
import type { Runtime } from "./runtime.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

/**
 * A routine's client notice against the in-process environment (#525;
 * routines spec, "Delivery targets"): real sockets, the environment's own
 * delivery of a firing's result, and two runtimes connected to it, as a
 * desktop and a phone would be. Each raises the `routine` notice once.
 */

const harness = useHarness();

/** A runtime paired with the environment `link` names, ready. */
const connected = async (link: string, environmentId: string): Promise<Runtime> => {
  const runtime = harness.runtime(inMemoryPlatform());
  await runtime.start();
  await runtime.connections.add({ link });
  await holds(runtime.connections.list, (records) => records.some((record) => record.environmentId === environmentId && record.phase === "ready"));
  return runtime;
};

/** The runtime's `routine` notices, once it holds one. */
const routineNotices = async (runtime: Runtime): Promise<readonly Notice[]> =>
  (await holds(runtime.projections.notices, (notices) => notices.some((notice) => notice.kind === "routine"))).filter((notice) => notice.kind === "routine");

describe("a routine's client notice", () => {
  it("is raised once by each of two runtimes connected to the routine's environment, about the firing's session", async () => {
    const t = await harness.environment({ name: "laptop" });
    const desk = await connected((await t.createPairing()).link, t.env.id);
    const phone = await connected((await t.createPairing()).link, t.env.id);

    const routineId = randomUUID();
    const definition = RoutineDefinitionInput.parse(written({ name: "Upstream watch", schedule: { kind: "manual" } }));
    const create = await desk.commands.dispatch(t.env.id, "routines.create", { routineId, definition });
    expect(create).toMatchObject({ ok: true });
    t.adapter.nextScripts.push(() => [end("completed", { resultText: "Three new releases; digest filed.\nThe details follow." })]);
    const ran = await phone.commands.dispatch(t.env.id, "routines.runNow", { routineId });
    if (!ran.ok || ran.result === undefined) throw new Error(`routines.runNow was not applied: ${JSON.stringify(ran)}`);
    const firingId = ran.result.entryId;

    const [deskNotices, phoneNotices] = [await routineNotices(desk), await routineNotices(phone)];
    const history = await desk.requests.call(t.env.id, "routines.history", { routineId });
    if (!history.ok) throw new Error(`routines.history failed: ${history.error.message}`);
    const [entry] = history.result.entries;
    if (entry?.kind !== "firing" || entry.id !== firingId) throw new Error(`The history does not open with the firing: ${JSON.stringify(entry)}`);
    for (const notices of [deskNotices, phoneNotices]) {
      expect(notices).toEqual([
        expect.objectContaining({
          environmentId: t.env.id,
          kind: "routine",
          message: "Upstream watch on laptop: Three new releases; digest filed.",
          outcome: "succeeded",
          about: { sessionId: entry.sessionId, runId: null, promptId: null },
        }),
      ]);
    }
  });
});
