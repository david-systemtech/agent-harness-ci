import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { fileVault, VAULT_FILE } from "../../environment/src/serve/vault.js";
import { useCleanups } from "../../environment/test/cleanups.js";
import { end, runCommand, say, type CommandResult } from "../../environment/test/fake-adapter.js";
import { startFakeForge } from "../../environment/test/fake-forge.js";
import { startFakeOpenBao } from "../../environment/test/fake-openbao.js";
import { DAVID, OTHER_TOKEN, TOKEN, added, list, pasted, update, verify } from "../../environment/test/forge.js";
import { startTestEnvironment, type TestEnvironment } from "../../environment/test/helper.js";
import { hostileMachineGit } from "../../environment/test/hostile-git.js";
import { ROLE_ID, SECRET_ID, added as keyManagerAdded, approle, move, setBasePath } from "../../environment/test/key-manager-connections.js";
import { sessionIn } from "../../environment/test/terminals.js";
import type { WireClient } from "../../environment/test/wire-client.js";

/**
 * The harness's git through the real helper, end to end (forge spec,
 * "Testing Decisions"; #314, #316): an in-process environment whose git
 * names this CLI, run from source, as its credential helper; the fake forge
 * serving its API and git's smart HTTP behind basic auth; a real git; and
 * the machine's global configuration naming a hostile helper and askpass
 * that hang, as on 2026-09-18. The fake OpenBao holds a forge account's
 * token once Move has taken it there (#371).
 */

const { onCleanup, tempDir } = useCleanups();

/** This CLI from source, as a service would run its built entry: node, its flags, the entry. */
const cliCommand = [
  process.execPath,
  "--conditions=@agent-harness/source",
  "--import",
  createRequire(import.meta.url).resolve("tsx"),
  fileURLToPath(new URL("./main.ts", import.meta.url)),
];

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

/** Far shorter than the hostile helper hangs; long enough for two helper runs from source on a loaded runner. */
const PROMPTLY_MS = 20_000;

