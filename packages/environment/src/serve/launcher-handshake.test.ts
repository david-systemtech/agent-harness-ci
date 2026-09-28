import { join } from "node:path";
import { DISCOVERY_PATH, HEALTH_PATH, PROTOCOL_VERSION, type Frame } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { readGrant, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { testLauncher, type TestLauncher } from "../../test/launcher.js";
import { openSocket } from "../../test/wire-client.js";
import type { Address } from "./http.js";
import { NO_LAUNCHER } from "./launcher.js";
import { HARNESS_VERSION } from "./start.js";

/**
 * The launcher's channel through the primary seam: the in-process
 * environment under the scripted launcher channel. The startup handshake
 * (`prepared` with the version, the wait for `committed`), the environment's
 * requests, and what the scripted launcher answers and records.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/**
 * Starts an environment under `launcher` without waiting for it, closed after
 * the test: the launcher leaves first, so a start still waiting for its commit
 * fails rather than holding the cleanup.
 */
const startUnder = (launcher: TestLauncher, options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const starting = startTestEnvironment({ ...options, launcher });
  onCleanup(async () => {
    launcher.leave();
    await starting.then(
      (t) => t.close(),
      () => undefined,
    );
  });
  return starting;
};

const getJson = async (address: Address, path: string): Promise<unknown> =>
  (await fetch(`http://${address.host}:${address.port}${path}`)).json();

/** The `environment.started` notices on the environment's stream, oldest first, as a subscriber from the start reads them. */
const startsNoted = async (t: TestEnvironment): Promise<unknown[]> => {
  const client = await t.client();
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
  const mine = (frame: Frame) => "subscription" in frame && frame.subscription === subscription;
  await client.next((frame) => frame.type === "synchronized" && mine(frame));
  const started = client.received.flatMap((frame) => (frame.type === "event" && mine(frame) && frame.event.type === "environment.started" ? [frame.event.payload] : []));
  await client.close();
  return started;
};

const authFrame = (token: string) => ({ type: "auth", token, protocolVersion: PROTOCOL_VERSION, clientKind: "tui", harnessVersion: "0.0.0-test" });

describe("under a launcher, the start", () => {
  it("says prepared with the version it runs, and until the launcher commits answers starting, notes no start and answers no socket's command", async () => {
    const dataDir = join(tempDir(), "data");
    const earlier = await startTestEnvironment({ dataDir });
    const { token } = await earlier.bootstrap();
    await earlier.close();

    const launcher = testLauncher({ present: true, commit: "held" });
    const starting = startUnder(launcher, { dataDir });
    expect(await launcher.heardPrepared()).toEqual({ type: "prepared", version: HARNESS_VERSION });
    const { address } = readGrant(dataDir);
    expect(await getJson(address, DISCOVERY_PATH)).toMatchObject({ readiness: "starting" });
    expect(await getJson(address, HEALTH_PATH)).toEqual({ status: "starting", version: HARNESS_VERSION });

    const early = await openSocket(address);
    early.send(authFrame(token));
    early.send({ type: "request", id: "pair", method: "access.pairings.create", params: { commandId: "0f8fad5b-d9cb-469f-a165-70867728950e" } });
    expect(await early.next((f) => f.type === "response")).toMatchObject({
      id: "pair",
      error: { code: "unavailable", data: { readiness: "starting" } },
    });
    expect(early.received.some((frame) => frame.type === "hello")).toBe(false);

    launcher.commit();
    const t = await starting;
    expect(t.env.readiness()).toBe("ready");
    expect(await early.next((f) => f.type === "hello")).toMatchObject({ type: "hello" });
    early.send({ type: "request", id: "ready", method: "environment.status", params: {} });
    expect(await early.next((f) => f.type === "response")).toMatchObject({ id: "ready", result: { readiness: "ready" } });
    await early.close();
    expect(await getJson(address, HEALTH_PATH)).toEqual({ status: "ready", version: HARNESS_VERSION });
    expect(await startsNoted(t)).toHaveLength(2);
  });

  it("fails at the prepared step when the launcher disconnects before committing, and notes no start", async () => {
    const dataDir = join(tempDir(), "data");
    const launcher = testLauncher({ present: true, commit: "held" });
    const starting = startUnder(launcher, { dataDir });
    await launcher.heardPrepared();
    const { address } = readGrant(dataDir);

    launcher.leave();
    await expect(starting).rejects.toMatchObject({ step: "prepared", message: expect.stringMatching(/disconnected/) as string });
    await expect(fetch(`http://${address.host}:${address.port}${HEALTH_PATH}`)).rejects.toThrow();
    expect(launcher.signals).toEqual(["prepared", "close"]);

    const again = await start({ dataDir });
    expect(await startsNoted(again)).toEqual([{ harnessVersion: HARNESS_VERSION, protocolVersion: PROTOCOL_VERSION }]);
  });

  it("does not wait with no launcher, in the foreground or in a container, and sends it nothing", async () => {
    for (const inContainer of [false, true]) {
      const launcher = testLauncher();
      const t = await start({ launcher, containerDetector: { inContainer: () => inContainer } });
      expect(t.env.readiness()).toBe("ready");
      expect(launcher.signals).toEqual(["prepared"]);
      expect(launcher.received).toEqual([]);
      await t.close();
    }
  });

  it("ignores a message from the launcher it does not know, and goes on answering the launcher's queries", async () => {
    const t = await start({ launcher: testLauncher({ present: true }) });
    for (const unknown of [{ type: "surprise" }, { type: "committed", again: true }, { type: "installed", id: 99 }, "idle?", null, 7]) t.launcher.send(unknown);
    expect(t.launcher.ask({ type: "idle?" })).toEqual({ type: "idle", readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false });
    expect(t.launcher.received).toEqual([
      { type: "prepared", version: HARNESS_VERSION },
      { type: "idle", readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false },
    ]);
  });
});

describe("the scripted launcher channel", () => {
  it("answers install?, switch? and versions? as the test scripts, and records what the environment sent", async () => {
    const launcher = testLauncher({
      present: true,
      install: ({ version }) => (version === "0.5.0" ? { type: "installed" } : { type: "refused", reason: "preflight" }),
      switch: () => ({ type: "refused", reason: "disk" }),
      versions: () => ({ type: "versions", installed: ["0.4.0", "0.5.0"], launcherVersion: "0.4.0", launcherProtocol: 1 }),
    });
    const t = await start({ launcher });
    const staged = join(t.dataDir, "staging", "0.5.0");
    expect(await launcher.request({ type: "install?", version: "0.5.0", staged })).toEqual({ type: "installed" });
    expect(await launcher.request({ type: "install?", version: "0.6.0", staged })).toEqual({ type: "refused", reason: "preflight" });
    expect(await launcher.request({ type: "switch?", updateId: "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20", version: "0.5.0" })).toEqual({ type: "refused", reason: "disk" });
    expect(await launcher.request({ type: "versions?" })).toEqual({
      type: "versions",
      installed: ["0.4.0", "0.5.0"],
      launcherVersion: "0.4.0",
      launcherProtocol: 1,
    });
    expect(launcher.received).toEqual([
      { type: "prepared", version: HARNESS_VERSION },
      { type: "install?", id: 1, version: "0.5.0", staged },
      { type: "install?", id: 2, version: "0.6.0", staged },
      { type: "switch?", id: 3, updateId: "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20", version: "0.5.0" },
      { type: "versions?", id: 4 },
    ]);
  });

  it("answers each request as a launcher that took it would, when the test scripts nothing", async () => {
    const launcher = testLauncher({ present: true });
    await start({ launcher });
    expect(await launcher.request({ type: "install?", version: "0.5.0", staged: "/staged" })).toEqual({ type: "installed" });
    expect(await launcher.request({ type: "switch?", updateId: "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20", version: "0.5.0" })).toEqual({ type: "switching" });
    expect(await launcher.request({ type: "versions?" })).toEqual({
      type: "versions",
      installed: [HARNESS_VERSION],
      launcherVersion: HARNESS_VERSION,
      launcherProtocol: 1,
    });
  });

  it("holds an answer its script has not given yet, and refuses what is outstanding when the launcher leaves", async () => {
    let answer!: () => void;
    const launcher = testLauncher({
      present: true,
      install: () => new Promise((resolve) => (answer = () => resolve({ type: "installed" }))),
      versions: () => new Promise(() => undefined),
    });
    await start({ launcher });
    const install = launcher.request({ type: "install?", version: "0.5.0", staged: "/staged" });
    const versions = launcher.request({ type: "versions?" });
    await new Promise((resolve) => setImmediate(resolve));
    answer();
    expect(await install).toEqual({ type: "installed" });
    launcher.leave();
    expect(await versions).toEqual(NO_LAUNCHER);
  });

  it("refuses every request at once with no launcher present, sending nothing", async () => {
    const launcher = testLauncher();
    await start({ launcher });
    expect(await launcher.request({ type: "versions?" })).toEqual(NO_LAUNCHER);
    expect(await launcher.request({ type: "install?", version: "0.5.0", staged: "/staged" })).toEqual(NO_LAUNCHER);
    expect(launcher.received).toEqual([]);
  });
});
