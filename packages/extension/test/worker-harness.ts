import { BRIDGE_PROOF_TEST_VECTOR, type PagePolicy } from "@agent-harness/contracts";
import { afterEach, expect } from "vitest";
import { extensionManifest } from "../src/manifest.js";
import { startWorker, type RunningWorker } from "../src/service-worker.js";
import type { WorkerStatus } from "../src/status.js";
import type { StoredPairing } from "../src/stored.js";
import { fakeChrome, type FakeChrome, type FakeChromeOptions } from "./fake-chrome.js";
import { manualClock, type ManualClock } from "./manual-clock.js";
import { ownFolder, scriptedEnvironment, WAIT_MS, type OwnFolder, type PeerSocket, type ScriptedEnvironment } from "./scripted-environment.js";

/**
 * The worker's tests' set-up: a fake Chrome profile holding the extension
 * built as 1.2.3-test, a manual clock, a folder standing for the
 * extension's own with the port file of a scripted environment in it, and
 * the worker started over them, all ended after each test.
 */

export interface Setup {
  readonly chrome: FakeChrome;
  readonly clock: ManualClock;
  readonly folder: OwnFolder;
  readonly environment: ScriptedEnvironment;
  /** Starts a worker on the setup's Chrome, as Chrome does at a wake; stopped after the test. */
  start(): RunningWorker;
}

export const workerHarness = () => {
  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const POLICY: PagePolicy = { devSites: [], evaluateEverywhere: false, deepReadEverywhere: false, browserDomains: [] };

  const environmentOf = async (options: { readonly name?: string; readonly environmentId?: string } = {}): Promise<ScriptedEnvironment> => {
    const environment = await scriptedEnvironment(options);
    cleanups.push(() => environment.close());
    return environment;
  };

  const setUp = async (options: { readonly started?: boolean; readonly chrome?: FakeChromeOptions } = {}): Promise<Setup> => {
    const chrome = fakeChrome(extensionManifest("1.2.3-test"), options.chrome);
    cleanups.push(() => chrome.close());
    const clock = manualClock();
    const folder = ownFolder();
    cleanups.push(() => folder.remove());
    const environment = await environmentOf();
    folder.writePortFile(environment.portFile);
    const start = () => {
      const worker = startWorker({ chrome, clock, readOwnFile: folder.readOwnFile });
      cleanups.push(() => worker.stop());
      return worker;
    };
    if (options.started !== false) start();
    return { chrome, clock, folder, environment, start };
  };

  /** The worker's status once it is one that `predicate` takes. */
  const statusOnce = async (chrome: FakeChrome, predicate: (status: WorkerStatus) => boolean): Promise<WorkerStatus> => {
    let last: unknown;
    const until = Date.now() + WAIT_MS;
    for (;;) {
      last = chrome.storage.session.peek("status");
      if (last !== undefined && predicate(last as WorkerStatus)) return last as WorkerStatus;
      if (Date.now() > until) throw new Error(`The worker's status never matched; it is ${JSON.stringify(last)}.`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /** Answers the announce on `socket` as the environment does, and waits for the worker to say it holds the socket. */
  const announced = async (setup: Pick<Setup, "chrome" | "environment">, socket: PeerSocket): Promise<void> => {
    expect(await socket.next()).toMatchObject({ type: "announce" });
    socket.send({ type: "announced", environmentId: setup.environment.environmentId, environmentName: setup.environment.environmentName });
    await statusOnce(setup.chrome, (status) => status.state === "unpaired");
  };

  /** A pairing as the worker keeps it, with #541's test vector's secret. */
  const pairingWith = (environment: ScriptedEnvironment): StoredPairing => ({
    chromeId: "6b0d6a3e-7c4f-4d0e-9f6a-2b1c3d4e5f60",
    secret: BRIDGE_PROOF_TEST_VECTOR.secret,
    environmentId: environment.environmentId,
    environmentName: environment.environmentName,
    name: "Work",
  });

  /** A setup whose Chrome holds a pairing with its environment, and the worker started. */
  const setUpPaired = async (chrome?: FakeChromeOptions): Promise<Setup> => {
    const setup = await setUp({ started: false, ...(chrome && { chrome }) });
    await setup.chrome.storage.local.set({ pairing: pairingWith(setup.environment) });
    setup.start();
    return setup;
  };

  /** Answers the hello on `socket` with the test vector's nonce and checks the proof, as the environment does. */
  const challenged = async (setup: Setup, socket: PeerSocket): Promise<void> => {
    expect(await socket.next()).toMatchObject({ type: "hello" });
    socket.send({ type: "challenge", environmentId: setup.environment.environmentId, nonce: BRIDGE_PROOF_TEST_VECTOR.nonce });
    expect(await socket.next()).toEqual({ type: "proof", mac: BRIDGE_PROOF_TEST_VECTOR.proof });
  };

  /** Runs `cleanup` after the test, before what was set up ahead of it. */
  const onCleanup = (cleanup: () => unknown): void => void cleanups.push(cleanup);

  return { POLICY, environmentOf, setUp, setUpPaired, statusOnce, announced, challenged, pairingWith, onCleanup };
};