describe("the harness's git through agent-harness git-credential", () => {
  it("clones and pushes a private repository with the forge account, never asking the machine's helper or askpass", async () => {
    const hostile = hostileMachineGit(tempDir, onCleanup);
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    const bare = forge.gitRepository("david/bank", { private: true, files: { "BANK.md": "# bank\n" } });
    forge.user(TOKEN, DAVID);
    forge.gitCredential(DAVID.login, TOKEN);
    const t = await startTestEnvironment({ forgeFetch: forge.fetch, harnessCommand: cliCommand });
    onCleanup(() => t.close());
    await added(await t.client(), { url: forge.origin, kind: "forgejo" });
    const parent = tempDir();

    const began = Date.now();
    const cloned = await t.env.forge.git({ operation: "clone", repository: `${forge.origin}/david/bank`, cwd: parent, directory: "bank", purpose: "clone a bank" });
    expect(cloned.outcome === "ran" && cloned.git.ok, JSON.stringify(cloned)).toBe(true);
    const checkout = join(parent, "bank");
    expect(readFileSync(join(checkout, "BANK.md"), "utf8")).toBe("# bank\n");

    writeFileSync(join(checkout, "memory.md"), "a memory\n");
    git(checkout, "add", "memory.md");
    git(checkout, "commit", "--quiet", "-m", "a memory");
    const pushed = await t.env.forge.git({ operation: "push", repository: `${forge.origin}/david/bank.git`, cwd: checkout, refspecs: ["main"], purpose: "land a memory" });
    expect(pushed.outcome === "ran" && pushed.git.ok, JSON.stringify(pushed)).toBe(true);
    expect(Date.now() - began).toBeLessThan(PROMPTLY_MS);

    expect(git(bare, "log", "--format=%s", "main").trim().split("\n")).toEqual(["a memory", "first"]);
    // Each operation's first request went without a credential, and git asked the helper once the forge refused it.
    const authenticated = forge.gitRequests.filter((request) => request.status === 200);
    expect(authenticated.length).toBeGreaterThan(0);
    expect(authenticated.every((request) => request.username === DAVID.login)).toBe(true);
    expect(hostile.asked()).toEqual([]);
  });

  it("creates a private repository on the primary forge and pushes its first commit through the harness's git, as the Memory bank step does", async () => {
    const hostile = hostileMachineGit(tempDir, onCleanup);
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    forge.gitCredential(DAVID.login, TOKEN);
    // The forge makes the repository it is asked for, empty, as a new one is.
    let bare = "";
    forge.answer(TOKEN, "POST /api/v1/user/repos", (request) => {
      const { name, private: isPrivate } = request.body as { name: string; private: boolean };
      bare = forge.gitRepository(`david/${name}`, { private: isPrivate, empty: true });
      return { status: 201, body: { full_name: `david/${name}`, private: isPrivate, default_branch: "main", html_url: `${forge.origin}/david/${name}` } };
    });
    const t = await startTestEnvironment({ forgeFetch: forge.fetch, harnessCommand: cliCommand });
    onCleanup(() => t.close());
    const client = await t.client();
    await added(client, { url: forge.origin, kind: "forgejo" });

    const created = await t.env.forge.repositories.create({ name: "bank", private: true, purpose: "create a memory bank" });
    expect(created).toMatchObject({ outcome: "done", value: { origin: forge.origin, fullName: "david/bank", private: true, defaultBranch: "main" } });
    if (created.outcome !== "done") return;

    const checkout = tempDir();
    git(checkout, "init", "--quiet", `--initial-branch=${created.value.defaultBranch}`);
    writeFileSync(join(checkout, "BANK.md"), "# bank\n");
    git(checkout, "add", "BANK.md");
    git(checkout, "commit", "--quiet", "-m", "a bank");
    const pushed = await t.env.forge.git({
      operation: "push",
      repository: `${created.value.origin}/${created.value.fullName}`,
      cwd: checkout,
      refspecs: [created.value.defaultBranch],
      purpose: "push a new bank's first commit",
    });
    expect(pushed.outcome === "ran" && pushed.git.ok, JSON.stringify(pushed)).toBe(true);

    expect(git(bare, "log", "--format=%s", "main").trim()).toBe("a bank");
    expect(forge.gitRequests.filter((request) => request.status === 200).every((request) => request.username === DAVID.login)).toBe(true);
    expect((await list(client))[0]?.capabilities.createRepository.state).toBe("verified");
    expect(hostile.asked()).toEqual([]);
  });

  it("pushes through a key-manager reference once Move has taken the forge account's pasted token into OpenBao, whose vault entry is gone", async () => {
    const hostile = hostileMachineGit(tempDir, onCleanup);
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    const bare = forge.gitRepository("david/bank", { private: true, files: { "BANK.md": "# bank\n" } });
    forge.user(TOKEN, DAVID);
    forge.gitCredential(DAVID.login, TOKEN);
    const t = await startTestEnvironment({ forgeFetch: forge.fetch, harnessCommand: cliCommand });
    onCleanup(() => t.close());
    const bao = await startFakeOpenBao({ now: () => t.clock.now() });
    onCleanup(() => bao.close());
    bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "harness"] });
    bao.policy("harness", `path "personal/data/harness/*" { capabilities = ["create", "update", "read"] }`);
    bao.kv("personal", 2);
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const connection = await keyManagerAdded(client, { address: bao.address, ca: bao.ca, credential: approle() });
    await setBasePath(client, connection.id, "personal/harness");

    const moved = await move(client, { connectionId: connection.id });

    const reference = { provider: "openbao", connectionId: connection.id, mount: "personal", path: "harness/forge-home", key: "token" };
    expect(moved.result?.items).toMatchObject([{ outcome: "moved", reference, storedValueDeleted: true }]);
    expect(bao.stored("personal", "harness/forge-home")).toMatchObject({ token: TOKEN });
    expect((await fileVault(join(t.dataDir, VAULT_FILE)).keys()).filter((key) => key.startsWith("forge:"))).toEqual([]);
    expect(await verify(client, account.id)).toMatchObject([{ id: account.id, credential: { kind: "reference", reference }, problem: null }]);

    const parent = tempDir();
    const cloned = await t.env.forge.git({ operation: "clone", repository: `${forge.origin}/david/bank`, cwd: parent, directory: "bank", purpose: "clone a bank" });
    expect(cloned.outcome === "ran" && cloned.git.ok, JSON.stringify(cloned)).toBe(true);
    const checkout = join(parent, "bank");
    writeFileSync(join(checkout, "memory.md"), "a memory\n");
    git(checkout, "add", "memory.md");
    git(checkout, "commit", "--quiet", "-m", "a memory");
    const pushed = await t.env.forge.git({ operation: "push", repository: `${forge.origin}/david/bank.git`, cwd: checkout, refspecs: ["main"], purpose: "land a memory" });
    expect(pushed.outcome === "ran" && pushed.git.ok, JSON.stringify(pushed)).toBe(true);

    expect(git(bare, "log", "--format=%s", "main").trim().split("\n")).toEqual(["a memory", "first"]);
    expect(forge.gitRequests.filter((request) => request.status === 200).every((request) => request.username === DAVID.login)).toBe(true);
    expect(hostile.asked()).toEqual([]);
  });
});

