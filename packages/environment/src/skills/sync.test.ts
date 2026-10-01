import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry, type CommandReceipt, type ParamsOf, type RunSkillSet, type SkillsView, type SkillsViewSource } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ForgeGitAnswer, ForgeGitRequest } from "../forge/harness-git.js";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { restartAfter, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, refusal } from "../../test/sessions.js";
import { SKILLS_HOST, skill, skillRepositories, skillsInsteadOf, type SkillRepositories } from "../../test/skill-repositories.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

/**
 * Syncing skill sources through the primary seam (skills spec, "Skill
 * sources" and "Testing Decisions"; ADR 0029; #499): an in-process
 * environment on a manual clock driven by a real client, sources on local
 * bare repositories reached by `https://skills.test/` URLs through the
 * harness git's `insteadOf`, which the test commits to, rewrites and
 * re-lays out between syncs, and the skills' git seen, and held where a
 * test needs a sync in flight, by a double in front of the ForgeService's.
 */

const { onCleanup, tempDir } = useCleanups();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The skills' git as a test sees it: every request, in order, and a hold on the calls made while one is set. */
interface SkillsGit {
  readonly requests: ForgeGitRequest[];
  /** Holds every call made from now until the release, which lets them all go. */
  hold(): () => void;
  /** Answers every call from now as git stopped at its time, having run none. */
  stopAtTime(): void;
  readonly wrap: NonNullable<TestEnvironmentOptions["skillsGit"]>;
}

const skillsGit = (): SkillsGit => {
  const requests: ForgeGitRequest[] = [];
  let gate: Promise<void> | null = null;
  let stopped = false;
  return {
    requests,
    stopAtTime() {
      stopped = true;
    },
    hold() {
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      gate = held;
      return () => {
        if (gate === held) gate = null;
        release();
      };
    },
    wrap: async (request: ForgeGitRequest, git: (request: ForgeGitRequest) => Promise<ForgeGitAnswer>): Promise<ForgeGitAnswer> => {
      requests.push(request);
      if (gate !== null) await gate;
      if (stopped) return { outcome: "ran", git: { ok: false, stdout: Buffer.alloc(0), truncated: true, timedOut: true, missing: false, code: null, stderr: "" } };
      return git(request);
    },
  };
};

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

/** Sends Pull now for the source; answers the receipt and the source it answered. */
const pull = async (client: WireClient, sourceId: string): Promise<{ receipt: CommandReceipt; source: SkillsViewSource | undefined }> => {
  const answer = registry["skills.sources.pull"].response.parse(await client.request("skills.sources.pull", { commandId: randomUUID(), sourceId }));
  return { receipt: answer.receipt, source: answer.result?.source };
};

/** Sends `skills.sources.setFollow`; answers the receipt and the source it answered. */
const setFollow = async (client: WireClient, sourceId: string, follow: ParamsOf<"skills.sources.setFollow">["follow"]): Promise<{ receipt: CommandReceipt; source: SkillsViewSource | undefined }> => {
  const answer = registry["skills.sources.setFollow"].response.parse(await client.request("skills.sources.setFollow", { commandId: randomUUID(), sourceId, follow }));
  return { receipt: answer.receipt, source: answer.result?.source };
};

const view = async (client: WireClient): Promise<SkillsView> => registry["skills.get"].result.parse(await client.request("skills.get", {}));

/** The events on the environment's skills stream, by type and payload. */
const skillsEvents = (t: TestEnvironment) => t.env.log.readStream({ kind: "skills", id: t.env.id }).map((event) => [event.type, event.payload] as const);

/** The commits of the source's snapshots under the data directory. */
const snapshotsOf = (t: TestEnvironment, sourceId: string): string[] => {
  const folder = join(t.dataDir, "skills", "snapshots", sourceId);
  return existsSync(folder) ? readdirSync(folder).sort() : [];
};

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

/** Where the member `name` of a run's set links to in its generation. */
const readLink = (set: RunSkillSet, name: string): string => readlinkSync(join(set.generation as string, "skills", name));

