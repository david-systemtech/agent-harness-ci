import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registry, type EventFrame, type SkillMember, type SkillSetMember, type SkillsView } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, refusal } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { TRASH_KEPT_MS, TRASH_SWEEP_INTERVAL_MS } from "../serve/trash.js";

/**
 * The reader and the own directory through the primary seam (skills spec,
 * "The skill set" and "The own directory and Carry over"; ADR 0018, ADR
 * 0029): an in-process environment on a temporary data directory, driven by
 * a real client, with skill folders written into the own directory as David
 * writes them by hand. `skills.get` names the own directory and answers the
 * set with every member's layer and whatever shadows it.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<{ t: TestEnvironment; client: WireClient }> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};

const get = async (client: WireClient, params: { sessionId?: string } = {}): Promise<SkillsView> =>
  registry["skills.get"].result.parse(await client.request("skills.get", params));

/** Sends `skills.own.create` and answers what its response carries. */
const createSkill = async (client: WireClient, name: string, description = "Test-driven development.", commandId = randomUUID()) =>
  registry["skills.own.create"].response.parse(await client.request("skills.own.create", { commandId, name, description }));

/** Sends `skills.own.remove` and answers what its response carries. */
const removeSkill = async (client: WireClient, name: string, commandId = randomUUID()) =>
  registry["skills.own.remove"].response.parse(await client.request("skills.own.remove", { commandId, name }));

/** The `skills.updated` notices on the environment's stream, in order. */
const notices = (t: TestEnvironment): EventEnvelope[] => t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "skills.updated");

/** Everything the data directory's trash holds, entry by entry. */
const trashed = (t: TestEnvironment): string[] => {
  const root = join(t.dataDir, "trash");
  return existsSync(root) ? readdirSync(root).flatMap((entry) => readdirSync(join(root, entry)).map((name) => `${entry}/${name}`)) : [];
};

/** Writes `text` at `path`, making its folders. */
const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A `SKILL.md`'s text: `frontmatter` between the fences, then `body`. */
const skill = (frontmatter: string, body = "Write the failing test first.\n"): string => `---\n${frontmatter}\n---\n${body}`;

/** The members `skills.get` lists, by their path in the own directory. */
const byPath = (view: SkillsView): Record<string, SkillSetMember> => Object.fromEntries(view.members.map((member) => [member.path, member]));

describe("the own directory", () => {
  it("lies under the data directory with skills/ and commands/, made at start, and skills.get names it with no sources, choices or members yet, for the default account", async () => {
    const { t, client } = await start();
    const view = await get(client);
    expect(view).toEqual({ ownDirectory: join(t.dataDir, "skills", "own"), sources: [], choices: [], accountId: "claude-max", members: [] });
    expect(statSync(join(view.ownDirectory, "skills")).isDirectory()).toBe(true);
    expect(statSync(join(view.ownDirectory, "commands")).isDirectory()).toBe(true);
  });
});

