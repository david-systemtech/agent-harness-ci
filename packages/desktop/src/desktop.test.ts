import { afterEach, describe, expect, it } from "vitest";
import { cleanUp, platformOn, rendererShell, start } from "../test/harness.js";
import { fakeElectron } from "../test/fake-electron.js";
import { startDesktop } from "./desktop.js";

afterEach(cleanUp);

/** Collects the deep links the renderer's `deepLinks.onOpen` hears. */
const hearLinks = (shell: ReturnType<typeof rendererShell>): string[] => {
  const heard: string[] = [];
  shell.deepLinks.onOpen((url) => heard.push(url));
  return heard;
};

/** Lets the renderer's `deepLinks.onOpen` subscription reach the main process and come back. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("one window, one instance", () => {
  it("opens one window, and a second instance quits without opening another or registering anything", async () => {
    const first = await start();
    expect(first.electron.windows).toHaveLength(1);

    const second = fakeElectron();
    second.app.locked = true;
    await startDesktop(second, platformOn("linux"));
    expect(second.app.calls).toContainEqual(["quit"]);
    expect(second.windows).toEqual([]);
    expect(second.protocol.privileged).toEqual([]);
    expect(second.ipcMain.channels()).toEqual([]);
  });

  it("brings the window forward on a second launch, restoring it when minimised, and hands the launch's deep link to the renderer", async () => {
    const { electron, shell } = await start();
    const heard = hearLinks(shell());
    await settle();
    const window = electron.window();
    window.minimized = true;

    electron.app.emit("second-instance", {}, ["/opt/agent-harness/agent-harness", "--no-sandbox", "agent-harness://pair?code=K7Q2MXH4RT"]);

    expect(window.calls.map(([method]) => method)).toEqual(expect.arrayContaining(["restore", "show", "focus"]));
    expect(heard).toEqual(["agent-harness://pair?code=K7Q2MXH4RT"]);
  });

  it("brings the window forward on a second launch without a deep link, and hands the renderer nothing", async () => {
    const { electron, shell } = await start();
    const heard = hearLinks(shell());
    await settle();

    electron.app.emit("second-instance", {}, ["/opt/agent-harness/agent-harness"]);

    expect(electron.window().calls.map(([method]) => method)).toContain("focus");
    expect(heard).toEqual([]);
  });

  it("hands the renderer the deep link a Windows or Linux launch was opened with, once it listens", async () => {
    for (const os of ["win32", "linux"] as const) {
      const { shell } = await start({
        electron: fakeElectron({ os }),
        platform: platformOn(os, { argv: ["C:\\Program Files\\agent-harness\\agent-harness.exe", "agent-harness://open/desk/1"] }),
      });
      const heard = hearLinks(shell());
      await settle();
      expect(heard).toEqual(["agent-harness://open/desk/1"]);
    }
  });

  it("on macOS takes a deep link opened before the app is ready, holds it for the renderer, and brings the window forward for a later one", async () => {
    const electron = fakeElectron({ os: "darwin", ready: false });
    const started = startDesktop(electron, platformOn("darwin"));
    let refused = false;
    electron.app.emit("open-url", { preventDefault: () => (refused = true) }, "agent-harness://pair?code=K7Q2MXH4RT");
    expect(refused).toBe(true);
    electron.app.becomeReady();
    await started;

    const heard = hearLinks(rendererShell(electron));
    await settle();
    expect(heard).toEqual(["agent-harness://pair?code=K7Q2MXH4RT"]);

    electron.app.emit("open-url", { preventDefault: () => {} }, "agent-harness://open/desk/2");
    expect(heard).toEqual(["agent-harness://pair?code=K7Q2MXH4RT", "agent-harness://open/desk/2"]);
    expect(electron.window().calls.map(([method]) => method)).toContain("focus");
  });

  it("keeps handing deep links to the page after it refused to navigate away from a link clicked out of it", async () => {
    const { electron, shell } = await start();
    const heard = hearLinks(shell());
    await settle();

    expect(electron.window().webContents.navigate("https://docs.example.org/").prevented).toBe(true);
    electron.app.emit("second-instance", {}, ["agent-harness", "agent-harness://open/desk/3"]);
    expect(heard).toEqual(["agent-harness://open/desk/3"]);
  });

  it("hands later deep links to a page loaded again once it listens", async () => {
    const { electron, shell } = await start();
    const before = hearLinks(shell());
    await settle();
    electron.app.emit("second-instance", {}, ["agent-harness", "agent-harness://open/desk/3"]);

    // The page loads again: a new preload, whose first listener asks again.
    const again = rendererShell(electron);
    const after: string[] = [];
    again.deepLinks.onOpen((url) => after.push(url));
    await settle();
    electron.app.emit("second-instance", {}, ["agent-harness", "agent-harness://open/desk/4"]);

    expect(before).toContain("agent-harness://open/desk/3");
    expect(after).toEqual(["agent-harness://open/desk/4"]);
  });

  it("registers its scheme with the OS: the scheme alone when packaged, with Electron's executable and the app's folder when not", async () => {
    const packaged = await start();
    expect(packaged.electron.app.calls).toContainEqual(["setAsDefaultProtocolClient", "agent-harness"]);

    const unpackaged = await start({
      platform: platformOn("win32", { relaunch: { executable: "C:\\dev\\electron.exe", args: ["C:\\dev\\agent-harness\\packages\\desktop"] } }),
    });
    expect(unpackaged.electron.app.calls).toContainEqual([
      "setAsDefaultProtocolClient",
      "agent-harness",
      "C:\\dev\\electron.exe",
      ["C:\\dev\\agent-harness\\packages\\desktop"],
    ]);
  });

  it("quits when its window closes: there is no tray to keep it", async () => {
    const { electron } = await start();
    electron.app.emit("window-all-closed");
    expect(electron.app.calls).toContainEqual(["quit"]);
  });

  it("keeps Chromium's profile in the platform's data directory, set before the app is ready", async () => {
    const electron = fakeElectron({ ready: false });
    const platform = platformOn("linux");
    const started = startDesktop(electron, platform);
    expect(electron.app.calls).toContainEqual(["setPath", "userData", platform.paths.data]);
    electron.app.becomeReady();
    await started;
  });
});

describe("the window", () => {
  it("runs the renderer sandboxed and isolated, with no Node anywhere, the preload bundle its one bridge", async () => {
    const { electron, platform } = await start();
    expect(electron.window().options.webPreferences).toEqual({
      preload: platform.paths.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
  });

  it("loads the renderer from agent-harness://app/, never from file:", async () => {
    const { electron } = await start();
    const loads = electron.window().calls.filter(([method]) => method === "loadURL");
    expect(loads).toEqual([["loadURL", "agent-harness://app/"]]);
  });
});
