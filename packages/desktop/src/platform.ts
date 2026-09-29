import type { ShellPlatform } from "@agent-harness/client-runtime";

/**
 * The machine the desktop runs on, handed to the main process rather than
 * read from `process` and `os` inside it, so a test drives any platform's
 * behaviour on any runner: the deep link a Windows launch carries on its
 * command line, macOS's Dock badge, where the desktop keeps its files.
 * `main.ts` reads the real one.
 */
export interface DesktopPlatform {
  /** The operating system, as Node names it. */
  readonly os: ShellPlatform;
  /** As Node names it: `x64`, `arm64`. */
  readonly architecture: string;
  readonly hostname: string;
  /** The OS user's login name. */
  readonly user: string;
  readonly paths: DesktopPaths;
  /** This launch's command line: where Windows and Linux put the deep link the app was opened with. */
  readonly argv: readonly string[];
  /**
   * How the OS starts this app again for a deep link, when that is not the
   * executable alone: an unpackaged app (`electron .`) is Electron's
   * executable and the app's folder.
   */
  readonly relaunch?: { readonly executable: string; readonly args: readonly string[] };
}

export interface DesktopPaths {
  /**
   * Where the desktop keeps its own files: Chromium's profile, the window's
   * last Canvas colour, the client session tokens and its log.
   */
  readonly data: string;
  /** This machine's environment's data directory, where its grant file is. */
  readonly environment: string;
  /**
   * The server artefact the desktop carries, unpacked: its own Node and its
   * CLI, whose `service` verbs install and start this machine's environment.
   * Absent where the desktop carries none, as when run from a checkout.
   */
  readonly server?: string;
  /** The `gui` package's build, which the app scheme serves. */
  readonly renderer: string;
  /** The preload bundle. */
  readonly preload: string;
}