describe("the reader", () => {
  it("reads each folder of skills/ holding SKILL.md as one member: its name, description, invocation, user-invocable flag, body size and approximate tokens, and the keys that act while it is active", async () => {
    const { client } = await start();
    const own = (await get(client)).ownDirectory;
    write(join(own, "skills", "tdd", "SKILL.md"), skill("name: tdd\ndescription: Test-driven development.", "Red, then green.\n"));
    write(join(own, "skills", "tdd", "scripts", "run.sh"), "#!/bin/sh\n");
    write(join(own, "skills", "handoff", "SKILL.md"), skill("name: handoff\ndescription: >\n  Hand the conversation off\n  to a fresh agent.\ndisable-model-invocation: true\nuser-invocable: false", "x".repeat(4210)));
    write(join(own, "skills", "guarded", "SKILL.md"), skill("name: guarded\ndescription: Runs a check.\nallowed-tools: Bash(git status:*)\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh"));
    const members = byPath(await get(client));
    expect(Object.keys(members)).toEqual(["skills/guarded", "skills/handoff", "skills/tdd"]);
    expect(members["skills/tdd"]).toEqual({
      name: "tdd",
      kind: "skill",
      path: "skills/tdd",
      description: "Test-driven development.",
      invocation: "model+slash",
      userInvocable: true,
      whileActive: [],
      origin: null,
      layer: { kind: "own" },
      size: "Red, then green.".length,
      tokens: 4,
      problems: [],
      warnings: [],
      shadowedBy: null,
    });
    expect(members["skills/handoff"]).toMatchObject({
      description: "Hand the conversation off to a fresh agent.",
      invocation: "slash-only",
      userInvocable: false,
      size: 4210,
      tokens: 1053,
    });
    expect(members["skills/guarded"]).toMatchObject({ whileActive: ["hooks", "allowed-tools"], problems: [] });
  });

  it("lists an invalid member with its problem and leaves it out of the set, and warns of a name unlike its folder", async () => {
    const { client } = await start();
    const own = (await get(client)).ownDirectory;
    write(join(own, "skills", "undescribed", "SKILL.md"), skill("name: undescribed"));
    write(join(own, "skills", "Bad_Name", "SKILL.md"), skill("description: A folder the rule refuses."));
    write(join(own, "skills", "broken", "SKILL.md"), skill("name: [broken\ndescription: x"));
    write(join(own, "skills", "tdd", "SKILL.md"), skill("name: test-driven\ndescription: Test-driven development."));
    const view = await get(client);
    const members = byPath(view);
    expect(members["skills/undescribed"]).toMatchObject({ name: "undescribed", description: null, problems: [{ kind: "description" }], shadowedBy: null });
    expect(members["skills/Bad_Name"]).toMatchObject({ name: null, problems: [{ kind: "name", message: expect.stringContaining("Bad_Name") }] });
    expect(members["skills/broken"]).toMatchObject({ name: "broken", problems: [{ kind: "frontmatter" }] });
    expect(members["skills/tdd"]).toMatchObject({ name: "test-driven", problems: [], warnings: [{ kind: "name-unlike-folder" }] });
    // Named members by name, those without a name last.
    expect(view.members.map((member) => member.path)).toEqual(["skills/broken", "skills/tdd", "skills/undescribed", "skills/Bad_Name"]);
  });

  it("reads no grandchild, and follows no link leading out of the tree, while a link inside it is followed", async () => {
    const { client } = await start();
    const own = (await get(client)).ownDirectory;
    write(join(own, "skills", "writing", "beats", "SKILL.md"), skill("name: beats\ndescription: Writing, exploit."));
    const outside = tempDir();
    write(join(outside, "escaped", "SKILL.md"), skill("name: escaped\ndescription: Lies outside the own directory."));
    symlinkSync(join(outside, "escaped"), join(own, "skills", "escaped"));
    write(join(own, "skills", "linked-file", "notes.md"), "notes\n");
    symlinkSync(join(outside, "escaped", "SKILL.md"), join(own, "skills", "linked-file", "SKILL.md"));
    write(join(own, "skills", "tdd", "SKILL.md"), skill("name: tdd\ndescription: Test-driven development."));
    symlinkSync(join(own, "skills", "tdd"), join(own, "skills", "alias"));
    const members = byPath(await get(client));
    expect(Object.keys(members).sort()).toEqual(["skills/alias", "skills/tdd"]);
    // Two folders holding one name in one layer: the one named for it wins.
    expect(members["skills/tdd"]).toMatchObject({ shadowedBy: null });
    expect(members["skills/alias"]).toMatchObject({ name: "tdd", warnings: [{ kind: "name-unlike-folder" }], shadowedBy: { layer: { kind: "own" }, path: "skills/tdd" } });
  });

  it("treats skills/ as one member when it holds SKILL.md itself, and then reads none of its children (the root-skill rule)", async () => {
    const { client } = await start();
    const own = (await get(client)).ownDirectory;
    write(join(own, "skills", "tdd", "SKILL.md"), skill("name: tdd\ndescription: Test-driven development."));
    write(join(own, "skills", "SKILL.md"), skill("description: A folder that is itself one skill."));
    expect((await get(client)).members).toEqual([expect.objectContaining({ name: "skills", path: "skills", kind: "skill", problems: [] })]);
  });

  it("reads each Markdown file of commands/ as a member named by its file and described by its frontmatter, which a skill folder of the same name shadows", async () => {
    const { client } = await start();
    const own = (await get(client)).ownDirectory;
    write(join(own, "commands", "review.md"), skill("name: other\ndescription: Review the branch.\nallowed-tools: Bash(git diff:*)", "Review $ARGUMENTS.\n"));
    write(join(own, "commands", "tdd.md"), skill("description: The command form."));
    write(join(own, "commands", "notes.txt"), "not a command\n");
    write(join(own, "commands", "nested", "deep.md"), skill("description: Too deep."));
    write(join(own, "skills", "tdd", "SKILL.md"), skill("name: tdd\ndescription: Test-driven development."));
    const view = await get(client);
    expect(view.members.map((member) => [member.path, member.shadowedBy])).toEqual([
      ["commands/review.md", null],
      ["skills/tdd", null],
      ["commands/tdd.md", { layer: { kind: "own" }, path: "skills/tdd" }],
    ]);
    expect(byPath(view)["commands/review.md"]).toMatchObject({ name: "review", kind: "command", description: "Review the branch.", whileActive: ["allowed-tools"], size: "Review $ARGUMENTS.".length });
  });

  it("gives each folder a provenance manifest in the own directory's root names its origin: repository, path, commit and licence", async () => {
    const { client } = await start();
    const own = (await get(client)).ownDirectory;
    write(join(own, "skills", "tdd", "SKILL.md"), skill("name: tdd\ndescription: Test-driven development."));
    write(join(own, "skills", "unslop", "SKILL.md"), skill("name: unslop\ndescription: Remove AI writing patterns."));
    write(join(own, "skills", "mine", "SKILL.md"), skill("name: mine\ndescription: Written by hand."));
    write(join(own, "skills", "odd", "SKILL.md"), skill("name: odd\ndescription: Named oddly in the manifest."));
    write(
      join(own, "skills.json"),
      JSON.stringify({
        version: 1,
        skills: {
          tdd: { repo: "mattpocock/skills", path: "skills/engineering/tdd", ref: "HEAD", sha: "c55ee46073ed923f86ce59a5eb3b6d895095d1b7", license: "MIT", digest: "sha256:0", updated: "2026-09-18" },
          unslop: { repo: "https://git.systemtech.dev:5526/David/Unslop.git", sha: "17ed39c" },
          odd: { repo: "not a repository" },
        },
      }),
    );
    const members = byPath(await get(client));
    expect(members["skills/tdd"]?.origin).toEqual({
      kind: "manifest",
      repository: "https://github.com/mattpocock/skills",
      path: "skills/engineering/tdd",
      commit: "c55ee46073ed923f86ce59a5eb3b6d895095d1b7",
      licence: "MIT",
    });
    expect(members["skills/unslop"]?.origin).toEqual({ kind: "manifest", repository: "https://git.systemtech.dev/david/unslop", path: ".", commit: "17ed39c", licence: null });
    expect(members["skills/mine"]?.origin).toBeNull();
    expect(members["skills/odd"]?.origin).toBeNull();
  });
});

