import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry, type RunInstructionsComposedPayload, type RunSkillSet } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { fakeAdapter, say, end, toolCall, type FakeAdapterOptions, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { GENERATION_SWEEP_INTERVAL_MS } from "./generations.js";

/**
 * Materialisation through the primary seam (skills spec, "Materialisation
 * and the Claude mapping"; ADR 0009): an in-process environment on a
 * temporary data directory, a real client, and the scripted fake adapter
 * recording the skill set each run is handed, whose generation is real on
 * disk. The set is resolved at each run's start and each commands listing;
 * the fingerprint keys the generation, the kept process and the
 * composition's manifest; and the sweep keeps what a live process uses.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (adapter: FakeAdapterOptions = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<{ t: TestEnvironment; client: WireClient }> => {
  const t = await startTestEnvironment({ ...options, adapter: fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};

const createSkill = async (client: WireClient, name: string, description = "Test-driven development.") =>
  registry["skills.own.create"].response.parse(await client.request("skills.own.create", { commandId: randomUUID(), name, description }));

/** Starts a run in the session and waits for its end; resolves with its id. */
const runIn = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Go"): Promise<string> => {
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  const runId = answer.result?.runId;
  if (runId === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true), {
    timeout: WAIT_MS,
  });
  return runId;
};

/** The skill set the adapter was handed for its latest run. */
const lastSet = (t: TestEnvironment): RunSkillSet => t.adapter.lastRun().input.skillSet;

/** The run's `run.instructions.composed` payload. */
const composedOf = (t: TestEnvironment, sessionId: string, runId: string): RunInstructionsComposedPayload | undefined =>
  t.env.log.readStream({ kind: "session", id: sessionId }).find((event) => event.type === "run.instructions.composed" && event.payload["runId"] === runId)?.payload as
    | RunInstructionsComposedPayload
    | undefined;

/** The generations under the data directory, by fingerprint. */
const generationsOf = (t: TestEnvironment): string[] => {
  const root = join(t.dataDir, "skills", "generations");
  return existsSync(root) ? readdirSync(root).sort() : [];
};

describe("a run's skill set", () => {
  it("after skills.own.create, is handed to the next run with a generation on disk linking the skill's folder, and the composition's manifest carries its fingerprint", async () => {
    const { t, client } = await start();
    const own = join(t.dataDir, "skills", "own");
    const { id } = await create(client);
    await createSkill(client, "tdd");
    const runId = await runIn(t, client, id);

    const set = lastSet(t);
    expect(set).toEqual({
      generation: join(t.dataDir, "skills", "generations", set.fingerprint as string),
      fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
      members: [{ name: "tdd", description: "Test-driven development.", origin: null, invocation: "model+slash", userInvocable: true, argumentHint: null, native: false, alwaysOn: false, file: join(set.generation as string, "skills", "tdd", "SKILL.md"), commit: null }],
      hiddenNativeNames: [],
    });
    const link = join(set.generation as string, "skills", "tdd");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(own, "skills", "tdd"));
    expect(JSON.parse(readFileSync(join(set.generation as string, ".claude-plugin", "plugin.json"), "utf8"))).toMatchObject({ name: "agent-harness" });
    expect(composedOf(t, id, runId)?.manifest.skillSetFingerprint).toBe(set.fingerprint);
  });

  it("is resolved again at each run's start: identical state gives the identical fingerprint and generation, served on the kept process, and an edit reaches the next run through the same link", async () => {
    const { t, client } = await start();
    const own = join(t.dataDir, "skills", "own");
    const { id } = await create(client);
    await createSkill(client, "tdd");
    const first = await runIn(t, client, id, "One");
    const firstSet = lastSet(t);
    writeFileSync(join(own, "skills", "tdd", "SKILL.md"), '---\nname: "tdd"\ndescription: "Test-driven development."\n---\n\nRed, green, refactor.\n');
    const second = await runIn(t, client, id, "Two");

    expect(lastSet(t)).toEqual(firstSet);
    expect(composedOf(t, id, second)?.manifest.skillSetFingerprint).toBe(composedOf(t, id, first)?.manifest.skillSetFingerprint);
    expect(t.adapter.processesOf(id).map((process) => process.runs)).toEqual([2]);
    expect(generationsOf(t)).toEqual([firstSet.fingerprint]);
    expect(readFileSync(join(firstSet.generation as string, "skills", "tdd", "SKILL.md"), "utf8")).toContain("Red, green, refactor.");
  });

  it("after another create, reaches the session's next run with a new fingerprint and generation, on a fresh process", async () => {
    const { t, client } = await start();
    const { id } = await create(client);
    await createSkill(client, "tdd");
    await runIn(t, client, id, "One");
    const before = lastSet(t);
    await createSkill(client, "handoff", "Hand the conversation off.");
    await runIn(t, client, id, "Two");

    const after = lastSet(t);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.members.map((member) => member.name)).toEqual(["handoff", "tdd"]);
    expect(readdirSync(join(after.generation as string, "skills")).sort()).toEqual(["handoff", "tdd"]);
    expect(t.adapter.processesOf(id).map((process) => [process.fingerprint, process.runs])).toEqual([
      [before.fingerprint, 1],
      [after.fingerprint, 1],
    ]);
  });

  it("holds a command member of the own directory as a skill folder whose SKILL.md links to the command file", async () => {
    const { t, client } = await start();
    const own = join(t.dataDir, "skills", "own");
    writeFileSync(join(own, "commands", "review.md"), "---\ndescription: Review the branch.\n---\nReview it.\n");
    const { id } = await create(client);
    await runIn(t, client, id);

    const set = lastSet(t);
    expect(set.members).toEqual([{ name: "review", description: "Review the branch.", origin: null, invocation: "model+slash", userInvocable: true, argumentHint: null, native: false, alwaysOn: false, file: join(set.generation as string, "skills", "review", "SKILL.md"), commit: null }]);
    expect(readlinkSync(join(set.generation as string, "skills", "review", "SKILL.md"))).toBe(join(own, "commands", "review.md"));
  });
});

