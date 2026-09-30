import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registry, type CarryOverMemoryCopy, type EventFrame, type ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import type { WireClient } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";
import { autoMemoryName } from "../workspace/auto-memory.js";

/**
 * Carry over's memory, its skills tick and the rest of its inventory
 * (setup spec, "2. Carry over"; ADR 0021; #580) through the primary seam:
 * an in-process environment with a real client over a real WebSocket, whose
 * preset account, `claude-max`, adopts a fixture directory holding memory
 * for two repositories (the first sharing its key with a memory directory
 * the environment holds already), a memory folder no transcript maps, plain
 * skills, a skill folder that is a checkout with a remote, a command, a
 * subagent, a plugin, hooks, permission rules and personal MCP servers.
 */

const { onCleanup, tempDir } = useCleanups();

/** The memory folders whose files a test makes unreadable, as if a file there turned unreadable after the folder was found. */
const unreadable = vi.hoisted(() => new Set<string>());

vi.mock("../workspace/carry-memory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/carry-memory.js")>();
  return {
    ...actual,
    memoryDigest: (directory: string) =>
      unreadable.has(directory) ? Promise.reject(new Error(`EACCES: permission denied, open '${directory}/MEMORY.md'`)) : actual.memoryDigest(directory),
  };
});

const ACCOUNT = "claude-max";
const IDENTITY = "https://git.systemtech.dev/david/agent-harness";
const PICKED = "https://git.systemtech.dev/david/receipts";

/** Writes `text` at `path`, making its folders. */
const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A path as the provider names its project folder: every character but a letter or digit a dash. */
const encoded = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");

/** A project folder's transcript, whose first record names `cwd`. */
const transcript = (directory: string, folder: string, cwd: string): void =>
  write(join(directory, "projects", folder, `${randomUUID()}.jsonl`), `${JSON.stringify({ type: "user", cwd, message: { content: "Hello" } })}\n`);

interface Fixture {
  /** The adopted directory. */
  readonly directory: string;
  /** The checkout whose origin is `IDENTITY`, and its project folder. */
  readonly harness: string;
  readonly harnessFolder: string;
  /** A checkout with no remote, keyed by its path, and its project folder. */
  readonly local: string;
  readonly localFolder: string;
  /** The project folder with memory and no transcript. */
  readonly lostFolder: string;
}

