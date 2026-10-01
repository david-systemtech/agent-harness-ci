import { describe, expect, it } from "vitest";
import { findHeadlessExecutable, type ExecutableSearch } from "./headless-executable.js";

/**
 * Which Chromium or Chrome the environment launches as its headless browser
 * (browser spec, "The headless Chromium"; #555): `browser.headless.executable`,
 * else the first found in the platform's usual install locations and then on
 * PATH. A pure part, tested over a scripted file system: no file is looked at
 * and no browser is launched.
 */

const linux = (present: readonly string[], env: ExecutableSearch["env"] = { PATH: "/usr/local/bin:/usr/bin:/bin" }): ExecutableSearch => ({
  platform: "linux",
  env,
  home: "/home/david",
  isExecutable: (path) => present.includes(path),
});

describe("the headless browser's executable", () => {
  it("is the one browser.headless.executable names, whatever else is installed", () => {
    expect(findHeadlessExecutable("/opt/chromium/chrome", linux(["/opt/chromium/chrome", "/usr/bin/chromium"]))).toEqual({ ok: true, path: "/opt/chromium/chrome" });
  });

  it("looks a bare name browser.headless.executable gives up on PATH", () => {
    expect(findHeadlessExecutable("chromium-dev", linux(["/usr/bin/chromium-dev", "/usr/bin/chromium"]))).toEqual({ ok: true, path: "/usr/bin/chromium-dev" });
  });

  it("is none, with the reason, when the named one is not there, rather than another found elsewhere", () => {
    expect(findHeadlessExecutable("/opt/chromium/chrome", linux(["/usr/bin/chromium"]))).toEqual({
      ok: false,
      reason: "the executable browser.headless.executable names, /opt/chromium/chrome, is not a file this environment can run",
    });
  });

  it("is, with none named, the first of Linux's usual install locations, Chromium before Chrome, before anything on PATH", () => {
    expect(findHeadlessExecutable(null, linux(["/usr/local/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]))).toEqual({ ok: true, path: "/usr/bin/chromium" });
    expect(findHeadlessExecutable(null, linux(["/usr/local/bin/chromium", "/usr/bin/google-chrome-stable"]))).toEqual({ ok: true, path: "/usr/bin/google-chrome-stable" });
    expect(findHeadlessExecutable(null, linux(["/snap/bin/chromium"]))).toEqual({ ok: true, path: "/snap/bin/chromium" });
  });

  it("is, where no usual location has one, the first on PATH, in PATH's order", () => {
    expect(findHeadlessExecutable(null, linux(["/home/david/bin/google-chrome", "/usr/local/bin/chromium"], { PATH: ":/usr/local/bin::/home/david/bin" }))).toEqual({
      ok: true,
      path: "/usr/local/bin/chromium",
    });
  });

  it("looks in macOS's Applications folders, the system's before the person's", () => {
    const chrome = "Google Chrome.app/Contents/MacOS/Google Chrome";
    const search = (present: readonly string[]): ExecutableSearch => ({ platform: "darwin", env: { PATH: "/usr/bin" }, home: "/Users/david", isExecutable: (path) => present.includes(path) });
    expect(findHeadlessExecutable(null, search([`/Users/david/Applications/${chrome}`, `/Applications/${chrome}`]))).toEqual({ ok: true, path: `/Applications/${chrome}` });
    expect(findHeadlessExecutable(null, search(["/Applications/Chromium.app/Contents/MacOS/Chromium"]))).toEqual({ ok: true, path: "/Applications/Chromium.app/Contents/MacOS/Chromium" });
    expect(findHeadlessExecutable(null, search([`/Users/david/Applications/${chrome}`]))).toEqual({ ok: true, path: `/Users/david/Applications/${chrome}` });
  });

  it("looks in Windows's program folders by their variables, then on Path, with Windows's separators", () => {
    const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\david\\AppData\\Local", Path: "C:\\Windows;C:\\Tools" };
    const search = (present: readonly string[]): ExecutableSearch => ({ platform: "win32", env, home: "C:\\Users\\david", isExecutable: (path) => present.includes(path) });
    expect(findHeadlessExecutable(null, search(["C:\\Users\\david\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"]))).toEqual({
      ok: true,
      path: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    });
    expect(findHeadlessExecutable(null, search(["C:\\Users\\david\\AppData\\Local\\Chromium\\Application\\chrome.exe"]))).toEqual({
      ok: true,
      path: "C:\\Users\\david\\AppData\\Local\\Chromium\\Application\\chrome.exe",
    });
    expect(findHeadlessExecutable(null, search(["C:\\Tools\\chromium.exe"]))).toEqual({ ok: true, path: "C:\\Tools\\chromium.exe" });
  });

  it("is none, with the reason and both ways to give one, where nothing is found", () => {
    expect(findHeadlessExecutable(null, linux([]))).toEqual({
      ok: false,
      reason:
        "no Chromium or Chrome was found in this platform's usual install locations or on PATH; name one in browser.headless.executable, or a browser beside the environment in browser.headless.endpoint",
    });
  });
});
