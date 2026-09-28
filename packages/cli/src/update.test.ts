import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError, PROTOCOL_VERSION, UpdatesStatus, registry } from "@agent-harness/contracts";
import { HARNESS_VERSION } from "@agent-harness/environment";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_CLAUDE_CODE_VERSION, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../environment/test/helper.js";
import { testLauncher } from "../../environment/test/launcher.js";
import { runCli, type CliContext } from "./cli.js";
import { renderUpdatesStatus } from "./update.js";

/**
 * The `update` verbs that reach the local environment (launcher-update spec,
 * "Settings, methods, notices and flags": CLI verbs), against the in-process
 * environment: `update status` prints `updates.status` as text or JSON, and
 * `update settings` writes the update settings through
 * `updates.settings.set`, each through a local client session exchanged from
 * the bootstrap grant and revoked after, as `pair` does.
 */

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  cleanups.push(() => t.close());
  return t;
};

/** The CLI in-process, its output captured. */
const harness = () => {
  let out = "";
  let err = "";
  const context: Partial<CliContext> = {
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    net: { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket },
  };
  return { context, out: () => out, err: () => err };
};

const run = async (args: readonly string[]) => {
  const cli = harness();
  const code = await runCli(args, cli.context);
  return { code, out: cli.out(), err: cli.err() };
};

