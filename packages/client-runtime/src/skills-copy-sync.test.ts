import { randomUUID } from "node:crypto";
import { CATALOGUE, type CommandMethodName, type ParamsOf, type ResultOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { fakeAdapter, signedInAs } from "../../environment/test/fake-adapter.js";
import type { TestEnvironment } from "../../environment/test/helper.js";
import { SKILLS_HOST, skill, skillRepositories, skillsInsteadOf } from "../../environment/test/skill-repositories.js";
import { useHarness } from "../test/harness.js";
import type { Runtime } from "./runtime.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

const harness = useHarness();

const pairedWith = async (...environments: TestEnvironment[]) => {
  const runtime = harness.runtime(inMemoryPlatform());
  await runtime.start();
  for (const t of environments) await runtime.connections.add({ link: (await t.createPairing()).link });
  return runtime;
};

const send = async <N extends CommandMethodName>(runtime: Runtime, environmentId: string, method: N, params: Omit<ParamsOf<N>, "commandId">) => {
  const answer = await runtime.requests.call(environmentId, method, { ...params, commandId: randomUUID() } as ParamsOf<N>);
  expect(answer).toMatchObject({ ok: true, result: { receipt: { status: "accepted" } } });
};

const read = async <N extends "skills.get" | "instructions.list" | "accounts.list">(runtime: Runtime, environmentId: string, method: N): Promise<ResultOf<N>> => {
  const answer = await runtime.requests.call(environmentId, method, {} as ParamsOf<N>);
  if (!answer.ok) throw new Error(answer.error.message);
  return answer.result as ResultOf<N>;
};

describe("skills and instructions copied through the runtime", () => {
  it("replays dismissed suggestions only when ticked and keeps the target's other dismissals", async () => {
    const source = await harness.environment();
    const target = await harness.environment();
    const runtime = await pairedWith(source, target);
    const [first, second] = CATALOGUE.instructions.entries;
    await send(runtime, source.env.id, "instructions.dismissSuggestion", { catalogueId: first!.id });
    await send(runtime, target.env.id, "instructions.dismissSuggestion", { catalogueId: second!.id });
    await runtime.commands.copyToEnvironments(source.env.id, {}, [target.env.id]);
    expect((await read(runtime, target.env.id, "instructions.list")).dismissed).toEqual([second!.id]);
    expect(await runtime.commands.copyToEnvironments(source.env.id, { dismissed: true }, [target.env.id])).toMatchObject([{ status: "copied", result: [{ kind: "dismissed", id: first!.id, status: "copied" }] }]);
    expect((await read(runtime, target.env.id, "instructions.list")).dismissed).toEqual([first!.id, second!.id].sort());
  });
  it("keeps a suggested instruction's edited text and original version when the target has a newer catalogue", async () => {
    const catalogueId = "coding.fresh-checkout";
    const catalogueAt = (version: number) => ({ ...CATALOGUE, instructions: { ...CATALOGUE.instructions, entries: CATALOGUE.instructions.entries.map((entry) => entry.id === catalogueId ? { ...entry, version, text: "New catalogue text.", earlierVersions: [{ version: 1, text: "Original text." }] } : entry) } });
    const source = await harness.environment({ catalogue: () => catalogueAt(1) });
    const target = await harness.environment({ catalogue: () => catalogueAt(2) });
    const runtime = await pairedWith(source, target);
    const id = randomUUID();
    await send(runtime, source.env.id, "instructions.create", { id, catalogueId });
    await send(runtime, source.env.id, "instructions.edit", { instructionId: id, title: "My title", body: "My edited text." });
    expect(await runtime.commands.copyToEnvironments(source.env.id, { instructionIds: [id] }, [target.env.id])).toMatchObject([{ status: "copied", result: [{ kind: "instruction", id, status: "copied" }] }]);
    expect((await read(runtime, target.env.id, "instructions.list")).instructions).toMatchObject([{ id, title: "My title", body: "My edited text.", origin: { catalogueId, version: 1 }, newerVersion: 2 }]);
  });
  it("replays source URL, folder and follow, skips duplicates, and never copies own-directory files or names another environment", async () => {
    const repositories = skillRepositories(harness.tempDir);
    const commit = repositories.commit("owner/skills", { "skills/tdd/SKILL.md": skill("tdd") });
    const source = await harness.environment({ name: "source-desk", harnessGitConfig: skillsInsteadOf(repositories) });
    const target = await harness.environment({ name: "target", harnessGitConfig: skillsInsteadOf(repositories) });
    const runtime = await pairedWith(source, target);
    await send(runtime, source.env.id, "skills.sources.add", { url: `${SKILLS_HOST}owner/skills`, folder: "skills", follow: { kind: "pinned", commit } });
    await send(runtime, source.env.id, "skills.own.create", { name: "own-only", description: "Keep this here." });
    const sourceBefore = await read(runtime, source.env.id, "skills.get");
    const [copied] = await runtime.commands.copyToEnvironments(source.env.id, { sources: true }, [target.env.id]);
    expect(copied).toMatchObject({ status: "copied", result: [{ kind: "source", id: sourceBefore.sources[0]!.id, status: "copied" }] });
    const targetView = await read(runtime, target.env.id, "skills.get");
    expect(targetView.sources).toMatchObject([{ url: `${SKILLS_HOST}owner/skills`, folder: "skills", follow: { kind: "pinned", commit } }]);
    expect(targetView.members.map((member) => member.name)).toEqual(["tdd"]);
    expect((await read(runtime, source.env.id, "skills.get")).sources).toEqual(sourceBefore.sources);
    expect(await runtime.commands.copyToEnvironments(source.env.id, { sources: true }, [target.env.id])).toMatchObject([
      { status: "copied", result: [{ kind: "source", id: sourceBefore.sources[0]!.id, status: "skipped", reason: "duplicate" }] },
    ]);
    const targetEvents = target.env.log.readStream({ kind: "skills", id: target.env.id });
    expect(JSON.stringify([targetView, targetEvents])).not.toContain(source.env.id);
    expect(JSON.stringify([targetView, targetEvents])).not.toContain("source-desk");
  });
  it("maps choices and instruction scopes by identity, creates the same id, then edits and sets it on a later copy", async () => {
    const sourceAdapter = fakeAdapter();
    sourceAdapter.setStatus((account) => account.id === "target-login" ? signedInAs(null) : signedInAs("david@example.com", account.id === "absent" ? "Other organisation" : null));
    const targetAdapter = fakeAdapter();
    targetAdapter.setStatus(() => signedInAs("david@example.com"));
    const source = await harness.environment({ adapter: sourceAdapter, accounts: [{ id: "source-login", provider: sourceAdapter.descriptor.provider }, { id: "absent", provider: sourceAdapter.descriptor.provider }, { id: "target-login", provider: sourceAdapter.descriptor.provider }] });
    const target = await harness.environment({ adapter: targetAdapter, accounts: [{ id: "target-login", provider: targetAdapter.descriptor.provider }] });
    const runtime = await pairedWith(source, target);
    await read(runtime, source.env.id, "accounts.list");
    await read(runtime, target.env.id, "accounts.list");
    await send(runtime, source.env.id, "skills.setAlwaysOn", { name: "tdd", accountId: "source-login", on: true });
    await send(runtime, source.env.id, "skills.setEnabled", { name: "tdd", accountId: null, enabled: false });
    await send(runtime, source.env.id, "skills.setEnabled", { name: "other", accountId: "absent", enabled: false });
    await send(runtime, source.env.id, "skills.setAlwaysOn", { name: "unknown-login", accountId: "target-login", on: true });
    const id = randomUUID();
    await send(runtime, source.env.id, "instructions.create", { id, title: "Small modules", body: "Keep modules deep.", scope: ["source-login", "absent"], enabled: false, position: "n" });
    const scopedOut = randomUUID();
    await send(runtime, source.env.id, "instructions.create", { id: scopedOut, title: "Other organisation", body: "Only there.", scope: ["absent"] });
    await send(runtime, target.env.id, "instructions.create", { id: scopedOut, title: "Keep this", body: "My target text." });
    const unselected = randomUUID();
    await send(runtime, source.env.id, "instructions.create", { id: unselected, title: "Unselected", body: "Leave this here." });

    const reports = await runtime.commands.copyToEnvironments(source.env.id, { choices: true, instructionIds: [id, scopedOut] }, [target.env.id]);
    expect(reports).toMatchObject([{ environmentId: target.env.id, status: "copied", result: expect.arrayContaining([
      { kind: "choice", choiceKind: "enabled", id: "other", accountId: "absent", status: "skipped", reason: "account_absent" },
      { kind: "choice", choiceKind: "always-on", id: "unknown-login", accountId: "target-login", status: "skipped", reason: "account_absent" },
      { kind: "instruction", id, accountId: "absent", status: "skipped", reason: "account_absent" },
      { kind: "instruction", id: scopedOut, accountId: "absent", status: "skipped", reason: "account_absent" },
      { kind: "instruction", id, status: "copied" },
    ]) }]);
    expect((await read(runtime, target.env.id, "skills.get")).choices).toEqual([
      { kind: "enabled", name: "tdd", accountId: null, enabled: false },
      { kind: "always-on", name: "tdd", accountId: "target-login", on: true },
    ]);
    const copiedInstructions = (await read(runtime, target.env.id, "instructions.list")).instructions;
    expect(copiedInstructions).toHaveLength(2);
    expect(copiedInstructions.find((instruction) => instruction.id === id)).toMatchObject({ id, title: "Small modules", body: "Keep modules deep.", scope: ["target-login"], enabled: false, position: "n" });
    expect(copiedInstructions.find((instruction) => instruction.id === scopedOut)).toMatchObject({ title: "Keep this", body: "My target text.", scope: "all" });

    await send(runtime, source.env.id, "instructions.edit", { instructionId: id, title: "Deep modules", body: "Use a small interface." });
    await send(runtime, source.env.id, "instructions.setScope", { instructionId: id, scope: "all" });
    await send(runtime, source.env.id, "instructions.setEnabled", { instructionId: id, enabled: true });
    await send(runtime, source.env.id, "instructions.move", { instructionId: id, position: "t" });
    await runtime.commands.copyToEnvironments(source.env.id, { instructionIds: [id] }, [target.env.id]);
    expect((await read(runtime, target.env.id, "instructions.list")).instructions.find((instruction) => instruction.id === id)).toMatchObject({ id, title: "Deep modules", body: "Use a small interface.", scope: "all", enabled: true, position: "t" });
    const events = ["skills", "instructions"].flatMap((kind) => target.env.log.readStream({ kind, id: target.env.id }));
    expect(JSON.stringify(events)).not.toContain(source.env.id);
  });
});
