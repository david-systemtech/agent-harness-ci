import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanUp, scratch, start } from "../test/harness.js";
import { desktopLog, LOG_SET_ASIDE_BYTES } from "./log.js";

afterEach(cleanUp);

/**
 * The desktop's log (docs/specs/gui.md, "The desktop platform"): the faults
 * with no caller to hand them to, the main process's and the window's, one
 * dated entry each in `logs/desktop.log` in the desktop's data directory.
 */

const AT = new Date("2026-09-29T08:30:00.000Z");

describe("the desktop's log", () => {
  it("writes each fault with its time, an error with its stack", async () => {
    const dir = scratch();
    const log = desktopLog(dir, () => AT);
    log.report(new Error("The window failed to load."));
    log.report("The window: Uncaught TypeError: x is undefined");
    await log.flushed();
    const text = readFileSync(join(dir, "logs", "desktop.log"), "utf8");
    expect(text).toMatch(/^2026-09-29T08:30:00\.000Z Error: The window failed to load\.\n {4}at /);
    expect(text).toContain("\n2026-09-29T08:30:00.000Z The window: Uncaught TypeError: x is undefined\n");
  });

  it("sets aside a log grown past its bound when it opens, keeping one before it", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "logs"));
    writeFileSync(join(dir, "logs", "desktop.log"), "x".repeat(LOG_SET_ASIDE_BYTES + 1));
    const log = desktopLog(dir, () => AT);
    log.report("after");
    await log.flushed();
    expect(readFileSync(join(dir, "logs", "desktop.log"), "utf8")).toBe("2026-09-29T08:30:00.000Z after\n");
    expect(existsSync(join(dir, "logs", "desktop.log.1"))).toBe(true);
  });

  it("hears the window's console errors, where the renderer reports its faults, and nothing quieter", async () => {
    const reported: unknown[] = [];
    const { electron } = await start({ reportError: (error) => reported.push(error) });
    const page = electron.window().webContents;
    page.log("info", "Download the React DevTools");
    page.log("warning", "A slow network request");
    page.log("error", "Error: The presentation document could not be read in full");
    expect(reported).toEqual(["The window: Error: The presentation document could not be read in full (agent-harness://app/assets/index.js:1)"]);
  });
});