describe("skills.get", () => {
  const accounts = [
    { id: "work", provider: "fake", directory: "/nonexistent/accounts/work" },
    { id: "personal", provider: "fake", directory: "/nonexistent/accounts/personal" },
  ];

  it("resolves the set for the session's account, or without a session the default account's", async () => {
    const { client } = await start({ accounts });
    const personal = await create(client, { account: "personal" });
    const unnamed = await create(client);
    expect((await get(client)).accountId).toBe("work");
    expect((await get(client, { sessionId: personal.id })).accountId).toBe("personal");
    expect((await get(client, { sessionId: unnamed.id })).accountId).toBe("work");
  });

  it("refuses a session the environment does not hold not_found, kind session", async () => {
    const { client } = await start();
    const sessionId = randomUUID();
    expect(await refusal(client.request("skills.get", { sessionId }))).toEqual({ code: "not_found", data: { kind: "session", sessionId } });
  });

  it("is open to a read-only client, while the own directory's commands are admin's", async () => {
    const { t } = await start();
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token, clientKind: "program" });
    expect((await get(reader)).members).toEqual([]);
    expect(await refusal(reader.request("skills.own.create", { commandId: randomUUID(), name: "tdd", description: "Test-driven development." }))).toMatchObject({
      code: "forbidden",
      data: { scope: "admin" },
    });
    expect(await refusal(reader.request("skills.own.remove", { commandId: randomUUID(), name: "tdd" }))).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
  });
});

