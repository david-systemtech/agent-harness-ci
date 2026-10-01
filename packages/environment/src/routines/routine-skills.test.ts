import { randomUUID } from "node:crypto";
import type { RoutineDefinitionInput } from "@agent-harness/contracts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, gate, say, type Gate, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { created, history, listed, ranNow, untilEvent, untilSettled, untilStarted, written } from "../../test/routines.js";
import type { WireClient } from "../../test/wire-client.js";
import type { InstructionScope } from "../adapter/seams.js";
import { composeInstructions } from "../instructions/composer.js";

/**
 * A routine's skills (routines spec, "The routine" and "A firing"; #531),
 * through the primary seam: an in-process environment and a real client,
 * the scripted fake provider and the manual clock, with the skill set
 * fixed by the own directory's skills, made as a client makes them.
 */

const { onCleanup } = useCleanups();

/** A gate opened when the test ends, so a run it holds never outlives it. */
const heldGate = (): Gate => {
  const held = gate();
  onCleanup(() => held.open());
  return held;
};

/** A run that says it is working and waits for `held` to open, then completes. */
const heldRun =
  (held: Gate): Script =>
  async function* () {
    yield say("Working");
    await held.opened;
    yield say("Done.");
    yield end();
  };

/** The composer the environment presets, each scope it is asked to compose for kept in `scopes`. */
const observedComposer = (scopes: InstructionScope[]) => {
  const compose = composeInstructions();
  return (scope: InstructionScope) => {
    scopes.push(scope);
    return compose(scope);
  };
};

/** The started firing's session and first run. */
const firingOf = async (t: TestEnvironment, routineId: string, firingId: string) => (await untilStarted(t, routineId, firingId)).payload as { sessionId: string; runId: string };

/** Resolves once the run has said something: its adapter has it, past its skill set and its instructions. */
const working = (t: TestEnvironment, sessionId: string, runId: string) =>
  untilEvent(t, { kind: "session", id: sessionId }, (event) => event.type === "assistant.text" && event.payload["runId"] === runId);

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ name: "laptop", ...options });
  onCleanup(() => t.close());
  return t;
};

/** A routine as a client writes it, fired by run now in a scratch directory of its own. */
const routine = (overrides: Partial<RoutineDefinitionInput> = {}): RoutineDefinitionInput => written({ schedule: { kind: "manual" }, ...overrides });