/** The descriptions of the members of the latest run's set, by name. */
const descriptions = (t: TestEnvironment): Record<string, string | null> => Object.fromEntries(lastSet(t).members.map((member) => [member.name, member.description]));

describe("Pull now", () => {
  it("brings a new upstream commit into the next run's set, which a run's start alone never fetches", async () => {
    const forge = skillRepositories(tempDir);
    const first = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "First.") });
    const git = skillsGit();
    const { t, client } = await start(forge, { skillsGit: git.wrap });
    const source = await add(client, `${SKILLS_HOST}david/skills`, { folder: "skills" });
    const { id } = await create(client);
    const second = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "Second.") });

    const fetched = git.requests.length;
    await runIn(t, client, id);
    expect(git.requests).toHaveLength(fetched);
    expect(descriptions(t)).toEqual({ tdd: "First." });
    expect(source.commit).toBe(first);

    const pulled = await pull(client, source.id);
    expect(pulled.source).toMatchObject({ id: source.id, commit: second, skillCount: 1, sync: { outcome: "ok" }, attemptedAt: t.clock.now().toISOString() });
    await runIn(t, client, id);
    expect(descriptions(t)).toEqual({ tdd: "Second." });
    expect(readLink(lastSet(t), "tdd")).toBe(join(t.dataDir, "skills", "snapshots", source.id, second, "skills", "tdd"));
    expect(skillsEvents(t).at(-1)).toEqual([
      "skills.source-synced",
      { sourceId: source.id, outcome: "ok", commit: second, members: [{ name: "tdd", path: "tdd", description: "Second.", invocation: "model+slash", problems: [] }] },
    ]);
    expect((await view(client)).sources).toEqual([pulled.source]);
  });
});

