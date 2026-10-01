import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractError, registry, type SkillsProbeResult } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, unreachableOrigin, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added } from "../../test/forge.js";
import { hostileMachineGit } from "../../test/hostile-git.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * `skills.probe` through the primary seam (skills spec, "Skill sources", the
 * probe, and "Testing Decisions"; ADR 0029, ADR 0020; #497): an in-process
 * environment driven by a real client. Sources are local bare repositories
 * the test commits to, reached by `https://skills.test/` URLs that a
 * test-only `insteadOf` in the harness git's configuration rewrites to
 * them, so the source URL rule runs as written; a private repository is the
 * fake forge's, behind basic auth; the kept checkout runs on the manual
 * clock.
 */

const { onCleanup, tempDir } = useCleanups();

/** The host the test's `https` URLs name, which the harness git's `insteadOf` sends to the test's bare repositories. */
const SKILLS_HOST = "https://skills.test/";

/** git in the test's own name, outside the machine's configuration. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"],
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });

/** Writes `text` at `path`, making its folders. */
const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A `SKILL.md` naming `name` and describing it, or with the frontmatter given. */
const skill = (name: string | null, description = `The ${name ?? "unnamed"} skill.`, extra = ""): string =>
  `---\n${name === null ? "" : `name: ${name}\n`}description: ${description}\n${extra}---\n\nDo the thing.\n`;

/** The test's forge of bare repositories under one root, which the harness git reaches through `insteadOf`. */
interface Repositories {
  readonly root: string;
  /**
   * Makes the bare repository `path` (`owner/name`) holding one commit of
   * `files` on `branch`, a link where a file's text starts `link:`; answers
   * the commit. Again on the same path adds a commit on that branch.
   */
  commit(path: string, files: Readonly<Record<string, string>>, branch?: string): string;
}