/** Makes `name` a skill of the own directory, whose body is `SKILL BODY <name>`. */
const ownSkill = async (t: TestEnvironment, client: WireClient, name: string): Promise<void> => {
  await client.request("skills.own.create", { commandId: randomUUID(), name, description: `The ${name} skill.` });
  writeFileSync(join(t.dataDir, "skills", "own", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill.\n---\nSKILL BODY ${name}`);
};

describe("a routine's skills at its firing's start", () => {
  it("is a skip cannot-start skill_unknown naming each name the account's skill set lacks, a disabled one included, with no session; it counts as a failure", async () => {
    const t = await start();
    const client = await t.client();
    await ownSkill(t, client, "tdd");
    await ownSkill(t, client, "unslop");
    await client.request("skills.setEnabled", { commandId: randomUUID(), name: "unslop", accountId: "claude-max", enabled: false });
    const { state } = await created(client, routine({ skills: ["tdd", "grilling", "unslop"] }));

    const entryId = await ranNow(client, state.id);
    await untilSettled(t, state.id, entryId);

    expect(await history(client, state.id)).toMatchObject([
      { kind: "skip", id: entryId, reason: "cannot-start", cannotStart: "skill_unknown", detail: "The skill set of the account claude-max does not hold: grilling, unslop." },
    ]);
    expect((await listed(client, state.id))?.state).toMatchObject({ lastOutcome: { kind: "skip", reason: "cannot-start" }, failureStreak: 1 });
    expect((await client.request("sessions.list", {})).sessions).toEqual([]);
    expect(t.adapter.runs).toHaveLength(0);
  });
});

describe("a routine's skill attention", () => {
  it("shows skill_unknown naming each name the skill set of the account it resolves to lacks, in the list, a command's answer and an import's warnings, and follows the skill set", async () => {
    const t = await start({ accounts: [{ id: "work", provider: "fake" }, { id: "home", provider: "fake" }] });
    const client = await t.client();
    await ownSkill(t, client, "tdd");
    const home = { provider: "fake", email: "home@example.com", organisation: null };
    const answered = await created(client, routine({ name: "On home", account: home, skills: ["tdd", "grilling"] }));
    const onDefault = await created(client, routine({ name: "On the default", skills: ["tdd"] }));
    const bare = await created(client, routine({ name: "No skills" }));
    expect(answered).toMatchObject({ attention: ["skill_unknown"], unknownSkills: ["grilling"] });
    expect(await listed(client, answered.state.id)).toMatchObject({ attention: ["skill_unknown"], unknownSkills: ["grilling"] });
    expect(await listed(client, onDefault.state.id)).toMatchObject({ attention: [], unknownSkills: [] });
    expect(await listed(client, bare.state.id)).toMatchObject({ attention: [], unknownSkills: [] });
    // An import's warnings name them as the list does.
    const { yaml } = await client.request("routines.export", { routineIds: [answered.state.id] });
    const [checked] = (await client.request("routines.checkImport", { yaml })).documents;
    expect(checked?.warnings).toMatchObject({ attention: ["skill_unknown"], unknownSkills: ["grilling"] });

    // The skill set gains the name: nothing is saved, and the attention goes.
    await ownSkill(t, client, "grilling");
    expect(await listed(client, answered.state.id)).toMatchObject({ attention: [], unknownSkills: [] });

    // Switched off for the routine's account alone: that routine's set lacks it, the default account's does not.
    await client.request("skills.setEnabled", { commandId: randomUUID(), name: "tdd", accountId: "home", enabled: false });
    expect(await listed(client, answered.state.id)).toMatchObject({ attention: ["skill_unknown"], unknownSkills: ["tdd"] });
    expect(await listed(client, onDefault.state.id)).toMatchObject({ attention: [], unknownSkills: [] });
  });
});

describe("a routine's skills in its firing's runs", () => {
  it("reach the composer as the run's extra always-on names, for its first run and for the run the environment starts from its queue", async () => {
    const scopes: InstructionScope[] = [];
    const adapter = fakeAdapter({ capabilities: { providerQueue: false, steering: false } });
    const t = await start({ adapter, adapterSeams: { instructions: observedComposer(scopes) } });
    const client = await t.client();
    await ownSkill(t, client, "tdd");
    await ownSkill(t, client, "unslop");
    const held = heldGate();
    adapter.nextScripts.push(heldRun(held));
    const { state } = await created(client, routine({ skills: ["unslop", "tdd"] }));

    const firingId = await ranNow(client, state.id);
    const { sessionId, runId } = await firingOf(t, state.id, firingId);
    await working(t, sessionId, runId);
    // Queued while the firing's run is live: the environment holds it, and starts the next run with it once that run ends.
    await client.request("runs.send", { commandId: randomUUID(), sessionId, text: "Also look at the tags." });
    held.open();
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(2), { timeout: 10_000 });

    expect(scopes.map((scope) => ({ sessionId: scope.sessionId, origin: scope.origin, alwaysOn: scope.alwaysOn }))).toEqual([
      { sessionId, origin: "routine", alwaysOn: ["unslop", "tdd"] },
      { sessionId, origin: "routine", alwaysOn: ["unslop", "tdd"] },
    ]);
  });

  it("are none of a person's attended run in the firing's session: one their read-now starts from the queue, or one they start after", async () => {
    const scopes: InstructionScope[] = [];
    const adapter = fakeAdapter({ capabilities: { providerQueue: false, steering: false } });
    const t = await start({ adapter, adapterSeams: { instructions: observedComposer(scopes) } });
    const client = await t.client();
    await ownSkill(t, client, "tdd");
    const held = heldGate();
    adapter.nextScripts.push(heldRun(held));
    const { state } = await created(client, routine({ skills: ["tdd"] }));

    const firingId = await ranNow(client, state.id);
    const { sessionId, runId } = await firingOf(t, state.id, firingId);
    await working(t, sessionId, runId);
    await client.request("runs.send", { commandId: randomUUID(), sessionId, text: "Stop and read this." });
    // The read-now interrupts the firing's run, and the run of the queue after it is the caller's.
    await client.request("runs.readNow", { commandId: randomUUID(), sessionId });
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(2), { timeout: 10_000 });
    await untilSettled(t, state.id, firingId);
    const { runId: theirs } = await client.apply("runs.start", { commandId: randomUUID(), sessionId, text: "What did you find?" });
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(3), { timeout: 10_000 });

    expect(theirs).toBeTypeOf("string");
    expect(scopes.map((scope) => ({ origin: scope.origin, alwaysOn: scope.alwaysOn }))).toEqual([
      { origin: "routine", alwaysOn: ["tdd"] },
      { origin: "client", alwaysOn: [] },
      { origin: "client", alwaysOn: [] },
    ]);
  });
});

