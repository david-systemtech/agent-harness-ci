import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registry, type ParamsOf, type SkillsCarryOverReport, type SkillsView } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import type { WireClient } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";

/**
 * Carry over's skills half (skills spec, "The own directory and Carry
 * over"; ADR 0021; #513) through the primary seam: an in-process
 * environment whose preset account, `claude-max`, adopts a fixture
 * directory holding plain skills, an invalid one, a skill folder that is a
 * git checkout at a detached HEAD, a link to a skill folder inside a
 * checkout on a branch, command files, a subagent and a plugin; and a home
 * the test sets, holding `.agents/skills`.
 */

const { onCleanup, tempDir } = useCleanups();

const ACCOUNT = "claude-max";

/** Writes `text` at `path`, making its folders. */
const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A `SKILL.md` or command file: `frontmatter` between the fences, then a body. */
const markdown = (frontmatter: string, body = "Do the thing.\n"): string => `---\n${frontmatter}\n---\n${body}`;

/** A repository at `path` holding what `files` names, committed, with `origin` at `url`. */
const repository = (path: string, url: string, files: Record<string, string>): string => {
  for (const [file, text] of Object.entries(files)) write(join(path, file), text);
  git(path, "init", "-q");
  git(path, "add", ".");
  git(path, "commit", "-q", "-m", "skills");
  git(path, "remote", "add", "origin", url);
  return git(path, "rev-parse", "HEAD").trim();
};

interface Fixture {
  readonly adopted: string;
  readonly home: string;
  /** The commit the detached checkout is at. */
  readonly pinned: string;
}

/** The adopted directory and the home, as the module comment describes them. */
const fixture = (): Fixture => {
  const adopted = join(tempDir(), ".fake");
  const skills = join(adopted, "skills");
  write(join(skills, "tdd", "SKILL.md"), markdown("name: tdd\ndescription: Test-driven development.", "Red, then green.\n"));
  write(join(skills, "tdd", "scripts", "run.sh"), "#!/bin/sh\necho red\n");
  write(join(skills, "notes", "SKILL.md"), markdown("name: notes"));
  write(join(skills, "README.md"), "Not a skill.\n");
  write(
    join(skills, "skills.json"),
    JSON.stringify({
      version: 1,
      skills: {
        tdd: { repo: "mattpocock/skills", path: "skills/engineering/tdd", sha: "74ca5fe", license: "MIT", digest: "kept-as-written" },
        grill: { repo: "mattpocock/skills", path: "skills/productivity/grill-me", sha: "74ca5fe", license: "MIT" },
      },
    }),
  );
  // A skill folder that is itself a clone, its HEAD detached, its origin's URL holding a credential.
  const grill = join(skills, "grill");
  const first = repository(grill, "https://token-for-tests@git.example.com/david/grill.git", { "SKILL.md": markdown("name: grill\ndescription: Grill the plan.") });
  write(join(grill, "SKILL.md"), markdown("name: grill\ndescription: Grill the plan, harder."));
  git(grill, "commit", "-q", "-am", "harder");
  git(grill, "checkout", "-q", "--detach", first);
  // A link to a skill folder two levels into a checkout elsewhere, on a local branch whose upstream is origin's main.
  const elsewhere = tempDir();
  repository(elsewhere, "git@git.example.com:david/agent-skills.git", { "skills/handoff/SKILL.md": markdown("name: handoff\ndescription: Hand the conversation off.") });
  git(elsewhere, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(elsewhere, "checkout", "-q", "-b", "work");
  git(elsewhere, "branch", "-q", "--set-upstream-to=origin/main");
  symlinkSync(join(elsewhere, "skills", "handoff"), join(skills, "linked"));
  write(join(adopted, "commands", "ship.md"), markdown("description: Ship the branch.\nallowed-tools: Bash(git push:*)"));
  write(join(adopted, "commands", "review.md"), markdown("description: Review the diff."));
  write(join(adopted, "commands", "draft.md"), "Draft a reply.\n");
  write(join(adopted, "agents", "reviewer.md"), markdown("name: reviewer\ndescription: Reviews."));
  write(join(adopted, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "skills@mattpocock": [{ scope: "user", version: "1.0.0" }] } }));
  const home = tempDir();
  write(join(home, ".agents", "skills", "unslop", "SKILL.md"), markdown("name: unslop\ndescription: Remove the slop."));
  write(join(home, ".agents", "skills", "tdd", "SKILL.md"), markdown("name: tdd\ndescription: Another test-driven development."));
  return { adopted, home, pinned: first };
};