const repositories = (): Repositories => {
  const root = tempDir("agent-harness-probe-forge-");
  return {
    root,
    commit(path, files, branch = "main") {
      const bare = join(root, `${path}.git`);
      if (!existsSync(bare)) {
        mkdirSync(bare, { recursive: true });
        git(bare, "init", "--quiet", "--bare", "--initial-branch=main");
      }
      const work = mkdtempSync(join(tmpdir(), "agent-harness-probe-work-"));
      try {
        git(work, "init", "--quiet", `--initial-branch=${branch}`);
        for (const [name, text] of Object.entries(files)) {
          if (text.startsWith("link:")) {
            mkdirSync(dirname(join(work, name)), { recursive: true });
            symlinkSync(text.slice("link:".length), join(work, name));
          } else write(join(work, name), text);
        }
        git(work, "add", "--all");
        git(work, "commit", "--quiet", "--allow-empty", "-m", "skills");
        git(work, "push", "--quiet", "--force", bare, `${branch}:${branch}`);
        return git(work, "rev-parse", "HEAD").trim();
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
};

/** The harness git's `insteadOf`: every `https://skills.test/` URL to the repositories' root. */
const insteadOf = (forge: Repositories) => [[`url.${pathToFileURL(forge.root).href}/.insteadOf`, SKILLS_HOST] as const];

const start = async (forge: Repositories, options: TestEnvironmentOptions = {}): Promise<{ t: TestEnvironment; client: WireClient }> => {
  const t = await startTestEnvironment({ harnessGitConfig: insteadOf(forge), ...options });
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};

const probe = async (client: WireClient, url: string, branch?: string): Promise<SkillsProbeResult> =>
  registry["skills.probe"].result.parse(await client.request("skills.probe", { url, ...(branch !== undefined && { branch }) }));

/** What a refused probe was refused with: its code, message and data. */
const refused = async (client: WireClient, url: string, branch?: string): Promise<{ code: string; message: string; data: Record<string, unknown> }> => {
  try {
    await client.request("skills.probe", { url, ...(branch !== undefined && { branch }) });
  } catch (error) {
    if (error instanceof ContractError) return { code: error.code, message: error.message, data: error.data };
    throw error;
  }
  throw new Error("The probe was answered, not refused.");
};

/** The checkouts kept under the data directory. */
const checkouts = (t: TestEnvironment): string[] => {
  const root = join(t.dataDir, "skills", "probes");
  return existsSync(root) ? readdirSync(root) : [];
};

describe("skills.probe on a repository", () => {
  it("answers a repository whose root holds SKILL.md as one member named after the repository, with its licence file, the branch and the commit", async () => {
    const forge = repositories();
    const commit = forge.commit("theclaymethod/unslop", { "SKILL.md": skill(null, "Remove AI writing patterns."), LICENSE: "MIT\n", "references/patterns.md": "# patterns\n" });
    const { client } = await start(forge);

    const answer = await probe(client, `${SKILLS_HOST}theclaymethod/unslop`);
    expect(answer).toEqual({
      probeId: expect.any(String),
      identity: "https://skills.test/theclaymethod/unslop",
      branch: "main",
      commit,
      root: { folder: ".", members: [{ name: "unslop", path: ".", description: "Remove AI writing patterns.", invocation: "model+slash", problems: [] }], count: 1, licence: "LICENSE" },
      folders: [],
      truncated: false,
    });
  });
});

describe("skills.probe's folders", () => {
  it("lists every folder up to four levels down whose children hold SKILL.md, with members, counts and licence files, skipping .git and node_modules, never following a link out of the checkout", async () => {
    const forge = repositories();
    const outside = tempDir("agent-harness-probe-outside-");
    write(join(outside, "stolen", "SKILL.md"), skill("stolen"));
    const commit = forge.commit("mattpocock/skills", {
      "README.md": "# skills\n",
      "skills/engineering/tdd/SKILL.md": skill("tdd", "Test-driven development.", "disable-model-invocation: true\n"),
      "skills/engineering/review/SKILL.md": skill("review"),
      "skills/engineering/Bad_Folder/SKILL.md": "---\ndescription: No name passes.\n---\n",
      "skills/engineering/LICENSE.md": "MIT\n",
      "skills/productivity/grill-me/SKILL.md": skill("grill-me"),
      "skills/productivity/notes/README.md": "not a skill\n",
      "a/b/c/d/e/SKILL.md": skill("deep-four"),
      "a/b/c/d/e/f/SKILL.md": skill("deep-five"),
      "node_modules/pkg/skill/SKILL.md": skill("vendored"),
      "tools/node_modules/SKILL.md": skill("named-node-modules"),
      "links/outside": `link:${outside}`,
      "links/elsewhere": "link:../skills/productivity/grill-me",
    });
    const { client } = await start(forge);

    const answer = await probe(client, `${SKILLS_HOST}mattpocock/skills.git`);
    expect(answer).toMatchObject({ identity: "https://skills.test/mattpocock/skills", branch: "main", commit, root: null, truncated: false });
    expect(answer.folders.map((folder) => [folder.folder, folder.count, folder.members.map((member) => member.name), folder.licence])).toEqual([
      ["skills/engineering", 2, [null, "review", "tdd"], "skills/engineering/LICENSE.md"],
      ["skills/productivity", 1, ["grill-me"], null],
      ["a/b/c/d", 1, ["deep-four"], null],
    ]);
    const engineering = answer.folders.find((folder) => folder.folder === "skills/engineering");
    expect(engineering?.members).toEqual([
      { name: null, path: "Bad_Folder", description: "No name passes.", invocation: "model+slash", problems: [expect.objectContaining({ kind: "name" })] },
      { name: "review", path: "review", description: "The review skill.", invocation: "model+slash", problems: [] },
      { name: "tdd", path: "tdd", description: "Test-driven development.", invocation: "slash-only", problems: [] },
    ]);
  });

  it("clones the branch named, and answers none for a repository with no skill folder", async () => {
    const forge = repositories();
    forge.commit("david/notes", { "README.md": "# notes\n" });
    const release = forge.commit("david/notes", { "skills/tdd/SKILL.md": skill("tdd") }, "release/2");
    const { client } = await start(forge);

    expect(await probe(client, `${SKILLS_HOST}david/notes`)).toMatchObject({ branch: "main", root: null, folders: [], truncated: false });
    const named = await probe(client, `${SKILLS_HOST}david/notes`, "release/2");
    expect(named).toMatchObject({ branch: "release/2", commit: release, root: null, folders: [{ folder: "skills", count: 1 }] });
  });

  it("reads at most 2,000 directories, and says it stopped", async () => {
    const forge = repositories();
    const files: Record<string, string> = { "zz/tdd/SKILL.md": skill("tdd") };
    for (let index = 0; index < 2000; index += 1) files[`d${String(index).padStart(4, "0")}/.keep`] = "";
    forge.commit("david/many", files);
    const { client } = await start(forge);

    expect(await probe(client, `${SKILLS_HOST}david/many`)).toMatchObject({ root: null, folders: [], truncated: true });
  }, 60_000);
});

describe("skills.probe's refusals", () => {
  it("refuses a URL failing the source URL rule as invalid_params, cloning nothing", async () => {
    const { t, client } = await start(repositories());
    for (const [url, reason] of [
      ["http://skills.test/david/notes", "scheme"],
      ["https://token-for-tests@skills.test/david/notes", "credential"],
      ["/srv/git/notes", "local_path"],
    ] as const) {
      const answer = await refused(client, url);
      expect(answer.code, url).toBe("invalid_params");
      expect(answer.data["issues"]).toEqual([expect.objectContaining({ path: ["url"], params: { rule: "source-url", reason } })]);
    }
    expect(checkouts(t)).toEqual([]);
  });

  it("is unreachable not_found for a repository or branch that is not there, network for a host it cannot reach, and git_failed with git's fatal: line otherwise, keeping no checkout", async () => {
    const forge = repositories();
    forge.commit("david/notes", { "skills/tdd/SKILL.md": skill("tdd") });
    forge.commit("david/broken", { "skills/tdd/SKILL.md": skill("tdd") });
    const objects = join(forge.root, "david", "broken.git", "objects");
    for (const entry of readdirSync(objects)) if (/^[0-9a-f]{2}$/.test(entry)) rmSync(join(objects, entry), { recursive: true });
    const nowhere = await unreachableOrigin();
    const { t, client } = await start(forge, { harnessGitConfig: [...insteadOf(forge), [`url.${nowhere}/.insteadOf`, "https://down.test/"]] });

    expect((await refused(client, `${SKILLS_HOST}david/missing`)).data).toMatchObject({ reason: "unreachable", problem: "not_found", origin: "https://skills.test" });
    expect((await refused(client, `${SKILLS_HOST}david/notes`, "no-such-branch")).data).toMatchObject({ reason: "unreachable", problem: "not_found" });
    const down = await refused(client, "https://down.test/david/notes");
    expect(down).toMatchObject({ code: "conflict", data: { reason: "unreachable", problem: "network", origin: "https://down.test" } });
    const broken = await refused(client, `${SKILLS_HOST}david/broken`);
    expect(broken.data).toMatchObject({ reason: "unreachable", problem: "git_failed", line: expect.stringMatching(/^fatal: /) });
    expect(broken.message).toContain(String(broken.data["line"]));
    expect(checkouts(t)).toEqual([]);
  });
});

describe("skills.probe's checkout", () => {
  it("lies under the data directory and is kept thirty minutes for an add to reuse, then removed", async () => {
    const forge = repositories();
    forge.commit("david/notes", { "skills/tdd/SKILL.md": skill("tdd") });
    const { t, client } = await start(forge);

    const { probeId } = await probe(client, `${SKILLS_HOST}david/notes`);
    expect(checkouts(t)).toEqual([probeId]);
    expect(existsSync(join(t.dataDir, "skills", "probes", probeId, "skills", "tdd", "SKILL.md"))).toBe(true);
    t.clock.advance(30 * 60_000 - 1);
    expect(checkouts(t)).toEqual([probeId]);
    t.clock.advance(1);
    expect(checkouts(t)).toEqual([]);
  });
});

describe("skills.probe's git", () => {
  /** A stand-in for the CLI's credential helper: asks the environment's credential route as `agent-harness git-credential` does. */
  const routeHelper = (): string[] => {
    const script = join(tempDir("agent-harness-helper-"), "helper.mjs");
    writeFileSync(
      script,
      `const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
  const [, slug, action] = process.argv.slice(2);
  if (action !== "get") return;
  const attributes = Object.fromEntries(Buffer.concat(chunks).toString("utf8").split("\\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const answer = await fetch("http://" + process.env.AGENT_HARNESS_ADDRESS + "/api/internal/git-credential", {
    method: "POST",
    headers: { authorization: "Bearer " + process.env.AGENT_HARNESS_RUN_SECRET, "content-type": "application/json" },
    body: JSON.stringify({ action, slug, protocol: attributes.protocol, host: attributes.host }),
  });
  if (!answer.ok) return void console.log("quit=1");
  const { username, password } = await answer.json();
  console.log("username=" + username + "\\npassword=" + password);
});
`,
    );
    return [process.execPath, script];
  };

  /** A forge reached as `https://forge.test`, a verified alias of the fake forge's origin, its API routed there. */
  const FORGE_ALIAS = "https://forge.test";
  const aliasFetch = (forge: FakeForge) => (url: string, init: RequestInit) => forge.fetch(url.startsWith(FORGE_ALIAS) ? forge.origin + url.slice(FORGE_ALIAS.length) : url, init);

  /** The machine's git with nothing configured: `HOME` pointed at an empty folder for the test. */
  const emptyHome = (): void => {
    const before = process.env["HOME"];
    process.env["HOME"] = tempDir("agent-harness-empty-home-");
    onCleanup(() => void (before === undefined ? delete process.env["HOME"] : (process.env["HOME"] = before)));
  };

  it("probes a private repository on the fake forge with the forge account for its origin, never asking the machine's helper", async () => {
    const hostile = hostileMachineGit(tempDir, onCleanup);
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.gitRepository("david/private-skills", { private: true, files: { "SKILL.md": skill(null, "A private skill.") } });
    forge.user(TOKEN, DAVID);
    forge.gitCredential(DAVID.login, TOKEN);
    const { client } = await start(repositories(), { forgeFetch: aliasFetch(forge), harnessCommand: routeHelper() });
    await added(client, { url: forge.origin, kind: "forgejo", aliases: [FORGE_ALIAS] });

    const answer = await probe(client, `${FORGE_ALIAS}/david/private-skills`);
    expect(answer).toMatchObject({
      identity: "https://127.0.0.1/david/private-skills",
      branch: "main",
      root: { folder: ".", members: [{ name: "private-skills", description: "A private skill." }], count: 1 },
    });
    expect(forge.gitRequests.some((request) => request.username === DAVID.login && request.status === 200)).toBe(true);
    expect(hostile.asked()).toEqual([]);
  });

  it("reads an origin with no forge account anonymously, and a private repository there fails authentication at once, naming the origin", async () => {
    emptyHome();
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.gitRepository("david/private-skills", { private: true, files: { "SKILL.md": skill(null, "A private skill.") } });
    forge.gitRepository("david/public-skills", { files: { "SKILL.md": skill(null, "A public skill.") } });
    const { t, client } = await start(repositories(), { forgeFetch: aliasFetch(forge), harnessGitConfig: [[`url.${forge.origin}/.insteadOf`, `${FORGE_ALIAS}/`]] });

    expect(await probe(client, `${FORGE_ALIAS}/david/public-skills`)).toMatchObject({ root: { members: [{ name: "public-skills" }] } });
    const answer = await refused(client, `${FORGE_ALIAS}/david/private-skills`);
    expect(answer).toMatchObject({ code: "conflict", data: { reason: "unreachable", problem: "authentication", origin: FORGE_ALIAS } });
    expect(answer.message).toContain("Set up, Forges");
    expect(forge.gitRequests.every((request) => request.username === null)).toBe(true);
    expect(checkouts(t)).toHaveLength(1);
  });

  it("reads an ssh URL on a host no forge account covers over ssh, with the user's own keys and ssh in batch mode", async () => {
    const forge = repositories();
    const commit = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd") });
    // An ssh on the PATH that records how it was asked, then serves the command it was given from the test's repositories.
    const bin = tempDir("agent-harness-fake-ssh-");
    const record = join(bin, "asked");
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\necho "$*" >> '${record}'\nfor last; do :; done\ncd '${forge.root}' && exec sh -c "git \${last#git-}"\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path ?? ""}`;
    onCleanup(() => void (path === undefined ? delete process.env["PATH"] : (process.env["PATH"] = path)));
    const { client } = await start(forge);

    expect(await probe(client, "git@ssh.skills.test:david/skills.git")).toMatchObject({ identity: "https://ssh.skills.test/david/skills", commit, folders: [{ folder: "skills", count: 1 }] });
    const asked = readFileSync(record, "utf8");
    expect(asked).toContain("-o BatchMode=yes");
    expect(asked).toContain("git@ssh.skills.test git-upload-pack 'david/skills.git'");
  });

  it("is git_failed with the shell's line, not not_found, when there is no ssh to clone an ssh URL with", async () => {
    const { client } = await start(repositories());
    // A PATH that holds git and nothing else, so the shell git runs ssh through says it is not found.
    const bin = tempDir("agent-harness-no-ssh-");
    symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
    const path = process.env["PATH"];
    process.env["PATH"] = bin;
    onCleanup(() => void (path === undefined ? delete process.env["PATH"] : (process.env["PATH"] = path)));

    const answer = await refused(client, "git@ssh.skills.test:david/skills.git");
    expect(answer.data).toMatchObject({ reason: "unreachable", problem: "git_failed", line: expect.stringMatching(/\bssh: (?:command )?not found$/) });
    expect(answer.message).toContain("git could not clone the repository.");
  });
});
