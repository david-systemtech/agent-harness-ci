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