/** Every entry under `root` by its path from there: a folder, a file's mode and text, or a link's target. */
const tree = (root: string): Record<string, string> => {
  const found: Record<string, string> = {};
  const walk = (relative: string): void => {
    const path = join(root, relative);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) found[relative] = `link ${readlinkSync(path)}`;
    else if (entry.isDirectory()) {
      found[relative] = `folder ${entry.mode.toString(8)}`;
      for (const name of readdirSync(path)) walk(join(relative, name));
    } else found[relative] = `file ${entry.mode.toString(8)} ${readFileSync(path, "base64")}`;
  };
  walk(".");
  return found;
};

const start = async (fixed: Fixture): Promise<{ t: TestEnvironment; client: WireClient }> => {
  const t = await startTestEnvironment({ setupSteps: NO_SETUP_STEPS, adapter: fakeAdapter({ ambientDirectory: fixed.adopted }), carryOverHome: fixed.home });
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};

type CarryOverParams = Omit<ParamsOf<"skills.carryOver">, "commandId">;

/** Sends `skills.carryOver` for the preset account, not dry unless asked, and answers its response. */
const carryOver = async (client: WireClient, params: Partial<CarryOverParams> = {}) =>
  registry["skills.carryOver"].response.parse(await client.request("skills.carryOver", { commandId: randomUUID(), accountId: ACCOUNT, dryRun: false, ...params }));

/** A run's report, which an accepted run answers. */
const reportOf = async (client: WireClient, params: Partial<CarryOverParams> = {}): Promise<SkillsCarryOverReport> => {
  const response = await carryOver(client, params);
  if (response.result === undefined) throw new Error(`skills.carryOver answered no report: ${JSON.stringify(response.receipt)}`);
  return response.result;
};

const get = async (client: WireClient): Promise<SkillsView> => registry["skills.get"].result.parse(await client.request("skills.get", {}));

/** The `skills.updated` notices on the environment's stream. */
const notices = (t: TestEnvironment): number => t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "skills.updated").length;

