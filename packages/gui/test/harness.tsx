import { act, render, type RenderResult } from "@testing-library/react";
import { userEvent, type UserEvent } from "@testing-library/user-event";
import type { Runtime } from "@agent-harness/client-runtime";
import type { FakeShell, ManualClock } from "@agent-harness/client-runtime/testing";
import type { EnvironmentHandle, Script, ScriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { onTestFinished, vi } from "vitest";
import { App } from "../src/app.js";
import { focusedPane, showSession } from "../src/grid/layout.js";
import type { Presentation, PaneSession } from "../src/presentation.js";
import { prepareWorld, startWorld, type Mount, type RenderOptions, type HarnessPlatform } from "../gallery/world.js";

export type { RenderOptions, HarnessPlatform } from "../gallery/world.js";

export {
  certificateOf,
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

const mount = async ({ world, clock, shell, macOS, documents, protocolVersion, stepCards, version }: Mount, pair: readonly string[]): Promise<RenderedApp> => {
  const { platform, runtime, presentation, stopFollowing } = await startWorld(
    { world, clock, shell, macOS, documents, protocolVersion, stepCards, version }, pair,
  );
  onTestFinished(async () => {
    stopFollowing();
    await runtime.close();
  });
  const view = render(<App runtime={runtime} presentation={presentation} clock={clock} version={platform.client.version} macOS={macOS} shell={shell} stepCards={stepCards} />);
  return {
    world,
    clock,
    platform,
    shell,
    runtime,
    presentation,
    user: userEvent.setup({ advanceTimers: (delay) => { if (vi.isFakeTimers()) vi.advanceTimersByTime(delay); } }),
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
      return mount({ world, clock, shell, macOS, documents: platform.documents, protocolVersion, stepCards, version }, []);
    },
  };
};

/**
 * The app over `script`: the runtime started, the local environment reached
 * through its grant and each `paired` one paired by its link, then the
 * window mounted. With no local environment scripted, the grant the shell
 * reads is none, as on a desktop whose machine runs no environment yet.
 */
export const renderApp = async (
  script: Script,
  options: RenderOptions = {},
  /** Registers custom environment answers before the runtime or window can request them. */
  configure?: (world: ScriptedWorld) => void,
): Promise<RenderedApp> => {
  const world = await prepareWorld(script, options);
  configure?.(world.world);
  return mount(world, world.paired);
};
