import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISCOVERY_PATH, DiscoveryDocument, MANAGED_TOOLS, type EventEnvelope, type EventFrame, type ManagedToolRow } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START, manualClock } from "../../test/clock.js";
import { fakeAdapter, signedInAs } from "../../test/fake-adapter.js";
import { fakeToolPath, scriptedPackageOwners, type FakeToolPath } from "../../test/fake-tools.js";
import { TEST_BUNDLED_CLAUDE, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { AUTH_HELP_WITHOUT_LOGIN, LOGIN_HELP, fakeSignInSpawner } from "../../test/signin.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The Managed tools registry through the primary seam (key-managers spec,
 * "Managed tools" and "Testing Decisions"; ADR 0026; #373): an in-process
 * environment and a real client over a real WebSocket, with fake CLIs on a
 * PATH the test sets, which the environment's scripted read of the login
 * shell answers, and scripted package-owner answers. The fakes are shell
 * scripts that answer `--version` as the test says, and record each call.
 */

const { onCleanup, tempDir } = useCleanups();

/** The fakes are `#!/bin/sh` scripts on a colon-joined PATH, linked with symlinks: POSIX only, as `system.lower.test.ts` is. */
const posix = describe.runIf(process.platform !== "win32");

const FIFTEEN_MINUTES = 15 * 60_000;

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** A fake PATH under a fresh directory, with its root's links resolved so realpaths compare. */
const fakePath = (): FakeToolPath => fakeToolPath(realpathSync(tempDir()));

/** An environment whose login shell answers the fake PATH, as it is when the environment reads it. */
const withTools = async (path: FakeToolPath, options: TestEnvironmentOptions = {}) => {
  const t = await start({ ...options, managedTools: { readPath: async () => path.path(), ...options.managedTools } });
  return { t, client: await t.client() };
};

const list = (client: WireClient, refresh?: boolean) => client.request("tools.list", refresh === undefined ? {} : { refresh });

const rowOf = (rows: readonly ManagedToolRow[], tool: string): ManagedToolRow => {
  const row = rows.find((candidate) => candidate.tool === tool);
  if (row === undefined) throw new Error(`No ${tool} row.`);
  return row;
};

/** The managed-tools notices on the environment stream after `afterSequence`. */
const toolsEvents = async (client: WireClient, afterSequence: number): Promise<EventEnvelope[]> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence });
  const events: EventEnvelope[] = [];
  for (;;) {
    const frame = await client.next((f) => "subscription" in f && f.subscription === subscription && (f.type === "event" || f.type === "synchronized"));
    if (frame.type === "synchronized") return events.filter((event) => event.type === "tools.updated");
    events.push((frame as EventFrame).event);
  }
};

