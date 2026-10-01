import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ManagedToolRow } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { latestNoticed, noticedRows, startFakeReleaseSources, type FakeReleaseSources } from "../../test/fake-release-sources.js";
import { fakeToolPath, type FakeToolPath } from "../../test/fake-tools.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { MANAGED_TOOLS_ACTOR } from "./registry.js";

/**
 * The latest version of each managed tool through the primary seam
 * (key-managers spec, "Managed tools"; ADR 0026; #374): an in-process
 * environment and a real client over a real WebSocket, fake CLIs on a PATH
 * the test sets, and every release source faked on one loopback server on
 * port 0, which the environment is pointed at. Time is the manual clock's:
 * the day between fetches, and the ten seconds a fetch may take.
 */

const { onCleanup, tempDir } = useCleanups();

/** The fakes are `#!/bin/sh` scripts on a colon-joined PATH: POSIX only, as the Managed tools suites are. */
const posix = describe.runIf(process.platform !== "win32");

const DAY = 24 * 60 * 60_000;
const FIFTEEN_MINUTES = 15 * 60_000;

const sources = async (): Promise<FakeReleaseSources> => {
  const started = await startFakeReleaseSources();
  onCleanup(() => started.close());
  return started;
};

/** A fake PATH under a fresh directory, with its root's links resolved so realpaths compare. */
const fakePath = (): FakeToolPath => fakeToolPath(realpathSync(tempDir()));

/** An environment whose login shell answers the fake PATH, reading its tools' latest versions from the fake sources. */
const withTools = async (path: FakeToolPath, released: FakeReleaseSources, options: TestEnvironmentOptions = {}) => {
  const t = await startTestEnvironment({ ...options, managedTools: { readPath: async () => path.path(), releaseOrigins: released.origins, ...options.managedTools } });
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};

const list = (client: WireClient, refresh?: boolean) => client.request("tools.list", refresh === undefined ? {} : { refresh });

/** The rows by tool, each as the fields a test compares. */
const byTool = (rows: readonly ManagedToolRow[], ...fields: readonly (keyof ManagedToolRow)[]): Record<string, unknown> =>
  Object.fromEntries(rows.map((row) => [row.tool, fields.length === 1 ? row[fields[0] as keyof ManagedToolRow] : fields.map((field) => row[field])]));

