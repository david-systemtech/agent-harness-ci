import type { RoutineDefinitionInput, SessionCreatedPayload } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { created, history, listed, ranNow, runNow, untilSettled, untilStarted, written } from "../../test/routines.js";
import { get } from "../../test/sessions.js";

/**
 * A routine's firing through run now (routines spec, "A firing"; #523),
 * through the primary seam: an in-process environment and a real client,
 * the scripted fake provider, the manual clock, and real directories and
 * git repositories in the temporary directory. What is asserted is what a
 * client sees: the answer, the history, the list, the firing's session and
 * its stream.
 */

const { onCleanup } = useCleanups();

/** The zone the test environment runs in: not the machine's, so a preset zone is visibly the environment's. */
const ZONE = "Asia/Manila";

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ timeZone: ZONE, name: "laptop", ...options });
  onCleanup(() => t.close());
  return t;
};

/** A routine as a client writes it, firing in a scratch directory of its own. */
const routine = (overrides: Partial<RoutineDefinitionInput> = {}): RoutineDefinitionInput => written({ schedule: { kind: "manual" }, ...overrides });

const sessionEvents = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId });

describe("routines.runNow", () => {
  it("answers at once with the entry id, and the firing is a session tagged with the routine, made as the routine with the firing id as its command id", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client, routine({ name: "Upstream watch", timezone: "Europe/London", model: "sonnet", mode: "plan" }));
    const routineId = state.id;

    const answer = await runNow(client, routineId);
    expect(answer.receipt).toMatchObject({ status: "accepted" });
    const firingId = answer.result?.entryId as string;
    const started = await untilStarted(t, routineId, firingId);
    const { sessionId, runId } = started.payload as { sessionId: string; runId: string };
    expect(started).toMatchObject({
      actor: `routine:${routineId}`,
      commandId: firingId,
      payload: { firingId, trigger: "run-now", dueAt: MANUAL_CLOCK_START, count: 1, requestedBy: client.hello.clientSessionId, preCheck: null, targets: [{ kind: "client-notice", on: "both" }] },
    });

    const [createdEvent] = sessionEvents(t, sessionId);
    expect(createdEvent).toMatchObject({ type: "session.created", actor: `routine:${routineId}`, commandId: firingId });
    expect(createdEvent?.payload as SessionCreatedPayload).toMatchObject({
      // The due time in the routine's zone: 00:00 UTC is 01:00 in London in September.
      title: "Upstream watch 2026-09-24 01:00",
      tags: ["routine", "Upstream watch"],
      account: "claude-max",
      model: "sonnet",
      mode: "plan",
    });
    expect(await get(client, sessionId)).toMatchObject({ title: "Upstream watch 2026-09-24 01:00", tags: ["routine", "Upstream watch"], accountId: "claude-max", model: "sonnet" });

    const ended = await untilSettled(t, routineId, firingId);
    expect(ended).toMatchObject({ type: "routine.firing-ended", actor: `routine:${routineId}`, payload: { firingId, outcome: "succeeded", reason: null } });
    const [entry] = await history(client, routineId);
    expect(entry).toMatchObject({ kind: "firing", id: firingId, sessionId, runId, trigger: "run-now", outcome: "succeeded", requestedBy: client.hello.clientSessionId });
    expect((await listed(client, routineId))?.state).toMatchObject({
      liveFiring: null,
      lastOutcome: { kind: "firing", entryId: firingId, outcome: "succeeded", reason: null, at: MANUAL_CLOCK_START },
      failureStreak: 0,
    });
    expect(await ranNow(client, routineId)).not.toBe(firingId);
  });
});
