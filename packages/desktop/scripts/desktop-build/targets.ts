import { PRODUCT_NAME } from "@agent-harness/contracts";

/**
 * What the desktop build (#423) builds: one file per platform, each the
 * format the desktop's `update` installs a release's build in (#355), built
 * on the platform it is for, the Windows setup on an x86_64 Linux too (#359).
 */

/** The desktop build cannot go on: the message says why, and nothing it wrote is a build. */
export class DesktopBuildError extends Error {
  override readonly name = "DesktopBuildError";
}

/** One platform's desktop build. */
export interface DesktopTarget {
  /** `<os>-<arch>` as Node names them, as a release lists its assets: `darwin-arm64`. */
  readonly platform: string;
  readonly os: "darwin" | "win32" | "linux";
  readonly arch: "arm64" | "x64";
  /**
   * The format `update.current()` reports for an install of it, and a
   * release's manifest lists it under: a zip holding the macOS bundle, an
   * NSIS setup, an Arch package. electron-builder's target has the same name.
   */
  readonly format: "zip" | "nsis" | "pacman";
  /** The file's name: `agent-harness-desktop-darwin-arm64.zip`. */
  readonly name: string;
  /** The platforms it is built on, `<os>-<arch>`: its own first. */
  readonly hosts: readonly string[];
  /** The label of the CI runner that builds it. */
  readonly runner: string;
}

const target = (os: DesktopTarget["os"], arch: DesktopTarget["arch"], format: DesktopTarget["format"], file: string, runner: string, alsoOn: readonly string[] = []): DesktopTarget => {
  const platform = `${os}-${arch}`;
  return { platform, os, arch, format, name: `${PRODUCT_NAME}-desktop-${platform}${file}`, hosts: [platform, ...alsoOn], runner };
};

/**
 * Milestone 1's three builds. The zip is built on the MacBook's runner
 * (`macos`), which signs it ad hoc: electron-builder signs only on macOS, and
 * Apple silicon runs no unsigned code. The Arch package is built on an x86_64
 * ci runner (`ci-x64`, the release job's), where electron-builder's fpm runs.
 * No runner has Windows, so the setup is built on `ci-x64` too, in an image
 * with Wine: on Linux, electron-builder runs its own makensis and edits the
 * app's executable itself, and runs the setup under Wine only to write its
 * uninstaller. It builds on Windows as well, by hand.
 */
export const DESKTOP_TARGETS: readonly DesktopTarget[] = [
  target("darwin", "arm64", "zip", ".zip", "macos"),
  target("win32", "x64", "nsis", "-setup.exe", "ci-x64", ["linux-x64"]),
  target("linux", "x64", "pacman", ".pacman", "ci-x64"),
];

/** The build for `platform`; a platform no desktop is built for is a `DesktopBuildError`. */
export const desktopTarget = (platform: string): DesktopTarget => {
  const found = DESKTOP_TARGETS.find((each) => each.platform === platform);
  if (found === undefined) {
    throw new DesktopBuildError(`No desktop is built for ${JSON.stringify(platform)}; the platforms are ${DESKTOP_TARGETS.map((each) => each.platform).join(", ")}.`);
  }
  return found;
};
