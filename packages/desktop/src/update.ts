import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ShellApplyOutcome, ShellApplyWhen, ShellStagedBuild, ShellUpdate } from "@agent-harness/client-runtime";
import { options, text } from "./arguments.js";
import { lastLine, oneAtATime } from "./commands.js";
import type { ElectronApp } from "./electron.js";
import type { DesktopPlatform } from "./platform.js";

/**
 * The shell's `update` (launcher-update spec, "The desktop moves with its
 * local environment"): the build the desktop runs, and the application of
 * one its local environment staged from the same public GitHub release
 * channel as the server (no desktop forge credential), each platform its
 * own way. A macOS
 * bundle is swapped by rename, the old one renamed back when the swap
 * fails; a Windows install hands over to its NSIS setup, showing progress once
 * the desktop has quit; an Arch install runs `pacman -U` through `pkexec`.
 * An AppImage, a `.deb` or a bundle that cannot be replaced has no format:
 * the runtime reports it `unsupported`, with the release page.
 *
 * Temporary folders are made and removed through physical file calls, never a
 * command, so no platform's cleanup rests on a tool it may lack; a cleanup
 * that fails is said as one, never as an install that failed.
 */

/** The file calls an update makes: Node's own, unless a test wraps one to fail. */
export interface UpdateFiles {
  readonly access: typeof access;
  readonly lstat: typeof lstat;
  readonly mkdtemp: typeof mkdtemp;
  readonly readFile: typeof readFile;
  readonly readdir: typeof readdir;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
  readonly writeFile: typeof writeFile;
}

/** What a command run to its end came to: its exit code, and what it said on its standard error. */
export interface CommandResult {
  readonly code: number;
  readonly stderr: string;
}

/**
 * What applying an update asks of the machine: the OS's commands (`ditto`,
 * `pkexec`, `pacman`, a setup) and the file calls. `startDesktop` takes
 * Node's own (`NODE_UPDATE_SYSTEM`); a test hands in a recording fake.
 */
export interface UpdateSystem {
  /** Runs `command` with `args` to its end. Rejects when it could not be started, as one that is not installed. */
  run(command: string, args: readonly string[]): Promise<CommandResult>;
  /** Starts `command` with `args` on its own, left running once the desktop has quit. Rejects when it could not be started. */
  start(command: string, args: readonly string[]): Promise<void>;
  readonly files: UpdateFiles;
}

export const NODE_UPDATE_SYSTEM: UpdateSystem = {
  run: (command, args) =>
    new Promise((settle, reject) => {
      execFile(command, [...args], { windowsHide: true, encoding: "utf8" }, (error, _stdout, stderr) => {
        if (error === null) settle({ code: 0, stderr });
        else if (typeof error.code === "number") settle({ code: error.code, stderr });
        else reject(error);
      });
    }),
  start: (command, args) =>
    new Promise((settle, reject) => {
      const child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        settle();
      });
    }),
  files: { access, lstat, mkdtemp, readFile, readdir, rename, rm, writeFile },
};

export interface UpdateParts {
  readonly onInstalling?: () => void;
  /** Writes one line to the desktop's update log, `logs/desktop-update.log` in its data directory (`updateLog`); preset none. */
  readonly log?: (line: string) => void;
  /** The time now in milliseconds since the epoch; preset `Date.now`. */
  readonly clock?: () => number;
  readonly app: ElectronApp;
  readonly platform: DesktopPlatform;
  readonly system: UpdateSystem;
  /** Hears a failure no caller may be left to hear: an install at the quit, or a cleanup before a restart. */
  readonly report: (error: unknown) => void;
}

/** A build the renderer handed over to apply, as the local environment staged it: its path, version and SHA-256. */
export const stagedBuild = (value: unknown): ShellStagedBuild => {
  const { path, version, sha256 } = options(value, "A staged build");
  const digest = text(sha256, "A staged build's SHA-256");
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError("A staged build's SHA-256 must be 64 lowercase hexadecimal digits.");
  return { path: text(path, "A staged build's path"), version: text(version, "A staged build's version"), sha256: digest };
};