posix("tools.list", () => {
  it("answers a row per tool in the table's order, each not installed with the Install action when nothing is on the PATH", async () => {
    const { client } = await withTools(fakePath());
    const answer = await list(client);
    expect(answer.probedAt).toBe(MANUAL_CLOCK_START);
    expect(answer.tools).toEqual(
      MANAGED_TOOLS.map((tool) => ({
        tool: tool.name,
        label: tool.label,
        path: null,
        realpath: null,
        version: null,
        latest: null,
        minimum: tool.minimum,
        method: null,
        status: "not-installed",
        action: "install",
        command: null,
      })),
    );
    expect(rowOf(answer.tools, "claude").label).toBe("claude in your terminal");
  });

  it("finds each tool on the login shell's PATH, runs its --version, and answers the version against its minimum", async () => {
    const path = fakePath();
    const tools = {
      claude: path.install("claude", { output: "2.1.283 (Claude Code)" }),
      bao: path.install("bao", { output: "OpenBao v2.1.1 (a1b2c3d4), built 2025-01-01T00:00:00Z" }),
      vault: path.install("vault", { output: "Vault v1.13.2 ('b9b773f1628260423e6cc9745531fd903cae853f'), built 2023-04-25T13:02:50Z" }),
      doppler: path.install("doppler", { output: "v3.76.0" }),
      op: path.install("op", { output: "2.30.0" }),
      bws: path.install("bws", { output: "bws 0.2.1" }),
      gh: path.install("gh", { output: "gh version 2.63.2 (2024-12-05)\nhttps://github.com/cli/cli/releases/tag/v2.63.2" }),
    };
    const { client } = await withTools(path);

    const rows = (await list(client)).tools;
    expect(Object.fromEntries(rows.map((row) => [row.tool, [row.version, row.status]]))).toEqual({
      claude: ["2.1.283", "current"],
      bao: ["2.1.1", "current"],
      vault: ["1.13.2", "below-minimum"],
      doppler: ["3.76.0", "current"],
      op: ["2.30.0", "current"],
      bws: ["0.2.1", "below-minimum"],
      gh: ["2.63.2", "current"],
    });
    // Placed by hand: claude, bao and doppler update themselves (#1833); the others run the vendor's command in a terminal pane, and vault none.
    const actions = { claude: "update", bao: "update", vault: "copy", doppler: "update", op: "terminal", bws: "terminal", gh: "terminal" } as const;
    for (const [name, tool] of Object.entries(tools)) {
      expect(rowOf(rows, name), name).toMatchObject({ path: tool.onPath, realpath: tool.file, method: "manual", action: actions[name as keyof typeof actions] });
      expect(tool.calls(), name).toEqual([["--version"]]);
    }
  });

  it("reads a version it cannot parse, or one a failing --version prints, as unknown: below a declared minimum, and current for claude, which has none", async () => {
    const path = fakePath();
    path.install("gh", { output: "gh version dev" });
    path.install("op", { output: "2.30.0", exitCode: 1 });
    path.install("claude", { output: "" });
    const { client } = await withTools(path);
    const rows = (await list(client)).tools;
    expect(rowOf(rows, "gh")).toMatchObject({ version: null, status: "below-minimum" });
    expect(rowOf(rows, "op")).toMatchObject({ version: null, status: "below-minimum" });
    expect(rowOf(rows, "claude")).toMatchObject({ version: null, status: "current" });
  });

  it("takes the first executable of a name on the PATH, passing over a file that is not executable and a relative entry", async () => {
    const path = fakePath();
    path.append("relative/bin");
    path.append(join(path.root, "later"));
    const first = path.install("doppler", { output: "v3.80.0" });
    path.install("doppler", { at: "later/doppler", link: null, output: "v9.0.0" });
    writeFileSync(join(path.root, "bin", "gh"), "not executable\n");
    chmodSync(join(path.root, "bin", "gh"), 0o644);
    const gh = path.install("gh", { at: "later/gh", link: null, output: "gh version 2.63.2 (2024-12-05)" });
    const { client } = await withTools(path);
    const rows = (await list(client)).tools;
    expect(rowOf(rows, "doppler")).toMatchObject({ path: first.onPath, version: "3.80.0" });
    expect(rowOf(rows, "gh")).toMatchObject({ path: gh.file, realpath: gh.file, version: "2.63.2" });
  });

  it("passes over a tool inside the harness's own resources, the bundled binary's package among them, however it is linked", async () => {
    const path = fakePath();
    // The bundled binary, linked from the PATH's first directory, and its package on the PATH next.
    const own = path.install("claude", { at: "sdk/claude", output: "2.1.281 (Claude Code)" });
    path.append(join(path.root, "sdk"));
    path.append(join(path.root, "tools"));
    const person = fakeToolPath(join(path.root, "person")).install("claude", { output: "2.1.283 (Claude Code)" });
    mkdirSync(join(path.root, "tools"));
    symlinkSync(person.file, join(path.root, "tools", "claude"));
    const { client } = await withTools(path, { signInProcess: { bundled: own.file } });
    expect(rowOf((await list(client)).tools, "claude")).toMatchObject({ path: join(path.root, "tools", "claude"), realpath: person.file, version: "2.1.283" });
    expect(own.calls()).toEqual([]);
  });

  it("gives up on a --version that has not answered within five seconds: the version is unknown", async () => {
    const path = fakePath();
    const op = path.install("op", { hang: true });
    const { t, client } = await withTools(path);
    const answer = list(client);
    await vi.waitFor(() => expect(op.calls()).toEqual([["--version"]]), { timeout: 30_000 });
    t.clock.advance(5_000);
    expect(rowOf((await answer).tools, "op")).toMatchObject({ path: op.onPath, version: null, status: "below-minimum", action: "terminal" });
  });

  it("is a read method: a client session with the read scope alone may call it", async () => {
    const { t } = await withTools(fakePath());
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    expect((await list(reader)).tools).toHaveLength(MANAGED_TOOLS.length);
  });
});

