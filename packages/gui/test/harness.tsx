import { render, type RenderResult } from "@testing-library/react";
import { userEvent, type UserEvent } from "@testing-library/user-event";
import { createRuntime, type Runtime } from "@agent-harness/client-runtime";
import { fakeShell, inMemoryPlatform, manualClock, type FakeShell, type InMemoryDocumentStore, type InMemoryPlatform, type ManualClock } from "@agent-harness/client-runtime/testing";
import { scriptedWorld, type EnvironmentHandle, type Script, type ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { onTestFinished } from "vitest";
import { App } from "../src/app.js";
import { openPresentation, type Presentation } from "../src/presentation.js";

export { scriptedWorld, type EnvironmentHandle, type Script, type ScriptedEnvironment } from "@agent-harness/client-runtime/testing/scripted-environment";

/**
 * The GUI's test harness (docs/specs/gui.md, "Testing Decisions"): the app
 * mounted over a client runtime on the in-memory platform, against the
 * scripted fake environment, with the recording fake shell as the desktop's,
 * in jsdom. A test drives it as a person does, through `user` (Testing
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
}

export interface RenderedApp {
  readonly world: ScriptedWorld;
  readonly clock: ManualClock;
  readonly platform: InMemoryPlatform;
  readonly shell: FakeShell;
  readonly runtime: Runtime;
  readonly presentation: Presentation;
  readonly user: UserEvent;
  readonly view: RenderResult;
  environment(name: string): EnvironmentHandle;
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
  readonly documents?: InMemoryDocumentStore;
  readonly secrets?: InMemoryPlatform["secrets"];
}

const mount = async ({ world, clock, shell, macOS, documents, secrets }: Mount, pair: readonly string[]): Promise<RenderedApp> => {
  const platform = inMemoryPlatform({
    clock,
    kind: "desktop",
    fetch: world.fetch,
    webSocket: world.webSocket,
    shell,
    ...(world.grant && { grant: world.grant }),
    ...(documents && { documents }),
    ...(secrets && { secrets }),
  });
  const runtime = createRuntime(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  for (const name of pair) {
    const outcome = await runtime.connections.add({ link: world.environment(name).wire.link });
    if (outcome.status !== "paired") throw new Error(`The harness could not pair ${name}: ${JSON.stringify(outcome)}.`);
  }
  const presentation = await openPresentation(platform.documents, platform.reportError);
  const view = render(<App runtime={runtime} presentation={presentation} macOS={macOS} />);
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
    async remount() {
      view.unmount();
      await presentation.close();
      await runtime.close();
      return mount({ world, clock, shell, macOS, documents: platform.documents, secrets: platform.secrets }, []);
    },
  };
};

/**
 * The app over `script`: the runtime started, the local environment reached
 * through its grant and each `paired` one paired by its link, then the
 * window mounted.
 */
export const renderApp = async (script: Script, options: RenderOptions = {}): Promise<RenderedApp> => {
  const clock = manualClock();
  const world = scriptedWorld(clock, script);
  const paired = script.environments.filter((environment) => environment.reach === "paired").map((environment) => environment.name);
  return mount({ world, clock, shell: options.shell ?? fakeShell(), macOS: options.macOS ?? false }, paired);
};
