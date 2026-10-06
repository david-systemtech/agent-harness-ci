import { chooseHeaderAction, openHeaderMenu } from "../test/header-actions.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { fakeShell, type FakeShell } from "@agent-harness/client-runtime/testing";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/harness.js";

const opened = async (shell?: FakeShell) => {
  const app = await renderApp(
    { environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }, { title: "Notes" }] }] },
    shell ? { shell } : {},
  );
  app.open("desk");
  await within(await screen.findByRole("region", { name: "Transcript" })).findByText("Nothing said yet.");
  return app;
};

describe("the browser dock", () => {
  it("restores the current address on Escape without navigating or hiding the browser", async () => {
    const app = await opened();
    await chooseHeaderAction(app, "Browser");
    const dock = await screen.findByRole("region", { name: "Browser" });
    await waitFor(() => expect(app.shell.calls.some(([name]) => name === "webView.attach")).toBe(true));
    act(() => app.shell.changeWebView("view-1", { url: "https://example.org/current", canGoBack: true, canGoForward: false, loading: false }));
    const address = within(dock).getByRole("textbox", { name: "Address" });
    await app.user.clear(address);
    await app.user.type(address, "unfinished");
    await app.user.keyboard("{Escape}");
    expect((address as HTMLInputElement).value).toBe("https://example.org/current");
    expect(app.shell.calls.some(([name]) => name === "webView.navigate")).toBe(false);
    expect(screen.getByRole("region", { name: "Browser" })).toBe(dock);
  });

  it("says a navigation failure in the browser and clears it on the next navigation", async () => {
    const shell = fakeShell();
    shell.answer("webView.navigate", async () => { throw new Error("This page could not be reached."); });
    const app = await opened(shell);
    await chooseHeaderAction(app, "Browser");
    const dock = await screen.findByRole("region", { name: "Browser" });
    await waitFor(() => expect(within(dock).getByRole("button", { name: "Go" }).hasAttribute("disabled")).toBe(false));
    await app.user.click(within(dock).getByRole("button", { name: "Go" }));
    expect((await within(dock).findByRole("status")).textContent).toContain("This page could not be reached.");
    shell.answer("webView.navigate", async () => {});
    await app.user.click(within(dock).getByRole("button", { name: "Go" }));
    await waitFor(() => expect(within(dock).queryByRole("status")).toBeNull());
  });

  it.each([
    ["localhost:3000/path", "https://localhost:3000/path"],
    ["example.org:8443/path", "https://example.org:8443/path"],
    ["example.org/path", "https://example.org/path"],
    ["http://localhost:3000/path", "http://localhost:3000/path"],
    ["https://example.org/path", "https://example.org/path"],
    ["about:blank", "about:blank"],
    ["ftp://example.org/path", "ftp://example.org/path"],
  ])("navigates address %s as %s", async (input, url) => {
    const app = await opened();
    await chooseHeaderAction(app, "Browser");
    const dock = await screen.findByRole("region", { name: "Browser" });
    await waitFor(() => expect(app.shell.calls.some(([name]) => name === "webView.attach")).toBe(true));
    const address = within(dock).getByRole("textbox", { name: "Address" });
    await app.user.clear(address);
    act(() => address.focus());
    await app.user.keyboard(`${input}{Enter}`);
    await waitFor(() => expect(app.shell.calls).toContainEqual(["webView.navigate", "view-1", url]));
  });

  it("opens from the header, navigates with its address line and hides and restores the same page with Mod+Shift+B", async () => {
    const app = await opened();
    await chooseHeaderAction(app, "Browser");
    const dock = await screen.findByRole("region", { name: "Browser" });
    await waitFor(() => expect(app.shell.calls.some(([name]) => name === "webView.attach")).toBe(true));
    const address = within(dock).getByRole("textbox", { name: "Address" });
    await app.user.clear(address);
    act(() => address.focus());
    await app.user.keyboard("https://example.org/one{Enter}");
    await waitFor(() => expect(app.shell.calls).toContainEqual(["webView.navigate", "view-1", "https://example.org/one"]));
    act(() => app.shell.changeWebView("view-1", { url: "https://example.org/two", canGoBack: true, canGoForward: true, loading: false }));
    expect((address as HTMLInputElement).value).toBe("https://example.org/two");
    await app.user.click(within(dock).getByRole("button", { name: "Back" }));
    await app.user.click(within(dock).getByRole("button", { name: "Forward" }));
    await app.user.click(within(dock).getByRole("button", { name: "Reload" }));
    expect(app.shell.calls).toContainEqual(["webView.back", "view-1"]);
    expect(app.shell.calls).toContainEqual(["webView.forward", "view-1"]);
    expect(app.shell.calls).toContainEqual(["webView.reload", "view-1"]);
    await app.user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    await waitFor(() => expect(app.shell.calls).toContainEqual(["webView.hide", "view-1"]));
    expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
    expect(app.shell.calls.filter(([name]) => name === "webView.destroy")).toHaveLength(0);
    await app.user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    expect(await screen.findByRole("region", { name: "Browser" })).toBeDefined();
    expect(app.shell.calls.filter(([name]) => name === "webView.create")).toHaveLength(1);
    await app.user.click(screen.getByRole("button", { name: "Close Browser" }));
    await waitFor(() => expect(app.shell.calls).toContainEqual(["webView.destroy", "view-1"]));
  });
  it("replaces Reload with a named, tooltipped Stop while loading and restores Reload after Stop or completion", async () => {
    const app = await opened();
    await chooseHeaderAction(app, "Browser");
    const dock = within(await screen.findByRole("region", { name: "Browser" }));
    await waitFor(() => expect(app.shell.calls.some(([name]) => name === "webView.attach")).toBe(true));
    const loading = { url: "https://example.org/slow", canGoBack: true, canGoForward: false, loading: true };
    act(() => app.shell.changeWebView("view-1", loading));
    expect(dock.queryByRole("button", { name: "Reload" })).toBeNull();
    const stop = dock.getByRole("button", { name: "Stop" });
    expect(stop.querySelector("svg")).not.toBeNull();
    // Keyboard focus opens the tooltip without a wall-clock hover delay.
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => stop.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("Stop · Enter / Space");
    await app.user.click(stop);
    expect(app.shell.calls).toContainEqual(["webView.stop", "view-1"]);
    expect(dock.getByRole("button", { name: "Reload" })).toBeDefined();
    expect(dock.queryByRole("button", { name: "Stop" })).toBeNull();
    act(() => app.shell.changeWebView("view-1", loading));
    act(() => app.shell.changeWebView("view-1", { ...loading, loading: false }));
    await app.user.click(dock.getByRole("button", { name: "Reload" }));
    expect(app.shell.calls).toContainEqual(["webView.reload", "view-1"]);
    expect(dock.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("follows size and position changes while shown, keeps pages across session switches and Settings, and isolates the next pane", async () => {
    const app = await opened();
    await chooseHeaderAction(app, "Browser");
    const surface = screen.getByLabelText("Browser page");
    let bounds = { x: 600, y: 130, width: 500, height: 620 };
    const geometry = vi.spyOn(surface, "getBoundingClientRect").mockImplementation(() => new DOMRect(bounds.x, bounds.y, bounds.width, bounds.height));
    await waitFor(() => expect(app.shell.calls).toContainEqual(["webView.attach", "view-1", bounds]));
    bounds = { x: 620, y: 130, width: 400, height: 500 };
    await waitFor(() => expect(app.shell.calls).toContainEqual(["webView.attach", "view-1", bounds]));
    // A position change alone also moves the native view.
    bounds = { x: 650, y: 130, width: 400, height: 500 };
    await waitFor(() => expect(app.shell.calls).toContainEqual(["webView.attach", "view-1", bounds]));
    geometry.mockRestore();
    app.open("desk", 1);
    await waitFor(() => expect(app.shell.calls).toContainEqual(["webView.hide", "view-1"]));
    expect(app.shell.calls.some(([name]) => name === "webView.destroy")).toBe(false);
    app.open("desk", 0);
    await screen.findByRole("region", { name: "Browser" });
    expect(app.shell.calls.filter(([name]) => name === "webView.create")).toHaveLength(1);
    await app.user.keyboard("{Control>},{/Control}");
    await screen.findByRole("region", { name: "Settings" });
    await waitFor(() => expect(app.shell.calls.at(-1)).toEqual(["webView.hide", "view-1"]));
    expect(app.shell.calls.some(([name]) => name === "webView.destroy")).toBe(false);
    await app.user.keyboard("{Escape}");
    await screen.findByRole("region", { name: "Browser" });
    expect(app.shell.calls.filter(([name]) => name === "webView.create")).toHaveLength(1);
    await chooseHeaderAction(app, "Split right");
    app.open("desk", 1);
    await chooseHeaderAction(app, "Browser");
    await waitFor(() => expect(app.shell.calls.filter(([name]) => name === "webView.create")).toHaveLength(2));
    expect(app.shell.calls.some(([name]) => name === "webView.destroy")).toBe(false);
    const focused = screen.getAllByRole("region", { name: "Session pane" }).find((pane) => pane.getAttribute("aria-current") === "true")!;
    await app.user.click(within(focused).getByRole("button", { name: "Close the pane" }));
    await waitFor(() => expect(app.shell.calls).toContainEqual(["webView.destroy", "view-2"]));
    expect(app.shell.calls).not.toContainEqual(["webView.destroy", "view-1"]);
  });

  it("has no page without webView and says the no-shell reason", async () => {
    const shell = { ...fakeShell(), webView: undefined } as unknown as FakeShell;
    const app = await opened(shell);
    expect(app.runtime.capability(app.environment("desk").environmentId, "shell.webView")).toMatchObject({ status: "absent", reason: "no-shell" });
    const menu = await openHeaderMenu(app);
    expect(within(menu).getByRole("menuitem", { name: "Browser" }).getAttribute("aria-disabled")).toBe("true");
    await app.user.keyboard("{Escape}");
    await app.user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
    const menuAgain = await openHeaderMenu(app);
    const choice = within(menuAgain).getByRole("menuitem", { name: /^Browser/ });
    expect(choice.getAttribute("aria-disabled")).toBe("true");
    await app.user.click(choice);
    expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
    const absent = app.runtime.capability(app.environment("desk").environmentId, "shell.webView");
    if (absent.status === "absent") expect(choice.textContent).toContain(absent.message);
    expect(app.shell.calls.some(([name]) => name === "webView.create")).toBe(false);
  });

  it("destroys a page closed before its creation finishes, without attaching it late", async () => {
    const shell = fakeShell();
    let finish!: (id: string) => void;
    shell.answer(
      "webView.create",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const app = await opened(shell);
    await chooseHeaderAction(app, "Browser");
    await app.user.click(screen.getByRole("button", { name: "Close Browser" }));
    await act(async () => finish("delayed-view"));
    await waitFor(() => expect(app.shell.calls).toContainEqual(["webView.destroy", "delayed-view"]));
    expect(app.shell.calls.some(([name]) => name === "webView.attach")).toBe(false);
    expect(app.platform.reported).toEqual([]);
  });

  it("reopens a dock in the same opaque partition after relaunch, so its cookies and storage survive", async () => {
    let app = await opened();
    await chooseHeaderAction(app, "Browser");
    await waitFor(() => expect(app.shell.calls.some(([name]) => name === "webView.attach")).toBe(true));
    const creates = () => app.shell.calls.filter(([name]) => name === "webView.create").map(([, options]) => options as { partition?: string });
    expect(creates()[0]!.partition).toMatch(/^[a-z0-9-]+$/);
    app = await app.remount();
    await screen.findByRole("region", { name: "Browser" });
    await waitFor(() => expect(creates()).toHaveLength(2));
    expect(creates()[1]!.partition).toBe(creates()[0]!.partition);
  });
  it("answers the toggle from the native page too, using this client's remapped key", async () => {
    const app = await opened();
    act(() => app.presentation.set("keyRemaps", { "app.browser.toggle": ["Mod+Shift+K"] }));
    await chooseHeaderAction(app, "Browser");
    await waitFor(() => expect(app.shell.calls.some(([name]) => name === "webView.attach")).toBe(true));
    act(() => app.shell.pressWebViewKey("view-1", { key: "K", code: "KeyK", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }));
    expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
    expect(app.shell.calls).toContainEqual(["webView.hide", "view-1"]);
    expect(app.shell.calls.some(([name]) => name === "webView.destroy")).toBe(false);
  });
});