/** The labels of the client sessions still live on `t`. */
const liveLabels = async (t: TestEnvironment): Promise<string[]> => {
  const admin = await t.client();
  const labels = (await admin.request("access.sessions.list", { live: true })).sessions.map((session) => session.label);
  await admin.close();
  return labels;
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe("agent-harness update status", () => {
  it("prints what runs here and that nothing manages its updates under a foreground serve, saying why", async () => {
    const t = await start({ harnessVersion: "0.4.1" });
    const { code, out, err } = await run(["update", "status", "--data-dir", t.dataDir]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain(`Version: agent-harness 0.4.1, protocol ${PROTOCOL_VERSION}`);
    expect(out).toContain(`Claude Code (bundled): ${TEST_CLAUDE_CODE_VERSION}`);
    expect(out).toMatch(/Updates: not managed: serve runs in the foreground/);
    expect(out).toContain("Pending update: none");
    expect(out).not.toContain("Installed:");
  });

  it("prints the launcher with its version and the versions installed, under a launcher", async () => {
    const launcher = testLauncher({
      present: true,
      versions: () => ({ type: "versions", installed: ["0.4.0", "0.4.1"], launcherVersion: "0.4.0", launcherProtocol: 1 }),
    });
    const t = await start({ harnessVersion: "0.4.1", launcher });
    const { code, out } = await run(["update", "status", "--data-dir", t.dataDir]);
    expect(code).toBe(0);
    expect(out).toContain("Updates: managed by its launcher, version 0.4.0");
    expect(out).toContain("Installed: 0.4.0, 0.4.1");
  });

  it("prints the document updates.status answers as JSON with --json", async () => {
    const t = await start({ containerDetector: { inContainer: () => true } });
    const { code, out } = await run(["update", "status", "--json", "--data-dir", t.dataDir]);
    expect(code).toBe(0);
    const printed = UpdatesStatus.parse(JSON.parse(out));
    const admin = await t.client();
    expect(printed).toEqual(await admin.request("updates.status", {}));
    expect(printed).toMatchObject({ version: HARNESS_VERSION, manager: { kind: "outside", lastPoll: null } });
  });

  it("revokes its own local client session before it exits", async () => {
    const t = await start();
    expect((await run(["update", "status", "--data-dir", t.dataDir])).code).toBe(0);
    const admin = await t.client();
    const own = (await admin.request("access.sessions.list", {})).sessions.filter((session) => session.label === "agent-harness update status");
    expect(own).toHaveLength(1);
    expect(own[0]?.revokedAt).not.toBeNull();
    expect(await liveLabels(t)).not.toContain("agent-harness update status");
  });
});

describe("agent-harness update settings", () => {
  it("sets any of the five update settings from flags through updates.settings.set, and prints all five", async () => {
    const t = await start();
    const { code, out, err } = await run([
      "update",
      "settings",
      "--auto-update",
      "off",
      "--channel",
      "beta",
      "--pinned-version",
      "0.4.2",
      "--idle-window-minutes",
      "25",
      "--deferral-cap-hours",
      "48",
      "--data-dir",
      t.dataDir,
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const expected = {
      "updates.autoUpdate": false,
      "updates.channel": "beta",
      "updates.pinnedVersion": "0.4.2",
      "updates.idleWindowMinutes": 25,
      "updates.deferralCapHours": 48,
    };
    const admin = await t.client();
    expect((await admin.request("settings.get", { keys: Object.keys(expected) as never })).values).toEqual(expected);
    expect(out).toContain("Auto-update: off");
    expect(out).toContain("Channel: beta");
    expect(out).toContain("Pinned version: 0.4.2");
    expect(out).toContain("Idle window: 25 minutes");
    expect(out).toContain("Deferral cap: 48 hours");
    const [updated] = t.env.log.readStream({ kinds: ["settings"] });
    expect(updated).toMatchObject({ type: "settings.updated", payload: { values: expected } });
  });

  it("sets one key alone, leaving the others as they were, and clears a pin with none", async () => {
    const t = await start();
    expect((await run(["update", "settings", "--pinned-version", "0.4.2", "--data-dir", t.dataDir])).code).toBe(0);
    const { code, out } = await run(["update", "settings", "--pinned-version", "none", "--data-dir", t.dataDir]);
    expect(code).toBe(0);
    expect(out).toContain("Pinned version: none");
    expect(out).toContain("Channel: stable");
    const admin = await t.client();
    expect((await admin.request("settings.get", { keys: ["updates.pinnedVersion", "updates.autoUpdate"] })).values).toEqual({
      "updates.pinnedVersion": null,
      "updates.autoUpdate": true,
    });
  });

  it("revokes its own local client session before it exits", async () => {
    const t = await start();
    expect((await run(["update", "settings", "--channel", "beta", "--data-dir", t.dataDir])).code).toBe(0);
    expect(await liveLabels(t)).not.toContain("agent-harness update settings");
  });

  it("prints its usage and exits 2, setting nothing, on a value a key does not take, an unknown flag, or no flag", async () => {
    for (const args of [
      ["--auto-update", "maybe"],
      ["--channel", "nightly"],
      ["--pinned-version", "v0.4.2"],
      ["--idle-window-minutes", "0"],
      ["--idle-window-minutes", "121"],
      ["--idle-window-minutes", "2.5"],
      ["--deferral-cap-hours", "169"],
      ["--deferral-cap-hours", "a day"],
      ["--drain-cap", "30"],
      [],
    ]) {
      const { code, err } = await run(["update", "settings", ...args, "--data-dir", "/nonexistent/agent-harness"]);
      expect(code, args.join(" ")).toBe(2);
      expect(err, args.join(" ")).toContain("agent-harness update settings");
    }
  });
});

describe("the status as update status prints it", () => {
  const updateId = "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20";
  const at = "2026-09-28T10:00:00.000Z";
  const later = "2026-09-29T10:00:00.000Z";
  const base: UpdatesStatus = {
    version: "0.4.2",
    protocolVersion: 1,
    bundledClaudeCodeVersion: null,
    manager: { kind: "outside", lastPoll: at },
    newest: "0.5.0",
    lastCheck: { at, result: "failed", reason: "unreachable", message: "The forge did not answer." },
    pending: { state: "current" },
    lastOutcome: { outcome: "failed", updateId, fromVersion: "0.4.2", toVersion: "0.5.0", at, stage: "trial", reason: "deadline", rolledBack: true },
    failedVersions: ["0.5.0"],
    installed: [],
  };
  const pending = { updateId, toVersion: "0.5.1", source: "channel", since: at, deferUntil: later, image: null } as const;

  it("says each part the document can carry, the channel, pending and outcome parts later tickets fill included", () => {
    expect(renderUpdatesStatus(base).split("\n")).toEqual([
      "Version: agent-harness 0.4.2, protocol 1",
      "Claude Code (bundled): unknown",
      `Updates: managed outside, by a host-side updater; last polled at ${at}`,
      "Channel's newest: 0.5.0",
      `Last check: ${at}, failed (unreachable): The forge did not answer.`,
      "Pending update: none",
      `Last update: 0.4.2 to 0.5.0, failed at ${at} (trial: deadline), rolled back`,
      "Failed versions: 0.5.0",
      "",
    ]);
    const lines: [UpdatesStatus["pending"], string][] = [
      [{ state: "staging", updateId, toVersion: "0.5.1", source: "request" }, "0.5.1 (request), staging"],
      [{ state: "waiting", ...pending, waitsOn: { reason: "parked-prompt", until: later } }, `0.5.1 (channel), waiting since ${at}, forced at ${later}; busy: parked-prompt until ${later}`],
      [{ state: "waiting", ...pending, waitsOn: { reason: "run-running", until: null } }, `0.5.1 (channel), waiting since ${at}, forced at ${later}; busy: run-running`],
      [{ state: "ready", ...pending }, `0.5.1 (channel), ready for the host-side updater since ${at}`],
      [{ state: "draining", ...pending, cause: "cap" }, "0.5.1 (channel), draining (cap)"],
      [{ state: "blocked", reason: "launcher", toVersion: "0.9.0" }, "0.9.0, blocked (launcher)"],
    ];
    for (const [state, line] of lines) expect(renderUpdatesStatus({ ...base, pending: state })).toContain(`Pending update: ${line}\n`);
    expect(renderUpdatesStatus({ ...base, lastOutcome: { outcome: "updated", updateId: null, fromVersion: "0.4.1", toVersion: "0.4.2", at } })).toContain(
      `Last update: 0.4.1 to 0.4.2, updated at ${at}\n`,
    );
    expect(renderUpdatesStatus({ ...base, manager: { kind: "outside", lastPoll: null }, lastCheck: null, newest: null })).toMatch(
      /Updates: managed outside, by a host-side updater; it has not polled yet\nChannel's newest: not read yet\nLast check: never\n/,
    );
  });
});

describe("the update verbs", () => {
  it("say plainly and exit 1 when no environment runs on the data directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-harness-cli-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const args of [["status"], ["status", "--json"], ["settings", "--channel", "beta"]]) {
      const { code, out, err } = await run(["update", ...args, "--data-dir", dir]);
      expect(code, args.join(" ")).toBe(1);
      expect(err, args.join(" ")).toMatch(/No environment is running on/);
      expect(out, args.join(" ")).toBe("");
    }
  });

  it("say what the environment refused and exit 1, and still revoke their local client session", async () => {
    const t = await start();
    t.env.methods.register(registry["updates.status"], () => {
      throw new ContractError({ code: "unavailable", message: "The environment is draining.", data: { readiness: "draining" } });
    });
    const { code, out, err } = await run(["update", "status", "--data-dir", t.dataDir]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("The environment refused updates.status: The environment is draining.\n");
    expect(await liveLabels(t)).not.toContain("agent-harness update status");
  });

  it("say plainly and exit 1 when the environment does not answer on the port", async () => {
    const t = await start();
    const port = await freePort();
    const { code, err } = await run(["update", "status", "--data-dir", t.dataDir, "--port", String(port)]);
    expect(code).toBe(1);
    expect(err).toMatch(/did not answer/);
  });

  it("print the usage and exit 2 on a verb they do not know, or none", async () => {
    for (const args of [["update"], ["update", "now"], ["update", "status", "extra"]]) {
      const { code, err } = await run(args);
      expect(code, args.join(" ")).toBe(2);
      expect(err, args.join(" ")).toContain("agent-harness update status [--json]");
    }
  });
});