describe("a sync", () => {
  it("is joined by a Pull now sent while one runs: one fetch, depth one on the branch the source follows, both answered with the commit it brought", async () => {
    const forge = skillRepositories(tempDir);
    forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd") });
    forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd") }, "release/2");
    const git = skillsGit();
    const { client } = await start(forge, { skillsGit: git.wrap });
    const source = await add(client, `${SKILLS_HOST}david/skills`, { folder: "skills", follow: { kind: "branch", branch: "release/2" } });
    const next = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd"), "skills/review/SKILL.md": skill("review") }, "release/2");

    const fetched = git.requests.length;
    const release = git.hold();
    const first = pull(client, source.id);
    await vi.waitFor(() => expect(git.requests).toHaveLength(fetched + 1), { timeout: WAIT_MS });
    const second = pull(client, source.id);
    // A query after it on the same socket is answered once the second's prepare has begun, and so has joined the sync.
    await view(client);
    release();

    const [one, two] = await Promise.all([first, second]);
    expect(one.source).toMatchObject({ commit: next, skillCount: 2, sync: { outcome: "ok" } });
    expect(two.source).toEqual(one.source);
    expect(git.requests.slice(fetched)).toEqual([expect.objectContaining({ operation: "clone", depth: 1, branch: "release/2", timeoutMs: 60_000 })]);
  });

  it("that changes nothing appends nothing, and moves the source's last attempt", async () => {
    const forge = skillRepositories(tempDir);
    forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd") });
    const { t, client } = await start(forge);
    const source = await add(client, `${SKILLS_HOST}david/skills`, { folder: "skills" });
    const events = skillsEvents(t);

    t.clock.advance(60_000);
    const pulled = await pull(client, source.id);
    expect(pulled.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(pulled.source).toEqual({ ...source, attemptedAt: t.clock.now().toISOString() });
    expect(skillsEvents(t)).toEqual(events);
    expect((await view(client)).sources).toEqual([pulled.source]);
  });

  it("keeps the last good snapshot through a fetch that fails and a layout that moved, saying why beside the commit, and follows a rewritten history to its new commit", async () => {
    const forge = skillRepositories(tempDir);
    const good = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "Good.") });
    const { t, client } = await start(forge);
    const source = await add(client, `${SKILLS_HOST}david/skills`, { folder: "skills" });
    const { id } = await create(client);

    // The fetch fails: the repository is not there.
    const bare = join(forge.root, "david", "skills.git");
    renameSync(bare, `${bare}.away`);
    t.clock.advance(60_000);
    const failed = await pull(client, source.id);
    const since = t.clock.now().toISOString();
    expect(failed.source).toMatchObject({ commit: good, skillCount: 1, sync: { outcome: "failed", since, problem: "not_found", line: expect.stringMatching(/^fatal: /) }, attemptedAt: since });
    const line = failed.source?.sync.outcome === "failed" ? failed.source.sync.line : "";
    expect(skillsEvents(t).at(-1)).toEqual(["skills.source-synced", { sourceId: source.id, outcome: "failed", problem: "not_found", line }]);
    expect((await view(client)).sources).toEqual([failed.source]);
    // Failing the same way again changes nothing the log holds.
    const events = skillsEvents(t).length;
    t.clock.advance(60_000);
    expect((await pull(client, source.id)).source).toMatchObject({ sync: { outcome: "failed", since }, attemptedAt: t.clock.now().toISOString() });
    expect(skillsEvents(t)).toHaveLength(events);
    await runIn(t, client, id);
    expect(descriptions(t)).toEqual({ tdd: "Good." });

    // The layout moved: the folder yields nothing at the new commit; the snapshot made for it is not kept.
    renameSync(`${bare}.away`, bare);
    const moved = forge.commit("david/skills", { "agents/tdd/SKILL.md": skill("tdd", "Moved.") });
    const relaid = await pull(client, source.id);
    expect(relaid.source).toMatchObject({ commit: good, skillCount: 1, sync: { outcome: "layout_moved", commit: moved, folders: ["agents"] } });
    expect(skillsEvents(t).at(-1)).toEqual(["skills.source-synced", { sourceId: source.id, outcome: "layout_moved", commit: moved, folders: ["agents"] }]);
    expect(snapshotsOf(t, source.id)).toEqual([good]);
    await runIn(t, client, id);
    expect(descriptions(t)).toEqual({ tdd: "Good." });

    // The history is rewritten: the branch holds a commit that does not descend from the last.
    rmSync(bare, { recursive: true, force: true });
    const rewritten = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "Rewritten.") });
    const followed = await pull(client, source.id);
    expect(followed.source).toMatchObject({ commit: rewritten, skillCount: 1, sync: { outcome: "ok" } });
    await runIn(t, client, id);
    expect(descriptions(t)).toEqual({ tdd: "Rewritten." });
    expect((await view(client)).sources).toEqual([followed.source]);
  });

  it("is failed, network, when git is stopped at the fetch's sixty seconds, keeping the last good snapshot", async () => {
    const forge = skillRepositories(tempDir);
    const good = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd") });
    const git = skillsGit();
    const { client } = await start(forge, { skillsGit: git.wrap });
    const source = await add(client, `${SKILLS_HOST}david/skills`, { folder: "skills" });

    git.stopAtTime();
    const timedOut = await pull(client, source.id);
    expect(git.requests.at(-1)).toMatchObject({ operation: "clone", depth: 1, timeoutMs: 60_000 });
    expect(timedOut.source).toMatchObject({ commit: good, sync: { outcome: "failed", problem: "network", line: "git was stopped after 60 seconds." } });
  });
});