posix("a tool's latest version", () => {
  it("is fetched on a refresh from the source its install method matches: the Homebrew API, the npm registry, WinGet's manifests; a row behind it is update-available", async () => {
    const released = await sources();
    const path = fakePath();
    path.install("gh", { at: "homebrew/Cellar/gh/2.63.2/bin/gh", output: "gh version 2.63.2 (2024-12-05)" });
    path.install("op", { at: "homebrew/Caskroom/1password-cli/2.39.0/op", output: "2.39.0" });
    path.install("doppler", { at: "AppData/Local/Microsoft/WinGet/Packages/Doppler.doppler_Microsoft.Winget.Source_8wekyb3d8bbwe/doppler", output: "v3.76.0" });
    path.install("claude", { at: "lib/node_modules/@anthropic-ai/claude-code/cli.js", output: "2.1.283 (Claude Code)" });
    const reads = {
      gh: released.formula("gh", "2.101.0"),
      op: released.cask("1password-cli", "2.39.0"),
      doppler: released.winget("Doppler.doppler", ["3.75.3", "3.76.10", "3.76.6", "4.0.0-beta.1"], ["README.md"]),
      claude: released.npm("@anthropic-ai/claude-code", "2.1.285"),
    };
    const { t, client } = await withTools(path, released);

    // A client never fetches: the rows answer the latest cached, none yet, and nothing was read.
    const before = await list(client);
    expect(byTool(before.tools, "latest", "status")).toMatchObject({ gh: [null, "current"], op: [null, "current"], doppler: [null, "current"], claude: [null, "current"] });
    expect(released.server.requests).toEqual([]);

    const from = t.env.log.head();
    await list(client, true);
    const updated = await latestNoticed(client, from, "gh");

    const after = (await list(client)).tools;
    expect(byTool(after, "method", "version", "latest", "status")).toEqual({
      claude: ["npm", "2.1.283", "2.1.285", "update-available"],
      bao: [null, null, null, "not-installed"],
      vault: [null, null, null, "not-installed"],
      doppler: ["winget", "3.76.0", "3.76.10", "update-available"],
      op: ["homebrew", "2.39.0", "2.39.0", "current"],
      bws: [null, null, null, "not-installed"],
      gh: ["homebrew", "2.63.2", "2.101.0", "update-available"],
    });
    // The notice carried every row the latest versions changed, as tools.list now answers them.
    expect(updated).toEqual(after.filter((row) => ["claude", "doppler", "op", "gh"].includes(row.tool)));
    for (const [tool, read] of Object.entries(reads)) expect(released.reads(read), tool).toBe(1);
    // Only the installed tools' sources were read.
    expect(released.server.requests).toHaveLength(4);
  });

  it("is otherwise read from the vendor's release feed: GitHub releases for bao, doppler, bws and gh, past drafts, prereleases and other products' tags; Claude Code's latest channel; 1Password's feed; HashiCorp's releases", async () => {
    const released = await sources();
    const path = fakePath();
    const bao = path.install("bao", { output: "OpenBao v2.6.3" });
    path.install("doppler", { at: ".local/share/mise/installs/doppler/3.76.6/bin/doppler", output: "v3.76.6" });
    path.install("bws", { output: "bws 1.0.0" });
    path.install("gh", { at: "scoop/apps/gh/2.63.2/gh", output: "gh version 2.63.2 (2024-12-05)" });
    path.install("claude", { at: ".local/share/claude/versions/2.1.283", output: "2.1.283 (Claude Code)" });
    path.install("op", { output: "2.38.0" });
    path.install("vault", { output: "Vault v1.15.0" });
    released.github("openbao/openbao", [{ tag: "v2.8.0-beta20261001", prerelease: true }, { tag: "v2.9.0", draft: true }, "v2.7.0", "v2.6.3"]);
    released.github("DopplerHQ/cli", ["3.76.6", "3.76.5"]);
    released.github("bitwarden/sdk-sm", ["rust-v3.0.0", "napi-v3.0.0", "bws-v2.1.0", "python-v2.1.0", "bws-v2.0.0"]);
    released.github("cli/cli", ["v2.102.0", "v2.101.0"]);
    released.claude("2.1.285");
    released.onePassword("2.39.0");
    released.hashicorp("vault", "2.1.1");
    // bao is owned by the system's package manager: its vendor's repository publishes what its GitHub releases do.
    const { t, client } = await withTools(path, released, { managedTools: { packageOwner: async (file) => (file === bao.file ? { kind: "owned", manager: "dpkg", package: "openbao" } : { kind: "none" }) } });

    const from = t.env.log.head();
    await list(client, true);
    await latestNoticed(client, from, "bao");

    expect(byTool((await list(client)).tools, "method", "latest", "status")).toEqual({
      claude: ["native", "2.1.285", "update-available"],
      bao: ["apt", "2.7.0", "update-available"],
      vault: ["manual", "2.1.1", "update-available"],
      doppler: ["mise", "3.76.6", "current"],
      op: ["manual", "2.39.0", "update-available"],
      bws: ["manual", "2.1.0", "update-available"],
      gh: ["scoop", "2.102.0", "update-available"],
    });
  });

  it("is fetched at most once a day per tool: a refresh within the day fetches only a tool never fetched, and one a day on fetches again; a latest that changes no row raises no tools.updated", async () => {
    const released = await sources();
    const path = fakePath();
    path.install("gh", { output: "gh version 2.63.2 (2024-12-05)" });
    const gh = released.github("cli/cli", ["v2.101.0"]);
    const doppler = released.github("DopplerHQ/cli", ["3.76.6"]);
    const bws = released.github("bitwarden/sdk-sm", ["bws-v2.1.0"]);
    const { t, client } = await withTools(path, released);

    let from = t.env.log.head();
    await list(client, true);
    expect(await latestNoticed(client, from, "gh")).toMatchObject([{ tool: "gh", latest: "2.101.0", status: "update-available" }]);

    // Fifteen minutes on, a refresh probes and finds doppler: only it is fetched.
    t.clock.advance(FIFTEEN_MINUTES);
    path.install("doppler", { output: "v3.76.0" });
    from = t.env.log.head();
    await list(client, true);
    expect(await latestNoticed(client, from, "doppler")).toMatchObject([{ tool: "doppler", latest: "3.76.6" }]);
    expect([released.reads(gh), released.reads(doppler)]).toEqual([1, 1]);

    // A day after gh's fetch, it is fetched again, and finds what it found; doppler's day is not up. bws is new.
    t.clock.advance(DAY - FIFTEEN_MINUTES);
    path.install("bws", { output: "bws 2.1.0" });
    from = t.env.log.head();
    await list(client, true);
    expect(await latestNoticed(client, from, "bws")).toMatchObject([{ tool: "bws", latest: "2.1.0", status: "current" }]);
    expect([released.reads(gh), released.reads(doppler), released.reads(bws)]).toEqual([2, 1, 1]);
    expect(byTool((await list(client)).tools, "latest")).toMatchObject({ gh: "2.101.0", doppler: "3.76.6", bws: "2.1.0" });
  });

  it("is kept on the environment across a restart, which neither fetches it again within the day nor notices it again", async () => {
    const released = await sources();
    const path = fakePath();
    path.install("gh", { output: "gh version 2.63.2 (2024-12-05)" });
    const gh = released.github("cli/cli", ["v2.101.0"]);
    released.github("DopplerHQ/cli", ["3.76.6"]);
    const dataDir = join(tempDir(), "data");
    const clock = manualClock();
    const before = await withTools(path, released, { dataDir, clock });
    await list(before.client, true);
    await latestNoticed(before.client, 0, "gh");
    const closedAt = before.t.env.log.head();
    await before.t.close();

    clock.advance(60 * 60_000);
    path.install("doppler", { output: "v3.76.0" });
    const { t, client } = await withTools(path, released, { dataDir, clock });
    expect(byTool((await list(client)).tools, "latest", "status")).toMatchObject({ gh: ["2.101.0", "update-available"], doppler: [null, "current"] });
    const from = t.env.log.head();
    await list(client, true);
    expect(await latestNoticed(client, from, "doppler")).toMatchObject([{ tool: "doppler", latest: "3.76.6" }]);
    expect(released.reads(gh)).toBe(1);
    // Since the restart, only doppler, found since, was noticed: gh's row, its latest among it, is as the log last carried it.
    const notices = t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "tools.updated" && event.sequence > closedAt);
    expect(notices.flatMap((event) => noticedRows(event)).map((row) => row.tool)).toEqual(["doppler", "doppler"]);
  });

  it("is none in a row the log carried from before rows had one, so the first start after the update notices nothing new", async () => {
    const released = await sources();
    const path = fakePath();
    const dataDir = join(tempDir(), "data");
    const clock = manualClock();
    const before = await withTools(fakePath(), released, { dataDir, clock });
    await list(before.client);
    // gh's row as a probe before #374 carried it: no latest, and no command, which an Update row carries none of (#426).
    const gh = path.install("gh", { at: "homebrew/Cellar/gh/2.63.2/bin/gh", output: "gh version 2.63.2 (2024-12-05)" });
    const recorded = { tool: "gh", label: "GitHub CLI", path: gh.onPath, realpath: gh.file, version: "2.63.2", minimum: "2.40.0", method: "homebrew", status: "current", action: "update" };
    before.t.env.log.append({ kind: "environment", id: before.t.env.id }, [{ type: "tools.updated", payload: { tools: [recorded] } }], { actor: MANAGED_TOOLS_ACTOR });
    const closedAt = before.t.env.log.head();
    await before.t.close();

    const { t, client } = await withTools(path, released, { dataDir, clock });
    expect((await list(client)).tools.find((row) => row.tool === "gh")).toEqual({ ...recorded, latest: null, command: null });
    expect(t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "tools.updated" && event.sequence > closedAt)).toEqual([]);
  });

  it("is left as last known, or none, by a fetch that fails or has not answered within ten seconds, which counts as the day's fetch", async () => {
    const released = await sources();
    const path = fakePath();
    path.install("op", { output: "2.30.0" });
    const op = released.onePassword("2.39.0");
    const gh = released.github("cli/cli", []);
    released.fail(gh);
    const doppler = released.github("DopplerHQ/cli", ["3.76.6"]);
    const { t, client } = await withTools(path, released);

    let from = t.env.log.head();
    await list(client, true);
    expect(await latestNoticed(client, from, "op")).toMatchObject([{ tool: "op", latest: "2.39.0" }]);

    // An hour on, gh and doppler are found: gh's source fails, so it has none.
    t.clock.advance(60 * 60_000);
    path.install("gh", { output: "gh version 2.63.2 (2024-12-05)" });
    path.install("doppler", { output: "v3.76.0" });
    from = t.env.log.head();
    await list(client, true);
    expect(await latestNoticed(client, from, "doppler")).toMatchObject([{ tool: "doppler", latest: "3.76.6" }]);
    expect(byTool((await list(client)).tools, "latest")).toMatchObject({ gh: null, op: "2.39.0", doppler: "3.76.6" });

    // A day after op's fetch, its source holds its answer past ten seconds.
    t.clock.advance(DAY - 60 * 60_000);
    released.hold(op);
    await list(client, true);
    await vi.waitFor(() => expect(released.reads(op)).toBe(2), { timeout: WAIT_MS });
    t.clock.advance(10_000);

    // A day after gh's and doppler's: gh answers now, and doppler's source fails. op's slow fetch was its day's.
    t.clock.advance(60 * 60_000);
    released.github("cli/cli", ["v2.101.0"]);
    released.fail(doppler);
    from = t.env.log.head();
    await list(client, true);
    expect(await latestNoticed(client, from, "gh")).toMatchObject([{ tool: "gh", latest: "2.101.0" }]);
    expect(byTool((await list(client)).tools, "latest", "status")).toMatchObject({ gh: ["2.101.0", "update-available"], op: ["2.39.0", "update-available"], doppler: ["3.76.6", "update-available"] });
    expect([released.reads(op), released.reads(gh), released.reads(doppler)]).toEqual([2, 2, 2]);
  });
});