/** When a staged build is applied: `now`, or as the desktop next quits. */
export const applyWhen = (value: unknown): ShellApplyWhen => {
  if (value !== "now" && value !== "quit") throw new TypeError(`A build is applied now or at the quit, not ${JSON.stringify(value)}.`);
  return value;
};

/** The bundle the macOS executable runs in (`<bundle>.app/Contents/MacOS/<name>`), or undefined when it runs in none. */
const bundleOf = (executable: string): string | undefined => {
  const bundle = resolve(executable, "..", "..", "..");
  return basename(bundle).endsWith(".app") && basename(dirname(executable)) === "MacOS" ? bundle : undefined;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The SHA-256 of the file at `path`, read as a stream: a build is a hundred megabytes or more. */
const sha256Of = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
};

const APPLIED: ShellApplyOutcome = { outcome: "applied" };
const failed = (failure: "install" | "cleanup", message: string, byHand?: string): ShellApplyOutcome => ({ outcome: "failed", failure, message, ...(byHand !== undefined && { byHand }) });

/**
 * A build installed ahead of the click (#2194), ready to switch to: where the
 * installed app is, and the folder it was unpacked into when that is not
 * where it stays.
 */
export interface Prepared {
  readonly target: string;
  readonly temporary?: string;
}

/**
 * Where a build is on its way to "Restart to update" (#2194): downloaded (the
 * local environment staged it), installing in the background beside the app
 * that runs, installed and ready to switch to, or failed to prepare, the
 * running version untouched. Only an installed build is switched to.
 */
export type PreparationState =
  | { readonly state: "downloaded"; readonly build: ShellStagedBuild }
  | { readonly state: "installing"; readonly build: ShellStagedBuild }
  | { readonly state: "installed"; readonly build: ShellStagedBuild; readonly prepared: Prepared }
  | { readonly state: "failed"; readonly build: ShellStagedBuild; readonly reason: string };

const sameBuild = (a: ShellStagedBuild, b: ShellStagedBuild): boolean => a.path === b.path && a.version === b.version && a.sha256 === b.sha256;

/**
 * The platform-neutral state machine of a build's preparation: one build at a
 * time, the newest downloaded winning. A step for a build that is no longer
 * the one being prepared answers false, so its caller removes what it made.
 */
export const preparation = () => {
  let current: PreparationState | undefined;
  const is = (build: ShellStagedBuild, state: PreparationState["state"]): boolean => current?.state === state && sameBuild(current.build, build);
  return {
    get current(): PreparationState | undefined {
      return current;
    },
    /** `build` is downloaded; answers the installed build it replaces, if any, whose files are then removed. A build already installing or installed stays so. */
    downloaded(build: ShellStagedBuild): Prepared | undefined {
      if (current !== undefined && current.state !== "failed" && sameBuild(current.build, build)) return undefined;
      const replaced = current?.state === "installed" ? current.prepared : undefined;
      current = { state: "downloaded", build };
      return replaced;
    },
    installing(build: ShellStagedBuild): void {
      if (!is(build, "downloaded")) throw new Error(`${build.version} is installed only once downloaded.`);
      current = { state: "installing", build };
    },
    installed(build: ShellStagedBuild, prepared: Prepared): boolean {
      if (!is(build, "installing")) return false;
      current = { state: "installed", build, prepared };
      return true;
    },
    failed(build: ShellStagedBuild, reason: string): boolean {
      if (!is(build, "installing")) return false;
      current = { state: "failed", build, reason };
      return true;
    },
    /** What the click switches to: `build` once installed, else undefined. */
    switchable(build: ShellStagedBuild): Prepared | undefined {
      return current?.state === "installed" && sameBuild(current.build, build) ? current.prepared : undefined;
    },
    /** The switch is done: nothing is prepared any more. */
    switched(): void {
      current = undefined;
    },
  };
};