describe("the syncs on their own", () => {
  it("sync every unpinned source once after start, past the startup gate with the wire open while the fetch is still held, and never a pinned one", async () => {
    const forge = skillRepositories(tempDir);
    const before = forge.commit("david/first", { "skills/tdd/SKILL.md": skill("tdd") });
    const pinnedAt = forge.commit("david/second", { "handoff/SKILL.md": skill("handoff") });
    const { t, client } = await start(forge, { dataDir: join(tempDir(), "data") });
    await add(client, `${SKILLS_HOST}david/first`, { folder: "skills" });
    await add(client, `${SKILLS_HOST}david/second`, { follow: { kind: "pinned", commit: pinnedAt } });
    const after = forge.commit("david/first", { "skills/tdd/SKILL.md": skill("tdd", "Moved on.") });
    forge.commit("david/second", { "handoff/SKILL.md": skill("handoff", "Moved on.") });

    const git = skillsGit();
    const release = git.hold();
    const again = await restartAfter(t, MINUTE, (options) => start(forge, { ...options, skillsGit: git.wrap }));
    await vi.waitFor(() => expect(git.requests).toHaveLength(1), { timeout: WAIT_MS });
    expect((await view(again.client)).sources.map((source) => [source.commit, source.attemptedAt])).toEqual([
      [before, null],
      [pinnedAt, null],
    ]);

    release();
    await vi.waitFor(async () => expect((await view(again.client)).sources[0]).toMatchObject({ commit: after, attemptedAt: again.t.clock.now().toISOString() }), { timeout: WAIT_MS });
    expect(git.requests).toEqual([expect.objectContaining({ operation: "clone", repository: `${SKILLS_HOST}david/first`, depth: 1 })]);
    expect((await view(again.client)).sources[1]).toMatchObject({ commit: pinnedAt, attemptedAt: null });
  });

  it("sync each unpinned source once every six hours on one timer, staggered by position from six hours after start, and never a pinned one", async () => {
    const forge = skillRepositories(tempDir);
    const urls = ["one", "two", "three"].map((name) => `${SKILLS_HOST}david/${name}`);
    const commits = ["one", "two", "three"].map((name) => forge.commit(`david/${name}`, { "SKILL.md": skill(name) }));
    const git = skillsGit();
    const { t, client } = await start(forge, { skillsGit: git.wrap });
    const [one, two] = [await add(client, urls[0] as string), await add(client, urls[1] as string)];
    await add(client, urls[2] as string, { follow: { kind: "pinned", commit: commits[2] as string } });
    const added = git.requests.length;
    const fetched = async (): Promise<string[]> => {
      // A round trip first: a sync the clock started has asked for its fetch by the time the answer comes back.
      await view(client);
      return git.requests.slice(added).map((request) => request.repository);
    };
    const synced = (source: SkillsViewSource) =>
      vi.waitFor(async () => expect((await view(client)).sources.find((listed) => listed.id === source.id)?.attemptedAt).toBe(t.clock.now().toISOString()), { timeout: WAIT_MS });

    t.clock.advance(6 * HOUR - 1);
    expect(await fetched()).toEqual([]);
    t.clock.advance(1);
    await synced(one);
    expect(await fetched()).toEqual([urls[0]]);
    t.clock.advance(18 * MINUTE);
    await synced(two);
    expect(await fetched()).toEqual([urls[0], urls[1]]);

    t.clock.advance(6 * HOUR - 18 * MINUTE - 1);
    expect(await fetched()).toEqual([urls[0], urls[1]]);
    t.clock.advance(1);
    await synced(one);
    t.clock.advance(18 * MINUTE);
    await synced(two);
    expect(await fetched()).toEqual([urls[0], urls[1], urls[0], urls[1]]);
  });
});