describe("reading the own directory", () => {
  it("raises skills.updated when a skills.get finds it changed since the last read, and not when nothing changed, with no watcher raising it meanwhile", async () => {
    const { t, client } = await start();
    const own = (await get(client)).ownDirectory;
    expect(notices(t)).toEqual([]);
    write(join(own, "skills", "tdd", "SKILL.md"), skill("name: tdd\ndescription: Test-driven development."));
    // Nothing reads the directory until something asks.
    expect(notices(t)).toEqual([]);
    expect((await get(client)).members.map((member) => member.name)).toEqual(["tdd"]);
    expect(notices(t)).toEqual([expect.objectContaining({ streamKind: "environment", streamId: t.env.id, payload: {}, actor: "system:own-skills" })]);
    await get(client);
    expect(notices(t)).toHaveLength(1);
    // An edit to the body changes the member's size, which is a change.
    write(join(own, "skills", "tdd", "SKILL.md"), skill("name: tdd\ndescription: Test-driven development.", "Red, then green, then refactor.\n"));
    await get(client);
    expect(notices(t)).toHaveLength(2);
  });

  it("reads it at each run's start, raising skills.updated on environment.subscribe when the run's read finds it changed", async () => {
    const { t, client } = await start();
    const own = (await get(client)).ownDirectory;
    const session = await create(client);
    const watcher = await t.client();
    const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    await watcher.next((frame) => frame.type === "synchronized" && "subscription" in frame && frame.subscription === subscription);
    write(join(own, "commands", "review.md"), skill("description: Review the branch."));

    await client.request("runs.start", { commandId: randomUUID(), sessionId: session.id, text: "Review this branch" });
    const frame = await watcher.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "skills.updated");
    expect(frame.event).toMatchObject({ streamKind: "environment", type: "skills.updated", payload: {} });
    // The read the run made is the last: asking again finds nothing new.
    expect((await get(client)).members.map((member) => member.path)).toEqual(["commands/review.md"]);
    expect(notices(t)).toHaveLength(1);
  });
});

describe("skills.own.create", () => {
  it("writes a folder with a minimal SKILL.md, answers the member as read, and raises skills.updated with its receipt", async () => {
    const { t, client } = await start();
    const own = (await get(client)).ownDirectory;
    const commandId = randomUUID();
    const answer = await createSkill(client, "tdd", "Test-driven development: red, then green.", commandId);
    const member: SkillMember = {
      name: "tdd",
      kind: "skill",
      path: "skills/tdd",
      description: "Test-driven development: red, then green.",
      invocation: "model+slash",
      userInvocable: true,
      whileActive: [],
      origin: null,
      layer: { kind: "own" },
      size: "# tdd".length,
      tokens: 2,
      problems: [],
      warnings: [],
    };
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { member } });
    expect(readFileSync(join(own, "skills", "tdd", "SKILL.md"), "utf8")).toBe('---\nname: "tdd"\ndescription: "Test-driven development: red, then green."\n---\n\n# tdd\n');
    expect(notices(t)).toEqual([expect.objectContaining({ commandId, actor: `client_session:${client.hello.clientSessionId}` })]);
    expect((await get(client)).members).toEqual([{ ...member, shadowedBy: null }]);
    // The create's own notice stands for the change: the read after it finds nothing new.
    expect(notices(t)).toHaveLength(1);
  });

  it("writes a name YAML would read as another type, and a description with quotes, colons and a line break, so both read back as written", async () => {
    const { client } = await start();
    for (const name of ["null", "7", "true"]) expect((await createSkill(client, name)).result?.member.name).toBe(name);
    const description = 'Review: "the branch"\nand say what broke.';
    expect((await createSkill(client, "review", description)).result?.member).toMatchObject({ name: "review", description, problems: [], warnings: [] });
  });

  it("refuses a name failing the rule invalid_params, and one the own directory holds as a folder, a command file or a member's name conflict, writing nothing", async () => {
    const { t, client } = await start();
    const own = (await get(client)).ownDirectory;
    expect(await refusal(client.request("skills.own.create", { commandId: randomUUID(), name: "Test_Driven", description: "x" }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["name"], params: { rule: "skill-name", reason: "character" } })] },
    });
    write(join(own, "skills", "notes", "draft.md"), "not a skill yet\n");
    write(join(own, "commands", "review.md"), skill("description: Review the branch."));
    write(join(own, "skills", "tdd", "SKILL.md"), skill("name: test-driven\ndescription: Test-driven development."));
    await createSkill(client, "grill");
    const head = t.env.log.head();
    for (const name of ["notes", "review", "test-driven", "grill"]) {
      const answer = await createSkill(client, name);
      expect(answer.receipt, name).toMatchObject({ status: "rejected", reason: "conflict", error: { code: "conflict", data: { reason: "exists", name } } });
    }
    expect(readdirSync(join(own, "skills")).sort()).toEqual(["grill", "notes", "tdd"]);
    expect(t.env.log.readStream({ kind: "environment", id: t.env.id }, head).map((event) => event.type)).toEqual([]);
  });

  it("refuses conflict, reason root_skill, while skills/ holds a SKILL.md itself, since no folder in it would be read", async () => {
    const { client } = await start();
    const own = (await get(client)).ownDirectory;
    write(join(own, "skills", "SKILL.md"), skill("description: A folder that is itself one skill."));
    expect((await createSkill(client, "tdd")).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "root_skill" } } });
    expect(readdirSync(join(own, "skills"))).toEqual(["SKILL.md"]);
  });

  it("answers a retry of the same command its first receipt, writing once", async () => {
    const { t, client } = await start();
    const commandId = randomUUID();
    const first = await createSkill(client, "tdd", "Test-driven development.", commandId);
    expect(await createSkill(client, "tdd", "Test-driven development.", commandId)).toEqual({ receipt: first.receipt });
    expect(notices(t)).toHaveLength(1);
  });
});

