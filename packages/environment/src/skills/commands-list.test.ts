import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry, type RunSkillSetMember } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { SkillSetSeam } from "../adapter/seams.js";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter, type FakeAdapterOptions } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * `commands.list` by session through the primary seam (skills spec,
 * "Materialisation and the Claude mapping"; ADR 0009; #503): an in-process
 * environment on a temporary data directory, a real client, and the
 * scripted fake adapter answering a provider listing of its own commands,
 * built-ins among them, beside each member of the set it is handed, as
 * Claude lists them: `agent-harness:<name>` for a linked member, `<name>`
 * for a native one. What is asserted is the listing a client gets.
 */

const { onCleanup } = useCleanups();

const start = async (adapter: FakeAdapterOptions = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<{ t: TestEnvironment; client: WireClient }> => {
  const t = await startTestEnvironment({ ...options, adapter: fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};

/** Writes a file under the own directory, its folders made. */
const writeOwn = (t: TestEnvironment, path: string, text: string): void => {
  const file = join(t.dataDir, "skills", "own", path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

const COMPACT = { name: "compact", description: "Compact the conversation.", builtin: true };
const DEPLOY = { name: "deploy", description: "Deploy the branch.", builtin: false };

describe("commands.list by session", () => {
  it("answers a skill entry for each member a person may invoke, command members included, then the provider's own commands with its built-ins flagged", async () => {
    const { t, client } = await start({ commands: [COMPACT, DEPLOY] });
    writeOwn(t, "skills/tdd/SKILL.md", '---\nname: tdd\ndescription: Test-driven development.\nargument-hint: "<feature>"\ndisable-model-invocation: true\n---\nRed, green.\n');
    writeOwn(t, "commands/review.md", "---\ndescription: Review the branch.\nargument-hint: [branch]\n---\nReview it.\n");
    writeOwn(t, "skills/notes/SKILL.md", "---\nname: notes\ndescription: Background the model reads.\nuser-invocable: false\n---\nNotes.\n");
    registry["skills.setAlwaysOn"].response.parse(await client.request("skills.setAlwaysOn", { commandId: randomUUID(), name: "review", accountId: "claude-max", on: true }));
    const { id } = await create(client);

    expect(await client.request("commands.list", { sessionId: id })).toEqual({
      accountId: "claude-max",
      entries: [
        { kind: "skill", name: "review", description: "Review the branch.", invocation: "model+slash", origin: null, alwaysOn: true, argumentHint: "[branch]" },
        { kind: "skill", name: "tdd", description: "Test-driven development.", invocation: "slash-only", origin: null, alwaysOn: false, argumentHint: "<feature>" },
        { kind: "command", ...COMPACT },
        { kind: "command", ...DEPLOY },
      ],
    });
    // The provider was asked under the set a run of the session would have, the member a person may not invoke among it.
    expect(t.adapter.commandListings.at(-1)?.scope.skillSet.members.map((member) => member.name)).toEqual(["notes", "review", "tdd"]);
  });

  it("folds the provider's listing of a linked member and of a native one into the skill entries, and keeps a built-in that shares a member's name", async () => {
    const member = (name: string, native: boolean): RunSkillSetMember => ({
      name,
      description: `The ${name} skill.`,
      origin: null,
      invocation: "model+slash",
      userInvocable: true,
      argumentHint: null,
      native,
      alwaysOn: false,
    });
    const skillSet: SkillSetSeam = async () => ({ generation: null, fingerprint: "3f9a", members: [member("tdd", false), member("release", true), member("compact", false)], hiddenNativeNames: [] });
    const { client } = await start({ commands: [COMPACT, { name: "agent-harness:handoff", description: "A plugin's own.", builtin: false }] }, { adapterSeams: { skillSet } });
    const { id } = await create(client);

    const { entries } = await client.request("commands.list", { sessionId: id });
    expect(entries.map((entry) => [entry.kind, entry.name])).toEqual([
      ["skill", "compact"],
      ["skill", "release"],
      ["skill", "tdd"],
      ["command", "compact"],
      ["command", "agent-harness:handoff"],
    ]);
  });

  it("refuses a session it does not hold not_found, and an adapter without the commands capability as before", async () => {
    const { client } = await start({ commands: [COMPACT] });
    expect(await refusal(client.request("commands.list", { sessionId: randomUUID() }))).toMatchObject({ code: "not_found", data: { kind: "session" } });

    const bare = await start();
    const { id } = await create(bare.client);
    expect(await refusal(bare.client.request("commands.list", { sessionId: id }))).toMatchObject({ code: "invalid_params", data: { reason: "unsupported", capability: "commands" } });
    expect(bare.t.adapter.commandListings).toEqual([]);
  });
});