describe("skills.sources.setFollow", () => {
  it("pins a source at its current commit with skills.source-follow-set alone, after which it never syncs and Pull now on it is conflict, reason pinned", async () => {
    const forge = skillRepositories(tempDir);
    const current = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd") });
    const git = skillsGit();
    const { t, client } = await start(forge, { skillsGit: git.wrap });
    const source = await add(client, `${SKILLS_HOST}david/skills`, { folder: "skills" });
    const fetched = git.requests.length;

    const pinned = await setFollow(client, source.id, { kind: "pinned", commit: current });
    expect(pinned.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(pinned.source).toEqual({ ...source, follow: { kind: "pinned", commit: current } });
    expect(skillsEvents(t).at(-1)).toEqual(["skills.source-follow-set", { sourceId: source.id, follow: { kind: "pinned", commit: current } }]);

    forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "Moved on.") });
    const refused = await pull(client, source.id);
    expect(refused.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "pinned", commit: current } } });
    t.clock.advance(12 * HOUR);
    expect((await view(client)).sources).toEqual([pinned.source]);
    expect(git.requests).toHaveLength(fetched);
    // Pinning it where it is already pinned changes nothing.
    expect((await setFollow(client, source.id, { kind: "pinned", commit: current })).receipt).toMatchObject({ status: "accepted", changed: false });
  });

  it("pins a source at a named commit, fetched and exported into its snapshot, and refuses one it cannot fetch, one at which the folder yields nothing, and a source it does not track", async () => {
    const forge = skillRepositories(tempDir);
    const old = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "Old.") });
    const moved = forge.commit("david/skills", { "agents/tdd/SKILL.md": skill("tdd", "Moved.") });
    const latest = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "Latest.") });
    const { t, client } = await start(forge);
    const source = await add(client, `${SKILLS_HOST}david/skills`, { folder: "skills" });
    expect(source.commit).toBe(latest);

    const pinned = await setFollow(client, source.id, { kind: "pinned", commit: old });
    expect(pinned.source).toMatchObject({ follow: { kind: "pinned", commit: old }, commit: old, skillCount: 1, sync: { outcome: "ok" }, attemptedAt: t.clock.now().toISOString() });
    expect(skillsEvents(t).slice(-2)).toEqual([
      ["skills.source-follow-set", { sourceId: source.id, follow: { kind: "pinned", commit: old } }],
      ["skills.source-synced", { sourceId: source.id, outcome: "ok", commit: old, members: [{ name: "tdd", path: "tdd", description: "Old.", invocation: "model+slash", problems: [] }] }],
    ]);
    const { id } = await create(client);
    await runIn(t, client, id);
    expect(descriptions(t)).toEqual({ tdd: "Old." });

    const events = skillsEvents(t).length;
    const yieldsNothing = await setFollow(client, source.id, { kind: "pinned", commit: moved });
    expect(yieldsNothing.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "no_skills", folders: ["agents"] } } });
    expect(await refusal(setFollow(client, source.id, { kind: "pinned", commit: "a".repeat(40) }))).toMatchObject({ code: "conflict", data: { reason: "unreachable", problem: "not_found" } });
    const unknown = await setFollow(client, randomUUID(), { kind: "pinned", commit: old });
    expect(unknown.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "source" } } });
    expect(skillsEvents(t)).toHaveLength(events);
    expect(snapshotsOf(t, source.id)).toEqual([latest, old].sort());
  });

  it("unpins a source to a branch with skills.source-follow-set, and the environment syncs it at once", async () => {
    const forge = skillRepositories(tempDir);
    const old = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "Old.") });
    const release = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "Released.") }, "release/2");
    const { t, client } = await start(forge);
    const source = await add(client, `${SKILLS_HOST}david/skills`, { folder: "skills", follow: { kind: "pinned", commit: old } });

    const unpinned = await setFollow(client, source.id, { kind: "branch", branch: "release/2" });
    expect(unpinned.source).toMatchObject({ follow: { kind: "branch", branch: "release/2" }, commit: old });
    await vi.waitFor(async () => expect((await view(client)).sources[0]).toMatchObject({ follow: { kind: "branch", branch: "release/2" }, commit: release }), { timeout: WAIT_MS });
    const stream = t.env.log.readStream({ kind: "skills", id: t.env.id });
    expect(stream.slice(-2).map((event) => [event.type, event.actor])).toEqual([
      ["skills.source-follow-set", expect.stringMatching(/^client_session:/)],
      ["skills.source-synced", "system:skill-sync"],
    ]);
  });
});

