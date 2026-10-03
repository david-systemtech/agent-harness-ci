import { afterEach, expect, it } from "vitest";
import { cleanUp, platformOn, start } from "../test/harness.js";
import { fakeElectron } from "../test/fake-electron.js";

afterEach(cleanUp);

it.each(["darwin", "win32", "linux"] as const)("opens a hidden title bar on %s and answers its frame state", async (os) => {
  const { electron, shell } = await start({ electron: fakeElectron({ os }), platform: platformOn(os) });
  expect(electron.window().options).toMatchObject({ titleBarStyle: "hidden", ...(os === "darwin" ? { trafficLightPosition: { x: 12, y: 15 } } : { frame: false }) });
  expect(await shell().window.state?.()).toEqual({ platform: os, focused: true, maximized: false, fullScreen: false });
});

it.each(["darwin", "win32", "linux"] as const)("operates the %s native frame and follows OS events, with unsubscribe", async (os) => {
  const { electron, shell } = await start({ electron: fakeElectron({ os }), platform: platformOn(os) });
  const window = electron.window();
  const frame = shell().window;
  const heard: unknown[] = [];
  const stop = frame.onChange?.((state) => heard.push(state));
  frame.minimize?.();
  expect(window.minimized).toBe(true);
  frame.toggleMaximize?.();
  expect(window.maximized).toBe(true);
  frame.toggleMaximize?.();
  expect(window.maximized).toBe(false);
  window.emit("blur");
  window.emit("enter-full-screen");
  expect(heard.at(-1)).toEqual({ platform: os, focused: false, maximized: false, fullScreen: true });
  window.emit("focus");
  window.emit("leave-full-screen");
  expect(await frame.state?.()).toEqual({ platform: os, focused: true, maximized: false, fullScreen: false });
  expect(heard).toHaveLength(6);
  stop?.();
  window.emit("maximize");
  expect(heard).toHaveLength(6);
  frame.close?.();
  expect(window.calls).toContainEqual(["close"]);
});

it("refuses frame commands and state reads from another origin", async () => {
  const errors: unknown[] = [];
  const { electron, shell } = await start({ reportError: (error) => errors.push(error) });
  const foreign = shell("https://example.org/").window;
  foreign.minimize?.();
  foreign.toggleMaximize?.();
  foreign.close?.();
  expect(errors).toHaveLength(3);
  expect(electron.window().calls.map(([name]) => name)).not.toContain("close");
  await expect(foreign.state?.()).rejects.toThrow("own page only");
});
