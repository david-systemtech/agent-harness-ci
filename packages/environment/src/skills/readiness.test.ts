import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registry, type ParamsOf, type SkillReadiness } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { scriptedKeyManagers } from "../../test/key-managers.js";
import { create, refusal } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";
import type { ToolServerFactory, ToolServerScope } from "../adapter/seams.js";

/**
 * Readiness through the primary seam (skills spec, "Readiness"; ADR 0009):
 * an in-process environment whose own directory holds the skills, some
 * vendored from the Pocock set with a provenance manifest naming where they
 * came from, some declaring their checks in a sidecar; fixture workspaces
 * for each kind passing and failing (a PATH the test sets for `tool`, a
 * repository mid-merge, a branch ahead of main); and the fake adapter's
 * descriptor for `provider`. `skills.readiness` answers each member ready,
 * setup-needed or unsupported, and keeps its answers sixty seconds.
 */

const { onCleanup, tempDir } = useCleanups();

const SETUP = "/setup-matt-pocock-skills";

/** The key-manager connection the secret checks' references name. */
const CONNECTION = "c0ffee00-0000-4000-8000-000000000001";

/** What the scripted key manager answers for a reference that resolves: nothing a secret scanner takes for a real one. */
const SECRET_VALUE = "value-for-tests";

const start = async (options: TestEnvironmentOptions = {}): Promise<{ t: TestEnvironment; client: WireClient }> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};

/** A fake forge, closed after the test. */
const fakeForge = async (): Promise<FakeForge> => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  return forge;
};

/** Writes `text` at `path`, making its folders. */
const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** The own directory's folder of skills. */
const ownSkills = (t: TestEnvironment): string => join(t.dataDir, "skills", "own", "skills");