describe("the snapshots' sweep", () => {
  it("deletes hourly a snapshot no source holds current and no generation uses, and keeps one a live process's generation links into until the process stops", async () => {
    const forge = skillRepositories(tempDir);
    const first = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "First.") });
    const { t, client } = await start(forge, { adapter: fakeAdapter({ commands: [] }), processIdleMinutes: () => 24 * 60 });
    const source = await add(client, `${SKILLS_HOST}david/skills`, { folder: "skills" });
    const { id } = await create(client);
    await runIn(t, client, id);
    const second = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "Second.") });
    await pull(client, source.id);
    const third = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "Third.") });
    await pull(client, source.id);
    // The session's next set links the third; its live process still runs on the generation linking the first.
    await client.request("commands.list", { sessionId: id });
    expect(snapshotsOf(t, source.id)).toEqual([first, second, third].sort());

    // Two hourly sweeps: the first keeps what was made or read since the one at start, the second what a source or a generation keeps.
    t.clock.advance(HOUR);
    t.clock.advance(HOUR);
    await vi.waitFor(() => expect(snapshotsOf(t, source.id)).toEqual([first, third].sort()), { timeout: WAIT_MS });

    await client.request("providers.processes.stop", { commandId: randomUUID(), sessionId: id });
    await vi.waitFor(() => expect(t.adapter.processesOf(id)[0]?.stopped).toBe(true), { timeout: WAIT_MS });
    t.clock.advance(HOUR);
    await vi.waitFor(() => expect(snapshotsOf(t, source.id)).toEqual([third]), { timeout: WAIT_MS });
    await runIn(t, client, id);
    expect(descriptions(t)).toEqual({ tdd: "Third." });
  });

  it("deletes at start what a start before this one left that no source holds current: a snapshot left behind by a sync, and an export cut part-way", async () => {
    const forge = skillRepositories(tempDir);
    const first = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd") });
    const { t, client } = await start(forge, { dataDir: join(tempDir(), "data") });
    const source = await add(client, `${SKILLS_HOST}david/skills`, { folder: "skills" });
    const second = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "Second.") });
    await pull(client, source.id);
    const cut = join(t.dataDir, "skills", "snapshots", source.id, ".building-cut");
    mkdirSync(cut);
    writeFileSync(join(cut, "SKILL.md"), "---\nname: tdd\n");
    expect(snapshotsOf(t, source.id)).toEqual([".building-cut", first, second].sort());

    const again = await restartAfter(t, MINUTE, (options) => start(forge, options));
    await vi.waitFor(() => expect(snapshotsOf(again.t, source.id)).toEqual([second]), { timeout: WAIT_MS });
    expect((await view(again.client)).sources[0]).toMatchObject({ commit: second });
  });
});

describe("a sync cut by a drain", () => {
  it("records nothing and leaves no partial snapshot current, and the next start syncs the source again", async () => {
    const forge = skillRepositories(tempDir);
    const before = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "Before.") });
    const dataDir = join(tempDir(), "data");
    const first = await start(forge, { dataDir });
    const source = await add(first.client, `${SKILLS_HOST}david/skills`, { folder: "skills" });
    const after = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd", "After.") });

    // The drain comes while the start's fetch is in flight, and is never let go.
    const git = skillsGit();
    git.hold();
    const cutShort = await restartAfter(first.t, MINUTE, (options) => start(forge, { ...options, skillsGit: git.wrap }));
    await vi.waitFor(() => expect(git.requests).toHaveLength(1), { timeout: WAIT_MS });
    const events = skillsEvents(cutShort.t);
    // With no run to wait for, the drain takes its one turn on the clock and closes the environment.
    const drained = cutShort.t.env.drain("command");
    cutShort.t.clock.advance(0);
    expect(await drained).toMatchObject({ endedBy: "runs-finished" });
    // What an export the drain cut part-way would have left.
    const partial = join(dataDir, "skills", "snapshots", source.id, ".building-cut");
    mkdirSync(partial);
    writeFileSync(join(partial, "SKILL.md"), "---\nname: tdd\n");

    const next = await start(forge, { dataDir, clock: cutShort.t.clock });
    const current = (await view(next.client)).sources[0];
    expect([before, after]).toContain(current?.commit);
    await vi.waitFor(async () => expect((await view(next.client)).sources[0]).toMatchObject({ commit: after, sync: { outcome: "ok" } }), { timeout: WAIT_MS });
    await vi.waitFor(() => expect(existsSync(partial)).toBe(false), { timeout: WAIT_MS });
    expect(skillsEvents(next.t)).toEqual([...events, ["skills.source-synced", { sourceId: source.id, outcome: "ok", commit: after, members: [{ name: "tdd", path: "tdd", description: "After.", invocation: "model+slash", problems: [] }] }]]);
  });
});
