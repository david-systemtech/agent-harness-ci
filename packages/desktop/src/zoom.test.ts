import { afterEach, describe, expect, it } from "vitest";
import { cleanUp, platformOn, start } from "../test/harness.js";
import { fakeElectron } from "../test/fake-electron.js";

afterEach(cleanUp);

describe.each(["win32", "darwin", "linux"] as const)("window zoom on %s", (os) => {
  it("zooms in with plus, unshifted equals and keypad plus, out with minus, and resets with zero", async () => {
    const { electron } = await start({ electron: fakeElectron({ os }), platform: platformOn(os) });
    const page = electron.window().webContents;
    const mod = os === "darwin" ? { meta: true } : { control: true };
    for (const [key, code, shift] of [["+", "Equal", true], ["=", "Equal", false], ["+", "NumpadAdd", false], ["+", "BracketRight", false], ["Add", "NumpadAdd", false]] as const) {
      expect(page.press(key, { ...mod, code, shift }).prevented).toBe(true);
      expect(page.getZoomFactor()).toBe(1.1);
      expect(page.press("-", { ...mod, code: "Minus" }).prevented).toBe(true);
      expect(page.getZoomFactor()).toBe(1);
      page.press("=", { ...mod, code: "Equal" });
      expect(page.press("0", { ...mod, code: "Digit0" }).prevented).toBe(true);
      expect(page.getZoomFactor()).toBe(1);
    }
  });
  it("uses the same limits and reset through the shell controls, including recovery from a tiny window", async () => {
    const { electron, shell } = await start({ electron: fakeElectron({ os }), platform: platformOn(os) });
    const page = electron.window().webContents;
    const window = shell().window;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    window.zoom!("in");
    await settle();
    expect(page.getZoomFactor()).toBe(1.1);
    for (let n = 0; n < 30; n++) window.zoom!("out");
    await settle();
    expect(page.getZoomFactor()).toBe(0.5);
    for (let n = 0; n < 30; n++) window.zoom!("in");
    await settle();
    expect(page.getZoomFactor()).toBe(2);
    page.setZoomFactor(0.1);
    window.zoom!("reset");
    await settle();
    expect(page.getZoomFactor()).toBe(1);
  });
  it("bounds keyboard zoom and leaves typing, other modifiers and key releases alone", async () => {
    const { electron } = await start({ electron: fakeElectron({ os }), platform: platformOn(os) });
    const page = electron.window().webContents;
    const mod = os === "darwin" ? { meta: true } : { control: true };
    for (let n = 0; n < 30; n++) page.press("=", mod);
    expect(page.getZoomFactor()).toBe(2);
    for (let n = 0; n < 30; n++) page.press("-", mod);
    expect(page.getZoomFactor()).toBe(0.5);
    page.press("0", mod);
    for (const modifiers of [{}, { ...mod, type: "keyUp" }, { ...mod, alt: true }, os === "darwin" ? { control: true } : { meta: true }]) {
      expect(page.press("+", modifiers).prevented).toBe(false);
      expect(page.getZoomFactor()).toBe(1);
    }
  });

  it("accepts minus and zero on layouts that need Shift to type them", async () => {
    const { electron } = await start({ electron: fakeElectron({ os }), platform: platformOn(os) });
    const page = electron.window().webContents;
    const mod = os === "darwin" ? { meta: true } : { control: true };
    page.press("=", mod);
    expect(page.press("-", { ...mod, shift: true }).prevented).toBe(true);
    expect(page.getZoomFactor()).toBe(1);
    page.press("=", mod);
    expect(page.press("0", { ...mod, shift: true }).prevented).toBe(true);
    expect(page.getZoomFactor()).toBe(1);
  });

});
