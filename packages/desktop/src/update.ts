import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
 * fails; a Windows install hands over to its NSIS setup, run silently once
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

export const desktopUpdate = ({ app, platform, system, report }: UpdateParts): ShellUpdate => {
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
   * Swaps `bundle` for the one the staged zip holds: unpacked with `ditto`
   * into a temporary folder beside it, on the same volume, the old bundle
   * renamed into that folder and the new one renamed into its place, the
   * old one renamed back if that fails. A successful swap records cleanup for
   * the next process; a stranded rollback keeps the only copy of the app.
   */
  const swapBundle = async (bundle: string, staged: ShellStagedBuild): Promise<ShellApplyOutcome> => {
    let temporary: string;
    try {
      temporary = await files.mkdtemp(join(dirname(bundle), temporaryPrefix(bundle)));
    } catch (error) {
      return failed("install", `Could not make a folder beside ${bundle} to unpack ${staged.version} into (${messageOf(error)}), so ${stays()}.`);
    }
    const previous = join(temporary, "previous");
    const pendingMarker = temporary + PENDING_CLEANUP_MARKER;
    /** Undefined once the new bundle is in place, else why it is not. A stranded app's temporary folder is kept. */
    const swap = async (): Promise<SwapFailure | undefined> => {
      const unpacked = await system.run("ditto", ["-x", "-k", staged.path, temporary]).catch((error: unknown) => ({ code: -1, stderr: messageOf(error) }));
      if (unpacked.code !== 0) return { why: `${staged.version} did not unpack (${lastLine(unpacked.stderr) ?? `ditto exited with ${unpacked.code}`}), so ${stays()}.` };
      const bundles = (await files.readdir(temporary)).filter((name) => name.endsWith(".app"));
      const [incoming] = bundles;
      if (incoming === undefined || bundles.length > 1) return { why: `The build of ${staged.version} does not hold one app bundle, so ${stays()}.` };
      // Refuse the swap if ownership cannot be recorded; a partial write never strands an old bundle.
      await files.writeFile(pendingMarker, bundle, { flag: "wx", mode: 0o600 });
      try {
        await files.rename(bundle, previous);
      } catch (error) {
        return { why: `Could not move ${bundle} aside (${messageOf(error)}), so ${stays()}.` };
      }
      try {
        await files.rename(join(temporary, incoming), bundle);
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

  /** Hands the NSIS setup over, to run silently once the desktop has quit, and to start it again after when `restart`. */
  const runSetup = async (staged: ShellStagedBuild, restart: boolean): Promise<ShellApplyOutcome> => {
    try {
      await system.start(staged.path, ["/S", "--updated", ...(restart ? ["--force-run"] : [])]);
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
        return { format: "zip", afterQuit: false, install: (staged) => swapBundle(bundle, staged) };
      }
      case "win32":
        return { format: "nsis", afterQuit: true, install: runSetup };
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

  /** What this install can do with `staged`: install it, or why not. */
  const installable = async (staged: ShellStagedBuild): Promise<Exclude<Installation, { format: null }> | ShellApplyOutcome> => {
    const found = await installation();
    if (found.format === null) return failed("install", `This desktop cannot update itself, as ${found.why}: ${staged.version} is on the release page.`);
    const wrong = await mismatch(staged);
    return wrong === undefined ? found : failed("install", `${wrong}, so ${stays()}.`);
  };

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
      return "install" in found ? found.install(handed.staged, handed.restart) : found;
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
  };
};
