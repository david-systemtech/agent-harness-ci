import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { registry, type CommandReceipt, type ParamsOf, type RunSkillSet, type SkillsView, type SkillsViewSource } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added, verify } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, refusal } from "../../test/sessions.js";
import { SKILLS_HOST, skill, skillRepositories, skillsInsteadOf, type SkillRepositories } from "../../test/skill-repositories.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

/**
 * Tracking a skill source through the primary seam (skills spec, "Skill
 * sources" and "Testing Decisions"; ADR 0029; #498): an in-process
 * environment driven by a real client, sources on local bare repositories
 * reached by `https://skills.test/` URLs through the harness git's
 * `insteadOf`, and the scripted fake adapter recording the skill set and
 * generation each run is handed.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (forge: SkillRepositories, options: TestEnvironmentOptions = {}): Promise<{ t: TestEnvironment; client: WireClient }> => {
  const t = await startTestEnvironment({ harnessGitConfig: skillsInsteadOf(forge), adapter: fakeAdapter(), ...options });
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};

type AddParams = Omit<ParamsOf<"skills.sources.add">, "commandId">;

/** Adds a source, following the remote's default branch unless told otherwise; answers the source. */
const add = async (client: WireClient, url: string, params: Partial<AddParams> = {}): Promise<SkillsViewSource> => {
  const answer = registry["skills.sources.add"].response.parse(
    await client.request("skills.sources.add", { commandId: randomUUID(), url, folder: ".", follow: { kind: "branch", branch: null }, ...params }),
  );
  if (answer.result === undefined) throw new Error(`skills.sources.add was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.source;
};

/** Sends `skills.sources.add`, following the remote's default branch from its root unless told otherwise; answers the receipt. */
const send = async (client: WireClient, url: string, params: Partial<AddParams> = {}): Promise<CommandReceipt> =>
  (await client.request("skills.sources.add", { commandId: randomUUID(), url, folder: ".", follow: { kind: "branch", branch: null }, ...params })).receipt;

/** The receipt's rejection: its reason, message and data; throws unless the command was rejected. */
const rejection = (receipt: CommandReceipt) => {
  if (receipt.status !== "rejected") throw new Error(`The command was accepted: ${JSON.stringify(receipt)}`);
  return { reason: receipt.reason, message: receipt.error.message, data: receipt.error.data };
};

/** The events on the environment's skills stream, by type and payload. */
const skillsEvents = (t: TestEnvironment) => t.env.log.readStream({ kind: "skills", id: t.env.id }).map((event) => [event.type, event.payload] as const);

/** How many `skills.updated` notices the environment's stream holds. */
const updates = (t: TestEnvironment): number => t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "skills.updated").length;

/** The snapshots under the data directory, by source. */
const snapshots = (t: TestEnvironment): string[] => {
  const root = join(t.dataDir, "skills", "snapshots");
  return existsSync(root) ? readdirSync(root) : [];
};

const view = async (client: WireClient, sessionId?: string): Promise<SkillsView> =>
  registry["skills.get"].result.parse(await client.request("skills.get", sessionId === undefined ? {} : { sessionId }));

/** Starts a run in the session and waits for its end. */
const runIn = async (t: TestEnvironment, client: WireClient, sessionId: string): Promise<void> => {
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Go" }));
  const runId = answer.result?.runId;
  if (runId === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true), {
    timeout: WAIT_MS,
  });
};

/** The skill set the adapter was handed for its latest run. */
const lastSet = (t: TestEnvironment): RunSkillSet => t.adapter.lastRun().input.skillSet;

describe("a repository whose root is one skill (ADR 0029's root-skill test)", () => {
  it("is added with folder ., and its one member, named after the repository, reaches the next run's generation from the source's snapshot", async () => {
    const forge = skillRepositories(tempDir);
    const commit = forge.commit("theclaymethod/unslop", { "SKILL.md": skill(null, "Remove AI writing patterns."), "references/patterns.md": "# patterns\n" });
    const { t, client } = await start(forge);

    const source = await add(client, `${SKILLS_HOST}theclaymethod/unslop`);
    expect(source).toEqual({
      id: expect.any(String),
      url: `${SKILLS_HOST}theclaymethod/unslop`,
      identity: "https://skills.test/theclaymethod/unslop",
      folder: ".",
      follow: { kind: "branch", branch: null },
      position: 1,
      addedBy: { kind: "client_session", id: expect.any(String) },
      addedAt: expect.any(String),
      commit,
      skillCount: 1,
      sync: { outcome: "ok", since: source.addedAt },
      attemptedAt: source.addedAt,
    });

    const { id } = await create(client);
    await runIn(t, client, id);
    const set = lastSet(t);
    expect(set.members).toEqual([
      { name: "unslop", description: "Remove AI writing patterns.", origin: { kind: "repository", repository: "https://skills.test/theclaymethod/unslop", path: "." }, invocation: "model+slash", userInvocable: true, argumentHint: null, native: false, alwaysOn: false, file: join(set.generation as string, "skills", "unslop", "SKILL.md"), commit },
    ]);
    const link = join(set.generation as string, "skills", "unslop");
    expect(readlinkSync(link)).toBe(join(t.dataDir, "skills", "snapshots", source.id, commit));
    expect(readFileSync(join(link, "references", "patterns.md"), "utf8")).toBe("# patterns\n");
  });
});

describe("skills.sources.add's checkout", () => {
  it("reuses a live probe's checkout: the source is at the commit the probe cloned, though the branch has moved on since", async () => {
    const forge = skillRepositories(tempDir);
    const probed = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd") });
    const { client } = await start(forge);
    const { probeId } = await client.request("skills.probe", { url: `${SKILLS_HOST}david/skills` });
    forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd"), "skills/review/SKILL.md": skill("review") });

    expect(await add(client, `${SKILLS_HOST}david/skills`, { folder: "skills", probeId })).toMatchObject({ commit: probed, skillCount: 1 });
  });

  it("fetches when no live probe was cloned at what the source follows: a probe whose thirty minutes are up, one of another branch, or none, and a pin at its commit", async () => {
    const forge = skillRepositories(tempDir);
    const first = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd"), "more/review/SKILL.md": skill("review") });
    forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd") }, "release/2");
    const { t, client } = await start(forge);
    const url = `${SKILLS_HOST}david/skills`;
    const expired = (await client.request("skills.probe", { url })).probeId;
    const latest = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd"), "skills/review/SKILL.md": skill("review"), "more/review/SKILL.md": skill("review") });
    t.clock.advance(30 * 60_000);
    const release = (await client.request("skills.probe", { url, branch: "release/2" })).probeId;

    expect(await add(client, url, { folder: "skills", probeId: expired })).toMatchObject({ commit: latest, skillCount: 2 });
    expect(await add(client, url, { folder: "more", probeId: release })).toMatchObject({ commit: latest, skillCount: 1 });
    expect(await add(client, url, { folder: "skills/tdd", follow: { kind: "pinned", commit: first } })).toMatchObject({ commit: first, follow: { kind: "pinned", commit: first }, skillCount: 1 });
    // The add's own checkouts are gone once read; the probe of another branch is still kept.
    expect(readdirSync(join(t.dataDir, "skills", "probes"))).toEqual([release]);
  });

  it("is unreachable not_found for a pin at a commit the repository does not have, as the probe says, appending nothing", async () => {
    const forge = skillRepositories(tempDir);
    forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd") });
    const { t, client } = await start(forge);

    const answer = await refusal(send(client, `${SKILLS_HOST}david/skills`, { folder: "skills", follow: { kind: "pinned", commit: "a".repeat(40) } }));
    expect(answer).toMatchObject({ code: "conflict", data: { reason: "unreachable", problem: "not_found", origin: "https://skills.test" } });
    expect(skillsEvents(t)).toEqual([]);
  });

  it("refuses a URL or a folder failing its rule as invalid_params, fetching nothing", async () => {
    const forge = skillRepositories(tempDir);
    const { t, client } = await start(forge);
    for (const [params, path, rule, reason] of [
      [{ url: "https://token-for-tests@skills.test/david/skills", folder: "." }, "url", "source-url", "credential"],
      [{ url: `${SKILLS_HOST}david/skills`, folder: "../skills" }, "folder", "source-folder", "parent"],
      [{ url: `${SKILLS_HOST}david/skills`, folder: "/skills" }, "folder", "source-folder", "absolute"],
    ] as const) {
      const answer = await refusal(client.request("skills.sources.add", { commandId: randomUUID(), follow: { kind: "branch", branch: null }, ...params }));
      expect(answer.code, path).toBe("invalid_params");
      expect(answer.data["issues"]).toEqual([expect.objectContaining({ path: [path], params: { rule, reason } })]);
    }
    expect(snapshots(t)).toEqual([]);
  });
});

describe("a folder that yields no skill", () => {
  it("is refused conflict, reason no_skills, naming the folders that would, and leaves no snapshot and no event", async () => {
    const forge = skillRepositories(tempDir);
    forge.commit("mattpocock/skills", { "README.md": "# skills\n", "skills/engineering/tdd/SKILL.md": skill("tdd"), "skills/misc/notes/SKILL.md": skill("notes"), "docs/guide.md": "# guide\n" });
    const { t, client } = await start(forge);
    const url = `${SKILLS_HOST}mattpocock/skills`;

    for (const folder of [".", "docs", "skills/absent"]) {
      const refused = rejection(await send(client, url, { folder }));
      expect(refused, folder).toMatchObject({ reason: "conflict", data: { reason: "no_skills", folders: ["skills/engineering", "skills/misc"] } });
      expect(refused.message).toBe(`There are no skills in ${folder === "." ? "this repository" : `the folder ${folder}`}. These folders have skills: skills/engineering, skills/misc.`);
    }
    // A folder whose members are all invalid yields none either.
    forge.commit("david/broken", { "skills/Bad_Name/SKILL.md": "---\ndescription: No name passes.\n---\n" });
    const broken = rejection(await send(client, `${SKILLS_HOST}david/broken`, { folder: "skills" }));
    expect(broken.data).toEqual({ reason: "no_skills", folders: ["skills"] });
    // The walk finds the refused folder itself, so the message says its skills are invalid rather than naming it as one that would do.
    expect(broken.message).toBe("The skills in the folder skills cannot be used.");

    expect(skillsEvents(t)).toEqual([]);
    expect(updates(t)).toBe(0);
    await vi.waitFor(() => expect(snapshots(t).flatMap((source) => readdirSync(join(t.dataDir, "skills", "snapshots", source)))).toEqual([]), { timeout: WAIT_MS });
  });
});

describe("an added source", () => {
  it("appends skills.source-added (the record) and skills.source-synced (the commit, the members, outcome ok) on the skills stream, then skills.updated", async () => {
    const forge = skillRepositories(tempDir);
    const commit = forge.commit("mattpocock/skills", { "skills/engineering/tdd/SKILL.md": skill("tdd", "Test-driven development.", "disable-model-invocation: true\n"), "skills/engineering/Bad_Name/SKILL.md": "---\ndescription: No name passes.\n---\n" });
    const { t, client } = await start(forge);

    const source = await add(client, `${SKILLS_HOST}mattpocock/skills.git`, { folder: "skills/engineering", follow: { kind: "branch", branch: "main" } });
    expect(skillsEvents(t)).toEqual([
      [
        "skills.source-added",
        { id: source.id, url: `${SKILLS_HOST}mattpocock/skills.git`, identity: "https://skills.test/mattpocock/skills", folder: "skills/engineering", follow: { kind: "branch", branch: "main" }, position: 1 },
      ],
      [
        "skills.source-synced",
        {
          sourceId: source.id,
          outcome: "ok",
          commit,
          members: [
            { name: null, path: "Bad_Name", description: "No name passes.", invocation: "model+slash", problems: [expect.objectContaining({ kind: "name" })] },
            { name: "tdd", path: "tdd", description: "Test-driven development.", invocation: "slash-only", problems: [] },
          ],
        },
      ],
    ]);
    expect(source.skillCount).toBe(1);
    expect(updates(t)).toBe(1);
  });

  it("is exported at its commit into a read-only snapshot under the data directory holding the folder alone, which a run reads through its link", async () => {
    const forge = skillRepositories(tempDir);
    const commit = forge.commit("mattpocock/skills", { "skills/engineering/tdd/SKILL.md": skill("tdd"), "skills/engineering/tdd/scripts/check.md": "# check\n", "skills/misc/notes/SKILL.md": skill("notes"), "README.md": "# skills\n" });
    const { t, client } = await start(forge);
    const source = await add(client, `${SKILLS_HOST}mattpocock/skills`, { folder: "skills/engineering" });

    const snapshot = join(t.dataDir, "skills", "snapshots", source.id, commit);
    expect(readdirSync(snapshot)).toEqual(["skills"]);
    expect(readdirSync(join(snapshot, "skills"))).toEqual(["engineering"]);
    for (const path of [join(snapshot, "skills", "engineering", "tdd"), join(snapshot, "skills", "engineering", "tdd", "SKILL.md"), join(snapshot, "skills", "engineering", "tdd", "scripts", "check.md")]) {
      expect(statSync(path).mode & 0o222, path).toBe(0);
    }

    const { id } = await create(client);
    await runIn(t, client, id);
    const set = lastSet(t);
    expect(set.members).toEqual([
      { name: "tdd", description: "The tdd skill.", origin: { kind: "repository", repository: "https://skills.test/mattpocock/skills", path: "skills/engineering/tdd" }, invocation: "model+slash", userInvocable: true, argumentHint: null, native: false, alwaysOn: false, file: join(set.generation as string, "skills", "tdd", "SKILL.md"), commit },
    ]);
    expect(readlinkSync(join(set.generation as string, "skills", "tdd"))).toBe(join(snapshot, "skills", "engineering", "tdd"));
    // A later commit upstream changes nothing a run reads: only a sync moves a source.
    forge.commit("mattpocock/skills", { "skills/engineering/tdd/SKILL.md": skill("tdd", "Changed upstream.") });
    await runIn(t, client, id);
    expect(lastSet(t)).toEqual(set);
    expect(readFileSync(join(set.generation as string, "skills", "tdd", "SKILL.md"), "utf8")).toBe(skill("tdd"));
  });

  it("is listed by skills.get with its URL, identity, folder, follow, commit and skill count, its add as its last sync and attempt, its members in its layer", async () => {
    const forge = skillRepositories(tempDir);
    const commit = forge.commit("mattpocock/skills", { "skills/engineering/tdd/SKILL.md": skill("tdd"), "skills/engineering/review/SKILL.md": skill("review") });
    const { client } = await start(forge);
    const source = await add(client, `${SKILLS_HOST}mattpocock/skills`, { folder: "skills/engineering" });

    const { sources, members } = await view(client);
    expect(sources).toEqual([
      {
        id: source.id,
        url: `${SKILLS_HOST}mattpocock/skills`,
        identity: "https://skills.test/mattpocock/skills",
        folder: "skills/engineering",
        follow: { kind: "branch", branch: null },
        position: 1,
        addedBy: source.addedBy,
        addedAt: source.addedAt,
        commit,
        skillCount: 2,
        sync: { outcome: "ok", since: source.addedAt },
        attemptedAt: source.addedAt,
      },
    ]);
    expect(members.map((member) => [member.name, member.path, member.layer, member.shadowedBy])).toEqual([
      ["review", "review", { kind: "source", sourceId: source.id }, null],
      ["tdd", "tdd", { kind: "source", sourceId: source.id }, null],
    ]);
  });
});

describe("the source limits", () => {
  it("take twenty sources, one repository's twenty folders among them, and refuse a twenty-first as source_limit", async () => {
    const forge = skillRepositories(tempDir);
    const files: Record<string, string> = {};
    for (let index = 1; index <= 21; index += 1) files[`s${String(index).padStart(2, "0")}/SKILL.md`] = skill(`s${index}`);
    forge.commit("david/many", files);
    const { t, client } = await start(forge);
    const url = `${SKILLS_HOST}david/many`;
    const { probeId } = await client.request("skills.probe", { url });

    for (let index = 1; index <= 20; index += 1) await add(client, url, { folder: `s${String(index).padStart(2, "0")}`, probeId });
    const refused = rejection(await send(client, url, { folder: "s21", probeId }));
    expect(refused).toMatchObject({ reason: "conflict", message: "You can follow up to 20 collections. Remove one first.", data: { reason: "source_limit", limit: 20 } });
    expect((await view(client)).sources.map((source) => source.position)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(skillsEvents(t)).toHaveLength(40);
  });

  it("refuse a second source with the same identity and folder as duplicate, naming the first, however its URL is spelt, and take the same identity with another folder", async () => {
    const forge = skillRepositories(tempDir);
    forge.commit("mattpocock/skills", { "skills/engineering/tdd/SKILL.md": skill("tdd"), "skills/misc/notes/SKILL.md": skill("notes") });
    const { client } = await start(forge);
    const first = await add(client, `${SKILLS_HOST}mattpocock/skills`, { folder: "skills/engineering" });

    expect(rejection(await send(client, `${SKILLS_HOST}mattpocock/skills.git`, { folder: "skills/engineering/" }))).toMatchObject({
      reason: "conflict",
      message: "You already follow this collection.",
      data: { reason: "duplicate", sourceId: first.id },
    });
    expect(await add(client, `${SKILLS_HOST}mattpocock/skills.git`, { folder: "skills/misc" })).toMatchObject({ identity: first.identity, position: 2 });
  });
});

describe("skills.sources.remove", () => {
  it("appends skills.source-removed and skills.updated, answers the source as it was, and its members leave the next run's set", async () => {
    const forge = skillRepositories(tempDir);
    forge.commit("theclaymethod/unslop", { "SKILL.md": skill(null, "Remove AI writing patterns.") });
    const { t, client } = await start(forge);
    const source = await add(client, `${SKILLS_HOST}theclaymethod/unslop`);
    const { id } = await create(client);
    await runIn(t, client, id);
    expect(lastSet(t).members.map((member) => member.name)).toEqual(["unslop"]);

    const answer = registry["skills.sources.remove"].response.parse(await client.request("skills.sources.remove", { commandId: randomUUID(), sourceId: source.id }));
    expect(answer.result).toEqual({ source });
    expect(skillsEvents(t).at(-1)).toEqual(["skills.source-removed", { sourceId: source.id }]);
    expect(updates(t)).toBe(2);
    expect((await view(client)).sources).toEqual([]);
    await runIn(t, client, id);
    expect(lastSet(t)).toEqual({ generation: null, fingerprint: expect.any(String), members: [], hiddenNativeNames: [] });
  });

  it("refuses a source the environment does not track as not_found, kind source", async () => {
    const { client } = await start(skillRepositories(tempDir));
    const sourceId = randomUUID();
    const answer = registry["skills.sources.remove"].response.parse(await client.request("skills.sources.remove", { commandId: randomUUID(), sourceId }));
    expect(rejection(answer.receipt)).toMatchObject({ reason: "not_found", data: { kind: "source", sourceId } });
  });
});

describe("a source's place in the set", () => {
  it("is below the own directory, the earliest added source first, each shadowed member listed with the member that shadows it", async () => {
    const forge = skillRepositories(tempDir);
    forge.commit("david/first", { "skills/tdd/SKILL.md": skill("tdd"), "skills/grill-me/SKILL.md": skill("grill-me", "From the first.") });
    forge.commit("david/second", { "grill-me/SKILL.md": skill("grill-me", "From the second."), "handoff/SKILL.md": skill("handoff") });
    const { t, client } = await start(forge);
    const first = await add(client, `${SKILLS_HOST}david/first`, { folder: "skills" });
    const second = await add(client, `${SKILLS_HOST}david/second`);
    await client.request("skills.own.create", { commandId: randomUUID(), name: "tdd", description: "My own tdd." });

    const { members } = await view(client);
    expect(members.map((member) => [member.name, member.layer, member.shadowedBy])).toEqual([
      ["grill-me", { kind: "source", sourceId: first.id }, null],
      ["grill-me", { kind: "source", sourceId: second.id }, { layer: { kind: "source", sourceId: first.id }, path: "grill-me" }],
      ["handoff", { kind: "source", sourceId: second.id }, null],
      ["tdd", { kind: "own" }, null],
      ["tdd", { kind: "source", sourceId: first.id }, { layer: { kind: "own" }, path: "skills/tdd" }],
    ]);

    const { id } = await create(client);
    await runIn(t, client, id);
    const set = lastSet(t);
    expect(set.members.map((member) => [member.name, member.origin])).toEqual([
      ["grill-me", { kind: "repository", repository: "https://skills.test/david/first", path: "skills/grill-me" }],
      ["handoff", { kind: "repository", repository: "https://skills.test/david/second", path: "handoff" }],
      ["tdd", null],
    ]);
    expect(readlinkSync(join(set.generation as string, "skills", "tdd"))).toBe(join(t.dataDir, "skills", "own", "skills", "tdd"));
  });
});

describe("a source's provenance manifest", () => {
  const manifest = (entries: Record<string, { repo: string; path: string; sha: string; license: string }>): string => JSON.stringify({ version: 1, skills: entries });

  it("one level up from the folder gives the members it names their origin, the others coming from the source's repository", async () => {
    const forge = skillRepositories(tempDir);
    forge.commit("david/agent-skills", {
      "skills.json": manifest({ tdd: { repo: "mattpocock/skills", path: "skills/engineering/tdd", sha: "74ca5fe", license: "MIT" } }),
      "skills/tdd/SKILL.md": skill("tdd"),
      "skills/notes/SKILL.md": skill("notes"),
    });
    const { client } = await start(forge);
    await add(client, `${SKILLS_HOST}david/agent-skills`, { folder: "skills" });

    expect((await view(client)).members.map((member) => [member.name, member.origin])).toEqual([
      ["notes", { kind: "repository", repository: "https://skills.test/david/agent-skills", path: "skills/notes" }],
      ["tdd", { kind: "manifest", repository: "https://github.com/mattpocock/skills", path: "skills/engineering/tdd", commit: "74ca5fe", licence: "MIT" }],
    ]);
  });

  it("beside the members, in the folder itself, wins over one a level up", async () => {
    const forge = skillRepositories(tempDir);
    forge.commit("david/agent-skills", {
      "skills.json": manifest({ tdd: { repo: "someone/else", path: "tdd", sha: "1111111", license: "MIT" } }),
      "vendored/skills.json": manifest({ tdd: { repo: "mattpocock/skills", path: "skills/engineering/tdd", sha: "74ca5fe", license: "MIT" } }),
      "vendored/tdd/SKILL.md": skill("tdd"),
    });
    const { client } = await start(forge);
    await add(client, `${SKILLS_HOST}david/agent-skills`, { folder: "vendored" });

    expect((await view(client)).members.map((member) => member.origin)).toEqual([
      { kind: "manifest", repository: "https://github.com/mattpocock/skills", path: "skills/engineering/tdd", commit: "74ca5fe", licence: "MIT" },
    ]);
  });

  it("in the folder itself wins whole even when it names nothing, so one a level up gives no origin", async () => {
    const forge = skillRepositories(tempDir);
    forge.commit("david/agent-skills", {
      "skills.json": manifest({ tdd: { repo: "mattpocock/skills", path: "skills/engineering/tdd", sha: "74ca5fe", license: "MIT" } }),
      "vendored/skills.json": manifest({}),
      "vendored/tdd/SKILL.md": skill("tdd"),
    });
    const { client } = await start(forge);
    await add(client, `${SKILLS_HOST}david/agent-skills`, { folder: "vendored" });

    expect((await view(client)).members.map((member) => member.origin)).toEqual([
      { kind: "repository", repository: "https://skills.test/david/agent-skills", path: "vendored/tdd" },
    ]);
  });
});

describe("a source's repository", () => {
  it("joins the repositories this environment knows on its origin, which a forge account's verification probes its reads on", async () => {
    const repositories = skillRepositories(tempDir);
    repositories.commit("david/agent-skills", { "skills/tdd/SKILL.md": skill("tdd") });
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    forge.repository(TOKEN, "david/agent-skills");
    // The forge's own host, its git sent to the bare repositories; its API is the fake forge's.
    const { client } = await start(repositories, { harnessGitConfig: [[`url.${pathToFileURL(repositories.root).href}/.insteadOf`, "https://127.0.0.1/"]], setupSteps: NO_SETUP_STEPS });
    await add(client, "https://127.0.0.1/david/agent-skills", { folder: "skills" });

    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const [verified] = await verify(client, account.id);
    expect(verified?.capabilities.readRepository.state).toBe("verified");
    expect(forge.requests.map((request) => request.path)).toContain("/api/v1/repos/david/agent-skills");
  });
});
