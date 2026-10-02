// @vitest-environment jsdom-on-node
import { render, waitFor, within } from "@testing-library/react";
import { createRuntime, uuidv4, type Runtime } from "@agent-harness/client-runtime";
import { fakeShell, inMemoryPlatform } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../environment/test/cleanups.js";
import { startTestEnvironment, type TestEnvironment } from "../../environment/test/helper.js";
import { workspace } from "../../environment/test/sessions.js";
import { App } from "../src/app.js";
import { openPresentation } from "../src/presentation.js";

/**
 * The sidebar through the real spine (docs/specs/gui.md, "Testing
 * Decisions"; #397), serial: the #108 in-process environment on a temporary
 * data directory and loopback port 0, the real client runtime over a real
 * WebSocket, and the window rendered in jsdom over it. The window reaches
 * the environment through its bootstrap grant, as the desktop on the same
 * machine does, and draws its sessions under their headings; a session
 * another client (a second runtime, paired) archives, pins, groups or
 * renames moves in the sidebar with no reload.
 */

const { onCleanup } = useCleanups();

/**
 * A desktop window on this machine: its runtime reads the environment's
 * grant file, as the desktop's shell does, and exchanges it for a local
 * client session. Its sidebar is found within it.
 */
const openWindow = async (t: TestEnvironment) => {
  const platform = inMemoryPlatform({ kind: "desktop", shell: fakeShell(), grant: { read: async () => t.grant() } });
  const runtime = createRuntime(platform);
  onCleanup(() => runtime.close());
  await runtime.start();
  const presentation = await openPresentation(platform.documents, platform.reportError);
  onCleanup(() => presentation.close());
  // A window launched before, whose Set up was closed: the first launch's would take the whole window (#413).
  presentation.set("firstLaunchDone", true);
  const view = render(<App runtime={runtime} presentation={presentation} clock={platform.clock} version={platform.client.version} macOS={false} shell={platform.shell} />);
  onCleanup(() => view.unmount());
  const sidebar = await within(view.container).findByRole("navigation", { name: "Sessions" });
  return { runtime, sidebar };
};

/** Another client of the environment: a runtime paired with it, as a laptop's terminal UI is. */
const anotherClient = async (t: TestEnvironment): Promise<Runtime> => {
  const runtime = createRuntime(inMemoryPlatform({ kind: "tui" }));
  onCleanup(() => runtime.close());
  await runtime.start();
  const outcome = await runtime.connections.add({ link: (await t.createPairing()).link });
  if (outcome.status !== "paired") throw new Error(`The runtime could not pair: ${JSON.stringify(outcome)}.`);
  return runtime;
};

/** Sends a command through `runtime`'s outbox; throws unless the environment accepts it. */
const accepted = async (answer: Promise<{ readonly ok: boolean }>) => {
  const outcome = await answer;
  if (!outcome.ok) throw new Error(`The command was not accepted: ${JSON.stringify(outcome)}.`);
};

/** The sidebar as a person reads it: each heading, then its rows' titles, indented. */
const drawn = (sidebar: HTMLElement): string[] =>
  within(sidebar)
    .queryAllByRole("region")
    .flatMap((section) => [
      (within(section).getAllByRole("heading")[0]?.textContent ?? "").trim(),
      ...within(section)
        .queryAllByRole("listitem")
        .map((row) => `  ${(row.textContent ?? "").trim()}`),
    ]);

const WAIT = { timeout: 5000 };

describe("the sidebar through the real spine", { concurrent: false }, () => {
  it("exchanges the grant and draws the environment's sessions under their headings", async () => {
    const t = await startTestEnvironment({ name: "smoke-sidebar" });
    onCleanup(() => t.close());
    const other = await anotherClient(t);
    const environmentId = t.env.id;
    const [fix, pinned] = [uuidv4(), uuidv4()];
    await accepted(other.commands.dispatch(environmentId, "sessions.create", { id: fix, workspace, title: "Fix the rail", tags: ["wip"] }));
    await accepted(other.commands.dispatch(environmentId, "sessions.create", { id: pinned, workspace, title: "Pinned one" }));
    await accepted(other.commands.dispatch(environmentId, "sessions.pin", { sessionId: pinned }));

    const window = await openWindow(t);
    await waitFor(() => expect(drawn(window.sidebar)).toEqual(["▾ Pinned", "  Pinned one", "smoke-sidebar", "  Fix the rail #wip"]), WAIT);
    // Reached through the grant: the local environment, not a pairing.
    expect(window.runtime.connections.list.read()).toEqual([expect.objectContaining({ environmentId, kind: "local", phase: "ready" })]);
  });

  it("moves a session another client archives, pins, groups or renames, with no reload", async () => {
    const t = await startTestEnvironment({ name: "smoke-sidebar-moves" });
    onCleanup(() => t.close());
    const other = await anotherClient(t);
    const environmentId = t.env.id;
    const [archived, pinned, grouped, renamed] = [uuidv4(), uuidv4(), uuidv4(), uuidv4()];
    for (const [id, title] of [
      [archived, "Old thing"],
      [pinned, "Keep near"],
      [grouped, "Brand copy"],
      [renamed, "Untitled work"],
    ] as const) {
      await accepted(other.commands.dispatch(environmentId, "sessions.create", { id, workspace, title }));
    }
    const window = await openWindow(t);
    await waitFor(() => expect(drawn(window.sidebar).filter((line) => line.startsWith("  "))).toHaveLength(4), WAIT);

    await accepted(other.commands.dispatch(environmentId, "sessions.archive", { sessionId: archived }));
    await accepted(other.commands.dispatch(environmentId, "sessions.pin", { sessionId: pinned }));
    await accepted(other.commands.moveToGroup(environmentId, grouped, "Meadowstudios"));
    await accepted(other.commands.dispatch(environmentId, "sessions.rename", { sessionId: renamed, title: "Receipts" }));

    await waitFor(
      () => expect(drawn(window.sidebar)).toEqual(["▾ Pinned", "  Keep near", "▾ Meadowstudios", "  Brand copy", "smoke-sidebar-moves", "  Receipts", "▸ Archive 1"]),
      WAIT,
    );
  });
});
