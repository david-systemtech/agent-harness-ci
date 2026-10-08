import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ceiling, registry, type EventEnvelope, type EventFrame, type ManagedToolRow, type ParamsOf, type ResponseOf, type Scope, type ToolCommandEntry } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { fakePty, type FakePty } from "../../test/fake-pty.js";
import { fakeToolPath, scriptedPackageOwners, type FakeToolPath } from "../../test/fake-tools.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { follow, terminalCommand, typeInto } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";
import { nodePty } from "../terminals/pty.js";

/**
 * Install and Update in a tool terminal (key-managers spec, "Managed
 * tools"; ADR 0026; #376), through the primary seam: an in-process
 * environment and a real client over a real WebSocket, with fake CLIs and
 * fake package managers on a PATH the test sets, which the environment's
 * scripted read of the login shell answers. The fake pty holds each run's
 * command, so a test decides when it exits, and what it left on the PATH;
 * a real pty runs a fake installer from a test command table that asks for
 * a password, skipped where `node-pty` is unbuilt. The real table's
 * commands are only ever handed to the fake pty: nothing is installed.
 */

const { onCleanup, tempDir } = useCleanups();

/** The fakes are `#!/bin/sh` scripts on a colon-joined PATH: POSIX only. */
const posix = describe.runIf(process.platform !== "win32");

/** The login shell a test's tool terminals start: zsh as a login shell, which the fake pty never runs. */
const ZSH = { file: "/bin/zsh", args: ["-l"] } as const;
/** The clean base a test's terminals start over. */
const BASE = { TERM: "xterm-256color", PATH: "/usr/bin:/bin", HOME: "/home/tester", LANG: "C.UTF-8" };

/** Whether this machine built node-pty: the real-pty test needs it. */
const ptyBuilt = (() => {
  try {
    nodePty.check();
    return true;
  } catch {
    return false;
  }
})();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** A fake PATH under a fresh directory, with its root's links resolved so realpaths compare. */
const fakePath = (): FakeToolPath => fakeToolPath(realpathSync(tempDir()));

/** Puts fake programs of these names on the PATH: the package managers, sudo and the downloaders a method needs. */
const programs = (path: FakeToolPath, ...names: string[]): void => {
  for (const name of names) path.install(name);
};

/** An environment whose login shell answers the fake PATH and whose terminals start on the fake pty, how often the PATH was read, and its default client, which holds every scope. */
const withRunner = async (path: FakeToolPath, options: TestEnvironmentOptions = {}) => {
  const pty = fakePty();
  const reads = { count: 0 };
  const t = await start({
    ...options,
    terminals: { pty, shell: () => ZSH, baseEnvironment: () => ({ ...BASE }), gatherMs: 0 },
    managedTools: {
      readPath: async () => {
        reads.count += 1;
        return path.path();
      },
      packageOwner: scriptedPackageOwners(),
      ...options.managedTools,
    },
  });
  return { t, client: await t.client(), pty, reads };
};

type RunParams = Omit<ParamsOf<"tools.run">, "commandId" | "id"> & { readonly id?: string; readonly commandId?: string };

/** Sends `tools.run`, with a fresh terminal id unless one is given; the response, receipt and all. */
const run = async (client: WireClient, params: RunParams): Promise<ResponseOf<"tools.run">> =>
  registry["tools.run"].response.parse(await client.request("tools.run", { commandId: randomUUID(), id: randomUUID(), ...params })) as ResponseOf<"tools.run">;