posix("the install method", () => {
  it("comes from the realpath's shape: a Homebrew Cellar or Caskroom, WinGet's packages or links, Scoop, mise, asdf, node_modules, and claude's native versions directory", async () => {
    const path = fakePath();
    const doppler = path.install("doppler", { at: "homebrew/Cellar/doppler/3.80.0/bin/doppler", output: "v3.80.0" });
    const op = path.install("op", { at: "homebrew/Caskroom/1password-cli/2.30.0/op", output: "2.30.0" });
    const gh = path.install("gh", { at: "AppData/Local/Microsoft/WinGet/Packages/GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe/bin/gh", output: "gh version 2.63.2 (2024-12-05)" });
    const bws = path.install("bws", { at: "scoop/apps/bws/0.5.0/bws", output: "bws 0.5.0" });
    const bao = path.install("bao", { at: ".local/share/mise/installs/openbao/2.1.1/bin/bao", output: "OpenBao v2.1.1" });
    const vault = path.install("vault", { at: ".asdf/installs/vault/1.15.0/bin/vault", output: "Vault v1.15.0" });
    const claude = path.install("claude", { at: "lib/node_modules/@anthropic-ai/claude-code/cli.js", output: "2.1.283 (Claude Code)" });
    const owners = scriptedPackageOwners();
    const { client } = await withTools(path, { managedTools: { packageOwner: owners } });

    const rows = (await list(client)).tools;
    expect(Object.fromEntries(rows.map((row) => [row.tool, [row.method, row.status, row.action]]))).toEqual({
      claude: ["npm", "current", "update"],
      bao: ["mise", "current", "update"],
      vault: ["asdf", "current", "copy"],
      doppler: ["homebrew", "current", "update"],
      op: ["homebrew", "current", "update"],
      bws: ["scoop", "current", "update"],
      gh: ["winget", "current", "update"],
    });
    expect(rowOf(rows, "doppler").realpath).toBe(doppler.file);
    for (const tool of [op, gh, bws, bao, vault, claude]) expect(rows.some((row) => row.realpath === tool.file)).toBe(true);
    // A shape answers without asking the package manager.
    expect(owners.asked).toEqual([]);
  });

  it("comes from the shape of the path on the PATH when the realpath has none: a mise or asdf shim, WinGet's links", async () => {
    const path = fakePath();
    const mise = join(path.root, ".local/share/mise/shims");
    const asdf = join(path.root, ".asdf/shims");
    const links = join(path.root, "AppData/Local/Microsoft/WinGet/Links");
    for (const directory of [mise, asdf, links]) {
      mkdirSync(directory, { recursive: true });
      path.append(directory);
    }
    mkdirSync(join(path.root, ".local/share/mise/installs/doppler"), { recursive: true });
    // mise's shims are links to mise itself, driven where mise has the tool's own package; asdf's are scripts of their own.
    const miseBinary = fakeToolPath(join(path.root, "mise-itself")).install("mise", { output: "2025.1.0 linux-x64" });
    symlinkSync(miseBinary.file, join(mise, "doppler"));
    fakeToolPath(join(path.root, "asdf-shim")).install("vault", { output: "Vault v1.15.0" });
    symlinkSync(join(path.root, "asdf-shim/bin/vault"), join(asdf, "vault"));
    const op = fakeToolPath(join(path.root, "op-install")).install("op", { output: "2.30.0" });
    symlinkSync(op.file, join(links, "op"));
    const { client } = await withTools(path, { managedTools: { packageOwner: scriptedPackageOwners({ [miseBinary.file]: { manager: "dpkg", package: "mise" } }) } });

    const rows = (await list(client)).tools;
    expect(rowOf(rows, "doppler")).toMatchObject({ path: join(mise, "doppler"), method: "mise", action: "update" });
    expect(rowOf(rows, "vault")).toMatchObject({ path: join(asdf, "vault"), method: "asdf" });
    expect(rowOf(rows, "op")).toMatchObject({ path: join(links, "op"), method: "winget", action: "update" });
  });

  it("is claude's native installer when claude resolves into its versions directory, and only for claude", async () => {
    const path = fakePath();
    const claude = path.install("claude", { at: ".local/share/claude/versions/2.1.283", output: "2.1.283 (Claude Code)" });
    const gh = path.install("gh", { at: "claude/versions/gh", output: "gh version 2.63.2 (2024-12-05)" });
    const { client } = await withTools(path);
    const rows = (await list(client)).tools;
    expect(rowOf(rows, "claude")).toMatchObject({ realpath: claude.file, method: "native", status: "current", action: "update" });
    expect(rowOf(rows, "gh")).toMatchObject({ realpath: gh.file, method: "manual" });
  });

  it("comes from the system package that owns the realpath, dpkg's as apt and rpm's as dnf; else manual, or unknown when the owner could not be asked", async () => {
    const path = fakePath();
    const gh = path.install("gh", { output: "gh version 2.63.2 (2024-12-05)" });
    const op = path.install("op", { output: "2.30.0" });
    const bws = path.install("bws", { output: "bws 0.3.0" });
    const doppler = path.install("doppler", { output: "v3.76.0" });
    const owners = scriptedPackageOwners({ [gh.file]: { manager: "dpkg", package: "gh" }, [op.file]: { manager: "rpm", package: "1password-cli" }, [bws.file]: "unknown" });
    const { client } = await withTools(path, { managedTools: { packageOwner: owners } });

    const rows = (await list(client)).tools;
    expect(Object.fromEntries(["gh", "op", "bws", "doppler"].map((tool) => [tool, [rowOf(rows, tool).method, rowOf(rows, tool).status, rowOf(rows, tool).action]]))).toEqual({
      gh: ["apt", "current", "update"],
      op: ["dnf", "current", "update"],
      bws: ["unknown", "method-unknown", "terminal"],
      doppler: ["manual", "current", "update"],
    });
    expect(owners.asked.sort()).toEqual([gh.file, op.file, bws.file, doppler.file].sort());
  });

  it("offers Update where the closed command table updates the tool installed that way (#376), else Run in a terminal pane (#1833): never a command for vault, and bws from Homebrew or gh from npm in a terminal pane", async () => {
    const path = fakePath();
    path.install("vault", { at: "homebrew/Cellar/vault/1.15.0/bin/vault", output: "Vault v1.15.0" });
    path.install("bws", { at: "homebrew/Cellar/bws/1.0.0/bin/bws", output: "bws 1.0.0" });
    path.install("gh", { at: "lib/node_modules/gh/bin/gh", output: "gh version 2.63.2 (2024-12-05)" });
    const claude = path.install("claude", { output: "2.1.283 (Claude Code)" });
    const { client } = await withTools(path, { managedTools: { packageOwner: scriptedPackageOwners({ [claude.file]: { manager: "dpkg", package: "claude-code" } }) } });

    const rows = (await list(client)).tools;
    expect(Object.fromEntries(["vault", "bws", "gh", "claude"].map((tool) => [tool, [rowOf(rows, tool).method, rowOf(rows, tool).action]]))).toEqual({
      vault: ["homebrew", "copy"],
      bws: ["homebrew", "terminal"],
      gh: ["npm", "terminal"],
      claude: ["apt", "update"],
    });
  });

  it("says below-minimum before method-unknown: a tool too old to use needs attention first", async () => {
    const path = fakePath();
    const bws = path.install("bws", { output: "bws 0.2.1" });
    const { client } = await withTools(path, { managedTools: { packageOwner: scriptedPackageOwners({ [bws.file]: "unknown" }) } });
    expect(rowOf((await list(client)).tools, "bws")).toMatchObject({ method: "unknown", status: "below-minimum", action: "terminal" });
  });
});