/** The adopted directory the module comment describes, with the checkouts its transcripts name. */
const fixture = (): Fixture => {
  const directory = join(tempDir(), ".fake");
  const harness = tempDir();
  git(harness, "init", "-q");
  git(harness, "remote", "add", "origin", `${IDENTITY}.git`);
  const local = tempDir();
  git(local, "init", "-q");
  const [harnessFolder, localFolder, lostFolder] = [encoded(harness), encoded(local), "-tmp-scratch-pad"];

  transcript(directory, harnessFolder, harness);
  write(join(directory, "projects", harnessFolder, "memory", "MEMORY.md"), "# Memory\n- [Build](build.md)\n");
  write(join(directory, "projects", harnessFolder, "memory", "build.md"), "Build with pnpm.\n");
  transcript(directory, localFolder, local);
  write(join(directory, "projects", localFolder, "memory", "MEMORY.md"), "# Memory\n- [Receipts](receipts.md)\n");
  write(join(directory, "projects", localFolder, "memory", "receipts.md"), "Receipts are kept thirty days.\n");
  // A project folder whose transcripts the age sweep removed: its memory names no path.
  write(join(directory, "projects", lostFolder, "memory", "MEMORY.md"), "# Memory\n- [Pad](pad.md)\n");
  write(join(directory, "projects", lostFolder, "memory", "pad.md"), "The pad.\n");
  // A project folder with a transcript and no memory holds nothing to copy.
  transcript(directory, "-work-elsewhere", "/work/elsewhere");

  const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nDo it.\n`;
  write(join(directory, "skills", "tdd", "SKILL.md"), skill("tdd", "Test-driven development."));
  const grill = join(directory, "skills", "grill");
  write(join(grill, "SKILL.md"), skill("grill", "Grill the plan."));
  git(grill, "init", "-q", "-b", "main");
  git(grill, "add", ".");
  git(grill, "commit", "-q", "-m", "grill");
  git(grill, "remote", "add", "origin", "https://git.example.com/david/grill.git");
  write(join(directory, "commands", "ship.md"), "---\ndescription: Ship it.\n---\nShip.\n");
  write(join(directory, "agents", "reviewer.md"), "---\nname: reviewer\n---\nReview.\n");
  write(join(directory, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "formatter@marketplace": [{ scope: "user" }] } }));
  write(
    join(directory, "settings.json"),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "check" }, { type: "command", command: "log" }] }], Stop: [{ hooks: [{ type: "command", command: "notify" }] }] },
      permissions: { allow: ["Bash(pnpm test)", "Read"], ask: ["Bash(git push)"], deny: ["Read(./.env)"] },
    }),
  );
  write(
    join(directory, ".claude.json"),
    JSON.stringify({ mcpServers: { memory: { command: "memory-server" }, search: { command: "search" } }, projects: { [harness]: { mcpServers: { forge: { command: "forge" } } } } }),
  );
  return { directory, harness, harnessFolder, local, localFolder, lostFolder };
};

/** The tree under `directory`: each file's and folder's path from there, with a file's bytes and its last write. */
const treeOf = (directory: string): Record<string, string> => {
  const tree: Record<string, string> = {};
  const walk = (folder: string, within: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const name = `${within}${entry.name}`;
      if (entry.isDirectory()) {
        tree[`${name}/`] = String(statSync(path).mtimeMs);
        walk(path, `${name}/`);
      } else tree[name] = `${statSync(path).mtimeMs} ${readFileSync(path, "base64")}`;
    }
  };
  walk(directory, "");
  return tree;
};

/** The files under `directory`, by their path from there, with their text; none when it is not there. */
const filesOf = (directory: string): Record<string, string> => {
  if (!existsSync(directory)) return {};
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name).slice(directory.length + 1)] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
};

interface Started {
  readonly t: TestEnvironment;
  readonly client: WireClient;
  readonly fixture: Fixture;
  /** The auto-memory directory of a key. */
  readonly memoryOf: (key: { readonly path: string; readonly identity: string | null }) => string;
}

const start = async (): Promise<Started> => {
  const found = fixture();
  const t = await startTestEnvironment({ setupSteps: NO_SETUP_STEPS, adapter: fakeAdapter({ ambientDirectory: found.directory, sessions: [] }), carryOverHome: tempDir() });
  onCleanup(() => t.close());
  const memoryOf = ({ path, identity }: { readonly path: string; readonly identity: string | null }) =>
    join(t.dataDir, "auto-memory", autoMemoryName({ workspace: { kind: "directory", path }, repositoryIdentity: identity }));
  return { t, client: await t.client(), fixture: found, memoryOf };
};

type RunParams = Omit<ParamsOf<"carryOver.run">, "commandId">;

const run = async (client: WireClient, params: Partial<RunParams> = {}) =>
  registry["carryOver.run"].response.parse(
    await client.request("carryOver.run", { commandId: randomUUID(), accountId: ACCOUNT, dryRun: false, skills: false, ...params }),
  );

/** A memory folder's copy as the report names it, its digest whatever it is. */
const copied = (folder: string, directory: string, key: string, outcome: CarryOverMemoryCopy["outcome"], under: string | null = null) => ({
  folder,
  path: join(directory, "projects", folder, "memory"),
  key,
  outcome,
  under,
  digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown,
});

describe("carryOver.inventory, the rest of the counts", () => {
  it("counts the memory folders, the repositories they map to and the unmappable; the skills with the checkout offered; the subagents and plugins not carried; and the hooks, personal MCP servers and permission rules that do not carry", async () => {
    const { client, fixture: found } = await start();

    expect(await client.request("carryOver.inventory", { accountId: ACCOUNT })).toEqual({
      accountId: ACCOUNT,
      sessions: { total: 0, archived: 0, missingDirectory: 0, new: 0 },
      memory: { folders: 3, repositories: 2, unmappable: [{ folder: found.lostFolder, path: join(found.directory, "projects", found.lostFolder, "memory") }], new: 2 },
      skills: {
        skills: 2,
        commands: 1,
        new: 2,
        offered: [{ name: "grill", from: join(found.directory, "skills", "grill"), url: "https://git.example.com/david/grill.git", folder: ".", follow: { kind: "branch", branch: "main" } }],
        invalid: 0,
      },
      notCarried: [
        { kind: "subagent", name: "reviewer" },
        { kind: "plugin", name: "formatter@marketplace" },
      ],
      doesNotCarry: { hooks: 3, mcpServers: 3, permissionRules: 4 },
    });
  });
});

describe("carryOver.run's memory", () => {
  it("copies each mapped folder into its key's auto memory, a second source for a key under carried/ with a pointer line and no file overwritten, and lists the unmappable", async () => {
    const { t, client, fixture: found, memoryOf } = await start();
    // The environment's memory for the harness's identity, from its own runs.
    const harnessMemory = memoryOf({ path: found.harness, identity: IDENTITY });
    write(join(harnessMemory, "MEMORY.md"), "# Memory\n- [Style](style.md)\n");
    write(join(harnessMemory, "build.md"), "Build with make.\n");
    const before = treeOf(found.directory);

    const answer = await run(client);

    expect(answer.result).toEqual({
      accountId: ACCOUNT,
      dryRun: false,
      sessions: { listed: 0, imported: 0, archived: 0, missingDirectory: 0, held: 0 },
      memory: {
        folders: [
          copied(found.harnessFolder, found.directory, IDENTITY, "carried", `carried/${found.harnessFolder}`),
          copied(found.localFolder, found.directory, found.local, "copied"),
        ].sort((a, b) => (a.folder < b.folder ? -1 : 1)),
        unmappable: [{ folder: found.lostFolder, path: join(found.directory, "projects", found.lostFolder, "memory") }],
      },
      failed: [],
    });
    expect(filesOf(harnessMemory)).toEqual({
      // Its own files as they were, and the pointer line appended.
      "MEMORY.md": `# Memory\n- [Style](style.md)\n- [Memory carried from ${join(found.directory, "projects", found.harnessFolder, "memory")}](carried/${found.harnessFolder}/MEMORY.md)\n`,
      "build.md": "Build with make.\n",
      [`carried/${found.harnessFolder}/MEMORY.md`]: "# Memory\n- [Build](build.md)\n",
      [`carried/${found.harnessFolder}/build.md`]: "Build with pnpm.\n",
    });
    // A checkout with no remote is keyed by its main checkout.
    expect(filesOf(memoryOf({ path: found.local, identity: null }))).toEqual({
      "MEMORY.md": "# Memory\n- [Receipts](receipts.md)\n",
      "receipts.md": "Receipts are kept thirty days.\n",
    });
    // Nothing in the adopted directory created, changed or deleted.
    expect(treeOf(found.directory)).toEqual(before);
    const imported = t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "carry-over.imported");
    expect(imported.map((event) => event.payload)).toEqual([{ accountId: ACCOUNT, sessions: answer.result?.sessions, memory: answer.result?.memory, failed: [] }]);
  });

  it("answers a dry run with the report the import then makes, having copied nothing", async () => {
    const { t, client, fixture: found, memoryOf } = await start();
    const head = t.env.log.head();

    const dry = await run(client, { dryRun: true, skills: true });

    expect(dry.result?.memory.folders.map(({ folder, outcome }) => [folder, outcome])).toEqual(
      [
        [found.harnessFolder, "copied"],
        [found.localFolder, "copied"],
      ].sort(),
    );
    expect(dry.result?.skills?.copied.map((item) => item.name)).toEqual(["tdd", "ship"]);
    expect(existsSync(join(t.dataDir, "auto-memory"))).toBe(false);
    expect((await client.request("skills.get", {})).members).toEqual([]);
    expect(t.env.log.head()).toBe(head);

    const real = await run(client, { skills: true });
    expect(real.result?.memory).toEqual(dry.result?.memory);
    expect(real.result?.skills?.copied).toEqual(dry.result?.skills?.copied);
    expect(filesOf(memoryOf({ path: found.harness, identity: IDENTITY }))).toMatchObject({ "MEMORY.md": "# Memory\n- [Build](build.md)\n" });
  });

  it("on a re-run copies only memory that is new or changed and says what it kept, even after runs changed the key's directory", async () => {
    const { client, fixture: found, memoryOf } = await start();
    await run(client);
    const localMemory = memoryOf({ path: found.local, identity: null });
    const harnessMemory = memoryOf({ path: found.harness, identity: IDENTITY });
    // A harness run added memory since.
    writeFileSync(join(localMemory, "MEMORY.md"), "# Memory\n- [Receipts](receipts.md)\n- [Deploys](deploys.md)\n");
    writeFileSync(join(localMemory, "deploys.md"), "Deploy on Fridays.\n");

    const again = await run(client);

    expect(again.result?.memory.folders.map(({ folder, outcome }) => [folder, outcome]).sort()).toEqual(
      [
        [found.harnessFolder, "kept"],
        [found.localFolder, "kept"],
      ].sort(),
    );
    expect(Object.keys(filesOf(localMemory)).sort()).toEqual(["MEMORY.md", "deploys.md", "receipts.md"]);

    // The terminal client wrote memory in the adopted directory since: that folder is changed, and lands under carried/.
    write(join(found.directory, "projects", found.harnessFolder, "memory", "release.md"), "Tag from main.\n");
    const changed = await run(client);
    expect(changed.result?.memory.folders.find((folder) => folder.folder === found.harnessFolder)).toMatchObject({ outcome: "carried", under: `carried/${found.harnessFolder}` });
    expect(changed.result?.memory.folders.find((folder) => folder.folder === found.localFolder)).toMatchObject({ outcome: "kept" });
    expect(filesOf(harnessMemory)).toMatchObject({
      "MEMORY.md": `# Memory\n- [Build](build.md)\n- [Memory carried from ${join(found.directory, "projects", found.harnessFolder, "memory")}](carried/${found.harnessFolder}/MEMORY.md)\n`,
      "build.md": "Build with pnpm.\n",
      [`carried/${found.harnessFolder}/release.md`]: "Tag from main.\n",
    });
  });

  it("answers a dry run for several folders of one repository as the run then records them, and the inventory counts what the run copies", async () => {
    const { client, fixture: found } = await start();
    // Two more checkouts of the harness: one whose folder holds other memory, one whose folder holds the harness folder's again.
    const folders = [0, 1].map((n) => {
      const checkout = tempDir();
      git(checkout, "init", "-q");
      git(checkout, "remote", "add", "origin", `${IDENTITY}.git`);
      const folder = encoded(checkout);
      transcript(found.directory, folder, checkout);
      const memory = join(found.directory, "projects", folder, "memory");
      if (n === 0) {
        write(join(memory, "MEMORY.md"), "# Memory\n- [Deploy](deploy.md)\n");
        write(join(memory, "deploy.md"), "Deploy on Fridays.\n");
      } else {
        write(join(memory, "MEMORY.md"), "# Memory\n- [Build](build.md)\n");
        write(join(memory, "build.md"), "Build with pnpm.\n");
      }
      return folder;
    });
    const ofHarness = new Set([found.harnessFolder, ...folders]);

    const inventory = await client.request("carryOver.inventory", { accountId: ACCOUNT });
    const dry = await run(client, { dryRun: true });
    const real = await run(client);

    expect(real.result?.memory).toEqual(dry.result?.memory);
    const harnessCopies = real.result?.memory.folders.filter((folder) => ofHarness.has(folder.folder)) ?? [];
    expect(harnessCopies.filter((folder) => folder.outcome === "copied")).toHaveLength(1);
    expect(harnessCopies.filter((folder) => folder.outcome === "carried").map((folder) => folder.under)).toEqual(
      harnessCopies.filter((folder) => folder.outcome === "carried").map((folder) => `carried/${folder.folder}`),
    );
    expect(inventory.memory.new).toBe(real.result?.memory.folders.filter((folder) => folder.outcome !== "kept").length);
  });

  it("names a folder whose files cannot be read as failed, and copies the rest", async () => {
    const { client, fixture: found, memoryOf } = await start();
    const harnessMemory = join(found.directory, "projects", found.harnessFolder, "memory");
    unreadable.add(harnessMemory);
    onCleanup(() => {
      unreadable.delete(harnessMemory);
    });

    const inventory = await client.request("carryOver.inventory", { accountId: ACCOUNT });
    const answer = await run(client);

    expect(inventory.memory).toMatchObject({ folders: 3, new: 1 });
    expect(answer.result?.memory.folders.map(({ folder, outcome }) => [folder, outcome])).toEqual([[found.localFolder, "copied"]]);
    expect(answer.result?.failed).toEqual([{ providerSessionId: null, folder: found.harnessFolder, message: expect.stringContaining(`The memory folder ${harnessMemory} was not copied`) as unknown }]);
    expect(filesOf(memoryOf({ path: found.harness, identity: IDENTITY }))).toEqual({});
    expect(Object.keys(filesOf(memoryOf({ path: found.local, identity: null })))).toEqual(["MEMORY.md", "receipts.md"]);
  });
});

