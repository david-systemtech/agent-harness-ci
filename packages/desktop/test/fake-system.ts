import { constants } from "node:fs";
import { access, lstat, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import type { CommandResult, UpdateFiles, UpdateSystem } from "../src/update.js";

/**
 * What applying an update asks of the machine, faked for the desktop's
 * tests: the OS's commands (`ditto`, `pkexec`, `pacman`, a setup) recorded
 * and answered as each test scripts them, and Node's own file calls,
 * recorded and made for real on the test's scratch folders unless the test
 * has one fail. Nothing depends on the runner's own platform, so each
 * platform's path runs on every runner.
 */

/** A file call a test can have fail: the swap's renames, and the removal of a temporary folder. */
type Failable = "rename" | "rm";

export interface FakeSystem extends UpdateSystem {
  /** Every command run to its end, oldest first: the command, then its arguments. */
  readonly ran: (readonly string[])[];
  /** Every command started on its own, left running once the desktop quits. */
  readonly started: (readonly string[])[];
  /** Every temporary folder made. */
  readonly made: string[];
  /** Every path removed. */
  readonly removed: string[];
  /** How `command` answers from now on; one never answered is not installed, and cannot be started unless it is a file. */
  answer(command: string, answer: (args: readonly string[]) => CommandResult | Promise<CommandResult>): void;
  /** Has the next `call` whose paths `when` accepts fail, as a locked or vanished file would. */
  fail(call: Failable, when?: (...paths: string[]) => boolean): void;
  /** Makes `path`, and all it holds, read-only, as a disk image or a translocated app is. */
  readOnly(path: string): void;
}

const inside = (path: string, folder: string): boolean => {
  const way = relative(folder, path);
  return way === "" || (!way.startsWith("..") && !isAbsolute(way));
};

const notInstalled = (command: string): Error => Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });

export const fakeSystem = (): FakeSystem => {
  const ran: (readonly string[])[] = [];
  const started: (readonly string[])[] = [];
  const made: string[] = [];
  const removed: string[] = [];
  const answers = new Map<string, (args: readonly string[]) => CommandResult | Promise<CommandResult>>();
  const failing: { readonly call: Failable; readonly when: (...paths: string[]) => boolean }[] = [];
  const readOnly: string[] = [];

  /** Throws when a failure is set for `call` on `paths`, using it up. */
  const failIfSet = (call: Failable, ...paths: string[]): void => {
    const index = failing.findIndex((failure) => failure.call === call && failure.when(...paths));
    if (index === -1) return;
    failing.splice(index, 1);
    throw Object.assign(new Error(`EACCES: permission denied, ${call} '${paths[0]}'`), { code: "EACCES" });
  };

  const files: UpdateFiles = {
    lstat,
    readFile,
    writeFile,
    readdir,
    access: async (path, mode) => {
      if (mode !== undefined && (mode & constants.W_OK) !== 0 && readOnly.some((folder) => inside(String(path), folder))) {
        throw Object.assign(new Error(`EROFS: read-only file system, access '${String(path)}'`), { code: "EROFS" });
      }
      return access(path, mode);
    },
    mkdtemp: (async (prefix: string) => {
      const folder = await mkdtemp(prefix);
      made.push(folder);
      return folder;
    }) as UpdateFiles["mkdtemp"],
    rename: async (from, to) => {
      failIfSet("rename", String(from), String(to));
      return rename(from, to);
    },
    rm: async (path, options) => {
      failIfSet("rm", String(path));
      await rm(path, options);
      removed.push(String(path));
    },
  };

  return {
    ran,
    started,
    made,
    removed,
    files,
    async run(command, args) {
      ran.push([command, ...args]);
      const answer = answers.get(command);
      if (answer === undefined) throw notInstalled(command);
      return answer(args);
    },
    async start(command, args) {
      if (!answers.has(command) && !(await stat(command).then((found) => found.isFile(), () => false))) throw notInstalled(command);
      started.push([command, ...args]);
    },
    answer: (command, answer) => void answers.set(command, answer),
    fail: (call, when = () => true) => void failing.push({ call, when }),
    readOnly: (path) => void readOnly.push(path),
  };
};

/** A command that did what it was asked. */
export const succeeded: CommandResult = { code: 0, stderr: "" };