/** Where the old process writes the click's time, for the new one to read once its window is ready: `<data>/update-click.json`. */
export const CLICK_FILE = "update-click.json";

/** The pointer `desktop-launch.ps1` follows to the Windows version installed ahead of the click: `<data>/current`, the version's name. */
export const CURRENT_POINTER = "current";

/** A version that is safe as one path segment: `versions/<version>`. */
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/**
 * Appends lines to `logs/desktop-update.log` in the desktop's data directory,
 * where the Windows setup writes its `<version> setup <ms>ms`; a line that
 * cannot be written goes to `report`.
 */
export const updateLog = (dataDir: string, os: DesktopPlatform["os"], report: (error: unknown) => void) => {
  const dir = join(dataDir, "logs");
  const ending = os === "win32" ? "\r\n" : "\n";
  let written: Promise<void> = Promise.resolve();
  return (line: string): void => {
    written = written.then(() => mkdir(dir, { recursive: true })).then(() => appendFile(join(dir, "desktop-update.log"), line + ending)).catch(report);
  };
};

/** The Windows install's root: the folder of the executable, or of `versions` when it runs from a version installed ahead of the click. */
export const windowsInstallRoot = (executable: string): string => {
  const folder = dirname(executable);
  return basename(dirname(folder)) === "versions" ? dirname(dirname(folder)) : folder;
};

/** `pkexec`'s exit codes when it runs nothing: the authentication was dismissed (126), or refused or never asked (127). */
const PKEXEC_REFUSED: ReadonlySet<number> = new Set([126, 127]);

/** What `pkexec` says when no polkit authentication agent runs to ask the person, as under a bare window manager. */
const NO_AGENT = /No authentication agent found/i;

/** `text` as one word of a POSIX shell command: as it is when the shell would not split or expand it, else single-quoted. */
const shellWord = (text: string): string => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

/**
 * How this install takes a build: the format a release's build of it is,
 * and its install, which runs as the desktop runs, the desktop then started
 * again, or once it has quit, as a setup that starts it again when asked.
 * An install that cannot update itself has no format, and says why.
 */
type Installation =
  | { readonly format: null; readonly why: string }
  | {
      readonly format: "zip" | "nsis" | "pacman";
      readonly afterQuit: boolean;
      install(staged: ShellStagedBuild, restart: boolean): Promise<ShellApplyOutcome>;
      /** Installs `staged` beside the running app, ahead of the click; rejects saying why, the running version untouched. */
      prepare?(staged: ShellStagedBuild): Promise<Prepared>;
      /** Removes what a preparation made that will not be switched to. */
      discard?(prepared: Prepared): Promise<void>;
      /** Switches to the prepared build at the click (`restart`, starting it again) or at the quit. */
      switchTo?(staged: ShellStagedBuild, prepared: Prepared, restart: boolean): Promise<ShellApplyOutcome>;
    };

/** Why a bundle swap failed; `stranded` when the old bundle could not be renamed back either, so the temporary folder holds the only copy of the app. */
interface SwapFailure {
  readonly why: string;
  readonly stranded?: true;
}

/** A build handed over for the quit: installed as the desktop quits, then started again when `restart`. */
interface HandedOver {
  readonly staged: ShellStagedBuild;
  readonly restart: boolean;
}

/** Activated only after a successful swap; a stranded rollback has no cleanup authority. */
const CLEANUP_MARKER = ".cleanup";
const PENDING_CLEANUP_MARKER = ".cleanup-pending";
const temporaryPrefix = (bundle: string): string => `.${basename(bundle)}-update-`;

/** The shell's update, and what the new process says once its window is ready: the click's time to it, logged. */
export interface DesktopUpdate extends ShellUpdate {
  ready(): Promise<void>;
}