describe("skills.carryOver", () => {
  it("copies each valid skill folder and command file into the own directory, offers the checkouts as sources, keeps a name already held, reports the invalid with their problems, and lists the subagents and plugins not carried", async () => {
    const fixed = fixture();
    const { t, client } = await start(fixed);
    await client.apply("skills.own.create", { commandId: randomUUID(), name: "review", description: "The own review." });
    const own = (await get(client)).ownDirectory;
    const noticesBefore = notices(t);

    const report = await reportOf(client);

    const skills = join(fixed.adopted, "skills");
    const agents = join(fixed.home, ".agents", "skills");
    const commands = join(fixed.adopted, "commands");
    expect(report).toEqual({
      accountId: ACCOUNT,
      dryRun: false,
      copied: [
        { kind: "skill", name: "tdd", from: join(skills, "tdd"), path: "skills/tdd" },
        { kind: "skill", name: "unslop", from: join(agents, "unslop"), path: "skills/unslop" },
        { kind: "command", name: "ship", from: join(commands, "ship.md"), path: "commands/ship.md" },
      ],
      kept: [
        { kind: "skill", name: "tdd", from: join(agents, "tdd"), path: "skills/tdd" },
        { kind: "command", name: "review", from: join(commands, "review.md"), path: "skills/review" },
      ],
      offered: [
        { name: "grill", from: join(skills, "grill"), url: "https://git.example.com/david/grill.git", folder: ".", follow: { kind: "pinned", commit: fixed.pinned } },
        { name: "handoff", from: join(skills, "linked"), url: "git@git.example.com:david/agent-skills.git", folder: "skills/handoff", follow: { kind: "branch", branch: "main" } },
      ],
      invalid: [
        { kind: "skill", name: "notes", from: join(skills, "notes"), problems: [expect.objectContaining({ kind: "description" })] },
        { kind: "command", name: "draft", from: join(commands, "draft.md"), problems: [expect.objectContaining({ kind: "description" })] },
      ],
      notCarried: [
        { kind: "subagent", name: "reviewer" },
        { kind: "plugin", name: "skills@mattpocock" },
      ],
    });

    // The copies are whole, and the own directory reads them; the manifest's entry for a copied folder came with it.
    expect(readFileSync(join(own, "skills", "tdd", "scripts", "run.sh"), "utf8")).toBe("#!/bin/sh\necho red\n");
    expect(readFileSync(join(own, "skills", "tdd", "SKILL.md"), "utf8")).toContain("Red, then green.");
    const manifest = JSON.parse(readFileSync(join(own, "skills.json"), "utf8")) as { skills: Record<string, unknown> };
    expect(manifest.skills).toEqual({ tdd: { repo: "mattpocock/skills", path: "skills/engineering/tdd", sha: "74ca5fe", license: "MIT", digest: "kept-as-written" } });
    const members = Object.fromEntries((await get(client)).members.map((member) => [member.path, member]));
    expect(Object.keys(members).sort()).toEqual(["commands/ship.md", "skills/review", "skills/tdd", "skills/unslop"]);
    expect(members["skills/tdd"]?.origin).toEqual({ kind: "manifest", repository: "https://github.com/mattpocock/skills", path: "skills/engineering/tdd", commit: "74ca5fe", licence: "MIT" });
    expect(members["commands/ship.md"]).toMatchObject({ name: "ship", problems: [], whileActive: ["allowed-tools"] });
    // One notice, with the run's receipt; the read after it finds nothing new.
    expect(notices(t)).toBe(noticesBefore + 1);
  });

  it("merges the carried manifest entries into a manifest the own directory already holds, leaving its other entries", async () => {
    const fixed = fixture();
    const { client } = await start(fixed);
    const own = (await get(client)).ownDirectory;
    write(join(own, "skills.json"), JSON.stringify({ version: 1, skills: { handwritten: { repo: "david/skills", path: "handwritten" } } }));

    await reportOf(client);

    expect(JSON.parse(readFileSync(join(own, "skills.json"), "utf8"))).toEqual({
      version: 1,
      skills: {
        handwritten: { repo: "david/skills", path: "handwritten" },
        tdd: { repo: "mattpocock/skills", path: "skills/engineering/tdd", sha: "74ca5fe", license: "MIT", digest: "kept-as-written" },
      },
    });
  });

  it("answers a dry run with the same report and writes nothing, in the own directory or the log", async () => {
    const fixed = fixture();
    const { t, client } = await start(fixed);
    const own = (await get(client)).ownDirectory;
    const before = tree(own);
    const noticesBefore = notices(t);

    const dry = await reportOf(client, { dryRun: true });

    expect(tree(own)).toEqual(before);
    expect(notices(t)).toBe(noticesBefore);
    const run = await reportOf(client);
    expect({ ...dry, dryRun: false }).toEqual(run);
  });

  it("creates, links and deletes nothing in the adopted directory or the home's .agents/skills", async () => {
    const fixed = fixture();
    const adoptedBefore = tree(fixed.adopted);
    const homeBefore = tree(fixed.home);
    const { client } = await start(fixed);

    await reportOf(client, { dryRun: true });
    await reportOf(client);
    await reportOf(client);

    expect(tree(fixed.adopted)).toEqual(adoptedBefore);
    expect(tree(fixed.home)).toEqual(homeBefore);
  });

  it("copies nothing new on a second run, and reports what it kept, raising no notice", async () => {
    const fixed = fixture();
    const { t, client } = await start(fixed);
    const first = await reportOf(client);
    const own = (await get(client)).ownDirectory;
    const after = tree(own);
    const noticesAfter = notices(t);

    const second = await reportOf(client);

    expect(second.copied).toEqual([]);
    const skills = join(fixed.adopted, "skills");
    const agents = join(fixed.home, ".agents", "skills");
    const commands = join(fixed.adopted, "commands");
    expect(first.copied.map((item) => item.from)).toEqual([join(skills, "tdd"), join(agents, "unslop"), join(commands, "review.md"), join(commands, "ship.md")]);
    expect(second.kept).toEqual([
      { kind: "skill", name: "tdd", from: join(skills, "tdd"), path: "skills/tdd" },
      { kind: "skill", name: "tdd", from: join(agents, "tdd"), path: "skills/tdd" },
      { kind: "skill", name: "unslop", from: join(agents, "unslop"), path: "skills/unslop" },
      { kind: "command", name: "review", from: join(commands, "review.md"), path: "commands/review.md" },
      { kind: "command", name: "ship", from: join(commands, "ship.md"), path: "commands/ship.md" },
    ]);
    expect(second.offered).toEqual(first.offered);
    expect(tree(own)).toEqual(after);
    expect(notices(t)).toBe(noticesAfter);
  });

  it("refuses an account the environment does not hold, not_found, and one whose directory it owns, not_adopted", async () => {
    const fixed = fixture();
    const { client } = await start(fixed);
    expect((await carryOver(client, { accountId: "someone-else" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "not_found", data: { kind: "account", accountId: "someone-else" } },
    });
    const added = (await client.apply("accounts.add", { commandId: randomUUID(), label: "Work" })) as { account: { id: string } };
    expect((await carryOver(client, { accountId: added.account.id })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", data: { reason: "not_adopted", accountId: added.account.id } },
    });
  });
});
