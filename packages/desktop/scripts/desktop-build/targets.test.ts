import { describe, expect, it } from "vitest";
import { desktopTarget, DESKTOP_TARGETS } from "./targets.js";

/**
 * The desktop's three builds (#423): which file each platform's build is, the
 * format the desktop's `update` installs it as (#355), and where CI builds it
 * (#359).
 */

describe("the desktop's builds", () => {
  it("are the macOS zip for darwin-arm64, the Windows NSIS setup for win32-x64 and the Arch package for linux-x64, each named for its platform", () => {
    expect(DESKTOP_TARGETS.map(({ platform, format, name }) => ({ platform, format, name }))).toEqual([
      { platform: "darwin-arm64", format: "zip", name: "agent-harness-desktop-darwin-arm64.zip" },
      { platform: "win32-x64", format: "nsis", name: "agent-harness-desktop-win32-x64-setup.exe" },
      { platform: "linux-x64", format: "pacman", name: "agent-harness-desktop-linux-x64.pacman" },
    ]);
  });

  it("say which runner builds each: the Mac's for the zip, an x86_64 ci runner for the Arch package and for the setup, which is built there with Wine", () => {
    expect(desktopTarget("darwin-arm64").runner).toBe("macos");
    expect(desktopTarget("linux-x64").runner).toBe("ci-x64");
    expect(desktopTarget("win32-x64").runner).toBe("ci-x64");
  });

  it("say where each builds: the zip and the Arch package on their own platform, the setup on Windows or on an x86_64 Linux with Wine", () => {
    expect(DESKTOP_TARGETS.map(({ platform, hosts }) => [platform, hosts])).toEqual([
      ["darwin-arm64", ["darwin-arm64"]],
      ["win32-x64", ["win32-x64", "linux-x64"]],
      ["linux-x64", ["linux-x64"]],
    ]);
  });

  it("refuse a platform no desktop is built for, naming the three", () => {
    for (const platform of ["linux-arm64", "darwin-x64", "win32-arm64", ""]) {
      expect(() => desktopTarget(platform), platform).toThrow(`No desktop is built for ${JSON.stringify(platform)}; the platforms are darwin-arm64, win32-x64, linux-x64.`);
    }
  });
});