/** Sends `tools.run` and answers its result; throws unless it was accepted. */
const ran = async (client: WireClient, params: RunParams) => {
  const answer = await run(client, params);
  if (answer.result === undefined) throw new Error(`tools.run was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result;
};

/** The fake pty's `index`th process; throws when it was never started. */
const spawnedAt = (pty: FakePty, index = 0) => {
  const process = pty.spawned[index];
  if (process === undefined) throw new Error(`No process ${index} was spawned.`);
  return process;
};

/** The events of `type` on the environment stream so far. */
const eventsOf = async (client: WireClient, type: string): Promise<EventEnvelope[]> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
  const events: EventEnvelope[] = [];
  for (;;) {
    const frame = await client.next((f) => "subscription" in f && f.subscription === subscription && (f.type === "event" || f.type === "synchronized"));
    if (frame.type === "synchronized") return events.filter((event) => event.type === type);
    events.push((frame as EventFrame).event);
  }
};

/** Waits for the environment stream's first event of `type`, from the start. */
const eventOf = async (client: WireClient, type: string): Promise<EventEnvelope> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
  const frame = await client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === type);
  return (frame as EventFrame).event;
};

const rowOf = (rows: readonly ManagedToolRow[], tool: string): ManagedToolRow => {
  const row = rows.find((candidate) => candidate.tool === tool);
  if (row === undefined) throw new Error(`No ${tool} row.`);
  return row;
};

/** A client session issued straight from the environment, holding only `scopes`. */
const narrowClient = (t: TestEnvironment, scopes: Scope[]): Promise<WireClient> =>
  t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token });

posix("tools.run's Install", () => {
  it("opens a tool terminal running the first available of Homebrew, WinGet, the vendor's repository or its script, through the login shell, and answers the command it runs", async () => {
    const path = fakePath();
    programs(path, "brew", "apt-get", "sudo", "curl");
    const { client, pty } = await withRunner(path);
    const id = randomUUID();

    const result = await ran(client, { tool: "gh", action: "install", id, cols: 120, rows: 40 });

    expect(result).toEqual({
      terminal: { id, owner: "managed-tools", sessionId: null, openedAt: MANUAL_CLOCK_START, cols: 120, rows: 40, exitCode: null, signal: null },
      tool: "gh",
      action: "install",
      method: "homebrew",
      command: "brew install gh",
      doctor: null,
    });
    const child = spawnedAt(pty);
    expect([child.file, child.args, child.options.cols, child.options.rows]).toEqual(["/bin/zsh", ["-l", "-c", "brew install gh"], 120, 40]);
    expect(child.options.env?.["PATH"]).toBe(path.path());
  });

  it("adds the vendor's repository under sudo where Homebrew is not there, and the vendor's script where no repository is", async () => {
    const path = fakePath();
    programs(path, "apt-get", "sudo", "curl", "sh", "gpg");
    const { client, pty } = await withRunner(path);

    const gh = await ran(client, { tool: "gh", action: "install" });
    expect(gh.method).toBe("apt");
    expect(gh.command).toBe(
      [
        "sudo install -d -m 0755 /etc/apt/keyrings",
        "sudo curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg",
        "sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg",
        "dpkg --print-architecture | sed 's|.*|deb [arch=& signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main|' | sudo tee /etc/apt/sources.list.d/github-cli.list",
        "sudo apt-get update",
        "sudo apt-get install gh",
      ].join(" && "),
    );
    spawnedAt(pty).exit(1);
    await eventOf(client, "tool.run-finished");

    const bws = await ran(client, { tool: "bws", action: "install" });
    expect([bws.method, bws.command]).toEqual(["script", "curl -fsSL https://bws.bitwarden.com/install | sh"]);
    expect(spawnedAt(pty, 1).args).toEqual(["-l", "-c", "curl -fsSL https://bws.bitwarden.com/install | sh"]);
  });

  it("installs bao for vault's row, since vault is never installed", async () => {
    const path = fakePath();
    programs(path, "brew");
    const { client, pty } = await withRunner(path);

    const result = await ran(client, { tool: "vault", action: "install" });

    expect([result.tool, result.method, result.command]).toEqual(["bao", "homebrew", "brew install openbao"]);
    expect(spawnedAt(pty).args).toEqual(["-l", "-c", "brew install openbao"]);
  });

  it("is tool_not_runnable where no method is available, answering the vendor's documented command, and for a tool installed already, opening nothing", async () => {
    const path = fakePath();
    path.install("gh", { output: "gh version 2.63.2 (2024-12-05)" });
    const { client, pty } = await withRunner(path);

    const none = await run(client, { tool: "op", action: "install" });
    expect(none.receipt).toMatchObject({
      status: "rejected",
      reason: "tool_not_runnable",
      error: { code: "tool_not_runnable", data: { tool: "op", action: "install", command: "brew install --cask 1password-cli" } },
    });
    const installed = await run(client, { tool: "gh", action: "install" });
    expect(installed.receipt).toMatchObject({ status: "rejected", reason: "tool_not_runnable", error: { data: { tool: "gh", action: "install" } } });
    expect(pty.spawned).toEqual([]);
    expect(await eventsOf(client, "tool.run-started")).toEqual([]);
  });
});

posix("tools.run's Update", () => {
  it("runs the update of the method the row detected: Homebrew's for a tool in its Cellar, apt's with --only-upgrade for one dpkg owns", async () => {
    const path = fakePath();
    path.install("doppler", { at: "homebrew/Cellar/doppler/3.80.0/bin/doppler", output: "v3.80.0" });
    const gh = path.install("gh", { output: "gh version 2.63.2 (2024-12-05)" });
    const { client, pty } = await withRunner(path, { managedTools: { packageOwner: scriptedPackageOwners({ [gh.file]: { manager: "dpkg", package: "gh" } }) } });

    const doppler = await ran(client, { tool: "doppler", action: "update" });
    expect([doppler.method, doppler.command]).toEqual(["homebrew", "brew upgrade doppler"]);
    spawnedAt(pty).exit(0);
    await eventOf(client, "tool.run-finished");

    const apt = await ran(client, { tool: "gh", action: "update" });
    expect([apt.method, apt.command]).toEqual(["apt", "sudo apt-get update && sudo apt-get install --only-upgrade gh"]);
  });

  it("updates what Scoop, mise or asdf installed through its own upgrade, naming the package the realpath is under, and a bare binary by its vendor's update (#1833)", async () => {
    const path = fakePath();
    path.install("gh", { at: ".local/share/mise/installs/gh/2.63.2/bin/gh", output: "gh version 2.63.2 (2024-12-05)" });
    path.install("doppler", { at: ".asdf/installs/doppler/3.80.0/bin/doppler", output: "v3.80.0" });
    path.install("bao", { output: "OpenBao v2.1.1" });
    path.install("claude", { output: "2.1.283 (Claude Code)" });
    const { client, pty } = await withRunner(path);

    const updated: [string, string, string][] = [];
    for (const tool of ["gh", "doppler", "bao", "claude"] as const) {
      const result = await ran(client, { tool, action: "update" });
      updated.push([tool, result.method, result.command]);
      spawnedAt(pty, updated.length - 1).exit(0);
      await expect.poll(async () => (await eventsOf(client, "tool.run-finished")).length).toBe(updated.length);
    }
    expect(updated.slice(0, 2)).toEqual([
      ["gh", "mise", "mise upgrade gh"],
      ["doppler", "asdf", "asdf install doppler latest && asdf set --home doppler latest"],
    ]);
    expect(updated[2]?.slice(0, 2)).toEqual(["bao", "manual"]);
    expect(updated[2]?.[2]).toMatch(/^sh -c 'set -eu; .*checksums\.txt.*install -m 0755/);
    expect(updated[3]).toEqual(["claude", "manual", "claude update"]);
  });

  it("runs the vendor's documented command for a tool installed in a way the table cannot drive, held back until Enter in the tool terminal, whether asked as Update or as Run in a terminal pane (#1833)", async () => {
    const path = fakePath();
    programs(path, "brew");
    const bws = path.install("bws", { output: "bws 1.0.0" });
    path.install("gh", { at: "lib/node_modules/gh/bin/gh", output: "gh version 2.63.2 (2024-12-05)" });
    const { client, pty } = await withRunner(path, { managedTools: { packageOwner: scriptedPackageOwners({ [bws.file]: "unknown" }) } });

    const terminal = await ran(client, { tool: "bws", action: "terminal" });
    expect([terminal.tool, terminal.action, terminal.method]).toEqual(["bws", "terminal", "script"]);
    expect(terminal.command).toBe(
      "printf '%s\\n\\n%s ' 'curl -fsSL https://bws.bitwarden.com/install | sh' 'Press Enter to run it here, or Ctrl+C to cancel.' && sh -c 'read -r answer' && curl -fsSL https://bws.bitwarden.com/install | sh",
    );
    expect(spawnedAt(pty).args).toEqual(["-l", "-c", terminal.command]);
    spawnedAt(pty).exit(0);
    await eventOf(client, "tool.run-finished");

    const update = await ran(client, { tool: "gh", action: "update" });
    expect([update.method, update.command]).toEqual(["homebrew", expect.stringMatching(/^printf .* && sh -c 'read -r answer' && brew install gh$/)]);
  });

  it("never upgrades the Node a tool was installed into by npm under mise or asdf, nor a file a system package manager may own: their rows run the vendor's command once Enter is pressed (#1833)", async () => {
    const path = fakePath();
    path.install("claude", { at: ".local/share/mise/installs/node/22.11.0/lib/node_modules/@anthropic-ai/claude-code/cli.js", output: "2.1.283 (Claude Code)" });
    path.install("gh", { at: ".asdf/installs/nodejs/22.11.0/lib/node_modules/gh/bin/gh", output: "gh version 2.63.2 (2024-12-05)" });
    path.install("bao", { at: ".cargo/bin/bao", output: "OpenBao v2.1.1" });
    const { client, pty } = await withRunner(path);

    const rows = (await client.request("tools.list", {})).tools;
    expect(Object.fromEntries(rows.filter((row) => ["claude", "gh", "bao"].includes(row.tool)).map((row) => [row.tool, [row.method, row.action]]))).toEqual({
      claude: ["mise", "terminal"],
      gh: ["asdf", "terminal"],
      bao: ["manual", "terminal"],
    });
    const held: string[] = [];
    for (const tool of ["claude", "gh", "bao"] as const) {
      held.push((await ran(client, { tool, action: "update" })).command);
      spawnedAt(pty, held.length - 1).exit(0);
      await expect.poll(async () => (await eventsOf(client, "tool.run-finished")).length).toBe(held.length);
    }
    for (const command of held) expect(command).toMatch(/ && sh -c 'read -r answer' && /);
    expect(held.join("\n")).not.toMatch(/mise upgrade|asdf install|checksums\.txt/);
  });

  it("drives a mise or asdf shim only when their package directory holds the tool's own package, and offers no self-update for a file a system package manager may own (#1833)", async () => {
    const path = fakePath();
    const mise = join(path.root, ".local/share/mise");
    const asdf = join(path.root, ".asdf");
    for (const directory of [join(mise, "shims"), join(mise, "installs/github-cli/2.63.2"), join(asdf, "shims"), join(asdf, "installs/nodejs/22.11.0")]) mkdirSync(directory, { recursive: true });
    path.append(join(mise, "shims"));
    path.append(join(asdf, "shims"));
    // mise's shims are links to mise itself; asdf's are scripts naming the plugin, here the Node `npm i -g` put claude into.
    symlinkSync(fakeToolPath(join(path.root, "mise-itself")).install("mise", { output: "gh version 2.63.2 (2024-12-05)" }).file, join(mise, "shims/gh"));
    path.install("claude", { at: ".asdf/shims/claude", link: null, output: "2.1.283 (Claude Code)" });
    path.install("doppler", { at: ".cargo/bin/doppler", output: "v3.80.0" });
    const { client, pty } = await withRunner(path);

    const rows = (await client.request("tools.list", {})).tools;
    expect(Object.fromEntries(rows.filter((row) => ["claude", "gh", "doppler"].includes(row.tool)).map((row) => [row.tool, [row.method, row.action]]))).toEqual({
      claude: ["asdf", "terminal"],
      gh: ["mise", "update"],
      doppler: ["manual", "terminal"],
    });
    const commands: string[] = [];
    for (const tool of ["gh", "claude", "doppler"] as const) {
      commands.push((await ran(client, { tool, action: "update" })).command);
      spawnedAt(pty, commands.length - 1).exit(0);
      await expect.poll(async () => (await eventsOf(client, "tool.run-finished")).length).toBe(commands.length);
    }
    expect(commands[0]).toBe("mise upgrade github-cli");
    for (const command of commands.slice(1)) expect(command).toMatch(/ && sh -c 'read -r answer' && /);
    expect(commands[1]).not.toMatch(/asdf install/);
    expect(commands[2]).not.toMatch(/doppler update/);
  });

  it("is tool_not_runnable for vault, which the harness never installs or updates, and for a tool not installed, opening nothing", async () => {
    const path = fakePath();
    programs(path, "brew");
    path.install("vault", { output: "Vault v1.15.0" });
    const { client, pty } = await withRunner(path);

    for (const action of ["update", "terminal"] as const) {
      expect((await run(client, { tool: "vault", action })).receipt).toMatchObject({ status: "rejected", reason: "tool_not_runnable", error: { data: { tool: "vault", action, command: null } } });
    }
    expect((await run(client, { tool: "gh", action: "terminal" })).receipt).toMatchObject({ reason: "tool_not_runnable", error: { message: "gh is not installed on this environment: Install it.", data: { command: "brew install gh" } } });
    expect(pty.spawned).toEqual([]);
  });

  it("puts that command on each terminal row tools.list answers, so a client shows it before anything is clicked, and none on a row whose action runs it directly (#426, #1833)", async () => {
    const path = fakePath();
    programs(path, "brew");
    path.install("doppler", { output: "v3.80.0" });
    path.install("gh", { at: "lib/node_modules/gh/bin/gh", output: "gh version 2.63.2 (2024-12-05)" });
    path.install("vault", { output: "Vault v1.15.0" });
    path.install("op", { at: "homebrew/Caskroom/1password-cli/2.30.0/op", output: "2.30.0" });
    path.install("bws", { output: "bws 1.0.0" });
    const { client } = await withRunner(path);

    const rows = (await client.request("tools.list", {})).tools;
    const commands = Object.fromEntries(rows.map((row) => [row.tool, [row.action, row.command]]));
    expect(commands).toEqual({
      claude: ["install", null],
      bao: ["install", null],
      vault: ["copy", null],
      doppler: ["update", null],
      op: ["update", null],
      bws: ["terminal", "curl -fsSL https://bws.bitwarden.com/install | sh"],
      gh: ["terminal", "brew install gh"],
    });
  });

  it("on claude runs claude doctor first, answering its report beside the method the row detected, which the update uses", async () => {
    const path = fakePath();
    const claude = path.install("claude", {
      at: ".local/share/claude/versions/2.1.283",
      output: "2.1.283 (Claude Code)",
      answers: { doctor: { stdout: "Claude Code doctor\n\nRunning: npm-global (2.1.283)\nPath: /usr/lib/node_modules\n\nNo installation issues found." } },
    });
    const { client, pty } = await withRunner(path);

    const result = await ran(client, { tool: "claude", action: "update" });

    expect([result.method, result.command]).toEqual(["script", "claude update"]);
    expect(result.doctor).toEqual({
      outcome: "read",
      method: "npm",
      fields: [
        { name: "Running", value: "npm-global (2.1.283)" },
        { name: "Path", value: "/usr/lib/node_modules" },
      ],
      warnings: [],
    });
    expect(claude.calls()).toContainEqual(["doctor"]);
    expect(spawnedAt(pty).args).toEqual(["-l", "-c", "claude update"]);
  });
});

posix("a tool run", () => {
  it("is recorded as tool.run-started by the client session that ran it, naming the tool, the action, the method, the terminal and the command", async () => {
    const path = fakePath();
    programs(path, "brew");
    const { client } = await withRunner(path);

    const { terminal } = await ran(client, { tool: "doppler", action: "install" });

    const [started] = await eventsOf(client, "tool.run-started");
    expect(started?.payload).toEqual({ tool: "doppler", action: "install", method: "homebrew", terminalId: terminal.id, command: "brew install doppler" });
    expect(started?.actor.kind).toBe("client_session");
  });

  it("reads the PATH again when its command exits, probes the tool and verifies it, raising tools.updated for the row it changed and recording tool.run-finished with the exit code and the verification", async () => {
    const path = fakePath();
    programs(path, "brew");
    const { client, pty, reads } = await withRunner(path);
    const { terminal } = await ran(client, { tool: "gh", action: "install" });
    const readsBefore = reads.count;

    // What the install leaves: gh on the PATH, signed in.
    path.install("gh", { output: "gh version 2.63.2 (2024-12-05)", answers: { auth: { stderr: "github.com\n  ✓ Logged in to github.com account tester (keyring)" } } });
    spawnedAt(pty).exit(0);

    const finished = await eventOf(client, "tool.run-finished");
    expect(finished.payload).toEqual({
      tool: "gh",
      action: "install",
      method: "homebrew",
      terminalId: terminal.id,
      exitCode: 0,
      signal: null,
      cause: "exited",
      verification: { tool: "gh", outcome: "passed", reason: "gh auth status passed: signed in to github.com as tester." },
    });
    expect(finished.actor).toEqual({ kind: "system", id: "managed-tools" });
    expect(reads.count).toBeGreaterThan(readsBefore);
    const updated = (await eventsOf(client, "tools.updated")).at(-1);
    expect((updated?.payload as { tools: ManagedToolRow[] }).tools.map((row) => [row.tool, row.status])).toEqual([["gh", "current"]]);
    expect(rowOf((await client.request("tools.list", {})).tools, "gh")).toMatchObject({ version: "2.63.2", status: "current" });
  });

  it("records a failed command's exit code, and verifies the tool all the same", async () => {
    const path = fakePath();
    programs(path, "brew");
    const { client, pty } = await withRunner(path);
    await ran(client, { tool: "op", action: "install" });

    spawnedAt(pty).exit(1);

    expect((await eventOf(client, "tool.run-finished")).payload).toMatchObject({ tool: "op", exitCode: 1, cause: "exited", verification: { tool: "op", outcome: "not-installed" } });
  });

  it("runs one at a time on the environment: another while one is under way is conflict tool_run_in_progress naming it, and is taken once it has finished", async () => {
    const path = fakePath();
    programs(path, "brew");
    const { client, pty } = await withRunner(path);
    const first = await ran(client, { tool: "gh", action: "install" });

    const second = await run(client, { tool: "doppler", action: "install" });

    expect(second.receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { code: "conflict", data: { reason: "tool_run_in_progress", tool: "gh", terminalId: first.terminal.id } },
    });
    expect(pty.spawned).toHaveLength(1);
    spawnedAt(pty).exit(0);
    await eventOf(client, "tool.run-finished");
    expect((await run(client, { tool: "doppler", action: "install" })).receipt.status).toBe("accepted");
    expect(pty.spawned).toHaveLength(2);
  });

  it("answers one the row would refuse while a run is under way as the conflict too, since the run may change the row, and refuses it once that run has finished", async () => {
    const path = fakePath();
    programs(path, "brew");
    const { client, pty } = await withRunner(path);
    const first = await ran(client, { tool: "gh", action: "install" });

    const during = await run(client, { tool: "gh", action: "update" });

    expect(during.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "tool_run_in_progress", tool: "gh", terminalId: first.terminal.id } } });
    spawnedAt(pty).exit(0);
    await eventOf(client, "tool.run-finished");
    expect((await run(client, { tool: "gh", action: "update" })).receipt).toMatchObject({ status: "rejected", reason: "tool_not_runnable", error: { data: { tool: "gh", action: "update" } } });
    expect(pty.spawned).toHaveLength(1);
  });

  it("streams through terminals.subscribe, takes a password through terminals.write, and ends closed when terminals.close hangs it up", async () => {
    const path = fakePath();
    programs(path, "apt-get", "sudo", "curl");
    const { client, pty } = await withRunner(path);
    const { terminal } = await ran(client, { tool: "gh", action: "install" });
    const child = spawnedAt(pty);
    child.print("[sudo] password for tester: ");

    const view = await follow(client, terminal.id, 0);
    await view.until((v) => v.text.includes("password for tester"));
    await typeInto(client, terminal.id, "token-for-tests\r");
    expect(child.written).toEqual(["token-for-tests\r"]);
    expect((await terminalCommand(client, "terminals.close", { id: terminal.id })).result).toEqual({ id: terminal.id });
    expect(child.signals).toEqual(["SIGHUP"]);
    child.exit(129, 1);

    expect((await eventOf(client, "tool.run-finished")).payload).toMatchObject({ exitCode: 129, signal: 1, cause: "closed" });
  });

  it("is recorded finished, closed with no exit code and nothing verified, when the environment stops before its command exits", async () => {
    const path = fakePath();
    programs(path, "brew");
    const dataDir = realpathSync(tempDir());
    const first = await withRunner(path, { dataDir });
    const { terminal } = await ran(first.client, { tool: "gh", action: "install" });
    await first.t.close();

    const again = await withRunner(path, { dataDir });
    expect((await eventsOf(again.client, "tool.run-finished")).map((event) => event.payload)).toEqual([
      { tool: "gh", action: "install", method: "homebrew", terminalId: terminal.id, exitCode: null, signal: null, cause: "closed", verification: null },
    ]);
    // The environment that stopped took its run with it: another runs at once.
    expect((await run(again.client, { tool: "doppler", action: "install" })).receipt.status).toBe("accepted");
  });

  it("keeps its terminal's id for good: the same id is conflict exists, after a restart too; and pty_unavailable where no pseudo-terminal starts", async () => {
    const path = fakePath();
    programs(path, "brew");
    const dataDir = realpathSync(tempDir());
    const first = await withRunner(path, { dataDir });
    const { terminal } = await ran(first.client, { tool: "gh", action: "install" });
    spawnedAt(first.pty).exit(0);
    await eventOf(first.client, "tool.run-finished");
    await first.t.close();

    const again = await withRunner(path, { dataDir });
    const reused = await run(again.client, { tool: "doppler", action: "install", id: terminal.id });
    expect(reused.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exists", id: terminal.id } } });

    again.pty.unavailable = true;
    expect((await run(again.client, { tool: "doppler", action: "install" })).receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "pty_unavailable" } } });
    expect(again.pty.spawned).toEqual([]);
  });

  it("is admin's: a client session without admin is refused forbidden", async () => {
    const path = fakePath();
    programs(path, "brew");
    const { t, pty } = await withRunner(path);
    const terminalOnly = await narrowClient(t, ["read", "terminal"]);

    await expect(run(terminalOnly, { tool: "gh", action: "install" })).rejects.toMatchObject({ code: "forbidden", data: { scope: "admin" } });
    expect(pty.spawned).toEqual([]);
  });
});

/** A test command table: gh installed by a fake installer at `installer`, which asks for a password and drops a fake gh into `bin`. */
const installerTable = (installer: string): readonly ToolCommandEntry[] => [
  { tool: "gh", method: "script", platforms: ["darwin", "linux"], needs: ["fake-installer"], install: [[[installer, "gh"]]], update: [[[installer, "gh"]]] },
];

/** The fake installer: it asks for a password, refuses a wrong one, and otherwise writes a fake gh that answers --version and auth status. */
const writeInstaller = (file: string, bin: string): void => {
  const gh = join(bin, "gh");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      "printf 'Password: '",
      "read answer",
      `if [ "$answer" != "token-for-tests" ]; then echo "Sorry, try again."; exit 1; fi`,
      `printf '%s\\n' '#!/bin/sh' 'case "$1" in' '  --version) echo "gh version 2.63.2 (2024-12-05)" ;;' '  auth) echo "github.com" >&2; echo "  ✓ Logged in to github.com account tester (keyring)" >&2 ;;' 'esac' > '${gh}'`,
      `/bin/chmod 755 '${gh}'`,
      "echo 'Installed gh.'",
    ].join("\n") + "\n",
  );
  chmodSync(file, 0o755);
};

describe.runIf(process.platform !== "win32")("a tool run on a real pseudo-terminal", () => {
  it.skipIf(!ptyBuilt)("runs a fake installer that asks for a password, takes the one typed, and leaves the tool on the PATH, current and verified", async () => {
    const path = fakePath();
    const installer = join(path.root, "bin", "fake-installer");
    writeInstaller(installer, join(path.root, "bin"));
    const t = await start({
      terminals: { shell: () => ({ file: "/bin/sh", args: [] }) },
      managedTools: { readPath: async () => path.path(), packageOwner: scriptedPackageOwners(), commands: installerTable(installer) },
    });
    const client = await t.client();

    const { terminal, command } = await ran(client, { tool: "gh", action: "install" });
    expect(command).toBe(`${installer} gh`);
    const view = await follow(client, terminal.id, 0);
    await view.until((v) => v.text.includes("Password: "), "the password prompt");
    await typeInto(client, terminal.id, "token-for-tests\r");
    await view.until((v) => v.ended !== undefined, "the installer's exit");

    expect(view.text).toContain("Installed gh.");
    expect(view.exited).toEqual({ exitCode: 0, signal: null, cause: "exited" });
    const finished = await eventOf(client, "tool.run-finished");
    expect(finished.payload).toMatchObject({ tool: "gh", action: "install", method: "script", exitCode: 0, cause: "exited", verification: { tool: "gh", outcome: "passed" } });
    expect(rowOf((await client.request("tools.list", {})).tools, "gh")).toMatchObject({ path: join(path.root, "bin", "gh"), version: "2.63.2", status: "current" });
    expect(readFileSync(join(path.root, "bin", "gh"), "utf8")).toContain("gh version 2.63.2");
  });
});
