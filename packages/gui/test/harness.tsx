import { act, render, type RenderResult } from "@testing-library/react";
import { userEvent, type UserEvent } from "@testing-library/user-event";
import { createRuntime, type Runtime } from "@agent-harness/client-runtime";
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
import { scriptedWorld, type EnvironmentHandle, type Script, type ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { onTestFinished } from "vitest";
import { App } from "../src/app.js";
import { focusedPane, showSession } from "../src/grid/layout.js";
import { desktopPlatform, type DesktopPlatform } from "../src/platform/desktop-platform.js";
import { openPresentation, type PaneSession, type Presentation, type PresentationKey, type PresentationValues } from "../src/presentation.js";
import type { StepCards } from "../src/setup/cards.js";

export {
  scriptedWorld,
  type EnvironmentHandle,
  type Script,
  type ScriptedEnvironment,
  type ScriptedSetup,
} from "@agent-harness/client-runtime/testing/scripted-environment";

/**
 * The GUI's test harness (docs/specs/gui.md, "Testing Decisions"): the app
 * mounted over a client runtime on the desktop platform, against the
 * scripted fake environment, over the recording fake shell as the desktop's
 * preload gives it, in jsdom. The shell answers `http` and `localGrant` for
 * the scripted world and keeps `secrets` in memory; the documents, the
 * clock, the network signal and the sockets are the test's. A test drives it as a person does, through `user` (Testing
 * Library's user-event), and asserts what a person sees: roles, accessible
 * names and text, through `screen`. What presentation keeps is asserted by
 * mounting the window again on the same storage (`remount`).
 *
 * jsdom lays nothing out: `test/setup.ts` gives every element the size of a
 * 1280 by 800 window, so a divider's layout is computed and moved by keys.
 */

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
}

/** The desktop platform the window runs on, with what the test holds of it. */
export interface HarnessPlatform extends DesktopPlatform {
  readonly documents: InMemoryDocumentStore;
  readonly clock: ManualClock;
  readonly network: InMemoryNetwork;
  /** Every fault handed to `reportError`, oldest first. */
  readonly reported: readonly unknown[];
}

export interface RenderedApp {
  readonly world: ScriptedWorld;
  readonly clock: ManualClock;
  readonly platform: HarnessPlatform;
  readonly shell: FakeShell;
  readonly runtime: Runtime;
  readonly presentation: Presentation;
  readonly user: UserEvent;
  readonly view: RenderResult;
  environment(name: string): EnvironmentHandle;
  /** Opens the `index`th session the script lists on `name` (from 0) in the focused pane, as presentation holds it. */
  open(name: string, index?: number): void;
  /** The session the focused pane shows, as presentation holds it; null while it shows none. */
  shown(): PaneSession | null;
  /**
   * Closes the window, then opens it again on the same storage, as a
   * relaunch does: a new runtime and presentation over the same documents
   * and secrets, the scripted world and the clock going on.
   */
  remount(): Promise<RenderedApp>;
}

interface Mount {
  readonly world: ScriptedWorld;
  readonly clock: ManualClock;
  readonly shell: FakeShell;
  readonly macOS: boolean;
  readonly documents: InMemoryDocumentStore;
  readonly protocolVersion: number | undefined;
  readonly stepCards: StepCards | undefined;
}

const mount = async ({ world, clock, shell, macOS, documents, protocolVersion, stepCards }: Mount, pair: readonly string[]): Promise<RenderedApp> => {
  const reported: unknown[] = [];
  const network = inMemoryNetwork();
  const desktop = await desktopPlatform({
    shell,
    version: "0.0.0-test",
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
  onTestFinished(async () => {
    stopFollowing();
    await runtime.close();
  });
  await runtime.start();
  for (const name of pair) {
    const outcome = await runtime.connections.add({ link: world.environment(name).wire.link });
    if (outcome.status !== "paired") throw new Error(`The harness could not pair ${name}: ${JSON.stringify(outcome)}.`);
  }
  const presentation = await openPresentation(platform.documents, platform.reportError);
  const view = render(<App runtime={runtime} presentation={presentation} clock={clock} version={platform.client.version} macOS={macOS} shell={shell} stepCards={stepCards} />);
  return {
    world,
    clock,
    platform,
    shell,
    runtime,
    presentation,
    user: userEvent.setup(),
    view,
    environment: (name) => world.environment(name),
    open(name, index = 0) {
      const environment = world.environment(name);
      const layout = presentation.values.read().paneLayout;
      act(() => presentation.set("paneLayout", showSession(layout, layout.focused, { environmentId: environment.environmentId, sessionId: environment.sessionId(index) })));
    },
    shown: () => focusedPane(presentation.values.read().paneLayout).session,
    async remount() {
      view.unmount();
      await presentation.close();
      await runtime.close();
      return mount({ world, clock, shell, macOS, documents: platform.documents, protocolVersion, stepCards }, []);
    },
  };
};

/**
 * The app over `script`: the runtime started, the local environment reached
 * through its grant and each `paired` one paired by its link, then the
 * window mounted. With no local environment scripted, the grant the shell
 * reads is none, as on a desktop whose machine runs no environment yet.
 */
export const renderApp = async (script: Script, options: RenderOptions = {}): Promise<RenderedApp> => {
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
  return mount({ world, clock, shell, macOS: options.macOS ?? false, documents, protocolVersion: options.protocolVersion, stepCards: options.stepCards }, paired);
};
