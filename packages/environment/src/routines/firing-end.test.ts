import { shelfOf, type RoutineDefinitionInput } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, gate, say, type Gate, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { created, history, listed, ranNow, routineCommand, untilEvent, untilSettled, untilStarted, written } from "../../test/routines.js";
import { get } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * How a firing ends (routines spec, "Silence" and "A firing"; #524),
 * through the primary seam: an in-process environment and a real client,
 * the scripted fake provider (the marker alone, the marker opening a line,
 * the marker mid-sentence, a run that never ends) and the manual clock.
 * What is asserted is what a client sees: the firing's record, the
 * history, the list, the session and the notices.
 */

const { onCleanup } = useCleanups();

const start = async (): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ timeZone: "Asia/Manila", name: "laptop" });
  onCleanup(() => t.close());
  return t;
};

/** A routine as a client writes it, run now only. */
const routine = (overrides: Partial<RoutineDefinitionInput> = {}): RoutineDefinitionInput => written({ schedule: { kind: "manual" }, ...overrides });

/** A gate opened when the test ends, so a run it holds never outlives it. */
const heldGate = (): Gate => {
  const held = gate();
  onCleanup(() => held.open());
  return held;
};

/** A firing run now of the routine, whose run plays `script`: its id, its session and its run. */
const fire = async (t: TestEnvironment, client: WireClient, routineId: string, script: Script) => {
  t.adapter.nextScripts.push(script);
  const firingId = await ranNow(client, routineId);
  const { sessionId, runId } = (await untilStarted(t, routineId, firingId)).payload as { sessionId: string; runId: string };
  return { routineId, firingId, sessionId, runId };
};

/** A run whose final text is `text`, as its result. */
const answering = (text: string): Script => () => [say("Reading the sources."), end("completed", { resultText: text })];

/** The `routine.delivered` notices on the environment's stream for the entry. */
const deliveredFor = (t: TestEnvironment, entryId: string) =>
  t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "routine.delivered" && event.payload["entryId"] === entryId);

describe("a firing whose final text is silent", () => {
  it("ends silent, delivers nothing, and is settled by the routine with its end, so its session leaves the active list: the marker alone, on its own first line, or opening the text", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine());

    for (const text of ["[SILENT]", "[SILENT]\n\nNothing new upstream this week.", "[silent] no release since Monday."]) {
      const firing = await fire(t, client, state.id, answering(text));
      const ended = await untilSettled(t, state.id, firing.firingId);
      expect(ended.payload, text).toMatchObject({ firingId: firing.firingId, outcome: "silent", reason: null, text });

      const session = await get(client, firing.sessionId);
      expect(session, text).toMatchObject({ settledBy: "routine", settledAt: ended.occurredAt });
      expect(shelfOf(session, t.clock.now()), text).toBe("settled");
      // Settled as the routine, caused by its run's end, as the firing's end is.
      const settled = t.env.log.readStream({ kind: "session", id: firing.sessionId }).find((event) => event.type === "session.settled");
      expect(settled, text).toMatchObject({ actor: `routine:${state.id}`, causationId: ended.causationId, correlationId: firing.runId, occurredAt: ended.occurredAt });

      expect((await history(client, state.id))[0], text).toMatchObject({ id: firing.firingId, outcome: "silent", deliveries: [] });
      expect(deliveredFor(t, firing.firingId), text).toEqual([]);
    }
  });

  it("is delivered when the marker is mid-sentence: the firing succeeds and its session stays active", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine());

    const firing = await fire(t, client, state.id, answering("The changelog now says [SILENT] where the release notes were."));
    expect((await untilSettled(t, state.id, firing.firingId)).payload).toMatchObject({ outcome: "succeeded", reason: null });
    const session = await get(client, firing.sessionId);
    expect(session).toMatchObject({ settledBy: null, settledAt: null });
    expect(shelfOf(session, t.clock.now())).toBe("active");
    await untilEvent(t, { kind: "environment", id: t.env.id }, (event) => event.type === "routine.delivered" && event.payload["entryId"] === firing.firingId);
  });

  it("is read against the routine's own marker in place of [SILENT], the one the firing started with whatever an edit changes meanwhile", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine({ silenceMarker: "NOTHING TO REPORT" }));

    const preset = await fire(t, client, state.id, answering("[SILENT]"));
    expect((await untilSettled(t, state.id, preset.firingId)).payload).toMatchObject({ outcome: "succeeded" });

    const held = heldGate();
    const edited = await fire(t, client, state.id, async function* () {
      yield say("Reading the sources.");
      await held.opened;
      yield end("completed", { resultText: "Nothing to report." });
    });
    await routineCommand(client, "routines.update", { routineId: state.id, fields: { silenceMarker: "[QUIET]" } });
    held.open();
    expect((await untilSettled(t, state.id, edited.firingId)).payload).toMatchObject({ outcome: "silent" });
    expect((await get(client, edited.sessionId)).settledBy).toBe("routine");
  });

  it("resets the failure streak, as a firing that succeeds does", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine());

    for (const _ of [1, 2]) {
      const failed = await fire(t, client, state.id, () => [end("error", { error: { message: "The provider failed.", code: null } })]);
      await untilSettled(t, state.id, failed.firingId);
    }
    expect((await listed(client, state.id))?.state.failureStreak).toBe(2);

    const silent = await fire(t, client, state.id, answering("[SILENT]"));
    await untilSettled(t, state.id, silent.firingId);
    expect((await listed(client, state.id))?.state).toMatchObject({ failureStreak: 0, lastOutcome: { kind: "firing", entryId: silent.firingId, outcome: "silent", reason: null } });
  });
});