/** Writes the own directory's skill `name`, its frontmatter given more lines when asked. */
const ownSkill = (t: TestEnvironment, name: string, frontmatter = ""): string => {
  const folder = join(ownSkills(t), name);
  write(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill.\n${frontmatter}---\nDo the thing.\n`);
  return folder;
};

/** Writes the own directory's skill `name` with a sidecar declaring `checks`. */
const declaring = (t: TestEnvironment, name: string, checks: readonly unknown[]): void => {
  write(join(ownSkill(t, name), "agents", "agent-harness.yaml"), stringify({ version: 1, checks }));
};

/** Vendors copies of the Pocock skills into the own directory, each at its folder upstream, as a provenance manifest names it. */
const vendored = (t: TestEnvironment, paths: Readonly<Record<string, string>>): void => {
  const skills: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(paths)) {
    ownSkill(t, name);
    skills[name] = { repo: "mattpocock/skills", path, sha: "74ca5fe", license: "MIT" };
  }
  write(join(t.dataDir, "skills", "own", "skills.json"), JSON.stringify({ version: 1, skills }));
};

type Params = ParamsOf<"skills.readiness">;

const readiness = async (client: WireClient, params: Params): Promise<SkillReadiness[]> =>
  registry["skills.readiness"].result.parse(await client.request("skills.readiness", params)).skills;

/** The params for the members `names` of a new session of `claude-max` in the directory `path`. */
const at = (path: string, names?: readonly string[], refresh?: boolean): Params => ({
  accountId: "claude-max",
  workspace: { kind: "directory", path },
  ...(names !== undefined && { names: [...names] }),
  ...(refresh !== undefined && { refresh }),
});

/** The one member `name`'s readiness in `path`, read again. */
const one = async (client: WireClient, path: string, name: string): Promise<SkillReadiness> => {
  const [answer] = await readiness(client, at(path, [name], true));
  if (answer === undefined) throw new Error(`skills.readiness answered nothing for ${name}.`);
  return answer;
};

/** How a member's failing checks failed, each as its outcome and message. */
const failures = (answer: SkillReadiness): [string, string][] => (answer.state === "ready" ? [] : answer.failing.map((failure) => [failure.outcome, failure.message]));

/** A repository with one commit on main, and the test user's identity. */
const repository = (): string => {
  const root = tempDir();
  git(root, "init", "--quiet");
  write(join(root, "README.md"), "# A repository\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "first");
  return root;
};

/** Commits `file` holding `text` in `root`. */
const commit = (root: string, file: string, text: string): void => {
  write(join(root, file), text);
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", `add ${file}`);
};

describe("skills.readiness", () => {
  it("answers ready for a member that declares nothing, and leaves out a name not in the set", async () => {
    const { t, client } = await start();
    ownSkill(t, "notes");

    expect(await readiness(client, at(tempDir(), ["notes", "absent"]))).toEqual([{ name: "notes", state: "ready", declaredBy: null }]);
  });

  it("matches a vendored Pocock copy to the overlay through its provenance manifest: setup-needed with every failing check and the first one's why and fix, then the Forges step once the files are there, then ready", async () => {
    const { t, client } = await start();
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    forge.repositories(TOKEN, []);
    vendored(t, { "to-spec": "skills/engineering/to-spec", tdd: "skills/engineering/tdd", "codebase-design": "skills/engineering/codebase-design" });
    const workspace = repository();
    git(workspace, "remote", "add", "origin", `${forge.origin}/david/agent-harness.git`);

    const before = await one(client, workspace, "to-spec");
    expect(before).toMatchObject({ name: "to-spec", state: "setup-needed", declaredBy: "overlay", fix: SETUP });
    expect(before.state !== "ready" && before.why).toMatch(/docs\/agents\/issue-tracker\.md/);
    expect(before.state !== "ready" && before.failing.map((failure) => failure.check)).toEqual([
      expect.objectContaining({ kind: "file", paths: ["docs/agents/issue-tracker.md"] }),
      expect.objectContaining({ kind: "file", paths: ["CLAUDE.md", "AGENTS.md"], headings: ["Agent skills"] }),
      expect.objectContaining({ kind: "git", condition: "forge-account", fix: "forges" }),
    ]);
    expect(failures(before)).toEqual([
      ["failed", "docs/agents/issue-tracker.md is not in the repository."],
      ["failed", 'No CLAUDE.md or AGENTS.md in the repository holds the heading "Agent skills" with content under it.'],
      ["failed", `No forge account on this environment serves ${forge.origin}, where the repository's remote is.`],
    ]);
    // tdd's callee is in the set; the overlay has nothing for codebase-design.
    expect(await readiness(client, at(workspace, ["tdd", "codebase-design"]))).toEqual([
      { name: "codebase-design", state: "ready", declaredBy: null },
      { name: "tdd", state: "ready", declaredBy: "overlay" },
    ]);

    write(join(workspace, "docs", "agents", "issue-tracker.md"), "Issues live on the forge.\n");
    write(join(workspace, "AGENTS.md"), "# The repository\n\n## Agent skills\n\n### Issue tracker\n\nSee docs/agents/issue-tracker.md.\n");
    const files = await one(client, workspace, "to-spec");
    expect(files).toMatchObject({ state: "setup-needed", fix: "forges" });
    expect(files.state !== "ready" && files.why).toMatch(/forge account/);
    await added(client, { url: forge.origin, kind: "forgejo" });
    expect(await one(client, workspace, "to-spec")).toEqual({ name: "to-spec", state: "ready", declaredBy: "overlay" });
  });

  it("lets a valid sidecar win whole over the overlay, and shows an invalid one as a warning in skills.get that counts as none", async () => {
    const { t, client } = await start();
    vendored(t, { "to-spec": "skills/engineering/to-spec", triage: "skills/engineering/triage" });
    write(join(ownSkills(t), "to-spec", "agents", "agent-harness.yaml"), stringify({ version: 1, checks: [{ kind: "git", condition: "repository", why: "It works in a repository." }] }));
    write(join(ownSkills(t), "triage", "agents", "agent-harness.yaml"), "version: 1\nchecks:\n  - kind: file\n    path: [docs/agents/issue-tracker.md]\n");
    const workspace = tempDir();

    // The sidecar's one check, not the overlay's two.
    const toSpec = await one(client, workspace, "to-spec");
    expect(toSpec).toMatchObject({ state: "setup-needed", declaredBy: "sidecar", why: "It works in a repository.", fix: null });
    expect(failures(toSpec)).toEqual([["failed", "The workspace is not in a git repository."]]);
    expect(await one(client, repository(), "to-spec")).toEqual({ name: "to-spec", state: "ready", declaredBy: "sidecar" });

    const triage = await one(client, workspace, "triage");
    expect(triage).toMatchObject({ state: "setup-needed", declaredBy: "overlay", fix: SETUP });
    const view = registry["skills.get"].result.parse(await client.request("skills.get", {}));
    expect(view.members.find((member) => member.name === "triage")?.warnings).toEqual([
      { kind: "sidecar-invalid", message: expect.stringMatching(/^Its readiness sidecar, agents\/agent-harness\.yaml, is not a readiness declaration at checks\.0\.paths: .*so it counts as none\.$/) },
    ]);
    expect(view.members.find((member) => member.name === "to-spec")?.warnings).toEqual([]);
  });

  it("reads a file check's paths from the repository's root, else the workspace, and wants each heading with content under it", async () => {
    const { t, client } = await start();
    declaring(t, "readme", [{ kind: "file", paths: ["README.md"] }]);
    declaring(t, "local", [{ kind: "file", paths: ["local.md"] }]);
    declaring(t, "headed", [{ kind: "file", paths: ["CLAUDE.md", "AGENTS.md"], headings: ["Agent skills", "Domain docs"] }]);
    const root = repository();
    const nested = join(root, "packages", "app");
    write(join(nested, "local.md"), "Only in the package.\n");

    // In a repository, from its root: the root's README.md, never the package's own file.
    expect(await one(client, nested, "readme")).toMatchObject({ state: "ready" });
    expect(failures(await one(client, nested, "local"))).toEqual([["failed", "local.md is not in the repository."]]);
    // Outside any, from the workspace.
    expect(await one(client, nested.replace(root, tempDir()), "local")).toMatchObject({ state: "setup-needed" });
    const plain = tempDir();
    write(join(plain, "local.md"), "Here.\n");
    expect(await one(client, plain, "local")).toMatchObject({ state: "ready" });

    // A heading with nothing under it, or only inside a code fence, is not held; a subsection's lines are its parent's content.
    write(join(root, "CLAUDE.md"), "## Agent skills\n\n## Domain docs\n\nOne context.\n");
    expect(failures(await one(client, root, "headed"))).toEqual([["failed", 'No CLAUDE.md or AGENTS.md in the repository holds the headings "Agent skills", "Domain docs" with content under it.']]);
    write(join(root, "CLAUDE.md"), "```markdown\n## Agent skills\n\nText.\n```\n\n## Domain docs\n\nOne context.\n");
    expect(await one(client, root, "headed")).toMatchObject({ state: "setup-needed" });
    write(join(root, "AGENTS.md"), "# Agents\n\n## agent  SKILLS ##\n\n### Issue tracker\n\nOn the forge.\n\n## Domain docs\n\nOne context.\n");
    expect(await one(client, root, "headed")).toEqual({ name: "headed", state: "ready", declaredBy: "sidecar" });
  });

  it("finds a tool check's command on the PATH a run gets, and fails one that is not there", async () => {
    const bin = tempDir();
    write(join(bin, "gh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "gh"), 0o755);
    const { t, client } = await start({ managedTools: { hostEnv: { PATH: bin } } });
    declaring(t, "forge", [{ kind: "tool", command: "gh" }]);
    declaring(t, "gitlab", [{ kind: "tool", command: "glab", fix: "forges" }]);
    const workspace = tempDir();

    expect(await one(client, workspace, "forge")).toMatchObject({ state: "ready" });
    const gitlab = await one(client, workspace, "gitlab");
    expect(gitlab).toMatchObject({ state: "setup-needed", why: null, fix: "forges" });
    expect(failures(gitlab)).toEqual([["failed", "glab is not on the PATH a run on this environment gets."]]);
  });

  it("checks git's repository, merge-in-progress and changes-since, the last from the merge base with the default branch or the ref named", async () => {
    const { t, client } = await start();
    declaring(t, "in-repository", [{ kind: "git", condition: "repository" }]);
    declaring(t, "merging", [{ kind: "git", condition: "merge-in-progress" }]);
    declaring(t, "reviewing", [{ kind: "git", condition: "changes-since" }]);
    declaring(t, "against-topic", [{ kind: "git", condition: "changes-since", ref: "topic" }]);
    const root = repository();
    git(root, "checkout", "--quiet", "-b", "topic");
    commit(root, "topic.md", "On the topic.\n");

    expect(await one(client, root, "in-repository")).toMatchObject({ state: "ready" });
    expect(failures(await one(client, tempDir(), "in-repository"))).toEqual([["failed", "The workspace is not in a git repository."]]);

    // On topic, a commit ahead of main; on main, nothing since its merge base with itself, nor with topic.
    expect(await one(client, root, "reviewing")).toMatchObject({ state: "ready" });
    git(root, "checkout", "--quiet", "main");
    expect(failures(await one(client, root, "reviewing"))).toEqual([["failed", "HEAD holds no changes since its merge base with main."]]);
    expect(failures(await one(client, root, "against-topic"))).toEqual([["failed", "HEAD holds no changes since its merge base with topic."]]);

    expect(failures(await one(client, root, "merging"))).toEqual([["failed", "No merge or rebase is in progress in the repository."]]);
    commit(root, "main.md", "On main.\n");
    git(root, "merge", "--quiet", "--no-ff", "--no-commit", "topic");
    expect(await one(client, root, "merging")).toMatchObject({ state: "ready" });
    // Mid-merge, main holds changes against topic: its own commit.
    expect(await one(client, root, "against-topic")).toMatchObject({ state: "ready" });
  });

  it("passes git's forge-account when a forge account here serves the repository's remote on its origin or a verified alias", async () => {
    const { t, client } = await start();
    const forge = await fakeForge();
    const tailnet = await fakeForge();
    for (const origin of [forge, tailnet]) {
      origin.user(TOKEN, DAVID);
      origin.repositories(TOKEN, []);
    }
    await added(client, { url: forge.origin, kind: "forgejo", aliases: [tailnet.origin] });
    declaring(t, "tracker", [{ kind: "git", condition: "forge-account", fix: "forges" }]);
    /** A repository whose remote `name` is at `url`. */
    const remoteAt = (url: string, name = "origin"): string => {
      const root = repository();
      git(root, "remote", "add", name, url);
      return root;
    };

    expect(await one(client, remoteAt(`${forge.origin}/david/agent-harness.git`), "tracker")).toMatchObject({ state: "ready" });
    expect(await one(client, remoteAt(`${tailnet.origin}/david/agent-harness`), "tracker")).toMatchObject({ state: "ready" });
    // The remote a repository's identity comes from: origin, else the only one.
    expect(await one(client, remoteAt(`${forge.origin}/david/agent-harness.git`, "upstream"), "tracker")).toMatchObject({ state: "ready" });

    const elsewhere = await one(client, remoteAt("https://forge.example.invalid/david/agent-harness.git"), "tracker");
    expect(elsewhere).toMatchObject({ state: "setup-needed", why: null, fix: "forges" });
    expect(failures(elsewhere)).toEqual([["failed", "No forge account on this environment serves https://forge.example.invalid, where the repository's remote is."]]);
    expect(failures(await one(client, remoteAt(tempDir()), "tracker"))).toEqual([["failed", "The repository's remote is a local path or a URL that names no forge."]]);
    expect(failures(await one(client, repository(), "tracker"))).toEqual([["failed", "The repository has no remote, so no forge account serves it."]]);
    expect(failures(await one(client, tempDir(), "tracker"))).toEqual([["failed", "The workspace is not in a git repository."]]);
  });

  it("checks a skill check's member is in the account's set, on, and one the model may call unless the check says otherwise", async () => {
    const { t, client } = await start();
    ownSkill(t, "grilling");
    ownSkill(t, "to-spec", "disable-model-invocation: true\n");
    declaring(t, "calls-grilling", [{ kind: "skill", name: "grilling" }]);
    declaring(t, "calls-to-spec", [{ kind: "skill", name: "to-spec" }]);
    declaring(t, "types-to-spec", [{ kind: "skill", name: "to-spec", modelInvocable: false }]);
    declaring(t, "calls-absent", [{ kind: "skill", name: "absent", fix: "skills" }]);
    const workspace = tempDir();

    expect(await one(client, workspace, "calls-grilling")).toMatchObject({ state: "ready" });
    expect(failures(await one(client, workspace, "calls-to-spec"))).toEqual([["failed", "to-spec is slash-only: the model cannot call it."]]);
    expect(await one(client, workspace, "types-to-spec")).toMatchObject({ state: "ready" });
    expect(await one(client, workspace, "calls-absent")).toMatchObject({ state: "setup-needed", fix: "skills" });

    await client.request("skills.setEnabled", { commandId: randomUUID(), name: "grilling", accountId: null, enabled: false });
    expect(failures(await one(client, workspace, "calls-grilling"))).toEqual([["failed", "No skill named grilling is in this account's set, or it is switched off."]]);
  });

  it("answers unsupported when a provider check fails, by provider or by a capability the adapter does not declare, with that check's why and fix", async () => {
    const { t, client } = await start();
    declaring(t, "on-fake", [{ kind: "provider", providers: ["claude", "fake"] }]);
    declaring(t, "delegates", [{ kind: "provider", capability: "subagents" }]);
    declaring(t, "claude-only", [
      { kind: "file", paths: ["docs/agents/issue-tracker.md"], why: "It reads the tracker." },
      { kind: "provider", providers: ["claude"], why: "It drives Claude Code's own tools." },
    ]);
    declaring(t, "forks", [{ kind: "provider", providers: ["codex"], capability: "fork" }]);
    const workspace = tempDir();

    expect(await one(client, workspace, "on-fake")).toMatchObject({ state: "ready" });
    expect(await one(client, workspace, "delegates")).toMatchObject({ state: "ready" });
    const claudeOnly = await one(client, workspace, "claude-only");
    expect(claudeOnly).toMatchObject({ state: "unsupported", why: "It drives Claude Code's own tools.", fix: null });
    expect(failures(claudeOnly)).toEqual([
      ["failed", "docs/agents/issue-tracker.md is not in the workspace."],
      ["failed", "This account's provider, fake, is not claude."],
    ]);
    expect(failures(await one(client, workspace, "forks"))).toEqual([["failed", "This account's provider, fake, is not codex, and its adapter does not declare fork."]]);
  });

  it("passes a secret check whose reference resolves, letting the value go at once and showing it nowhere, and fails one that does not, naming the refusal", async () => {
    const keyManagers = scriptedKeyManagers();
    const { t, client } = await start({ keyManagers: keyManagers.registry });
    const resolves = { provider: "doppler", connectionId: CONNECTION, name: "TRACKER_TOKEN" } as const;
    const refused = { provider: "doppler", connectionId: CONNECTION, name: "OTHER_TOKEN" } as const;
    keyManagers.answer(resolves, SECRET_VALUE);
    declaring(t, "tracked", [{ kind: "secret", reference: resolves }]);
    declaring(t, "untracked", [{ kind: "secret", reference: refused, fix: "key-manager" }]);
    const logged = (["log", "info", "warn", "error"] as const).map((method) => vi.spyOn(console, method));
    for (const spy of logged) onCleanup(() => spy.mockRestore());
    const head = t.env.log.head();

    const answers = await readiness(client, at(tempDir(), ["tracked", "untracked"], true));
    expect(answers).toEqual([
      { name: "tracked", state: "ready", declaredBy: "sidecar" },
      expect.objectContaining({ name: "untracked", state: "setup-needed", why: null, fix: "key-manager" }),
    ]);
    const [, untracked] = answers;
    expect(untracked !== undefined && failures(untracked)).toEqual([
      ["failed", `The key-manager reference OTHER_TOKEN does not resolve (credential_source_unavailable): The key manager answered no value for doppler reference ${CONNECTION}.`],
    ]);
    // The members are checked side by side, so the two resolves come in either order.
    const asked = keyManagers.requests.map((request) => request.reference);
    expect(asked).toHaveLength(2);
    expect(asked).toEqual(expect.arrayContaining([resolves, refused]));
    // Let go at once, and in no answer, event or log.
    expect(keyManagers.outstanding()).toBe(0);
    expect(JSON.stringify(answers)).not.toContain(SECRET_VALUE);
    expect(t.env.log.head()).toBe(head);
    expect(logged.flatMap((spy) => spy.mock.calls).some((call) => JSON.stringify(call).includes(SECRET_VALUE))).toBe(false);
  });

  it("never asks for a secret check's value in the session: the reference is resolved in process, and the session hears nothing", async () => {
    const keyManagers = scriptedKeyManagers();
    const { t, client } = await start({ keyManagers: keyManagers.registry });
    const reference = { provider: "doppler", connectionId: CONNECTION, name: "TRACKER_TOKEN" } as const;
    declaring(t, "tracked", [{ kind: "secret", reference, fix: "key-manager" }]);
    const { id } = await create(client, { workspace: { kind: "directory", path: tempDir() } });
    const head = t.env.log.head();

    expect(await readiness(client, { sessionId: id })).toEqual([expect.objectContaining({ name: "tracked", state: "setup-needed", fix: "key-manager" })]);
    keyManagers.answer(reference, SECRET_VALUE);
    expect(await readiness(client, { sessionId: id, refresh: true })).toEqual([{ name: "tracked", state: "ready", declaredBy: "sidecar" }]);

    expect(keyManagers.requests.map((request) => request.reference)).toEqual([reference, reference]);
    // No run, prompt or message on the session asked anyone for it.
    expect(t.env.log.head()).toBe(head);
    expect(t.adapter.runs).toEqual([]);
  });

  it("passes an mcp check when the tool-server factory gives the session's next run a server of that name, and without a session asks for a new session of the account and workspace", async () => {
    // A repository whose remote gives the session a repository identity, which its next run's servers are asked under (#1022).
    const linearIn = tempDir();
    git(linearIn, "init", "-q");
    git(linearIn, "remote", "add", "origin", "https://github.com/acme/receipts.git");
    const asked: ToolServerScope[] = [];
    const toolServers: ToolServerFactory = (scope) => {
      asked.push(scope);
      return scope.workspace.path === linearIn ? [{ name: "linear", config: {} }] : [];
    };
    const { t, client } = await start({ adapterSeams: { toolServers } });
    declaring(t, "tracker", [{ kind: "mcp", server: "linear", why: "It files issues through the linear tool server." }]);
    // The environment's own servers are the factory's too.
    declaring(t, "browsing", [{ kind: "mcp", server: "browser" }]);
    const { id } = await create(client, { workspace: { kind: "directory", path: linearIn } });
    const head = t.env.log.head();

    expect(await readiness(client, { sessionId: id })).toEqual([
      { name: "browsing", state: "ready", declaredBy: "sidecar" },
      { name: "tracker", state: "ready", declaredBy: "sidecar" },
    ]);
    expect(asked).not.toHaveLength(0);
    for (const scope of asked) {
      expect(scope).toMatchObject({ sessionId: id, accountId: "claude-max", workspace: { kind: "directory", path: linearIn }, repositoryIdentity: "https://github.com/acme/receipts", clientTools: [] });
    }

    asked.length = 0;
    const elsewhere = tempDir();
    const [tracker] = await readiness(client, at(elsewhere, ["tracker"]));
    expect(tracker).toMatchObject({ state: "setup-needed", why: "It files issues through the linear tool server." });
    expect(tracker !== undefined && failures(tracker)).toEqual([["failed", "A new session of this account in this workspace is given no tool server named linear."]]);
    const [newSession] = asked;
    expect(newSession).toMatchObject({ accountId: "claude-max", workspace: { kind: "directory", path: elsewhere }, repositoryIdentity: null, clientTools: [] });
    expect(newSession?.sessionId).not.toBe(id);
    expect(await readiness(client, at(linearIn, ["tracker"]))).toEqual([{ name: "tracker", state: "ready", declaredBy: "sidecar" }]);

    // Asking the factory starts no run and records nothing.
    expect(t.env.log.head()).toBe(head);
    expect(t.adapter.runs).toEqual([]);
  });

  it("keeps a session's answers apart from a new session's and another session's in the same workspace, as an mcp check answers for the session", async () => {
    const given = new Set<string>();
    const toolServers: ToolServerFactory = (scope) => (given.has(scope.sessionId) ? [{ name: "linear", config: {} }] : []);
    const { t, client } = await start({ adapterSeams: { toolServers } });
    declaring(t, "tracker", [{ kind: "mcp", server: "linear" }]);
    const workspace = tempDir();
    const { id } = await create(client, { workspace: { kind: "directory", path: workspace } });
    const { id: other } = await create(client, { workspace: { kind: "directory", path: workspace } });
    given.add(id);
    const tracker = async (params: Params): Promise<SkillReadiness | undefined> => (await readiness(client, { ...params, names: ["tracker"] }))[0];

    const newSession = await tracker(at(workspace));
    expect(newSession !== undefined && failures(newSession)).toEqual([["failed", "A new session of this account in this workspace is given no tool server named linear."]]);
    // Within the sixty seconds, each session is asked for its own.
    expect(await tracker({ sessionId: id })).toEqual({ name: "tracker", state: "ready", declaredBy: "sidecar" });
    const otherSession = await tracker({ sessionId: other });
    expect(otherSession !== undefined && failures(otherSession)).toEqual([["failed", "The session's next run is given no tool server named linear."]]);
    expect((await tracker(at(workspace)))?.state).toBe("setup-needed");
  });

  it("keeps each answer sixty seconds per workspace, account, session and fingerprint: refresh, another workspace or a changed set reads again", async () => {
    const { t, client } = await start();
    declaring(t, "tracked", [{ kind: "file", paths: ["docs/agents/issue-tracker.md"] }]);
    const workspace = tempDir();
    const elsewhere = tempDir();
    const state = async (path: string, refresh?: boolean): Promise<string | undefined> => (await readiness(client, at(path, ["tracked"], refresh)))[0]?.state;

    expect([await state(workspace), await state(elsewhere)]).toEqual(["setup-needed", "setup-needed"]);
    write(join(workspace, "docs", "agents", "issue-tracker.md"), "On the forge.\n");
    write(join(elsewhere, "docs", "agents", "issue-tracker.md"), "On the forge.\n");
    t.clock.advance(59_999);
    expect([await state(workspace), await state(elsewhere)]).toEqual(["setup-needed", "setup-needed"]);
    expect(await state(workspace, true)).toBe("ready");
    expect(await state(elsewhere)).toBe("setup-needed");
    t.clock.advance(1);
    expect(await state(elsewhere)).toBe("ready");

    // A changed set has another fingerprint: what was kept for the set before is not its answer.
    rmSync(join(workspace, "docs", "agents", "issue-tracker.md"));
    expect(await state(workspace)).toBe("ready");
    ownSkill(t, "another");
    expect(await state(workspace)).toBe("setup-needed");
  });

  it("takes a session's account and workspace, and refuses one the environment does not hold", async () => {
    const { t, client } = await start();
    vendored(t, { "resolving-merge-conflicts": "skills/engineering/resolving-merge-conflicts" });
    const root = repository();
    const { id } = await create(client, { workspace: { kind: "directory", path: root } });

    const [answer] = await readiness(client, { sessionId: id });
    expect(answer).toMatchObject({ name: "resolving-merge-conflicts", state: "setup-needed", declaredBy: "overlay" });
    expect(answer !== undefined && failures(answer)).toEqual([["failed", "No merge or rebase is in progress in the repository."]]);
    expect(await refusal(client.request("skills.readiness", { sessionId: randomUUID() }))).toMatchObject({ code: "not_found", data: { kind: "session" } });
    expect(await refusal(client.request("skills.readiness", { accountId: "nobody", workspace: { kind: "directory", path: root } }))).toMatchObject({
      code: "not_found",
      data: { kind: "account" },
    });
  });

  it("never blocks an invocation or changes the set: a member that needs setup is in the run's set and the run goes ahead", async () => {
    const { t, client } = await start();
    vendored(t, { "to-spec": "skills/engineering/to-spec" });
    const workspace = tempDir();
    const { id } = await create(client, { workspace: { kind: "directory", path: workspace } });
    expect(await readiness(client, { sessionId: id })).toEqual([expect.objectContaining({ name: "to-spec", state: "setup-needed" })]);

    const started = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "/to-spec" }));
    const runId = started.result?.runId;
    expect(runId).toBeDefined();
    await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id }).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true), {
      timeout: WAIT_MS,
    });
    expect(t.adapter.lastRun().input.skillSet.members.map((member) => member.name)).toEqual(["to-spec"]);
  });
});
