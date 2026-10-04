import { createRuntime } from "@agent-harness/client-runtime";
import {
  fakeShell,
  inMemoryDocuments,
  inMemoryNetwork,
  manualClock,
  runtimeSpeaking,
  seededRandom,
  type FakeShell,
  type InMemoryDocumentStore,
  type InMemoryNetwork,
  type ManualClock,
} from "@agent-harness/client-runtime/testing";
import { FAKE_HARNESS_VERSION } from "@agent-harness/client-runtime/testing/fake-wire";
import { scriptedWorld, type Script, type ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { browserPlatform } from "../src/platform/browser-platform.js";
import { desktopPlatform, type DesktopPlatform } from "../src/platform/desktop-platform.js";
import { openPresentation, type PresentationKey, type PresentationValues } from "../src/presentation.js";
import type { StepCards } from "../src/setup/cards.js";

/** Shared scripted desktop world for jsdom and the gallery; contains no test runner or renderer. */
export interface RenderOptions {
  /** Whether `Mod` is ⌘: preset false, Ctrl. */
  readonly macOS?: boolean;
  /** The desktop's shell: preset a fresh recording fake. */
  readonly shell?: FakeShell;
  /** What the window's presentation holds before it first opens, as a launch before this one left it. */
  readonly presentation?: Partial<PresentationValues>;
  /**
   * The window's first launch: its first-launch mark unset, so Set up takes the whole window once the home environment
   * is ready. Preset false: a window launched before, whose Set up was finished or closed, as most tests want it.
   */
  readonly firstLaunch?: boolean;
  /** The protocol version this client speaks: preset this build's, so a test can be the newer side of a mismatch. */
  readonly protocolVersion?: number;
  /** The step cards the full checklist draws, by step id: preset this build's. */
  readonly stepCards?: StepCards;
  /** This client's version: preset the one every scripted environment runs, so no environment is older than it. */
  readonly version?: string;
}

/** The desktop platform the window runs on, with what the test holds of it. */
export interface HarnessPlatform extends DesktopPlatform {
  readonly documents: InMemoryDocumentStore;
  readonly clock: ManualClock;
  readonly network: InMemoryNetwork;
  /** Every fault handed to `reportError`, oldest first. */
  readonly reported: readonly unknown[];
}

export interface Mount {
  readonly world: ScriptedWorld;
  readonly clock: ManualClock;
  readonly shell: FakeShell;
  readonly macOS: boolean;
  readonly documents: InMemoryDocumentStore;
  readonly protocolVersion: number | undefined;
  readonly stepCards: StepCards | undefined;
  readonly version: string;
}

export const startWorld = async ({ world, clock, shell, documents, protocolVersion, version }: Mount, pair: readonly string[]) => {
  const reported: unknown[] = [];
  const network = inMemoryNetwork();
  const desktop = await desktopPlatform({
    shell,
    version,
    documents,
    clock,
    network,
    webSocket: world.webSocket,
    random: seededRandom(),
    reportError: (error) => void reported.push(error),
  });
  const platform: HarnessPlatform = { ...desktop, documents, clock, network, reported };
  const runtime = protocolVersion === undefined ? createRuntime(platform) : runtimeSpeaking(platform, protocolVersion);
  const stopFollowing = platform.follow(runtime.connections.list);
  await runtime.start();
  for (const name of pair) {
    const outcome = await runtime.connections.add({ link: world.environment(name).wire.link });
    if (outcome.status !== "paired") throw new Error(`The harness could not pair ${name}: ${JSON.stringify(outcome)}.`);
  }
  const presentation = await openPresentation(platform.documents, platform.reportError);
  return { platform, runtime, presentation, stopFollowing };
};

export const prepareWorld = async (script: Script, options: RenderOptions = {}) => {
  const clock = manualClock();
  const world = scriptedWorld(clock, script);
  const paired = script.environments.filter((environment) => environment.reach === "paired").map((environment) => environment.name);
  const shell = options.shell ?? fakeShell();
  shell.answer("http", world.fetch);
  shell.answer("localGrant.read", async () => world.grant?.read());
  const documents = inMemoryDocuments();
  const presentation: Partial<PresentationValues> = { ...(options.firstLaunch !== true && { firstLaunchDone: true }), ...options.presentation };
  if (Object.keys(presentation).length > 0) {
    const left = await openPresentation(documents);
    for (const [key, value] of Object.entries(presentation) as [PresentationKey, never][]) left.set(key, value);
    await left.close();
  }
  return {
    world, clock, shell, macOS: options.macOS ?? false, documents,
    protocolVersion: options.protocolVersion, stepCards: options.stepCards,
    version: options.version ?? FAKE_HARNESS_VERSION, paired,
  };
};

/** The browser's storage, capabilities and identity; only the environment wire and clock are scripted. */
export const startWebWorld = async (script: Script, presentationValues: Partial<PresentationValues>) => {
  const clock = manualClock();
  const world = scriptedWorld(clock, script);
  const platform = { ...browserPlatform(window, FAKE_HARNESS_VERSION), clock, fetch: world.fetch, webSocket: world.webSocket, random: seededRandom() };
  const runtime = createRuntime(platform);
  await runtime.start();
  for (const environment of script.environments.filter(e => e.reach === "paired")) {
    const outcome = await runtime.connections.add({ link: world.environment(environment.name).wire.link });
    if (outcome.status !== "paired") throw new Error(`The gallery could not pair ${environment.name}.`);
  }
  const presentation = await openPresentation(platform.documents, platform.reportError);
  const values: Partial<PresentationValues> = { firstLaunchDone: true, ...presentationValues, runLocalEnvironment: false };
  for (const [key, value] of Object.entries(values) as [PresentationKey, never][]) presentation.set(key, value);
  return { world, clock, platform, runtime, presentation, shell: undefined, macOS: false, version: platform.client.version, stopFollowing: () => {} };
};
