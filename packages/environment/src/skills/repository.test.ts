import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { SKILLS_HOST, skill, skillRepositories, skillsInsteadOf, testGit, write } from "../../test/skill-repositories.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

const { onCleanup, tempDir } = useCleanups();

const fixture = async (sources?: ReturnType<typeof skillRepositories>) => {
  const root = join(tempDir("repository-skills-"), "repo");
  mkdirSync(root);
  testGit(root, "init", "-q");
  write(join(root, ".agents/skills/root-agent/SKILL.md"), skill("root-agent"));
  write(join(root, ".claude/skills/root-native/SKILL.md"), skill("root-native"));
  write(join(root, "app/.agents/skills/near-agent/SKILL.md"), skill("near-agent"));
  write(join(root, "app/.claude/skills/near-native/SKILL.md"), skill("near-native"));
  const t = await startTestEnvironment({ ...(sources === undefined ? {} : { harnessGitConfig: skillsInsteadOf(sources) }), adapter: fakeAdapter({ capabilities: { nativeSkillRoots: [".claude/skills", ".claude/commands"] } }) });
  onCleanup(() => t.close());
  const client = await t.client();
  const { id } = await create(client, { workspace: { kind: "directory", path: join(root, "app") } });
  return { root, t, client, id };
};

const view = async (client: WireClient, sessionId: string) => registry["skills.get"].result.parse(await client.request("skills.get", { sessionId }));
const trust = async (client: WireClient, sessionId: string, decision: "trusted" | "declined") =>
  registry["trust.decide"].response.parse(await client.request("trust.decide", { commandId: randomUUID(), sessionId, decision }));
const run = async (t: TestEnvironment, client: WireClient, sessionId: string) => {
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Go" }));
  const runId = answer.result?.runId;
  if (runId === undefined) throw new Error("The run was refused.");
  await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).some((e) => e.type === "run.ended" && e.payload["runId"] === runId)).toBe(true), { timeout: WAIT_MS });
  return t.adapter.lastRun().input.skillSet;
};