describe("carryOver.run's skills tick", () => {
  it("runs skills.carryOver in the same command, its report joining the run's and skills.updated appended with carry-over.imported", async () => {
    const { t, client, fixture: found } = await start();
    const commandId = randomUUID();

    const answer = registry["carryOver.run"].response.parse(await client.request("carryOver.run", { commandId, accountId: ACCOUNT, dryRun: false, skills: true }));

    expect(answer.result?.skills).toMatchObject({
      accountId: ACCOUNT,
      dryRun: false,
      copied: [
        { kind: "skill", name: "tdd", path: "skills/tdd" },
        { kind: "command", name: "ship", path: "commands/ship.md" },
      ],
      kept: [],
      offered: [{ name: "grill", from: join(found.directory, "skills", "grill") }],
      notCarried: [
        { kind: "subagent", name: "reviewer" },
        { kind: "plugin", name: "formatter@marketplace" },
      ],
    });
    expect((await client.request("skills.get", {})).members.map((member) => member.name).sort()).toEqual(["ship", "tdd"]);
    const events = t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.commandId === commandId);
    expect(events.map((event) => event.type)).toEqual(["skills.updated", "carry-over.imported"]);
    expect(events[1]?.payload).toMatchObject({ skills: answer.result?.skills });
    // Without the tick, no skill is copied and the report has none.
    expect((await run(client)).result?.skills).toBeUndefined();
  });
});

