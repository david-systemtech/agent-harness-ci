import { afterEach, describe, expect, it } from "vitest";
import { cleanUp, start } from "../test/harness.js";

afterEach(cleanUp);

describe("the browser dock's view", () => {
  it("puts each page beside the renderer in its own sandboxed partition, leaving renderer lockdown in force", async () => {
    const { electron, shell } = await start();
    const views = shell().webView;
    const first = await views.create({ url: "https://example.org/" });
    await views.create({ url: "https://example.org/other" });
    const [one, two] = electron.views;
    expect(one!.options.webPreferences.partition).not.toBe(two!.options.webPreferences.partition);
    expect(one!.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(one!.webContents.session).not.toBe(electron.window().webContents.session);
    const bounds = { x: 450, y: 100, width: 500, height: 600 };
    views.attach(first, bounds);
    expect(electron.window().children).toContain(one);
    expect(one!.bounds).toEqual(bounds);
    expect(electron.window().webContents.navigate("https://example.org/").prevented).toBe(true);
    expect(electron.window().webContents.cancels("https://example.org/")).toBe(true);
    await expect(shell("https://example.org/").webView.create({ url: "https://example.org/" })).rejects.toThrow("app's own page");
  });
  it("keeps history and the page while hidden, reports navigations, resizes and closes only when asked", async () => {
    const { electron, shell } = await start();
    const views = shell().webView;
    const changed: unknown[] = [];
    const stop = views.onChange((id, state) => changed.push([id, state]));
    const id = await views.create({ url: "about:blank" });
    const page = electron.views[0]!;
    await views.navigate(id, "https://example.org/one");
    await views.navigate(id, "https://example.org/two");
    views.back(id);
    expect(await views.state(id)).toEqual({ url: "https://example.org/one", canGoBack: true, canGoForward: true });
    views.forward(id);
    views.reload(id);
    expect(page.reloads).toBe(1);
    views.attach(id, { x: 200, y: 90, width: 600, height: 500 });
    views.hide(id);
    expect(page.visible).toBe(false);
    expect(page.closed).toBe(false);
    views.attach(id, { x: 220, y: 90, width: 580, height: 500 });
    expect(page.visible).toBe(true);
    expect(page.bounds.width).toBe(580);
    expect((await views.state(id)).url).toBe("https://example.org/two");
    expect(changed).toContainEqual([id, { url: "https://example.org/two", canGoBack: true, canGoForward: false }]);
    stop();
    views.destroy(id);
    expect(page.closed).toBe(true);
    expect(electron.window().children).not.toContain(page);
  });

  it("closes every retained page with the window, denies popup windows and rejects non-web URLs and invalid IPC bounds", async () => {
    const errors: unknown[] = [];
    const { electron, shell } = await start({ reportError: (error) => errors.push(error) });
    const views = shell().webView;
    const id = await views.create({ url: "about:blank" });
    const page = electron.views[0]!;
    await expect(views.navigate(id, "file:///etc/passwd")).rejects.toThrow("http and https");
    expect(page.webContents.navigate("agent-harness://app/").prevented).toBe(true);
    expect(page.webContents.navigate("https://example.org/").prevented).toBe(false);
    expect(page.webContents.openWindow("https://example.org/")).toEqual({ action: "deny" });
    electron.ipcMain.send("shell:webView.attach", [id, { x: 0, y: 0, width: -1, height: 10 }]);
    expect(errors.map(String)).toEqual(["TypeError: View bounds are non-negative whole numbers."]);
    electron.window().close();
    expect(page.closed).toBe(true);
    await expect(views.state(id)).rejects.toThrow("closed");
  });

  it("uses a supplied opaque key only in the dock's persistent namespace and refuses profile names from the renderer", async () => {
    const { electron, shell } = await start();
    const views = shell().webView;
    await views.create({ url: "about:blank", partition: "profile-for-tests" });
    expect(electron.views[0]!.options.webPreferences.partition).toBe("persist:dock-profile-for-tests");
    await expect(views.create({ url: "https://example.org/", partition: "persist:default" })).rejects.toThrow("opaque key");
    expect(electron.views).toHaveLength(1);
  });
  it("hands native page keys to the renderer over the shell bridge without session data", async () => {
    const { electron, shell } = await start();
    const views = shell().webView;
    const id = await views.create({ url: "about:blank" });
    const keys: unknown[] = [];
    const stop = views.onKey((id, key) => keys.push([id, key]));
    electron.views[0]!.press("B", { control: true, shift: true });
    expect(keys).toEqual([[id, { key: "B", code: "KeyB", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }]]);
    stop();
    electron.views[0]!.press("B", { control: true, shift: true });
    expect(keys).toHaveLength(1);
  });
  it("carries debugger commands, child events and detachment through the preload", async () => {
    const { electron, shell } = await start();
    const views = shell().webView;
    const id = await views.create({ url: "about:blank" });
    const debug = views.debugger!;
    await debug.attach(id);
    const events: unknown[] = [];
    const detached: unknown[] = [];
    const stop = debug.onEvent((id, event) => events.push([id, event]));
    debug.onDetach((id, reason) => detached.push([id, reason]));
    const native = electron.views[0]!.webContents.debugger;
    await expect(debug.send(id, "Page.enable", {}, "child-for-tests")).resolves.toEqual({});
    expect(native.commands).toEqual([["Page.enable", {}, "child-for-tests"]]);
    native.emit("message", {}, "Page.frameNavigated", { frame: { id: "frame" } }, "child-for-tests");
    expect(events).toEqual([[id, { method: "Page.frameNavigated", params: { frame: { id: "frame" } }, sessionId: "child-for-tests" }]]);
    stop();
    native.emit("message", {}, "Page.loadEventFired", {});
    expect(events).toHaveLength(1);
    await debug.detach(id);
    expect(detached).toEqual([[id, "target_closed"]]);
    await expect(debug.send(id, "Page.enable")).rejects.toThrow("attached");
  });

});