describe("repository skills behind the trust gate", () => {
  it("admits both roots at each depth only under trust, lists their layer and native flag, and links only the non-native members live", async () => {
    const { root, t, client, id } = await fixture();
    expect((await view(client, id)).members).toEqual([]);
    expect((await run(t, client, id)).members).toEqual([]);
    await trust(client, id, "declined");
    expect((await view(client, id)).members).toEqual([]);
    await trust(client, id, "trusted");
    const members = (await view(client, id)).members;
    expect(members.map((m) => [m.name, m.layer, m.native])).toEqual([
      ["near-agent", { kind: "repository", root: ".agents/skills", directory: "app" }, false],
      ["near-native", { kind: "repository", root: ".claude/skills", directory: "app" }, true],
      ["root-agent", { kind: "repository", root: ".agents/skills", directory: "." }, false],
      ["root-native", { kind: "repository", root: ".claude/skills", directory: "." }, true],
    ]);
    const set = await run(t, client, id);
    expect(set.members.map((m) => [m.name, m.native])).toEqual([["near-agent", false], ["near-native", true], ["root-agent", false], ["root-native", true]]);
    const generation = set.generation as string;
    expect(readdirSync(join(generation, "skills"))).toEqual(["near-agent", "root-agent"]);
    expect(readlinkSync(join(generation, "skills", "near-agent"))).toBe(join(root, "app/.agents/skills/near-agent"));
    expect(readlinkSync(join(generation, "skills", "root-agent"))).toBe(join(root, ".agents/skills/root-agent"));
  });
  it("resolves repository over own over earliest source, each loser naming its shadower, and falls back on revoke and own removal", async () => {
    const sources = skillRepositories(tempDir);
    sources.commit("david/first", { "shared/SKILL.md": skill("shared", "First source.") });
    sources.commit("david/second", { "shared/SKILL.md": skill("shared", "Second source.") });
    const { root, t, client, id } = await fixture(sources);
    for (const repo of ["first", "second"]) {
      await client.request("skills.sources.add", { commandId: randomUUID(), url: `${SKILLS_HOST}david/${repo}`, folder: ".", follow: { kind: "branch", branch: null } });
    }
    await client.request("skills.own.create", { commandId: randomUUID(), name: "shared", description: "Own skill." });
    for (const directory of [".", "app"]) for (const skills of [".agents/skills", ".claude/skills"]) {
      write(join(root, directory, skills, "shared/SKILL.md"), skill("shared", `${directory} ${skills}.`));
    }
    await trust(client, id, "trusted");
    const shared = (await view(client, id)).members.filter((m) => m.name === "shared");
    expect(shared.map((m) => m.description)).toEqual(["app .claude/skills.", ". .claude/skills.", "app .agents/skills.", ". .agents/skills.", "Own skill.", "First source.", "Second source."]);
    expect(shared[0]?.shadowedBy).toBeNull();
    for (const loser of shared.slice(1)) expect(loser.shadowedBy).toEqual({ layer: { kind: "repository", root: ".claude/skills", directory: "app" }, path: "app/.claude/skills/shared" });
    const trusted = await run(t, client, id);
    expect(trusted.members.find((m) => m.name === "shared")).toMatchObject({ description: "app .claude/skills.", native: true });
    const decision = await client.request("trust.get", { sessionId: id });
    await client.request("trust.revoke", { commandId: randomUUID(), key: decision.key });
    const revoked = await run(t, client, id);
    expect(revoked.members.map((m) => m.name)).toEqual(["shared"]);
    expect(revoked.members[0]).toMatchObject({ description: "Own skill.", native: false });
    expect(revoked.fingerprint).not.toBe(trusted.fingerprint);
    expect(t.adapter.processesOf(id)).toHaveLength(2);
    await client.request("skills.own.remove", { commandId: randomUUID(), name: "shared" });
    const fallback = await run(t, client, id);
    expect(fallback.members[0]).toMatchObject({ description: "First source.", native: false });
  });

  it("hides disabled native skills and commands, and fingerprints changes to native membership and hidden names", async () => {
    const { root, t, client, id } = await fixture();
    write(join(root, ".claude/commands/release.md"), skill("release", "Release the project."));
    await trust(client, id, "trusted");
    const first = await run(t, client, id);
    expect(first.members.find((m) => m.name === "release")).toMatchObject({ native: true });
    for (const name of ["root-native", "release"]) await client.request("skills.setEnabled", { commandId: randomUUID(), name, accountId: null, enabled: false });
    const disabled = await run(t, client, id);
    expect(disabled.hiddenNativeNames).toEqual(["release", "root-native"]);
    expect(disabled.members.map((m) => m.name)).toEqual(["near-agent", "near-native", "root-agent"]);
    expect(disabled.fingerprint).not.toBe(first.fingerprint);
    expect((await view(client, id)).members.find((m) => m.name === "release")).toMatchObject({ kind: "command", layer: { kind: "repository", root: ".claude/commands", directory: "." }, native: true, enabled: false });
    write(join(root, ".claude/skills/added/SKILL.md"), skill("added"));
    const added = await run(t, client, id);
    expect(added.fingerprint).not.toBe(disabled.fingerprint);
    expect(added.members.find((m) => m.name === "added")).toMatchObject({ native: true });
    rmSync(join(root, ".claude/skills/added"), { recursive: true });
    rmSync(join(root, ".claude/commands/release.md"));
    const removed = await run(t, client, id);
    expect(removed.hiddenNativeNames).toEqual(["root-native"]);
    expect(removed.members.some((m) => m.name === "added")).toBe(false);
    expect(removed.fingerprint).not.toBe(added.fingerprint);
    const decision = await client.request("trust.get", { sessionId: id });
    await client.request("trust.revoke", { commandId: randomUUID(), key: decision.key });
    expect((await run(t, client, id)).hiddenNativeNames).toEqual([]);
  });

  it("stops at the innermost repository, excludes sibling folders, and preserves a vendored skill's provenance", async () => {
    const { root, client, id } = await fixture();
    write(join(dirname(root), ".agents/skills/outside/SKILL.md"), skill("outside"));
    write(join(root, "sibling/.agents/skills/sibling/SKILL.md"), skill("sibling"));
    write(join(root, ".agents/skills.json"), JSON.stringify({ version: 1, skills: { "root-agent": { repo: "mattpocock/skills", path: "tdd", sha: "abc123", license: "MIT" } } }));
    await trust(client, id, "trusted");
    const members = (await view(client, id)).members;
    expect(members.map((m) => m.name)).toEqual(["near-agent", "near-native", "root-agent", "root-native"]);
    expect(members.find((m) => m.name === "root-agent")?.origin).toEqual({ kind: "manifest", repository: "https://github.com/mattpocock/skills", path: "tdd", commit: "abc123", licence: "MIT" });
    expect((await client.request("skills.get", {})).members).toEqual([]);
  });

  it("includes project commands at the workspace and its parents, with the nearest command winning", async () => {
    const { root, t, client, id } = await fixture();
    write(join(root, ".claude/commands/release.md"), skill("release", "Root release."));
    write(join(root, "app/.claude/commands/release.md"), skill("release", "Near release."));
    await trust(client, id, "trusted");
    const commands = (await view(client, id)).members.filter((m) => m.name === "release");
    expect(commands.map((m) => m.description)).toEqual(["Near release.", "Root release."]);
    expect(commands[1]?.shadowedBy).toEqual({ layer: { kind: "repository", root: ".claude/commands", directory: "app" }, path: "app/.claude/commands/release.md" });
    expect((await run(t, client, id)).members.find((m) => m.name === "release")).toMatchObject({ description: "Near release.", native: true });
  });
});
