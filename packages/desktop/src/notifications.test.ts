import { afterEach, describe, expect, it } from "vitest";
import { fakeElectron } from "../test/fake-electron.js";
import { cleanUp, platformOn, start } from "../test/harness.js";

afterEach(cleanUp);

/**
 * The shell's `notifications` (docs/specs/gui.md, "The desktop shell";
 * #405): an OS notification of the title and body the renderer composed,
 * and the tag it was shown with handed back to the renderer
 * (`notifications.onActivate`) when it is clicked, the window brought
 * forward. Driven over faked Electron, the renderer's side being the shell
 * the preload builds.
 */

const TAG = "agent-harness://session/desk/0199a100-0000-4000-8000-000000000001";

describe("a notification", () => {
  it("shows the title and body the renderer composed, and a click hands its tag back and brings the window forward", async () => {
    const { electron, shell } = await start();
    const clicked: string[] = [];
    shell().notifications.onActivate((tag) => clicked.push(tag));
    await shell().notifications.show({ title: "Parser", body: "Bash is waiting for permission", tag: TAG });

    const [shown] = electron.notifications;
    expect(shown?.options).toEqual({ title: "Parser", body: "Bash is waiting for permission" });
    expect(shown?.shown).toBe(true);
    electron.window().minimized = true;
    shown?.click();
    expect(clicked).toEqual([TAG]);
    expect(electron.window().calls).toEqual(expect.arrayContaining([["restore"], ["show"], ["focus"]]));
  });

  it("hands every listener the tag, and none once it has stopped listening", async () => {
    const { electron, shell } = await start();
    const renderer = shell();
    const first: string[] = [];
    const second: string[] = [];
    const stop = renderer.notifications.onActivate((tag) => first.push(tag));
    renderer.notifications.onActivate((tag) => second.push(tag));
    await renderer.notifications.show({ title: "Receipts", body: "The turn has finished", tag: TAG });
    stop();
    electron.notifications[0]?.click();
    expect(first).toEqual([]);
    expect(second).toEqual([TAG]);
  });

  it("shown without a tag still brings the window forward when clicked, and hands nothing back", async () => {
    const { electron, shell } = await start();
    const clicked: string[] = [];
    shell().notifications.onActivate((tag) => clicked.push(tag));
    await shell().notifications.show({ title: "agent-harness", body: "Upstream watch on desk: skipped." });
    electron.notifications[0]?.click();
    expect(clicked).toEqual([]);
    expect(electron.window().calls).toEqual(expect.arrayContaining([["show"], ["focus"]]));
  });

  it("refuses what is not a title and a body with an optional tag, showing nothing", async () => {
    const { electron, shell } = await start();
    await expect(shell().notifications.show({ title: 3, body: "x" } as never)).rejects.toThrow("A notification's title must be text.");
    await expect(shell().notifications.show({ title: "x", body: "y", tag: {} } as never)).rejects.toThrow("A notification's tag must be text.");
    expect(electron.notifications).toEqual([]);
  });

  it("says why where the OS shows none", async () => {
    const electron = fakeElectron();
    electron.notificationsSupported = false;
    const { shell } = await start({ electron });
    await expect(shell().notifications.show({ title: "Parser", body: "Bash is waiting for permission", tag: TAG })).rejects.toThrow(
      "This desktop cannot show notifications: the OS offers none to it.",
    );
    expect(electron.notifications).toEqual([]);
  });
});

describe("the app's identity", () => {
  it("on Windows is the AppUserModelID its Start menu shortcut carries, which a notification's sender must match", async () => {
    const electron = fakeElectron({ os: "win32" });
    electron.app.isPackaged = true;
    await start({ electron, platform: platformOn("win32") });
    expect(electron.app.calls).toContainEqual(["setAppUserModelId", "dev.systemtech.agent-harness"]);
  });

  it("on Windows run from a checkout, with no shortcut carrying that id, is Electron's executable, as Electron has a development run's", async () => {
    const platform = platformOn("win32", { executable: "C:\\agent-harness\\node_modules\\electron\\dist\\electron.exe" });
    const { electron } = await start({ electron: fakeElectron({ os: "win32" }), platform });
    expect(electron.app.calls).toContainEqual(["setAppUserModelId", "C:\\agent-harness\\node_modules\\electron\\dist\\electron.exe"]);
  });

  it("is set nowhere else, where the bundle or the desktop entry names the app", async () => {
    for (const os of ["darwin", "linux"] as const) {
      const { electron } = await start({ electron: fakeElectron({ os }), platform: platformOn(os) });
      expect(electron.app.calls.filter(([method]) => method === "setAppUserModelId")).toEqual([]);
    }
  });
});