posix("the probe's cadence", () => {
  it("probes at start, and again on a refresh at most every fifteen minutes; a list without refresh never probes", async () => {
    const path = fakePath();
    const gh = path.install("gh", { output: "gh version 2.39.2 (2023-11-01)" });
    let reads = 0;
    const { t, client } = await withTools(path, {
      managedTools: {
        readPath: async () => {
          reads += 1;
          return path.path();
        },
      },
    });
    expect(rowOf((await list(client)).tools, "gh")).toMatchObject({ version: "2.39.2", status: "below-minimum" });
    expect(reads).toBe(1);

    path.install("gh", { output: "gh version 2.63.2 (2024-12-05)" });
    t.clock.advance(FIFTEEN_MINUTES - 1);
    const early = await list(client, true);
    expect(early.probedAt).toBe(MANUAL_CLOCK_START);
    expect(rowOf(early.tools, "gh").version).toBe("2.39.2");
    t.clock.advance(1);
    expect(rowOf((await list(client)).tools, "gh").version).toBe("2.39.2");
    expect(reads).toBe(1);
    expect(gh.calls()).toEqual([]);

    const refreshed = await list(client, true);
    expect(refreshed.probedAt).toBe(new Date(Date.parse(MANUAL_CLOCK_START) + FIFTEEN_MINUTES).toISOString());
    expect(rowOf(refreshed.tools, "gh")).toMatchObject({ version: "2.63.2", status: "current" });
    expect(reads).toBe(2);
    expect(gh.calls()).toEqual([["--version"]]);
  });

  it("reads the login shell's PATH again on each probe, so a tool installed since is found", async () => {
    const path = fakePath();
    const { t, client } = await withTools(path);
    expect(rowOf((await list(client)).tools, "doppler").status).toBe("not-installed");

    const later = join(path.root, "later");
    mkdirSync(later);
    path.append(later);
    const doppler = fakeToolPath(join(path.root, "later-tools")).install("doppler", { output: "v3.76.0" });
    symlinkSync(doppler.file, join(later, "doppler"));
    t.clock.advance(FIFTEEN_MINUTES);
    expect(rowOf((await list(client, true)).tools, "doppler")).toMatchObject({ path: join(later, "doppler"), version: "3.76.0", status: "current" });
  });

  it("falls back on the environment's own PATH when the login shell's cannot be read", async () => {
    const path = fakePath();
    path.install("doppler", { output: "v3.76.0" });
    const { client } = await withTools(path, {
      managedTools: {
        readPath: async () => {
          throw new Error("the login shell did not answer");
        },
        hostEnv: { PATH: path.path() },
      },
    });
    expect(rowOf((await list(client)).tools, "doppler")).toMatchObject({ version: "3.76.0" });
  });
});