describe("carryOver.assignMemory", () => {
  it("copies an unmappable folder to the repository picked by the same rule, records it with its notice, and a re-run keeps it there", async () => {
    const { t, client, fixture: found, memoryOf } = await start();
    const watcher = await t.client();
    const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    await watcher.next((frame) => frame.type === "synchronized" && "subscription" in frame && frame.subscription === subscription);
    const lost = join(found.directory, "projects", found.lostFolder, "memory");

    const answer = registry["carryOver.assignMemory"].response.parse(
      await client.request("carryOver.assignMemory", { commandId: randomUUID(), accountId: ACCOUNT, folder: found.lostFolder, repositoryIdentity: PICKED }),
    );

    const copy = copied(found.lostFolder, found.directory, PICKED, "copied");
    expect(answer.result).toEqual({ accountId: ACCOUNT, repositoryIdentity: PICKED, copy });
    // Keyed by the identity alone, wherever the repository is checked out.
    expect(filesOf(memoryOf({ path: "/anywhere", identity: PICKED }))).toEqual({ "MEMORY.md": "# Memory\n- [Pad](pad.md)\n", "pad.md": "The pad.\n" });
    const frame = await watcher.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "carry-over.memory-assigned");
    expect(frame.event).toMatchObject({ streamKind: "environment", payload: { accountId: ACCOUNT, repositoryIdentity: PICKED, copy }, actor: { kind: "client_session", id: client.hello.clientSessionId } });

    expect((await client.request("carryOver.inventory", { accountId: ACCOUNT })).memory).toEqual({ folders: 3, repositories: 3, unmappable: [], new: 2 });
    const rerun = await run(client);
    expect(rerun.result?.memory.unmappable).toEqual([]);
    expect(rerun.result?.memory.folders.find((folder) => folder.path === lost)).toMatchObject({ key: PICKED, outcome: "kept" });
  });

  it("fails naming the folder when its files cannot be read, having copied nothing", async () => {
    const { client, fixture: found, memoryOf } = await start();
    const lost = join(found.directory, "projects", found.lostFolder, "memory");
    unreadable.add(lost);
    onCleanup(() => {
      unreadable.delete(lost);
    });

    await expect(client.request("carryOver.assignMemory", { commandId: randomUUID(), accountId: ACCOUNT, folder: found.lostFolder, repositoryIdentity: PICKED })).rejects.toMatchObject({
      code: "internal",
      message: expect.stringContaining(`The memory folder ${lost} was not copied: reading it failed`) as unknown,
    });
    expect(filesOf(memoryOf({ path: "/anywhere", identity: PICKED }))).toEqual({});
  });

  it("refuses a folder the directory holds no memory in, and an account it does not hold", async () => {
    const { client } = await start();
    const assign = (fields: { accountId?: string; folder?: string }) =>
      client.request("carryOver.assignMemory", { commandId: randomUUID(), accountId: ACCOUNT, folder: "-work-elsewhere", repositoryIdentity: PICKED, ...fields });

    expect((await assign({})).receipt).toMatchObject({ status: "rejected", error: { code: "not_found", data: { kind: "memory-folder", accountId: ACCOUNT, folder: "-work-elsewhere" } } });
    expect((await assign({ folder: "-nowhere" })).receipt).toMatchObject({ status: "rejected", error: { code: "not_found", data: { kind: "memory-folder", folder: "-nowhere" } } });
    expect((await assign({ accountId: "nobody" })).receipt).toMatchObject({ status: "rejected", error: { code: "not_found", data: { kind: "account", accountId: "nobody" } } });
  });
});