export const desktopUpdate = ({ app, platform, system, report, onInstalling, log = () => {}, clock = Date.now }: UpdateParts): DesktopUpdate => {
  const { files } = system;
  const stays = () => `${app.getVersion()} stays installed`;

  /** The new process owns cleanup after the old process has released its bundle. */
  const retryCleanup = async (): Promise<void> => {
    if (platform.os !== "darwin" || !app.isPackaged) return;
    const bundle = bundleOf(platform.executable);
    if (bundle === undefined) return;
    const parent = dirname(bundle);
    for (const name of await files.readdir(parent)) {
      const pending = name.endsWith(PENDING_CLEANUP_MARKER);
      const suffix = pending ? PENDING_CLEANUP_MARKER : CLEANUP_MARKER;
      if (!name.startsWith(temporaryPrefix(bundle)) || !name.endsWith(suffix)) continue;
      const marker = join(parent, name);
      const temporary = marker.slice(0, -suffix.length);
      try {
        // A filename alone never authorizes removal, nor does a symlink to an owned folder.
        if (!(await files.lstat(marker)).isFile()) continue;
        if (await files.readFile(marker, "utf8") !== bundle) continue;
        const found = await files.lstat(temporary).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (found !== undefined && !found.isDirectory()) continue;
        if (pending && found !== undefined) {
          // The incoming bundle remains here until the swap commits, including a stranded rollback.
          if ((await files.readdir(temporary)).some((entry) => entry.endsWith(".app"))) continue;
          if (!(await files.lstat(bundle)).isDirectory()) continue;
        }
        await files.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        // Keep the receipt outside the tree: a partial removal must not erase retry authority.
        await files.rm(marker, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") report(new Error(`The desktop's deferred update cleanup: ${messageOf(error)}`));
      }
    }
  };
  const cleanupReady = retryCleanup().catch(report);

  /** Whether `path` can be written: a bundle on a disk image, or translocated, cannot. */
  const writable = (path: string): Promise<boolean> =>
    files.access(path, constants.W_OK).then(
      () => true,
      () => false,
    );

  /**
   * Unpacks the staged zip with `ditto` into a temporary folder beside
   * `bundle`, on the same volume, as soon as the build is downloaded
   * (#2194): only the rename swap is left for the click. Rejects saying why,
   * the temporary folder removed.
   */
  const prepareBundle = async (bundle: string, staged: ShellStagedBuild): Promise<Prepared> => {
    let temporary: string;
    try {
      temporary = await files.mkdtemp(join(dirname(bundle), temporaryPrefix(bundle)));
    } catch (error) {
      throw new Error(`Could not make a folder beside ${bundle} to unpack ${staged.version} into (${messageOf(error)}), so ${stays()}.`, { cause: error });
    }
    const unpack = async (): Promise<Prepared> => {
      const unpacked = await system.run("ditto", ["-x", "-k", staged.path, temporary]).catch((error: unknown) => ({ code: -1, stderr: messageOf(error) }));
      if (unpacked.code !== 0) throw new Error(`${staged.version} did not unpack (${lastLine(unpacked.stderr) ?? `ditto exited with ${unpacked.code}`}), so ${stays()}.`);
      const bundles = (await files.readdir(temporary)).filter((name) => name.endsWith(".app"));
      const [incoming] = bundles;
      if (incoming === undefined || bundles.length > 1) throw new Error(`The build of ${staged.version} does not hold one app bundle, so ${stays()}.`);
      return { target: join(temporary, incoming), temporary };
    };
    try {
      return await unpack();
    } catch (error) {
      const removed = await files.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).then(() => "", (cleanup: unknown) => ` And the temporary folder ${temporary} could not be removed: ${messageOf(cleanup)}.`);
      throw new Error(messageOf(error) + removed, { cause: error });
    }
  };

  /**
   * Swaps `bundle` for the one prepared beside it: the old bundle renamed
   * into the temporary folder and the new one renamed into its place, the
   * old one renamed back if that fails. A successful swap records cleanup for
   * the next process; a stranded rollback keeps the only copy of the app.
   */
  const swapPrepared = async (bundle: string, staged: ShellStagedBuild, { target: incoming, temporary = dirname(incoming) }: Prepared): Promise<ShellApplyOutcome> => {
    const previous = join(temporary, "previous");
    const pendingMarker = temporary + PENDING_CLEANUP_MARKER;
    /** Undefined once the new bundle is in place, else why it is not. A stranded app's temporary folder is kept. */
    const swap = async (): Promise<SwapFailure | undefined> => {
      // Refuse the swap if ownership cannot be recorded; a partial write never strands an old bundle.
      await files.writeFile(pendingMarker, bundle, { flag: "wx", mode: 0o600 });
      try {
        await files.rename(bundle, previous);
      } catch (error) {
        return { why: `Could not move ${bundle} aside (${messageOf(error)}), so ${stays()}.` };
      }
      try {
        await files.rename(incoming, bundle);
      } catch (error) {
        try {
          await files.rename(previous, bundle);
        } catch (rollback) {
          return { why: `Could not put ${staged.version} in place (${messageOf(error)}), nor rename ${app.getVersion()} back (${messageOf(rollback)}): it is at ${previous}.`, stranded: true };
        }
        return { why: `Could not put ${staged.version} in place (${messageOf(error)}); the old bundle was renamed back, so ${stays()}.` };
      }
      return undefined;
    };
    const failure = await swap().catch((error: unknown): SwapFailure => ({ why: `Could not install ${staged.version} (${messageOf(error)}), so ${stays()}.` }));
    if (failure?.stranded) return failed("install", failure.why);
    try {
      if (failure === undefined) {
        await files.rename(pendingMarker, temporary + CLEANUP_MARKER);
      } else {
        await files.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        await files.rm(pendingMarker, { force: true });
      }
    } catch (error) {
      const cleanup = failure === undefined
        ? `cleanup of the temporary folder ${temporary} could not be scheduled: ${messageOf(error)}`
        : `the temporary folder ${temporary} could not be removed: ${messageOf(error)}`;
      return failure === undefined ? failed("cleanup", `${staged.version} is installed, but ${cleanup}.`) : failed("install", `${failure.why} And ${cleanup}.`);
    }
    return failure === undefined ? APPLIED : failed("install", failure.why);
  };

  /** The whole swap at once: unpacked, then swapped, as a build no preparation reached. */
  const swapBundle = async (bundle: string, staged: ShellStagedBuild): Promise<ShellApplyOutcome> => {
    let prepared: Prepared;
    try {
      prepared = await prepareBundle(bundle, staged);
    } catch (error) {
      return failed("install", messageOf(error));
    }
    return swapPrepared(bundle, staged, prepared);
  };

  /**
   * Installs `staged` into `versions/<version>` beside the Windows install,
   * ahead of the click (#2194): the setup runs silently in its staging mode
   * (`--stage=<folder>`, the build's NSIS include), which only extracts the
   * app's files there, never touching the running install, its shortcuts or
   * the install mutex. It extracts into a staging folder renamed into place
   * once complete, so a half-made version is never switched to.
   */
  const prepareVersion = async (staged: ShellStagedBuild): Promise<Prepared> => {
    if (!SAFE_VERSION.test(staged.version)) throw new Error(`${staged.version} is not a version a folder can be named after, so ${stays()}.`);
    const versions = join(windowsInstallRoot(platform.executable), "versions");
    const exe = basename(platform.executable);
    const folder = join(versions, staged.version);
    const target = join(folder, exe);
    if (await files.access(target).then(() => true, () => false)) return { target };
    const staging = join(versions, `.${staged.version}-staging`);
    await files.rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    const ran = await system.run(staged.path, ["/S", `--stage=${staging}`]).catch((error: unknown) => ({ code: -1, stderr: messageOf(error) }));
    const removeStaging = () => files.rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(report);
    if (ran.code !== 0) {
      await removeStaging();
      throw new Error(`The setup of ${staged.version} could not install it beside the app (${lastLine(ran.stderr) ?? `it exited with ${ran.code}`}), so ${stays()}.`);
    }
    if (!(await files.access(join(staging, exe)).then(() => true, () => false))) {
      await removeStaging();
      throw new Error(`The setup of ${staged.version} left no ${exe} beside the app, so ${stays()}.`);
    }
    await files.rename(staging, folder);
    return { target };
  };

  /**
   * Switches Windows to the version installed ahead of the click: the
   * pointer `desktop-launch.ps1` follows is written beside it and renamed
   * into place, so a launch reads the old version or the new one, never half
   * of one; at the click Electron starts the new executable once this one has
   * gone, its single-instance lock released.
   */
  const switchVersion = async (staged: ShellStagedBuild, prepared: Prepared, restart: boolean): Promise<ShellApplyOutcome> => {
    const pointer = join(platform.paths.data, CURRENT_POINTER);
    try {
      await files.writeFile(`${pointer}.tmp`, staged.version, "utf8");
      await files.rename(`${pointer}.tmp`, pointer);
    } catch (error) {
      return failed("install", `Could not point the desktop at ${staged.version} (${messageOf(error)}), so ${stays()}.`);
    }
    if (restart) app.relaunch({ execPath: prepared.target, args: ["--updated"] });
    return APPLIED;
  };

  /** Hands the NSIS setup over, with visible progress on a restart once the desktop has quit, and to start it again after when `restart`. */
  const runSetup = async (staged: ShellStagedBuild, restart: boolean): Promise<ShellApplyOutcome> => {
    try {
      onInstalling?.();
      await system.start(staged.path, [...(restart ? [] : ["/S"]), "--updated", ...(restart ? ["--force-run"] : [])]);
      return APPLIED;
    } catch (error) {
      return failed("install", `The setup of ${staged.version} could not be started (${messageOf(error)}), so ${stays()}.`);
    }
  };

  /**
   * Installs the staged Arch package with `pacman -U`, as root through
   * `pkexec`, which asks the person to authenticate. A failure says why and
   * gives the command that installs the same package by hand.
   */
  const pacmanInstall = async (staged: ShellStagedBuild): Promise<ShellApplyOutcome> => {
    const notInstalled = (why: string): ShellApplyOutcome => failed("install", `${why}, so ${stays()}.`, `sudo pacman -U ${shellWord(staged.path)}`);
    let ran: CommandResult;
    try {
      ran = await system.run("pkexec", ["pacman", "-U", "--noconfirm", staged.path]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return notInstalled(`Installing ${staged.version} needs pkexec, which polkit provides, and it is not installed`);
      return notInstalled(`pkexec could not be run to install ${staged.version} (${messageOf(error)})`);
    }
    if (ran.code === 0) return APPLIED;
    const said = lastLine(ran.stderr);
    if (PKEXEC_REFUSED.has(ran.code) && NO_AGENT.test(ran.stderr)) return notInstalled(`Installing ${staged.version} needs an administrator, and no polkit authentication agent is running to ask for one`);
    if (PKEXEC_REFUSED.has(ran.code)) return notInstalled(`Installing ${staged.version} needs an administrator, and the authentication was refused${said === undefined ? "" : ` (${said})`}`);
    return notInstalled(`pacman could not install ${staged.version} (${said ?? `it exited with ${ran.code}`})`);
  };

  const installation = async (): Promise<Installation> => {
    if (!app.isPackaged) return { format: null, why: "it runs from a checkout" };
    switch (platform.os) {
      case "darwin": {
        const bundle = bundleOf(platform.executable);
        if (bundle === undefined) return { format: null, why: "it runs in no app bundle" };
        if (!(await writable(bundle)) || !(await writable(dirname(bundle)))) {
          return { format: null, why: `its bundle cannot be replaced where it is, ${bundle}, as on a disk image or where it was downloaded` };
        }
        return {
          format: "zip",
          afterQuit: false,
          install: (staged) => swapBundle(bundle, staged),
          prepare: (staged) => prepareBundle(bundle, staged),
          discard: async ({ temporary }) => {
            if (temporary !== undefined) await files.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          },
          switchTo: async (staged, prepared, restart) => {
            const outcome = await swapPrepared(bundle, staged, prepared);
            if (restart && (outcome.outcome === "applied" || outcome.failure === "cleanup")) app.relaunch();
            return outcome;
          },
        };
      }
      case "win32":
        return {
          format: "nsis",
          afterQuit: true,
          install: runSetup,
          prepare: prepareVersion,
          discard: ({ target }) => files.rm(dirname(target), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
          switchTo: switchVersion,
        };
      case "linux": {
        const owned = await system.run("pacman", ["-Qqo", platform.executable]).catch(() => undefined);
        if (owned?.code !== 0) return { format: null, why: "no pacman package installed it, as for an AppImage or a .deb" };
        return { format: "pacman", afterQuit: false, install: pacmanInstall };
      }
    }
  };

  /** Why `staged` is not the build the local environment staged, or undefined when it is. */
  const mismatch = async (staged: ShellStagedBuild): Promise<string | undefined> => {
    try {
      return (await sha256Of(staged.path)) === staged.sha256 ? undefined : `The staged build at ${staged.path} does not match the SHA-256 ${staged.version} was staged with`;
    } catch (error) {
      return `The staged build of ${staged.version} could not be read (${messageOf(error)})`;
    }
  };

  const prepared = preparation();

  /** What this install can do with `staged`: install it, or why not. A build already installed ahead of the click was checked before. */
  const installable = async (staged: ShellStagedBuild): Promise<Exclude<Installation, { format: null }> | ShellApplyOutcome> => {
    const found = await installation();
    if (found.format === null) return failed("install", `This desktop cannot update itself, as ${found.why}: ${staged.version} is on the release page.`);
    if (prepared.switchable(staged) !== undefined) return found;
    const wrong = await mismatch(staged);
    return wrong === undefined ? found : failed("install", `${wrong}, so ${stays()}.`);
  };

  /**
   * Installs `staged` ahead of the click, once (#2194): downloaded, then
   * installing, then installed; a newer build replaces an older one, whose
   * files are removed. A failure logs `<version> stage failed: <reason>`
   * and says "Update failed to prepare, retry", the running version untouched.
   */
  const prepareAhead = async (found: Exclude<Installation, { format: null }>, staged: ShellStagedBuild): Promise<Prepared | ShellApplyOutcome> => {
    const ready = prepared.switchable(staged);
    if (ready !== undefined || found.prepare === undefined) return ready ?? APPLIED;
    const replaced = prepared.downloaded(staged);
    if (replaced !== undefined) await found.discard?.(replaced).catch(report);
    prepared.installing(staged);
    const started = clock();
    try {
      const made = await found.prepare(staged);
      if (!prepared.installed(staged, made)) {
        await found.discard?.(made).catch(report);
        return failed("install", `${staged.version} was replaced by a newer build while it installed, so ${stays()}.`);
      }
      log(`${staged.version} staged ${clock() - started}ms`);
      return made;
    } catch (error) {
      const reason = messageOf(error);
      prepared.failed(staged, reason);
      log(`${staged.version} stage failed: ${reason}`);
      return failed("install", `Update failed to prepare, retry. ${reason}`);
    }
  };

  /** The click's time, for the new process to log `click to ready` against; a click that cannot be recorded still restarts. */
  const recordClick = (staged: ShellStagedBuild): Promise<void> =>
    files.writeFile(join(platform.paths.data, CLICK_FILE), JSON.stringify({ version: staged.version, at: clock() }), "utf8").catch(report);

  const inTurn = oneAtATime();
  let handedOver: HandedOver | undefined;
  /** A build is installing while the desktop runs, at `now`. */
  let installingNow = false;
  /** A quit is held back, to be let through once the installs before it and the one handed over for it are done. */
  let quitHeld = false;

  // A quit while a build installs now, or one a build was handed over for, is held back until
  // that is done, then let through; every quit asked for meanwhile is held with it, so no quit
  // leaves an install half done. It installs what is handed over when its turn comes, so a
  // build installed now meanwhile is not replaced by an earlier hand-over.
  app.on("will-quit", (details) => {
    if (!quitHeld && !installingNow && handedOver === undefined) return;
    details.preventDefault();
    if (quitHeld) return;
    quitHeld = true;
    void inTurn(async () => {
      const handed = handedOver;
      handedOver = undefined;
      if (handed === undefined) return undefined;
      const found = await installable(handed.staged);
      if (!("install" in found)) return found;
      const ready = prepared.switchable(handed.staged);
      if (ready === undefined || found.switchTo === undefined) return found.install(handed.staged, handed.restart);
      const outcome = await found.switchTo(handed.staged, ready, handed.restart);
      if (outcome.outcome === "applied" || outcome.failure === "cleanup") prepared.switched();
      return outcome;
    })
      .then((outcome) => {
        if (outcome?.outcome === "failed") report(new Error(`The desktop's update at the quit: ${outcome.message}`));
      }, report)
      .finally(() => {
        quitHeld = false;
        app.quit();
      });
  });

  const apply = (staged: ShellStagedBuild, when: ShellApplyWhen): Promise<ShellApplyOutcome> =>
    inTurn(async () => {
      await cleanupReady;
      const found = await installable(staged);
      if (!("install" in found)) return found;
      if (found.prepare !== undefined && found.switchTo !== undefined) {
        // Installed ahead: the hand-over for the quit, right after the download, installs it, and "Restart to update" is offered once it has.
        const ready = await prepareAhead(found, staged);
        if ("outcome" in ready) return ready;
        if (when === "quit") {
          handedOver = { staged, restart: false };
          return APPLIED;
        }
        await recordClick(staged);
        installingNow = true;
        const outcome = await found.switchTo(staged, ready, true).finally(() => (installingNow = false));
        if (outcome.outcome === "applied" || outcome.failure === "cleanup") {
          if (outcome.outcome === "failed") report(new Error(`The desktop's update: ${outcome.message}`));
          handedOver = undefined;
          prepared.switched();
          app.quit();
        }
        return outcome;
      }
      if (when === "now") await recordClick(staged);
      if (when === "quit" || found.afterQuit) {
        handedOver = { staged, restart: when === "now" };
        if (when === "now") app.quit();
        return APPLIED;
      }
      // What was handed over for the quit stays so until a build installs now: the runtime keeps it ready after a failure.
      installingNow = true;
      const outcome = await found.install(staged, true).finally(() => (installingNow = false));
      if (outcome.outcome === "applied" || outcome.failure === "cleanup") {
        if (outcome.outcome === "failed") report(new Error(`The desktop's update: ${outcome.message}`));
        handedOver = undefined;
        app.relaunch();
        app.quit();
      }
      return outcome;
    });

  return {
    current: async () => {
      await cleanupReady;
      return { version: app.getVersion(), platform: platform.os, arch: platform.architecture, format: (await installation()).format };
    },
    apply,
    ready: async () => {
      const file = join(platform.paths.data, CLICK_FILE);
      const said = await files.readFile(file, "utf8").catch(() => undefined);
      if (said === undefined) return;
      await files.rm(file, { force: true }).catch(report);
      try {
        const { version, at } = JSON.parse(said) as { version?: unknown; at?: unknown };
        if (version === app.getVersion() && typeof at === "number") log(`Desktop update ${version}: click to ready ${clock() - at}ms`);
      } catch {
        // A click file that does not parse is from no click this process can time.
      }
    },
  };
};