posix("tools.updated", () => {
  it("is not raised by a first start that finds no tool: a tool the log never carried is not installed", async () => {
    const { client } = await withTools(fakePath());
    await list(client);
    expect(await toolsEvents(client, 0)).toEqual([]);
  });

  it("is raised by a probe that changes rows, carrying those rows; a probe that changes nothing raises none", async () => {
    const path = fakePath();
    path.install("gh", { output: "gh version 2.63.2 (2024-12-05)" });
    const { t, client } = await withTools(path);
    const first = await list(client);

    // The first start found gh; the others are not installed, which a tool the log never carried is.
    const events = await toolsEvents(client, 0);
    expect(events.map((event) => event.payload)).toEqual([{ tools: [rowOf(first.tools, "gh")] }]);
    expect(events[0]?.actor).toEqual({ kind: "system", id: "managed-tools" });

    const from = t.env.log.head();
    t.clock.advance(FIFTEEN_MINUTES);
    await list(client, true);
    expect(await toolsEvents(client, from)).toEqual([]);

    path.install("doppler", { output: "v3.76.0" });
    t.clock.advance(FIFTEEN_MINUTES);
    const changed = await list(client, true);
    expect((await toolsEvents(client, from)).map((event) => event.payload)).toEqual([{ tools: [rowOf(changed.tools, "doppler")] }]);
  });

  it("is not raised again by the first probe after a restart that finds the rows as they were", async () => {
    const path = fakePath();
    path.install("gh", { output: "gh version 2.63.2 (2024-12-05)" });
    const dataDir = join(tempDir(), "data");
    const clock = manualClock();
    const before = await startTestEnvironment({ dataDir, clock, managedTools: { readPath: async () => path.path() } });
    const firstRows = (await (await before.client()).request("tools.list", {})).tools;
    await before.close();

    path.install("op", { output: "2.30.0" });
    const { client } = await withTools(path, { dataDir, clock });
    const rows = (await list(client)).tools;
    expect((await toolsEvents(client, 0)).map((event) => event.payload)).toEqual([{ tools: [rowOf(firstRows, "gh")] }, { tools: [rowOf(rows, "op")] }]);
  });
});

