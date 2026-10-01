import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry, type RunInstructionsComposedPayload } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { created, ranNow, untilSettled, written } from "../../test/routines.js";
import { create } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { SKILLS_HOST, skillRepositories, skillsInsteadOf } from "../../test/skill-repositories.js";
import { composeInstructions } from "./composer.js";

const { onCleanup, tempDir } = useCleanups();
const ownSkill = async (t: TestEnvironment, client: WireClient, name: string, body: string) => {
  await client.request("skills.own.create", { commandId: randomUUID(), name, description: "A test skill." });
  writeFileSync(join(t.dataDir, "skills", "own", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: A test skill.\n---\n${body}`);
  await client.request("skills.setAlwaysOn", { commandId: randomUUID(), name, accountId: "claude-max", on: true });
};
const run = async (t: TestEnvironment, client: WireClient, sessionId: string) => {
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Go" }));
  const runId = answer.result?.runId;
  await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).some((e) => e.type === "run.ended" && e.payload["runId"] === runId)).toBe(true), { timeout: WAIT_MS });
  const event = t.env.log.readStream({ kind: "session", id: sessionId }).find((e) => e.type === "run.instructions.composed" && e.payload["runId"] === runId);
  return (event?.payload as RunInstructionsComposedPayload).manifest;
};

describe("always-on instructions through the environment", () => {
  it.each([false, true])("names a native skill's own folder when a generation exists: %s", async (hasGeneration) => {
    const folder = tempDir("agent-harness-native-skill-");
    const file = join(folder, "SKILL.md");
    writeFileSync(file, "---\nname: native\ndescription: A native skill.\n---\nFollow native guidance.");
    const t = await startTestEnvironment({ adapter: fakeAdapter(), adapterSeams: { instructions: composeInstructions({}), skillSet: async () => ({
      generation: hasGeneration ? tempDir("agent-harness-generation-") : null,
      fingerprint: "native-skill-for-tests",
      members: [{ name: "native", description: "A native skill.", origin: null, invocation: "model+slash", userInvocable: true, argumentHint: null, native: true, alwaysOn: true, file, commit: null }],
      hiddenNativeNames: [],
    }) } });
    onCleanup(() => t.close());
    const client = await t.client();
    const { id } = await create(client);
    await run(t, client, id);
    expect(t.adapter.lastRun().input.instructions).toBe(`# Always-on skill: native\n\nFollow this skill for the whole session; its files are relative to its folder (${folder}).\n\nFollow native guidance.`);
  });

  it("appends enabled account skills last, strips frontmatter and records their provenance", async () => {
    const t = await startTestEnvironment({ adapter: fakeAdapter(), accounts: [{ id: "claude-max", provider: "fake" }, { id: "other", provider: "fake" }], adapterSeams: { instructions: composeInstructions({ session: () => [{ id: "session", version: null, title: "Session", text: "SESSION" }] }) } });
    onCleanup(() => t.close());
    const client = await t.client();
    const { id } = await create(client);
    await ownSkill(t, client, "tidy", "Keep it tidy.");
    await ownSkill(t, client, "off", "DO NOT APPEND");
    await client.request("skills.setEnabled", { commandId: randomUUID(), name: "off", accountId: null, enabled: false });
    const manifest = await run(t, client, id);
    const text = t.adapter.lastRun().input.instructions;
    expect(text).toContain("SESSION\n\n# Always-on skill: tidy");
    expect(text).toContain("Follow this skill for the whole session");
    expect(text).toContain("Keep it tidy.");
    expect(text).not.toContain("description: A test skill.");
    expect(text).not.toContain("DO NOT APPEND");
    expect(manifest.alwaysOn).toEqual([{ name: "tidy", origin: null, commit: null }]);
    const other = await create(client, { account: "other" });
    await run(t, client, other.id);
    expect(t.adapter.lastRun().input.instructions).toBe("SESSION");
  });
  it("cuts a source body at 60,000 characters, names its generation file and records the snapshot commit", async () => {
    const forge = skillRepositories(tempDir);
    const commit = forge.commit("team/skills", { "long/SKILL.md": "---\nname: long\ndescription: A long skill.\n---\n" + "x".repeat(60_000) + "THE REST" });
    const t = await startTestEnvironment({ adapter: fakeAdapter(), harnessGitConfig: skillsInsteadOf(forge) });
    onCleanup(() => t.close());
    const client = await t.client();
    const added = registry["skills.sources.add"].response.parse(await client.request("skills.sources.add", { commandId: randomUUID(), url: `${SKILLS_HOST}team/skills`, folder: ".", follow: { kind: "branch", branch: null } }));
    expect(added.result).toBeDefined();
    await client.request("skills.setAlwaysOn", { commandId: randomUUID(), name: "long", accountId: "claude-max", on: true });
    const { id } = await create(client);
    const manifest = await run(t, client, id);
    const input = t.adapter.lastRun().input;
    expect(input.instructions).toContain("x".repeat(60_000) + "\n\n[Body cut at 60,000 characters;");
    expect(input.instructions).not.toContain("THE REST");
    expect(input.instructions).toContain(join(input.skillSet.generation as string, "skills", "long", "SKILL.md"));
    expect(manifest.alwaysOn).toEqual([{ name: "long", origin: { kind: "repository", repository: `${SKILLS_HOST}team/skills`, path: "long" }, commit }]);
  });

  it("drops always-on members last first before owned instructions under a channel cap", async () => {
    const t = await startTestEnvironment({ adapter: fakeAdapter({ capabilities: { instructionChannel: { kind: "system-prompt-append", maxCharacters: 45 } } }), adapterSeams: { instructions: composeInstructions({ owned: () => [
      { id: "one", version: null, title: "One", text: "Keep one." },
      { id: "two", version: null, title: "Two", text: "Keep two." },
    ] }) } });
    onCleanup(() => t.close());
    const client = await t.client();
    const { id } = await create(client);
    await ownSkill(t, client, "first", "FIRST");
    await ownSkill(t, client, "last", "LAST");
    const manifest = await run(t, client, id);
    expect(t.adapter.lastRun().input.instructions).toBe("# Standing instructions\n\n## One\n\nKeep one.");
    expect(manifest.alwaysOn).toEqual([]);
    expect(manifest.leftOut).toEqual([
      { layer: "always-on", id: "first", reason: "over-cap" },
      { layer: "always-on", id: "last", reason: "over-cap" },
      { layer: "user", id: "two", reason: "over-cap" },
    ]);
    expect(manifest.layers.map((layer) => layer.layer)).toEqual(["user"]);
  });

  it("an always-on change survives restart and starts a fresh process on the next run", async () => {
    const dataDir = join(tempDir("agent-harness-always-on-"), "data");
    const first = await startTestEnvironment({ dataDir, adapter: fakeAdapter() });
    onCleanup(() => first.close());
    const client = await first.client();
    const { id } = await create(client);
    await client.request("skills.own.create", { commandId: randomUUID(), name: "tidy", description: "A test skill." });
    writeFileSync(join(dataDir, "skills", "own", "skills", "tidy", "SKILL.md"), "---\nname: tidy\ndescription: A test skill.\n---\nTIDY");
    await run(first, client, id);
    const fingerprint = first.adapter.lastRun().input.skillSet.fingerprint;
    await client.request("skills.setAlwaysOn", { commandId: randomUUID(), name: "tidy", accountId: "claude-max", on: true });
    await run(first, client, id);
    expect(first.adapter.processesOf(id)).toHaveLength(2);
    expect(first.adapter.lastRun().input.skillSet.fingerprint).not.toBe(fingerprint);
    await first.close();
    const restarted = await startTestEnvironment({ dataDir, adapter: fakeAdapter() });
    onCleanup(() => restarted.close());
    await run(restarted, await restarted.client(), id);
    expect(restarted.adapter.lastRun().input.instructions).toContain("# Always-on skill: tidy");
  });

  it("keeps earlier always-on skills when only the last one must be left out", async () => {
    const t = await startTestEnvironment({ adapter: fakeAdapter({ capabilities: { instructionChannel: { kind: "system-prompt-append", maxCharacters: 500 } } }), adapterSeams: { instructions: composeInstructions({ owned: () => [{ id: "owned", version: null, title: "Owned", text: "OWNED" }] }) } });
    onCleanup(() => t.close());
    const client = await t.client();
    const { id } = await create(client);
    await ownSkill(t, client, "first", "FIRST");
    await ownSkill(t, client, "last", "x".repeat(1_000));
    const manifest = await run(t, client, id);
    expect(t.adapter.lastRun().input.instructions).toContain("OWNED\n\n# Always-on skill: first");
    expect(t.adapter.lastRun().input.instructions).not.toContain("# Always-on skill: last");
    expect(manifest.alwaysOn.map((skill) => skill.name)).toEqual(["first"]);
    expect(manifest.leftOut).toEqual([{ layer: "always-on", id: "last", reason: "over-cap" }]);
  });

  it("records always-on skills as channel-none without handing any text to an adapter with no channel", async () => {
    const t = await startTestEnvironment({ adapter: fakeAdapter({ capabilities: { instructionChannel: { kind: "none", maxCharacters: null } } }) });
    onCleanup(() => t.close());
    const client = await t.client();
    const { id } = await create(client);
    await ownSkill(t, client, "tidy", "TIDY");
    const manifest = await run(t, client, id);
    expect(t.adapter.lastRun().input.instructions).toBe("");
    expect(manifest.alwaysOn).toEqual([]);
    expect(manifest.leftOut).toContainEqual({ layer: "always-on", id: "tidy", reason: "channel-none" });
  });

  it("a routine's skills arrive as extra names after the account's always-on choices", async () => {
    const t = await startTestEnvironment({ adapter: fakeAdapter() });
    onCleanup(() => t.close());
    const client = await t.client();
    await ownSkill(t, client, "account", "ACCOUNT");
    await ownSkill(t, client, "requested", "REQUESTED");
    await client.request("skills.setAlwaysOn", { commandId: randomUUID(), name: "requested", accountId: "claude-max", on: false });
    const { state } = await created(client, written({ schedule: { kind: "manual" }, skills: ["requested", "unknown"] }));
    const firingId = await ranNow(client, state.id);
    await untilSettled(t, state.id, firingId);
    const text = t.adapter.lastRun().input.instructions ?? "";
    expect(text).toContain("# Always-on skill: account");
    expect(text).toContain("# Always-on skill: requested");
    expect(text.indexOf("ACCOUNT")).toBeLessThan(text.indexOf("REQUESTED"));
    expect(text).not.toContain("# Always-on skill: unknown");
  });

});
