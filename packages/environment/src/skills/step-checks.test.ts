import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry, type ParamsOf, type ResponseOf, type StepResult } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { SKILLS_HOST, skill, skillRepositories, skillsInsteadOf, type SkillRepositories } from "../../test/skill-repositories.js";
import { formatActor } from "../event-log/event-log.js";
import type { WireClient } from "../../test/wire-client.js";

const { onCleanup, tempDir } = useCleanups();
const start = async (options: TestEnvironmentOptions = {}) => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};
const check = async (client: WireClient): Promise<StepResult> => (await client.request("setup.check", { step: "skills" })).results[0] as StepResult;
type Command = "skills.sources.add" | "skills.sources.pull" | "skills.sources.setFollow" | "skills.own.create";
const send = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;
const add = async (client: WireClient, name: string) => {
  const answer = await send(client, "skills.sources.add", { url: `${SKILLS_HOST}${name}`, folder: "skills", follow: { kind: "branch", branch: null } });
  if (answer.result === undefined) throw new Error("The test source was not added.");
  return answer.result.source;
};
const startWithSources = (forge: SkillRepositories, options: TestEnvironmentOptions = {}) => start({ harnessGitConfig: skillsInsteadOf(forge), ...options });

describe("the Skills step through setup.check", () => {
  it("skips only with nothing tracked and an empty own directory, then checks an own skill", async () => {
    const { client } = await start();
    expect(await check(client)).toMatchObject({ state: "skipped", reason: "No skills added. Optional.", failing: [], actions: [] });
    await send(client, "skills.own.create", { name: "local-skill", description: "A skill of my own." });
    expect(await check(client)).toMatchObject({ state: "done", reason: "Your own skills are ready.", failing: [], actions: [] });
  });
  it("checks healthy tracked sources with local reads, fetching nothing", async () => {
    const forge = skillRepositories(tempDir);
    forge.commit("david/healthy", { "skills/tdd/SKILL.md": skill("tdd") });
    let gitCalls = 0;
    const { client } = await startWithSources(forge, { skillsGit: async (request, git) => { gitCalls += 1; return git(request); } });
    await add(client, "david/healthy");
    const before = gitCalls;
    expect(await check(client)).toMatchObject({ state: "done", reason: "Your skills are up to date.", failing: [], actions: [] });
    expect(gitCalls).toBe(before);
  });

  it("names every failed unpinned source with Pull now, while a pinned source never fails freshness", async () => {
    const forge = skillRepositories(tempDir);
    for (const name of ["first", "second", "pinned"]) forge.commit(`david/${name}`, { "skills/tdd/SKILL.md": skill("tdd") });
    const { client } = await startWithSources(forge);
    const first = await add(client, "david/first");
    const second = await add(client, "david/second");
    const pinned = await add(client, "david/pinned");
    await send(client, "skills.sources.setFollow", { sourceId: pinned.id, follow: { kind: "pinned", commit: pinned.commit } });
    for (const name of ["first", "second", "pinned"]) renameSync(join(forge.root, `david/${name}.git`), join(forge.root, `david/${name}-gone.git`));
    for (const source of [first, second]) await send(client, "skills.sources.pull", { sourceId: source.id });
    const result = await check(client);
    expect(result).toMatchObject({ state: "needs-attention", failing: ["skills.sources-synced"], actions: ["pull-now"], targets: [
      { action: "pull-now", kind: "skill-source", id: first.id, label: "david/first (skills)" },
      { action: "pull-now", kind: "skill-source", id: second.id, label: "david/second (skills)" },
    ] });
    // setup-copy.md §5.9: each failed collection by its name; the address and git's words in details.
    expect(result.reason).toBe("david/first (skills) could not update. Choose Update now. david/second (skills) could not update. Choose Update now.");
    expect(result.details).toEqual(expect.arrayContaining([expect.stringContaining(first.url), expect.stringContaining(second.url)]));
    expect(result.reason).not.toContain("pinned");
  });

  it("uses the last successful attempt's seven-hour grace, including unchanged pulls, while a scheduled fetch is held", async () => {
    const forge = skillRepositories(tempDir);
    forge.commit("david/fresh", { "skills/tdd/SKILL.md": skill("tdd") });
    forge.commit("david/pinned", { "skills/tdd/SKILL.md": skill("tdd") });
    let gate: Promise<void> | null = null;
    const { t, client } = await startWithSources(forge, { skillsGit: async (request, git) => { if (gate !== null) await gate; return git(request); } });
    const source = await add(client, "david/fresh");
    const pinned = await add(client, "david/pinned");
    await send(client, "skills.sources.setFollow", { sourceId: pinned.id, follow: { kind: "pinned", commit: pinned.commit } });
    t.clock.advance(60 * 60_000);
    await send(client, "skills.sources.pull", { sourceId: source.id });
    let release = (): void => undefined;
    gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      t.clock.advance(7 * 60 * 60_000);
      expect(await check(client)).toMatchObject({ state: "done", failing: [] });
      t.clock.advance(1);
      const result = await check(client);
      expect(result).toMatchObject({ state: "needs-attention", failing: ["skills.sources-synced"], actions: ["pull-now"], targets: [{ id: source.id }] });
      // Out of date is told apart from a failed update.
      expect(result.reason).toBe("david/fresh (skills) has not updated for over 7 hours. Choose Update now.");
      expect(result.details).toEqual(expect.arrayContaining([expect.stringContaining(source.url)]));
    } finally { gate = null; release(); await send(client, "skills.sources.pull", { sourceId: source.id }); }
  });

  it("names each source whose latest layout yields no skills, even though its last good snapshot remains", async () => {
    const forge = skillRepositories(tempDir);
    for (const name of ["first", "second"]) forge.commit(`david/${name}`, { "skills/tdd/SKILL.md": skill("tdd") });
    const { client } = await startWithSources(forge);
    const sources = [await add(client, "david/first"), await add(client, "david/second")];
    for (const name of ["first", "second"]) forge.commit(`david/${name}`, { "moved/tdd/SKILL.md": skill("tdd") });
    for (const source of sources) await send(client, "skills.sources.pull", { sourceId: source.id });
    const result = await check(client);
    // A moved layout asks to choose folders again, not to update: it is no failed update.
    expect(result).toMatchObject({ state: "needs-attention", failing: ["skills.sources-yield"], actions: ["choose-folders"] });
    expect(result.targets).toEqual(sources.map((source, index) => ({ action: "choose-folders", kind: "skill-source", id: source.id, label: `david/${["first", "second"][index]} (skills)` })));
    expect(result.reason).toBe("david/first (skills) no longer has skills where they were. Choose its folders again. david/second (skills) no longer has skills where they were. Choose its folders again.");
    expect(result.details).toEqual(expect.arrayContaining([expect.stringContaining("moved")]));
    expect((await client.request("skills.get", {})).sources.map((source) => source.skillCount)).toEqual([1, 1]);
  });

  it("fails the source limit above twenty after an import bypasses add, and names a zero-member source", async () => {
    const forge = skillRepositories(tempDir);
    const commit = forge.commit("david/imported", { "skills/tdd/SKILL.md": skill("tdd") });
    const { t, client } = await startWithSources(forge);
    const stream = { kind: "skills", id: t.env.id };
    const actor = formatActor({ kind: "system", id: "test-import" });
    const importSource = (index: number, members: unknown[]) => {
      const id = randomUUID();
      t.env.log.append(stream, [
        { type: "skills.source-added", payload: { id, url: `${SKILLS_HOST}david/imported`, identity: "skills.test/david/imported", folder: `folder-${index}`, follow: { kind: "pinned", commit }, position: index } },
        { type: "skills.source-synced", payload: { sourceId: id, outcome: "ok", commit, members } },
      ], { actor });
      return id;
    };
    for (let index = 1; index <= 20; index += 1) importSource(index, [{ name: "tdd", path: "tdd", description: "Do TDD.", invocation: "model+slash", problems: [] }]);
    expect(await check(client)).toMatchObject({ state: "done", failing: [] });
    const empty = importSource(21, []);
    expect(await check(client)).toMatchObject({ state: "needs-attention", failing: ["skills.sources-yield", "skills.source-limit"], actions: ["choose-folders"], targets: [{ id: empty }] });
    expect((await check(client)).reason).toContain("You follow 21 collections. The limit is 20. Remove 1.");
  });

  it("never skips an unreadable own directory, and treats an unrecognised file as nonempty", async () => {
    const { t, client } = await start();
    const own = join(t.dataDir, "skills", "own");
    writeFileSync(join(own, "skills", "unrecognised.txt"), "A file the skill reader ignores.");
    expect(await check(client)).toMatchObject({ state: "done", failing: [] });
    renameSync(join(own, "commands"), join(own, "commands-away"));
    writeFileSync(join(own, "commands"), "Not a readable directory.");
    const result = await check(client);
    expect(result).toMatchObject({ state: "needs-attention", failing: ["skills.own-directory"], actions: [] });
    expect(result.reason).toBe("agent-harness cannot open your own skills folder. Check that it exists.");
    expect(result.details).toEqual([expect.stringContaining(own)]);
    expect(result.details?.[0]).not.toMatch(/[\r\n]/);
  });

});