posix("the sign-in director's managed tool", () => {
  /** An environment holding one Claude account, `work`, whose bundled binary runs no sign-in, so a sign-in runs the managed tool. */
  const withSignIn = async (path: FakeToolPath) => {
    const spawner = fakeSignInSpawner();
    spawner.probe = (executable) => (executable === TEST_BUNDLED_CLAUDE ? { code: 0, stdout: AUTH_HELP_WITHOUT_LOGIN } : { code: 0, stdout: LOGIN_HELP });
    const workDirectory = join(tempDir(), "work");
    mkdirSync(workDirectory);
    const { t, client } = await withTools(path, {
      accounts: [{ id: "work", provider: "claude", directory: workDirectory }],
      adapter: fakeAdapter({ provider: "claude", status: () => signedInAs(null) }),
      signInProcess: { spawn: spawner.spawn },
    });
    await client.request("accounts.signin.start", { commandId: randomUUID(), accountId: "work" });
    return { t, client, spawner };
  };

  it("is the registry's claude row: a sign-in the bundled binary cannot run runs the claude the registry found", async () => {
    const path = fakePath();
    const claude = path.install("claude", { at: ".local/share/claude/versions/2.1.283", output: "2.1.283 (Claude Code)" });
    const { spawner } = await withSignIn(path);
    const login = await spawner.nextLogin();
    expect(login.command).toBe(claude.onPath);
    expect(login.argv).toEqual(["auth", "login"]);
    expect(spawner.probes().map((probe) => probe.command)).toEqual([TEST_BUNDLED_CLAUDE, claude.onPath]);
  });

  it("is none when the registry found no claude, and the sign-in fails pointing at the fallback command", async () => {
    const { t, spawner } = await withSignIn(fakePath());
    await vi.waitFor(
      () => {
        const ended = t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "signin.updated").at(-1)?.payload;
        expect(ended).toMatchObject({ state: "failed", error: expect.stringMatching(/The managed tool claude is not on the PATH\. Run the fallback command/) });
      },
      { timeout: 30_000 },
    );
    expect(spawner.logins()).toEqual([]);
  });
});

posix("the managedTools capability flag", () => {
  it("is in hello and the discovery document", async () => {
    const { t, client } = await withTools(fakePath());
    expect(client.hello.capabilities).toContain("managedTools");
    const response = await fetch(`http://${t.address.host}:${t.address.port}${DISCOVERY_PATH}`);
    expect(DiscoveryDocument.parse(await response.json()).capabilities).toContain("managedTools");
  });
});