describe("git in a run's provider process, through agent-harness git-credential (#315)", () => {
  /** How long the whole test may take: a dozen helper runs from source on a loaded runner. */
  const E2E_MS = 180_000;

  /**
   * What a Claude process inherits from the machine, as the fake's command
   * runs in it: the hostile home, whose global configuration names the
   * hanging helper and askpass, and git's own process-only configuration,
   * two entries the run's are numbered after; prompts off, as the
   * 2026-09-18 check runs git.
   */
  const machine = (): Record<string, string> => ({
    HOME: process.env["HOME"] ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "test",
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: "test@example.com",
  });

  const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

  /** Runs `command` as the session's next run's shell tool, in its process's spawn environment over the machine's; answers what it printed. */
  const inRun = async (t: TestEnvironment, client: WireClient, sessionId: string, command: string): Promise<CommandResult> => {
    let result: CommandResult | undefined;
    t.adapter.nextScripts.push(async function* (controls) {
      result = yield* runCommand(controls, command, { env: machine() });
      yield say(`git exited ${String(result.code)}`);
      yield end();
    });
    const before = ended(t, sessionId).length;
    const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: command }));
    if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
    await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1), { timeout: 60_000 });
    if (result === undefined) throw new Error("The run's command did not run.");
    return result;
  };

  /** Commits a new file in the clone and pushes it. */
  const landing = (name: string): string => `cd bank && echo '${name}' > ${name}.md && git add ${name}.md && git commit --quiet -m '${name}' && git push --quiet origin main`;

  it(
    "clones and pushes with the forge account, never asking the machine's helper, a fresh process after a slug or credential change does too, and a stopped process's secret gets quit=1",
    async () => {
      const hostile = hostileMachineGit(tempDir, onCleanup);
      const forge = await startFakeForge();
      onCleanup(() => forge.close());
      const bare = forge.gitRepository("david/bank", { private: true, files: { "BANK.md": "# bank\n" } });
      for (const token of [TOKEN, OTHER_TOKEN]) {
        forge.user(token, DAVID);
        forge.gitCredential(DAVID.login, token);
      }
      const t = await startTestEnvironment({ forgeFetch: forge.fetch, harnessCommand: cliCommand });
      onCleanup(() => t.close());
      const client = await t.client();
      const account = await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
      const sessionId = await sessionIn(client, tempDir());

      // The command reads the forge's variables as the model does: the primary's URL, the slug's kind.
      const cloned = await inRun(t, client, sessionId, `test "$FORGE_HOME_KIND" = forgejo && git clone --quiet "$FORGE_URL/david/bank.git" bank && ${landing("first-memory")}`);
      expect(cloned, cloned.stderr).toMatchObject({ code: 0 });

      await update(client, { forgeAccountId: account.id, slug: "house" });
      const afterSlug = await inRun(t, client, sessionId, `test -n "$FORGE_HOUSE_TOKEN" && test -z "$FORGE_HOME_TOKEN" && ${landing("after-the-slug")}`);
      expect(afterSlug, afterSlug.stderr).toMatchObject({ code: 0 });

      await update(client, { forgeAccountId: account.id, credential: pasted(OTHER_TOKEN) });
      const afterCredential = await inRun(t, client, sessionId, landing("after-the-credential"));
      expect(afterCredential, afterCredential.stderr).toMatchObject({ code: 0 });

      const processes = t.adapter.processesOf(sessionId);
      expect(processes).toHaveLength(3);
      const supplied = await Promise.all(processes.map((process) => process.supplied));
      expect(supplied.map((env) => env["GIT_CONFIG_VALUE_1"]?.endsWith(" git-credential home") ?? false)).toEqual([true, false, false]);
      expect(supplied.map((env) => env["FORGE_HOUSE_TOKEN"] ?? null)).toEqual([null, TOKEN, OTHER_TOKEN]);
      expect(git(bare, "log", "--format=%s", "main").trim().split("\n")).toEqual(["after-the-credential", "after-the-slug", "first-memory", "first"]);
      // Each push's first request went without a credential; git asked the helper once the forge refused it, and pushed as the forge account.
      const authenticated = forge.gitRequests.filter((request) => request.status === 200 && request.username !== null);
      expect(authenticated.length).toBeGreaterThan(0);
      expect(authenticated.every((request) => request.username === DAVID.login)).toBe(true);
      expect(hostile.asked()).toEqual([]);

      // Where the helper cannot reach the environment at all, as from inside a Linux sandbox's own network, it answers from the slug's token.
      forge.gitCredential("x-access-token", OTHER_TOKEN);
      const cutOff = await inRun(t, client, sessionId, `AGENT_HARNESS_ADDRESS=127.0.0.1:1 git ls-remote "$FORGE_HOUSE_URL/david/bank.git" main`);
      expect(cutOff, cutOff.stderr).toMatchObject({ code: 0 });
      expect(forge.gitRequests.at(-1)).toMatchObject({ username: "x-access-token", status: 200 });
      expect(hostile.asked()).toEqual([]);

      // The pool stops the process: git in what it was spawned with is refused at once.
      const [, , last] = supplied;
      const stopped = await client.request("providers.processes.stop", { commandId: randomUUID(), sessionId });
      expect(stopped.receipt.status).toBe("accepted");
      const refused = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        execFile("git", ["ls-remote", `${forge.origin}/david/bank.git`], { env: { PATH: process.env["PATH"], ...machine(), ...last }, timeout: 60_000 }, (error, _stdout, stderr) =>
          resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stderr }),
        );
      });
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("told us to quit");
      expect(refused.stderr).toContain("Set up, Forges");
      expect(hostile.asked()).toEqual([]);
    },
    E2E_MS,
  );
});
