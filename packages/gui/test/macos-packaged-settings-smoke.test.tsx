// @vitest-environment jsdom-on-node
import { act, screen } from "@testing-library/react";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { renderApp } from "./harness.js";

const script = new URL("../../../scripts/macos-desktop-update-smoke.mjs", import.meta.url).href;
const { clickPackagedSettings, packagedSettingsOpen } = await import(script) as {
  clickPackagedSettings: (evaluate: (expression: string) => Promise<unknown>) => Promise<boolean>;
  packagedSettingsOpen: (evaluate: (expression: string) => Promise<unknown>) => Promise<boolean>;
};

it.each([true, false])("the packaged smoke opens real Settings with first launch=%s", async (firstLaunch) => {
  await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [] }] }, { firstLaunch, macOS: true });
  // The CDP expression runs against the real GUI DOM; each click flushes React before the next poll.
  const evaluate = async (expression: string): Promise<unknown> => {
    let result: unknown;
    await act(async () => { result = runInNewContext(expression, { document }); });
    return result;
  };
  if (firstLaunch) {
    expect(screen.getByRole("heading", { name: "Welcome to agent-harness" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(await clickPackagedSettings(evaluate)).toBe(false);
    expect(screen.getByRole("dialog", { name: "Leave set up without an account?" })).toBeDefined();
    expect(await clickPackagedSettings(evaluate)).toBe(false);
    expect(screen.queryByRole("heading", { name: "Welcome to agent-harness" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Leave set up without an account?" })).toBeNull();
  }
  expect(screen.getByRole("button", { name: "Settings" })).toBeDefined();
  expect(await clickPackagedSettings(evaluate)).toBe(true);
  expect(await packagedSettingsOpen(evaluate)).toBe(true);
  expect(screen.getByRole("region", { name: "Settings" })).toBeDefined();
});
