import { afterEach, describe, expect, it, vi } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";

/**
 * The terminal pane without Ink's input emitter (docs/specs/tui.md, the
 * terminal pane build's notes): the pane hears each key's bytes on the
 * channel Ink's input parser emits them on, which `useStdin()` carries
 * though its type does not say so. An Ink that no longer carries it would
 * leave a pane that says it has the keys while every key went elsewhere,
 * so the pane is refused in one line instead.
 */

vi.mock("ink", async (actual) => {
  const ink = await actual<typeof import("ink")>();
  return {
    ...ink,
    // What Ink hands over, less the input emitter the pane listens on.
    useStdin: () => ({ ...ink.useStdin(), internal_eventEmitter: undefined }),
  };
});

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

describe("a terminal pane Ink cannot hand keys to", () => {
  it("is refused in one line, opening no terminal", async () => {
    const app = await renderApp({
      script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts", workspace: { kind: "directory", path: "/home/milo/receipts" } }] }] },
      flags: { session: "0199aa00-0000-4000-8000-000000000001" },
    });
    apps.push(app);
    await app.waitFor("Nothing said yet.");
    await app.type("/terminal");
    await app.press(KEY.enter);
    await app.waitFor("No terminal: this build of Ink does not hand the pane its keys.");
    expect(app.frame()).not.toContain("terminal · desk");
    expect(app.environment("desk").requests("terminals.open")).toEqual([]);
  });
});
