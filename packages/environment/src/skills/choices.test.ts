import { randomUUID } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry, type RunSkillSet, type SkillChoice, type SkillsView } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter, type FakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { create, refusal } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

/**
 * The choices through the primary seam (skills spec, "Choices: disabled and
 * always-on"; ADR 0009, ADR 0029, ADR 0030): an in-process environment with
 * two accounts on fake adapters, `claude-max` on the Claude-shaped one and
 * `local` on one whose instruction channel is `none`, the own directory's
 * skills made through `skills.own.create`, and each adapter recording the
 * skill set every run is handed. A choice is keyed by name, the whole
 * environment's outranks an account's, and it reaches the next run.
 */

const { onCleanup } = useCleanups();

const start = async (): Promise<{ t: TestEnvironment; client: WireClient; local: FakeAdapter }> => {
  const local = fakeAdapter({ provider: "fake-none", capabilities: { instructionChannel: { kind: "none", maxCharacters: null } } });
  const t = await startTestEnvironment({
    adapter: fakeAdapter(),
    otherAdapters: [local],
    accounts: [
      { id: "claude-max", provider: "fake" },
      { id: "local", provider: "fake-none" },
    ],
  });
  onCleanup(() => t.close());
  return { t, client: await t.client(), local };
};

const get = async (client: WireClient, params: { sessionId?: string } = {}): Promise<SkillsView> => registry["skills.get"].result.parse(await client.request("skills.get", params));

const createSkill = async (client: WireClient, name: string, description = "Test-driven development.") =>
  registry["skills.own.create"].response.parse(await client.request("skills.own.create", { commandId: randomUUID(), name, description }));

const setEnabled = async (client: WireClient, name: string, accountId: string | null, enabled: boolean) =>
  registry["skills.setEnabled"].response.parse(await client.request("skills.setEnabled", { commandId: randomUUID(), name, accountId, enabled }));

const setAlwaysOn = async (client: WireClient, name: string, accountId: string, on: boolean) =>
  registry["skills.setAlwaysOn"].response.parse(await client.request("skills.setAlwaysOn", { commandId: randomUUID(), name, accountId, on }));

/** Starts a run in the session and waits for its end. */
const runIn = async (t: TestEnvironment, client: WireClient, sessionId: string): Promise<void> => {
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Go" }));
  const runId = answer.result?.runId;
  if (runId === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true), {
    timeout: WAIT_MS,
  });
};

/** The skill set `adapter` was handed for its latest run. */
const lastSet = (adapter: FakeAdapter): RunSkillSet => adapter.lastRun().input.skillSet;

/** The names in a run's set, each with whether it is always-on. */
const namesOf = (set: RunSkillSet): [string, boolean][] => set.members.map((member) => [member.name, member.alwaysOn]);

/** The events on the environment's skills stream, as type and payload. */
const skillsEvents = (t: TestEnvironment) => t.env.log.readStream({ kind: "skills", id: t.env.id }).map((event) => [event.type, event.payload]);

/** How many `skills.updated` notices the environment's stream carries. */
const updates = (t: TestEnvironment): number => t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "skills.updated").length;

describe("skills.setEnabled and skills.setAlwaysOn", () => {
  it("append skills.enabled-set and skills.always-on-set on the skills stream as the client session, each followed by skills.updated, and answer the choice; the same choice again appends nothing", async () => {
    const { t, client } = await start();
    const before = updates(t);

    const off = await setEnabled(client, "tdd", null, false);
    const on = await setAlwaysOn(client, "unslop", "claude-max", true);
    const again = await setEnabled(client, "tdd", null, false);

    expect(off).toEqual({ receipt: expect.objectContaining({ status: "accepted", changed: true }), result: { choice: { kind: "enabled", name: "tdd", accountId: null, enabled: false } } });
    expect(on.result).toEqual({ choice: { kind: "always-on", name: "unslop", accountId: "claude-max", on: true } });
    expect(again).toEqual({ receipt: expect.objectContaining({ changed: false }), result: off.result });
    expect(skillsEvents(t)).toEqual([
      ["skills.enabled-set", { name: "tdd", accountId: null, enabled: false }],
      ["skills.always-on-set", { name: "unslop", accountId: "claude-max", on: true }],
    ]);
    const [first] = t.env.log.readStream({ kind: "skills", id: t.env.id });
    expect(first?.actor).toMatch(/^client_session:/);
    expect(updates(t) - before).toBe(2);
  });

  it("refuse a name failing the skill-name rule as invalid_params, and an account the environment does not hold as not_found, kind account, appending nothing", async () => {
    const { t, client } = await start();

    expect((await refusal(client.request("skills.setEnabled", { commandId: randomUUID(), name: "Test_Driven", accountId: null, enabled: false }))).code).toBe("invalid_params");
    expect((await refusal(client.request("skills.setAlwaysOn", { commandId: randomUUID(), name: "-tdd", accountId: "claude-max", on: true }))).code).toBe("invalid_params");
    for (const refused of [await setEnabled(client, "tdd", "nobody", false), await setAlwaysOn(client, "tdd", "nobody", true)]) {
      expect(refused.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "account", accountId: "nobody" } } });
    }
    expect(skillsEvents(t)).toEqual([]);
  });
});

