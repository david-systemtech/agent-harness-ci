// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { act, screen, waitFor, within } from "@testing-library/react";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { expect, it } from "vitest";
import { renderApp } from "../../test/harness.js";

it.each(["win32", "linux"] as const)("draws and operates the %s window buttons and follows native changes", async (platform) => {
  const shell = fakeShell();
  shell.answer("window.state", async () => ({ platform, focused: true, maximized: false, fullScreen: false }));
  const app = await renderApp({ environments: [] }, { shell });
  const header = within(screen.getByRole("banner"));
  await app.user.click(await header.findByRole("button", { name: "Minimize" }));
  await app.user.click(header.getByRole("button", { name: "Maximize" }));
  expect(shell.calls).toContainEqual(["window.minimize"]);
  expect(shell.calls).toContainEqual(["window.toggleMaximize"]);
  act(() => shell.changeWindow({ platform, focused: false, maximized: true, fullScreen: false }));
  await app.user.click(header.getByRole("button", { name: "Restore" }));
  expect(header.getByRole("group", { name: "Window controls" }).className).toContain("opacity-60");
  await app.user.click(header.getByRole("button", { name: "Close window" }));
  expect(shell.calls).toContainEqual(["window.close"]);
});

it("keeps the macOS traffic-light inset only outside full screen", async () => {
  const shell = fakeShell();
  shell.answer("window.state", async () => ({ platform: "darwin", focused: true, maximized: false, fullScreen: false }));
  await renderApp({ environments: [] }, { shell, macOS: true });
  const header = screen.getByRole("banner");
  await waitFor(() => expect(header.style.paddingLeft).toBe("76px"));
  expect(within(header).queryByRole("group", { name: "Window controls" })).toBeNull();
  act(() => shell.changeWindow({ platform: "darwin", focused: true, maximized: false, fullScreen: true }));
  expect(header.style.paddingLeft).toBe("");
  act(() => shell.changeWindow({ platform: "darwin", focused: true, maximized: false, fullScreen: false }));
  expect(header.style.paddingLeft).toBe("76px");
});

it("leaves a client without a native frame without window controls or an inset", async () => {
  await renderApp({ environments: [] });
  const header = screen.getByRole("banner");
  expect(within(header).queryByRole("group", { name: "Window controls" })).toBeNull();
  expect(header.style.paddingLeft).toBe("");
  expect(header.hasAttribute("data-native-frame")).toBe(false);
});

it("keeps the native event that arrives while the initial state read is held and unsubscribes on close", async () => {
  const shell = fakeShell();
  let resolve!: (value: Awaited<ReturnType<NonNullable<typeof shell.window.state>>>) => void;
  shell.answer("window.state", () => new Promise((answer) => { resolve = answer; }));
  let stopped = false;
  let changed!: Parameters<NonNullable<typeof shell.window.onChange>>[0];
  shell.answer("window.onChange", (listener) => {
    changed = listener;
    return () => { stopped = true; };
  });
  const app = await renderApp({ environments: [] }, { shell });
  act(() => changed({ platform: "win32", focused: false, maximized: true, fullScreen: false }));
  expect(await screen.findByRole("button", { name: "Restore" })).toBeDefined();
  await act(async () => resolve({ platform: "win32", focused: true, maximized: false, fullScreen: false }));
  expect(screen.queryByRole("button", { name: "Maximize" })).toBeNull();
  app.view.unmount();
  expect(stopped).toBe(true);
});

/** The drag and no-drag selectors of window-controls.css, so a header is checked against the rules Electron reads. */
const regions = (() => {
  const css = readFileSync(new URL("./window-controls.css", import.meta.url), "utf8");
  const selector = (region: string) => new RegExp(`([^{}]+)\\{\\s*-webkit-app-region: ${region};`).exec(css)![1]!.trim();
  return { drag: selector("drag"), noDrag: selector("no-drag"), size: /([^{}/]+)\{\s*min-width: 28px;/.exec(css)![1]!.trim() };
})();

/** The welcome's header, then Begin set up's checklist header: the two full-window Set up surfaces. */
const setupHeaders = async (app: Awaited<ReturnType<typeof renderApp>>, check: (header: HTMLElement) => Promise<void> | void) => {
  await check(screen.getByRole("heading", { name: "Welcome to agent-harness" }).closest("section")!.querySelector("header")!);
  await app.user.click(screen.getByRole("button", { name: "Begin set up" }));
  await check(screen.getByRole("region", { name: "Set up" }).querySelector("header")!);
};

it.each(["win32", "linux"] as const)("draws and operates the %s window buttons on the welcome and the Set up checklist, which drag the window", async (platform) => {
  const shell = fakeShell();
  shell.answer("window.state", async () => ({ platform, focused: false, maximized: false, fullScreen: false }));
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [] }] }, { firstLaunch: true, shell });
  await setupHeaders(app, async (header) => {
    const controls = await within(header).findByRole("group", { name: "Window controls" });
    const from = shell.calls.length;
    expect(controls.className).toContain("opacity-60");
    expect(header.matches(regions.drag)).toBe(true);
    for (const button of within(controls).getAllByRole("button")) expect(button.matches(regions.noDrag) && button.matches(regions.size)).toBe(true);
    for (const label of header.querySelectorAll("label")) expect(label.matches(regions.noDrag)).toBe(true);
    await app.user.click(within(controls).getByRole("button", { name: "Minimize" }));
    await app.user.click(within(controls).getByRole("button", { name: "Maximize" }));
    await app.user.click(within(controls).getByRole("button", { name: "Close window" }));
    expect(shell.calls.slice(from).filter(([member]) => member === "window.minimize" || member === "window.toggleMaximize" || member === "window.close")).toEqual([["window.minimize"], ["window.toggleMaximize"], ["window.close"]]);
  });
});

it("keeps the macOS traffic-light gutter on the welcome and the Set up checklist, without window buttons", async () => {
  const shell = fakeShell();
  shell.answer("window.state", async () => ({ platform: "darwin", focused: true, maximized: false, fullScreen: false }));
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [] }] }, { firstLaunch: true, shell, macOS: true });
  await setupHeaders(app, async (header) => {
    await waitFor(() => expect(header.style.paddingLeft).toBe("76px"));
    expect(header.matches(regions.drag)).toBe(true);
    expect(within(header).queryByRole("group", { name: "Window controls" })).toBeNull();
  });
});

it("leaves the welcome and the Set up checklist in a client without a native frame without window buttons, inset or drag", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [] }] }, { firstLaunch: true });
  await setupHeaders(app, (header) => {
    expect(within(header).queryByRole("group", { name: "Window controls" })).toBeNull();
    expect(header.style.paddingLeft).toBe("");
    expect(header.matches(regions.drag)).toBe(false);
  });
});