describe("commands.list", () => {
  it("hands the adapter the set it resolves for the session, whose members it lists and the listing folds into skill entries", async () => {
    const { t, client } = await start({ commands: [{ name: "compact", description: "Compact the conversation.", builtin: true }] });
    await createSkill(client, "tdd");
    const { id } = await create(client);
    const { entries } = await client.request("commands.list", { sessionId: id });

    const listing = t.adapter.commandListings.at(-1);
    expect(listing?.scope.skillSet).toMatchObject({ fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/), members: [{ name: "tdd", native: false }] });
    expect(existsSync(join(listing?.scope.skillSet.generation as string, "skills", "tdd"))).toBe(true);
    expect(entries.map((entry) => `${entry.kind} ${entry.name}`)).toEqual(["skill tdd", "command compact"]);
  });
});

describe("the generations' sweep", () => {
  it("runs hourly on the clock, deleting a generation no live process uses and no resolution holds current, and keeping one a live process uses until it stops", async () => {
    const clock = manualClock();
    const { t, client } = await start({ commands: [] }, { clock, processIdleMinutes: () => 24 * 60 });
    // A commands listing resolves the set, and the materialiser's work runs one piece at a time: it answers once every
    // sweep begun before it has finished.
    const kept = await create(client);
    const swept = () => client.request("commands.list", { sessionId: kept.id });
    const other = await create(client);
    await createSkill(client, "tdd");
    await runIn(t, client, kept.id);
    const used = lastSet(t);
    await createSkill(client, "handoff", "Hand the conversation off.");
    await runIn(t, client, other.id);
    const current = lastSet(t);

    // Two hourly sweeps: the first keeps what was resolved since the one at start, the second what a process or a resolution keeps.
    clock.advance(GENERATION_SWEEP_INTERVAL_MS);
    clock.advance(GENERATION_SWEEP_INTERVAL_MS);
    await swept();
    expect(generationsOf(t)).toEqual([used.fingerprint, current.fingerprint].sort());

    await client.request("providers.processes.stop", { commandId: randomUUID(), sessionId: kept.id });
    await vi.waitFor(() => expect(t.adapter.processesOf(kept.id)[0]?.stopped).toBe(true), { timeout: WAIT_MS });
    clock.advance(GENERATION_SWEEP_INTERVAL_MS);
    await swept();
    expect(generationsOf(t)).toEqual([current.fingerprint]);
    expect(existsSync(join(t.dataDir, "skills", "own", "skills", "tdd", "SKILL.md"))).toBe(true);
  });

  it("clears at start the generations a start before this one left", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start({}, { dataDir });
    const { id } = await create(first.client);
    await createSkill(first.client, "tdd");
    await runIn(first.t, first.client, id);
    const left = lastSet(first.t).fingerprint as string;
    await first.t.close();
    expect(readdirSync(join(dataDir, "skills", "generations"))).toEqual([left]);

    const second = await startTestEnvironment({ dataDir });
    onCleanup(() => second.close());
    await vi.waitFor(() => expect(readdirSync(join(dataDir, "skills", "generations"))).toEqual([]), { timeout: WAIT_MS });
  });
});

describe("the denylist", () => {
  it("leaves out the own directory, the snapshots and the generations, so a run reading a skill's files is not denied, and still covers the rest of the data directory", async () => {
    const { t, client } = await start();
    const { id } = await create(client);
    await createSkill(client, "tdd");
    await runIn(t, client, id);
    const generation = lastSet(t).generation as string;
    const read = (path: string) => ({ tool: "Read", summary: `Read ${path}`, access: { kind: "read", paths: [path] } }) as const;
    const reading: Script = async function* (controls) {
      for (const path of [join(generation, "skills", "tdd", "SKILL.md"), join(t.dataDir, "skills", "own", "skills", "tdd", "SKILL.md"), join(t.dataDir, "environment.db")]) {
        yield* toolCall(controls, read(path));
      }
      yield say("Read.");
      yield end();
    };
    t.adapter.nextScripts.push(reading);
    // Unattended, so a denylisted read is denied at once rather than parked for a person.
    const routine = t.env.startRun({ sessionId: id, text: "Read the skill", actor: { kind: "routine", name: "reader", ceiling: "acceptEdits", clientSessionId: null }, actorId: "routine-reader" });
    await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id }).some((event) => event.type === "run.ended" && event.payload["runId"] === routine.runId)).toBe(true), {
      timeout: WAIT_MS,
    });

    expect(t.adapter.lastRun().gated.map((entry) => entry.decision.decision)).toEqual(["allow", "allow", "deny"]);
    for (const path of ["own", "snapshots", "generations"]) {
      const { matches } = await client.request("permissions.denylist.test", { kind: "path", value: join(t.dataDir, "skills", path, "tdd", "SKILL.md") });
      expect(matches, path).toEqual([]);
    }
  });
});