describe("skills.own.remove", () => {
  it("moves the member's folder to the data directory's trash, raising skills.updated with its receipt, and a same-named command it shadowed takes its place", async () => {
    const { t, client } = await start();
    const own = (await get(client)).ownDirectory;
    await createSkill(client, "tdd");
    write(join(own, "skills", "tdd", "scripts", "run.sh"), "#!/bin/sh\n");
    write(join(own, "commands", "tdd.md"), skill("description: The command form."));
    const [created] = (await get(client)).members;
    const commandId = randomUUID();

    const answer = await removeSkill(client, "tdd", commandId);
    expect(answer.result?.member).toEqual({ ...created, shadowedBy: undefined });
    expect(existsSync(join(own, "skills", "tdd"))).toBe(false);
    expect(trashed(t)).toEqual([expect.stringMatching(/^\d+-[0-9a-f-]+\/tdd$/)]);
    const [entry] = trashed(t);
    expect(readFileSync(join(t.dataDir, "trash", entry as string, "scripts", "run.sh"), "utf8")).toBe("#!/bin/sh\n");
    expect(notices(t).at(-1)).toMatchObject({ commandId });
    expect((await get(client)).members).toEqual([expect.objectContaining({ name: "tdd", kind: "command", path: "commands/tdd.md", shadowedBy: null })]);

    await removeSkill(client, "tdd");
    expect(existsSync(join(own, "commands", "tdd.md"))).toBe(false);
    expect((await get(client)).members).toEqual([]);
    expect(trashed(t)).toHaveLength(2);
  });

  it("removes by the member's name, else by its folder's", async () => {
    const { client } = await start();
    const own = (await get(client)).ownDirectory;
    write(join(own, "skills", "tdd", "SKILL.md"), skill("name: test-driven\ndescription: Test-driven development."));
    write(join(own, "skills", "undescribed", "SKILL.md"), skill("name: notes"));
    expect((await removeSkill(client, "test-driven")).result?.member).toMatchObject({ name: "test-driven", path: "skills/tdd" });
    expect((await removeSkill(client, "undescribed")).result?.member).toMatchObject({ name: "notes", path: "skills/undescribed", problems: [{ kind: "description" }] });
    expect((await get(client)).members).toEqual([]);
  });

  it("refuses a name the own directory does not hold not_found, kind skill, and moves nothing", async () => {
    const { t, client } = await start();
    const answer = await removeSkill(client, "tdd");
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { code: "not_found", data: { kind: "skill", name: "tdd" } } });
    expect(trashed(t)).toEqual([]);
  });

  it("leaves what it trashed for thirty days, and the hourly sweep deletes it once it is thirty days old", async () => {
    const { t, client } = await start();
    await createSkill(client, "tdd");
    await removeSkill(client, "tdd");
    expect(trashed(t)).toHaveLength(1);
    // The first hourly sweep once it is thirty days old deletes it (what a sweep before keeps is the trash's own suite's).
    t.clock.advance(TRASH_KEPT_MS - TRASH_SWEEP_INTERVAL_MS);
    t.clock.advance(TRASH_SWEEP_INTERVAL_MS);
    await vi.waitFor(() => expect(trashed(t)).toEqual([]), { timeout: WAIT_MS, interval: 20 });
  });
});