describe("a choice in the run's set", () => {
  it("switched off leaves the name out of every member holding it and out of the generation, the session's next run on a fresh process under a new fingerprint; switched on again brings it back", async () => {
    const { t, client } = await start();
    const { id } = await create(client);
    await createSkill(client, "tdd");
    await createSkill(client, "handoff", "Hand the conversation off.");
    // A command file of the same name: a second member holding it, which the folder shadows.
    writeFileSync(join(t.dataDir, "skills", "own", "commands", "tdd.md"), "---\ndescription: Test-driven development.\n---\nRed, then green.\n");
    await runIn(t, client, id);
    const before = lastSet(t.adapter);

    await setEnabled(client, "tdd", null, false);
    await runIn(t, client, id);
    const off = lastSet(t.adapter);
    const listed = await get(client);
    await setEnabled(client, "tdd", null, true);
    await runIn(t, client, id);

    expect(namesOf(before)).toEqual([
      ["handoff", false],
      ["tdd", false],
    ]);
    expect(namesOf(off)).toEqual([["handoff", false]]);
    expect(readdirSync(join(off.generation as string, "skills"))).toEqual(["handoff"]);
    expect(listed.members.map((member) => [member.path, member.enabled])).toEqual([
      ["skills/handoff", true],
      ["skills/tdd", false],
      ["commands/tdd.md", false],
    ]);
    expect(off.fingerprint).not.toBe(before.fingerprint);
    expect(lastSet(t.adapter)).toEqual(before);
    expect(t.adapter.processesOf(id).map((process) => [process.fingerprint, process.runs])).toEqual([
      [before.fingerprint, 1],
      [off.fingerprint, 1],
      [before.fingerprint, 1],
    ]);
  });

  it("made always-on marks the member and reaches the session's next run on a fresh process under a new fingerprint", async () => {
    const { t, client } = await start();
    const { id } = await create(client);
    await createSkill(client, "tdd");
    await runIn(t, client, id);
    const before = lastSet(t.adapter);

    await setAlwaysOn(client, "tdd", "claude-max", true);
    await runIn(t, client, id);

    const after = lastSet(t.adapter);
    expect(namesOf(before)).toEqual([["tdd", false]]);
    expect(namesOf(after)).toEqual([["tdd", true]]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(t.adapter.processesOf(id).map((process) => [process.fingerprint, process.runs])).toEqual([
      [before.fingerprint, 1],
      [after.fingerprint, 1],
    ]);
  });

  it("switched off for the whole environment outranks an account's choice either way", async () => {
    const { t, client } = await start();
    const { id } = await create(client);
    await createSkill(client, "tdd");
    const enabledFor = async () => (await get(client, { sessionId: id })).members.map((member) => member.enabled);

    await setEnabled(client, "tdd", "claude-max", false);
    await runIn(t, client, id);
    expect(namesOf(lastSet(t.adapter))).toEqual([]);
    expect(await enabledFor()).toEqual([false]);

    await setEnabled(client, "tdd", null, true);
    await runIn(t, client, id);
    expect(namesOf(lastSet(t.adapter))).toEqual([["tdd", false]]);
    expect(await enabledFor()).toEqual([true]);

    await setEnabled(client, "tdd", "claude-max", true);
    await setEnabled(client, "tdd", null, false);
    await runIn(t, client, id);
    expect(namesOf(lastSet(t.adapter))).toEqual([]);
    expect(await enabledFor()).toEqual([false]);
  });

  it("for one account, switched off or always-on, reaches that account's runs and no other's", async () => {
    const { t, client, local } = await start();
    const claude = await create(client, { account: "claude-max" });
    const other = await create(client, { account: "local" });
    await createSkill(client, "tdd");
    await createSkill(client, "handoff", "Hand the conversation off.");

    await setEnabled(client, "tdd", "local", false);
    await setAlwaysOn(client, "handoff", "claude-max", true);
    await runIn(t, client, claude.id);
    await runIn(t, client, other.id);

    expect(namesOf(lastSet(t.adapter))).toEqual([
      ["handoff", true],
      ["tdd", false],
    ]);
    expect(namesOf(lastSet(local))).toEqual([["handoff", false]]);
  });

  it("for a name no layer holds is kept, inert, and listed by skills.get, and applies once the name appears", async () => {
    const { t, client } = await start();
    const { id } = await create(client);
    await setEnabled(client, "tdd", null, false);
    await setAlwaysOn(client, "unslop", "claude-max", true);

    const inert = await get(client);
    await runIn(t, client, id);
    expect(inert.members).toEqual([]);
    expect(inert.choices).toEqual([
      { kind: "enabled", name: "tdd", accountId: null, enabled: false },
      { kind: "always-on", name: "unslop", accountId: "claude-max", on: true },
    ]);
    expect(lastSet(t.adapter).members).toEqual([]);

    await createSkill(client, "tdd");
    await createSkill(client, "unslop", "Remove the tells.");
    await runIn(t, client, id);
    expect(namesOf(lastSet(t.adapter))).toEqual([["unslop", true]]);
    expect((await get(client)).members.map((member) => [member.name, member.enabled, member.alwaysOn])).toEqual([
      ["tdd", false, false],
      ["unslop", true, true],
    ]);
  });

  it("naming an account the environment removes is dropped, and the whole environment's is kept", async () => {
    const { client } = await start();
    await setEnabled(client, "tdd", "local", false);
    await setAlwaysOn(client, "tdd", "local", true);
    await setEnabled(client, "tdd", null, false);
    await setAlwaysOn(client, "tdd", "claude-max", true);

    await client.request("accounts.remove", { commandId: randomUUID(), accountId: "local" });

    expect((await get(client)).choices).toEqual<SkillChoice[]>([
      { kind: "enabled", name: "tdd", accountId: null, enabled: false },
      { kind: "always-on", name: "tdd", accountId: "claude-max", on: true },
    ]);
  });

  it("is never always-on on a new environment", async () => {
    const { t, client } = await start();
    const { id } = await create(client);
    await createSkill(client, "tdd");
    await runIn(t, client, id);

    const view = await get(client);
    expect(view.choices).toEqual([]);
    expect(view.members.map((member) => [member.name, member.enabled, member.alwaysOn, member.choices])).toEqual([["tdd", true, false, []]]);
    expect(namesOf(lastSet(t.adapter))).toEqual([["tdd", false]]);
  });
});

describe("skills.get", () => {
  it("answers each member's choices beside its size and approximate tokens, and each account's instruction channel, with the reason for one with none", async () => {
    const { client } = await start();
    await createSkill(client, "tdd");
    await setEnabled(client, "tdd", "local", false);
    await setAlwaysOn(client, "tdd", "claude-max", true);

    const view = await get(client);

    expect(view.accountId).toBe("claude-max");
    expect(view.accounts).toEqual([
      { accountId: "claude-max", channel: "system-prompt-append", reason: null },
      { accountId: "local", channel: "none", reason: "Its adapter, Fake, has no instruction channel, so no always-on skill reaches its runs." },
    ]);
    expect(view.members).toEqual([
      expect.objectContaining({
        name: "tdd",
        size: "# tdd".length,
        tokens: 2,
        enabled: true,
        alwaysOn: true,
        choices: [
          { kind: "enabled", name: "tdd", accountId: "local", enabled: false },
          { kind: "always-on", name: "tdd", accountId: "claude-max", on: true },
        ],
      }),
    ]);
  });
});
