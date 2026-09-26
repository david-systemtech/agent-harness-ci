import { afterEach, expect, it, vi } from "vitest";

// Colour is on for this file only: chalk reads FORCE_COLOR as it loads, which the hoisting puts before every import.
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { KEY, renderApp, type RenderedApp } from "../test/harness.js";

/**
 * The terminal pane's colours (docs/specs/tui.md, "The terminal pane": its
 * rows rendered as Ink text with colours; #148). Frames carry no colour
 * where the test runner's output is no terminal, so this file forces
 * chalk's full colour level and reads the escapes a terminal would get: a
 * palette colour, bold with a 256-colour one, and a true colour, each
 * reaching the frame as the shell wrote it.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const FIRST = "7e000000-0000-4000-8000-000000000001";

it("draws the scripted terminal output in the pane with its colours", async () => {
  const app = await renderApp({
    script: { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] },
    flags: { session: "0199aa00-0000-4000-8000-000000000001" },
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  await app.type("/terminal");
  await app.press(KEY.enter);
  await app.waitFor("terminal · desk");
  app.environment("desk").terminalOutput(FIRST, "\u001B[31mred\u001B[0m \u001B[1;38;5;208mbold orange\u001B[0m \u001B[38;2;10;20;30mrgb\u001B[0m");
  await app.waitFor("bold orange");
  const frame = app.frame();
  expect(frame).toContain("\u001B[38;5;1mred\u001B[39m");
  expect(frame).toContain("\u001B[1m\u001B[38;5;208mbold orange");
  expect(frame).toContain("\u001B[38;2;10;20;30mrgb\u001B[39m");
});
