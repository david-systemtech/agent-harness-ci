import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContractError, registry, type SkillsProbeResult } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, unreachableOrigin, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added } from "../../test/forge.js";
import { hostileMachineGit } from "../../test/hostile-git.js";
import { SKILLS_HOST, skill, skillRepositories, skillsInsteadOf, write, type SkillRepositories } from "../../test/skill-repositories.js";
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

const start = async (forge: SkillRepositories, options: TestEnvironmentOptions = {}): Promise<{ t: TestEnvironment; client: WireClient }> => {
  const t = await startTestEnvironment({ harnessGitConfig: skillsInsteadOf(forge), ...options });
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

/** Runs the rest of the test with `PATH` set to `path`, then puts it back. */
const usePath = (path: string): void => {
  const before = process.env["PATH"];
  process.env["PATH"] = path;
  onCleanup(() => void (before === undefined ? delete process.env["PATH"] : (process.env["PATH"] = before)));
};

/** An ssh on the PATH that says `refusal` and exits 255, as OpenSSH does when it cannot authenticate. */
const refusingSsh = (refusal: string): void => {
  const bin = tempDir("agent-harness-refusing-ssh-");
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\ncat >&2 <<'EOF'\n${refusal}\nEOF\nexit 255\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  usePath(`${bin}:${process.env["PATH"] ?? ""}`);
};

describe("skills.probe on a repository", () => {
  it("answers a repository whose root holds SKILL.md as one member named after the repository, with its licence file, the branch and the commit", async () => {
    const forge = skillRepositories(tempDir);
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
    const forge = skillRepositories(tempDir);
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
    const forge = skillRepositories(tempDir);
    forge.commit("david/notes", { "README.md": "# notes\n" });
    const release = forge.commit("david/notes", { "skills/tdd/SKILL.md": skill("tdd") }, "release/2");
    const { client } = await start(forge);

    expect(await probe(client, `${SKILLS_HOST}david/notes`)).toMatchObject({ branch: "main", root: null, folders: [], truncated: false });
    const named = await probe(client, `${SKILLS_HOST}david/notes`, "release/2");
    expect(named).toMatchObject({ branch: "release/2", commit: release, root: null, folders: [{ folder: "skills", count: 1 }] });
  });

  it("reads at most 2,000 directories, and says it stopped", async () => {
    const forge = skillRepositories(tempDir);
    const files: Record<string, string> = { "zz/tdd/SKILL.md": skill("tdd") };
    for (let index = 0; index < 2000; index += 1) files[`d${String(index).padStart(4, "0")}/.keep`] = "";
    forge.commit("david/many", files);
    const { client } = await start(forge);

    expect(await probe(client, `${SKILLS_HOST}david/many`)).toMatchObject({ root: null, folders: [], truncated: true });
  }, 60_000);
});

describe("skills.probe's refusals", () => {
  it("refuses a URL failing the source URL rule as invalid_params, cloning nothing", async () => {
    const { t, client } = await start(skillRepositories(tempDir));
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
    const forge = skillRepositories(tempDir);
    forge.commit("david/notes", { "skills/tdd/SKILL.md": skill("tdd") });
    forge.commit("david/broken", { "skills/tdd/SKILL.md": skill("tdd") });
    const objects = join(forge.root, "david", "broken.git", "objects");
    for (const entry of readdirSync(objects)) if (/^[0-9a-f]{2}$/.test(entry)) rmSync(join(objects, entry), { recursive: true });
    const nowhere = await unreachableOrigin(onCleanup);
    const { t, client } = await start(forge, { harnessGitConfig: [...skillsInsteadOf(forge), [`url.${nowhere}/.insteadOf`, "https://down.test/"]] });

    const missing = await refused(client, `${SKILLS_HOST}david/missing`);
    expect(missing).toMatchObject({ message: "agent-harness found no repository at this address.", data: { reason: "unreachable", problem: "not_found", origin: "https://skills.test" } });
    expect((await refused(client, `${SKILLS_HOST}david/notes`, "no-such-branch")).data).toMatchObject({ reason: "unreachable", problem: "not_found" });
    const down = await refused(client, "https://down.test/david/notes");
    expect(down).toMatchObject({ code: "conflict", message: "down.test did not answer in time. Try again.", data: { reason: "unreachable", problem: "network", origin: "https://down.test" } });
    const broken = await refused(client, `${SKILLS_HOST}david/broken`);
    expect(broken.data).toMatchObject({ reason: "unreachable", problem: "git_failed", line: expect.stringMatching(/^fatal: /) });
    // setup-copy.md §5.9: the message is the plain line; what git said is the data's line, for Details.
    expect(broken.message).toBe("agent-harness could not read this repository. Try again.");
    expect(checkouts(t)).toEqual([]);
  });

  it("names a missing git as not installed on this computer, from git's spawn ENOENT, keeping no checkout", async () => {
    const { t, client } = await start(skillRepositories(tempDir), { name: "desk" });
    // A PATH with no git on it, as on a computer where Git was never installed.
    usePath(tempDir("agent-harness-no-git-"));

    const answer = await refused(client, `${SKILLS_HOST}david/notes`);
    expect(answer).toMatchObject({
      code: "conflict",
      message: "Git is not installed on desk. Install Git, then try again.",
      data: { reason: "unreachable", problem: "git_missing", line: expect.stringContaining("ENOENT"), origin: "https://skills.test" },
    });
    expect(checkouts(t)).toEqual([]);
  });
});

describe("skills.probe's checkout", () => {
  it("lies under the data directory and is kept thirty minutes for an add to reuse, then removed", async () => {
    const forge = skillRepositories(tempDir);
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
    const { client } = await start(skillRepositories(tempDir), { forgeFetch: aliasFetch(forge), harnessCommand: routeHelper() });
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
    const { t, client } = await start(skillRepositories(tempDir), { forgeFetch: aliasFetch(forge), harnessGitConfig: [[`url.${forge.origin}/.insteadOf`, `${FORGE_ALIAS}/`]] });

    expect(await probe(client, `${FORGE_ALIAS}/david/public-skills`)).toMatchObject({ root: { members: [{ name: "public-skills" }] } });
    const answer = await refused(client, `${FORGE_ALIAS}/david/private-skills`);
    expect(answer).toMatchObject({ code: "conflict", data: { reason: "unreachable", problem: "authentication", origin: FORGE_ALIAS } });
    expect(answer.message).toBe("This repository is private. Add a forge for forge.test first.");
    expect(forge.gitRequests.every((request) => request.username === null)).toBe(true);
    expect(checkouts(t)).toHaveLength(1);
  });

  it("reads an ssh URL on a host no forge account covers over ssh, with the user's own keys and ssh in batch mode", async () => {
    const forge = skillRepositories(tempDir);
    const commit = forge.commit("david/skills", { "skills/tdd/SKILL.md": skill("tdd") });
    // An ssh on the PATH that records how it was asked, then serves the command it was given from the test's repositories.
    const bin = tempDir("agent-harness-fake-ssh-");
    const record = join(bin, "asked");
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\necho "$*" >> '${record}'\nfor last; do :; done\ncd '${forge.root}' && exec sh -c "git \${last#git-}"\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    usePath(`${bin}:${process.env["PATH"] ?? ""}`);
    const { client } = await start(forge);

    expect(await probe(client, "git@ssh.skills.test:david/skills.git")).toMatchObject({ identity: "https://ssh.skills.test/david/skills", commit, folders: [{ folder: "skills", count: 1 }] });
    const asked = readFileSync(record, "utf8");
    expect(asked).toContain("-o BatchMode=yes");
    expect(asked).toContain("git@ssh.skills.test git-upload-pack 'david/skills.git'");
  });

  it("is git_failed with the shell's line, not not_found, when there is no ssh to clone an ssh URL with", async () => {
    const { client } = await start(skillRepositories(tempDir));
    // A PATH that holds git and nothing else, so the shell git runs ssh through says it is not found.
    const bin = tempDir("agent-harness-no-ssh-");
    symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
    usePath(bin);

    const answer = await refused(client, "git@ssh.skills.test:david/skills.git");
    expect(answer.data).toMatchObject({ reason: "unreachable", problem: "git_failed", line: expect.stringMatching(/\bssh: (?:command )?not found$/) });
    expect(answer.message).toBe("agent-harness could not read this repository. Try again.");
  });

  // The image installs openssh-client but holds none of the user's keys (#874): ssh runs, refuses, and the
  // probe answers that as authentication, never the shell's `ssh: not found`.
  it.each([
    ["a host it holds no key for", "No ED25519 host key is known for ssh.skills.test and you have requested strict checking.\nHost key verification failed."],
    ["a host that takes none of the keys it has", "git@ssh.skills.test: Permission denied (publickey)."],
  ])("is authentication, not git_failed, when ssh runs without the user's keys and refuses %s", async (_case, refusal) => {
    refusingSsh(refusal);
    const { client } = await start(skillRepositories(tempDir));

    const answer = await refused(client, "git@ssh.skills.test:david/skills.git");
    expect(answer.data).toMatchObject({ reason: "unreachable", problem: "authentication", line: "fatal: Could not read from remote repository." });
    expect(answer.message).toBe("This repository is private. Add a forge for ssh.skills.test first.");
  });
});
