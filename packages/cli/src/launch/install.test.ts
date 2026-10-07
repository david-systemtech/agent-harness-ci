import { closeSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { LAUNCHER_PROTOCOL, type InstallAnswer } from "@agent-harness/contracts/launcher";
import { DATABASE_FILE } from "@agent-harness/contracts/launcher";
import { afterEach, describe, expect, it } from "vitest";
import { fakeTimer, installVersion, layOutVersion, preflightRuns, stageVersion, until } from "../../test/launcher-fixtures.js";
import type { DurableFs } from "./durable.js";
import { createInstaller, MOVE_RETRY_FIRST_WAIT_MS, MOVE_RETRY_LONGEST_WAIT_MS, MOVE_RETRY_MS, moveIntoVersions, type InstallerOptions } from "./install.js";
import { completeVersions } from "./versions.js";

/**
 * Installing a staged version (launcher-update spec, "Preflight"; #339),
 * without a launcher: the installer the launcher answers `install?` with,
 * on a temporary data directory with versions staged as the environment
 * unpacks them and the scripted preflight standing in for a version's own.
 * The launcher's tests drive it through the channel; these cover each
 * refusal and the move's order and failures, which a recording file double
 * shows and a launcher cannot.
 */

const posix = process.platform !== "win32";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A data directory with 0.5.0 installed. */
const dataDirectory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-install-"));
  dirs.push(dir);
  installVersion(dir, "0.5.0");
  return dir;
};

/** Every file and folder under `dir`, by its path relative to it, sorted. */
const treeOf = (dir: string): string[] => (readdirSync(dir, { recursive: true }) as string[]).sort();

/** An installer on `dataDir`, logging to memory, with a terabyte free unless `options` says otherwise. */
const installer = (dataDir: string, options: Partial<InstallerOptions> = {}) => {
  const lines: string[] = [];
  const installing = createInstaller({ dataDir, timer: fakeTimer(), freeBytes: () => 2 ** 40, log: (line) => lines.push(line), ...options });
  return { install: installing.install, lines };
};

/**
 * The file calls that change something, each recorded with the path it was
 * about relative to the data directory, a temporary file's id shortened;
 * `failAt` makes the call it names throw `code`, as a full disk or a failed
 * write does.
 */
const recordingFs = (dataDir: string, failAt?: { readonly call: string; readonly code: string }): { readonly fs: DurableFs; readonly calls: string[] } => {
  const calls: string[] = [];
  const opened = new Map<number, string>();
  const name = (path: string): string => (relative(dataDir, path) || ".").replace(/\.[0-9a-f-]{36}\.tmp$/, " (temporary)");
  const call = (text: string) => {
    if (text === failAt?.call) throw Object.assign(new Error(`${failAt.code}: ${text}`), { code: failAt.code });
    calls.push(text);
  };
  const fs: DurableFs = {
    openSync: (path, flags, mode) => {
      const fd = openSync(path, flags, mode);
      opened.set(fd, name(path));
      return fd;
    },
    writeFileSync: (fd, text) => {
      call(`write ${opened.get(fd)}`);
      writeFileSync(fd, text);
    },
    fsyncSync: (fd) => {
      call(`fsync ${opened.get(fd)}`);
      fsyncSync(fd);
    },
    closeSync: (fd) => closeSync(fd),
    renameSync: (from, to) => {
      call(`rename ${name(from)} to ${name(to)}`);
      renameSync(from, to);
    },
    rmSync: (path, options) => {
      call(`remove ${name(path)}`);
      rmSync(path, options);
    },
    linkSync: (existing, path) => {
      call(`link ${name(existing)} as ${name(path)}`);
      linkSync(existing, path);
    },
  };
  return { fs, calls };
};

describe.runIf(posix)("installing a staged version, without a launcher", () => {
  it("refuses an install that leaves the margin but cannot also fit the database snapshot", async () => {
    const dataDir = dataDirectory();
    writeFileSync(join(dataDir, DATABASE_FILE), "user data");
    const staged = stageVersion(dataDir, "0.6.0");
    const { install } = installer(dataDir, { freeBytes: () => 256 * 1024 * 1024 });
    expect(await install("0.6.0", staged)).toEqual({ type: "refused", reason: "disk" });
    expect(completeVersions(dataDir)).toEqual(["0.5.0"]);
    expect(preflightRuns(dataDir)).toEqual([]);
    expect(readFileSync(join(dataDir, DATABASE_FILE), "utf8")).toBe("user data");
  });

  it("refuses incomplete, running no preflight and leaving both directories as they were, a staging folder that is not a whole version", async () => {
    const cases: [what: string, ask: (dataDir: string) => { version: string; staged: string }, why: (staged: string, dataDir: string) => string][] = [
      [
        "a version that is not a release version",
        (dataDir) => ({ version: "../0.6.0", staged: stageVersion(dataDir, "0.6.0") }),
        () => '"../0.6.0" is not a release version, which is all the versions directory holds',
      ],
      [
        "nothing at the staged path",
        (dataDir) => ({ version: "0.6.0", staged: join(dataDir, "staging", "0.6.0") }),
        (staged, dataDir) => `${staged} is not a folder of the staging area ${join(dataDir, "staging")}`,
      ],
      [
        "a folder outside the staging area",
        (dataDir) => {
          const staged = join(dataDir, "elsewhere", "0.6.0");
          layOutVersion(staged, "0.6.0");
          return { version: "0.6.0", staged };
        },
        (staged, dataDir) => `${staged} is not a folder of the staging area ${join(dataDir, "staging")}`,
      ],
      [
        "a link in the staging area to a folder elsewhere",
        (dataDir) => {
          const elsewhere = join(dataDir, "elsewhere", "0.6.0");
          layOutVersion(elsewhere, "0.6.0");
          mkdirSync(join(dataDir, "staging"));
          symlinkSync(elsewhere, join(dataDir, "staging", "0.6.0"));
          return { version: "0.6.0", staged: join(dataDir, "staging", "0.6.0") };
        },
        (staged, dataDir) => `${staged} is not a folder of the staging area ${join(dataDir, "staging")}`,
      ],
      [
        "no Node runtime",
        (dataDir) => {
          const staged = stageVersion(dataDir, "0.6.0");
          rmSync(join(staged, "node", "bin", "node"));
          return { version: "0.6.0", staged };
        },
        (staged) => `${staged} has no Node runtime at ${join(staged, "node", "bin", "node")}`,
      ],
      [
        "no CLI entry",
        (dataDir) => {
          const staged = stageVersion(dataDir, "0.6.0");
          rmSync(join(staged, "packages", "cli", "dist", "main.js"));
          return { version: "0.6.0", staged };
        },
        (staged) => `${staged} has no CLI entry at ${join(staged, "packages", "cli", "dist", "main.js")}`,
      ],
      [
        "another version than the one asked for",
        (dataDir) => ({ version: "0.6.0", staged: stageVersion(dataDir, "0.6.1") }),
        (staged) => `${staged} holds 0.6.1`,
      ],
      [
        "a package that declares no launcher protocol",
        (dataDir) => {
          const staged = stageVersion(dataDir, "0.6.0");
          writeFileSync(join(staged, "packages", "cli", "package.json"), JSON.stringify({ type: "module", version: "0.6.0" }));
          return { version: "0.6.0", staged };
        },
        (staged) => `${join(staged, "packages", "cli", "package.json")} declares no launcher protocol`,
      ],
      [
        "a package that is not JSON",
        (dataDir) => {
          const staged = stageVersion(dataDir, "0.6.0");
          writeFileSync(join(staged, "packages", "cli", "package.json"), "{");
          return { version: "0.6.0", staged };
        },
        (staged) => `${join(staged, "packages", "cli", "package.json")} could not be read as JSON: `,
      ],
    ];
    for (const [what, ask, why] of cases) {
      const dataDir = dataDirectory();
      const { version, staged } = ask(dataDir);
      const before = treeOf(dataDir);
      const { install, lines } = installer(dataDir);
      expect(await install(version, staged), what).toEqual({ type: "refused", reason: "incomplete" });
      expect(lines, what).toEqual([expect.stringContaining(`refuses install? of ${version} from ${staged}: incomplete, as ${why(staged, dataDir)}`)]);
      expect(treeOf(dataDir), what).toEqual(before);
      expect(preflightRuns(dataDir), what).toEqual([]);
    }
  });

  it("puts the staged files on disk, renames the folder into the versions directory, and writes its sentinel last, durably", async () => {
    const dataDir = dataDirectory();
    const staged = stageVersion(dataDir, "0.6.0");
    const { fs, calls } = recordingFs(dataDir);
    const { install } = installer(dataDir, { fs });
    expect(await install("0.6.0", staged)).toEqual({ type: "installed" });
    const renamed = calls.indexOf("rename staging/0.6.0 to versions/0.6.0");
    // Every staged file was put on disk before the rename, the node runtime among them.
    expect(calls.slice(0, renamed)).toContain("fsync staging/0.6.0/node/bin/node");
    expect(calls.slice(0, renamed)).toContain("fsync staging/0.6.0");
    expect(calls.slice(renamed)).toEqual([
      "rename staging/0.6.0 to versions/0.6.0",
      "fsync versions",
      "fsync staging",
      "write versions/0.6.0/..complete (temporary)",
      "fsync versions/0.6.0/..complete (temporary)",
      "rename versions/0.6.0/..complete (temporary) to versions/0.6.0/.complete",
      "fsync versions/0.6.0",
    ]);
    expect(completeVersions(dataDir)).toEqual(["0.5.0", "0.6.0"]);
  });

  it("stages many small files on Windows with one sentinel flush, independent of the tree size", async () => {
    for (const count of [4, 1000]) {
      const dataDir = dataDirectory();
      const staged = stageVersion(dataDir, "0.6.0");
      const payload = join(staged, "payload");
      mkdirSync(payload);
      for (let index = 0; index < count; index++) writeFileSync(join(payload, `${index}.txt`), "payload");
      const { fs, calls } = recordingFs(dataDir);
      await moveIntoVersions(dataDir, "0.6.0", staged, fs, "win32");
      expect(calls.filter((call) => call.startsWith("fsync "))).toEqual(["fsync versions/0.6.0/..complete (temporary)"]);
      expect(calls.indexOf("rename staging/0.6.0 to versions/0.6.0")).toBeLessThan(calls.indexOf("write versions/0.6.0/..complete (temporary)"));
      expect(completeVersions(dataDir)).toEqual(["0.5.0", "0.6.0"]);
      expect(readFileSync(join(dataDir, "versions", "0.6.0", "payload", `${count - 1}.txt`), "utf8")).toBe("payload");
    }
  });

  it("never promotes a bundled sentinel on Windows when writing the completion marker fails", async () => {
    const dataDir = dataDirectory();
    const staged = stageVersion(dataDir, "0.6.0");
    writeFileSync(join(staged, ".complete"), "bundled");
    let completeAtRename = false;
    const recorded = recordingFs(dataDir, { call: "fsync versions/0.6.0/..complete (temporary)", code: "EIO" });
    const fs: DurableFs = {
      ...recorded.fs,
      renameSync: (from, to) => {
        recorded.fs.renameSync(from, to);
        if (from === staged) completeAtRename = completeVersions(dataDir).includes("0.6.0");
      },
    };
    await expect(moveIntoVersions(dataDir, "0.6.0", staged, fs, "win32")).rejects.toThrow("EIO");
    expect(completeAtRename).toBe(false);
    expect(completeVersions(dataDir)).toEqual(["0.5.0"]);
    expect(readFileSync(join(staged, "packages", "cli", "package.json"), "utf8")).toContain("0.6.0");
  });

  it("replaces a folder of the version without its sentinel, which an install cut short left", async () => {
    const dataDir = dataDirectory();
    mkdirSync(join(dataDir, "versions", "0.6.0"));
    writeFileSync(join(dataDir, "versions", "0.6.0", "half-a-copy"), "");
    const staged = stageVersion(dataDir, "0.6.0");
    const stagedFiles = treeOf(staged);
    const { install } = installer(dataDir);
    expect(await install("0.6.0", staged)).toEqual({ type: "installed" });
    expect(treeOf(join(dataDir, "versions", "0.6.0"))).toEqual([...stagedFiles, ".complete"].sort());
  });

  it("refuses io when the rename or the sentinel fails, and disk when that is for want of room, moving the version back so the versions directory is as it was", async () => {
    const failures: [call: string, code: string, reason: InstallAnswer][] = [
      ["rename staging/0.6.0 to versions/0.6.0", "EIO", { type: "refused", reason: "io" }],
      ["write versions/0.6.0/..complete (temporary)", "ENOSPC", { type: "refused", reason: "disk" }],
      ["fsync versions/0.6.0/..complete (temporary)", "EDQUOT", { type: "refused", reason: "disk" }],
      ["fsync versions", "EIO", { type: "refused", reason: "io" }],
    ];
    for (const [call, code, answer] of failures) {
      const dataDir = dataDirectory();
      const staged = stageVersion(dataDir, "0.6.0");
      const versions = treeOf(join(dataDir, "versions"));
      const stagedFiles = treeOf(staged);
      const { fs } = recordingFs(dataDir, { call, code });
      const { install, lines } = installer(dataDir, { fs });
      expect(await install("0.6.0", staged), call).toEqual(answer);
      expect(treeOf(join(dataDir, "versions")), call).toEqual(versions);
      expect(treeOf(staged), call).toEqual(stagedFiles);
      expect(lines.at(-1), call).toBe(`refuses install? of 0.6.0 from ${staged}: ${answer.type === "refused" ? answer.reason : ""}, as it could not be moved into ${join(dataDir, "versions")}: ${code}: ${call}`);
    }
  });

  describe("on Windows, a staged version whose rename meets a file still held", () => {
    /** A recording fs whose rename of the staged 0.6.0 into the versions directory fails with `code` its first `times` tries. */
    const heldFs = (dataDir: string, code: string, times: number) => {
      const recorded = recordingFs(dataDir);
      let tries = 0;
      const fs: DurableFs = {
        ...recorded.fs,
        renameSync: (from, to) => {
          if (to === join(dataDir, "versions", "0.6.0") && tries++ < times) throw Object.assign(new Error(`${code}: operation not permitted, rename '${from}'`), { code });
          recorded.fs.renameSync(from, to);
        },
      };
      return { fs, tries: () => tries };
    };

    it("tries the move again, after waits that double, until the hold ends, and installs", async () => {
      const dataDir = dataDirectory();
      const staged = stageVersion(dataDir, "0.6.0");
      const timer = fakeTimer();
      const { fs, tries } = heldFs(dataDir, "EPERM", 2);
      const { install, lines } = installer(dataDir, { fs, timer, platform: "win32" });
      const answer = install("0.6.0", staged);
      await until("the first try failed", () => timer.pending().includes(MOVE_RETRY_FIRST_WAIT_MS));
      timer.run(MOVE_RETRY_FIRST_WAIT_MS);
      await until("the second try failed", () => timer.pending().includes(2 * MOVE_RETRY_FIRST_WAIT_MS));
      timer.run(2 * MOVE_RETRY_FIRST_WAIT_MS);
      expect(await answer).toEqual({ type: "installed" });
      expect(tries()).toBe(3);
      expect(completeVersions(dataDir)).toEqual(["0.5.0", "0.6.0"]);
      expect(lines.filter((line) => line.includes("trying again"))).toEqual([
        `${staged} could not be moved into ${join(dataDir, "versions")} yet, as a file of it is still held (EPERM: operation not permitted, rename '${staged}'); trying again in ${MOVE_RETRY_FIRST_WAIT_MS} ms`,
        `${staged} could not be moved into ${join(dataDir, "versions")} yet, as a file of it is still held (EPERM: operation not permitted, rename '${staged}'); trying again in ${2 * MOVE_RETRY_FIRST_WAIT_MS} ms`,
      ]);
    });

    it("refuses io once the hold outlasts the bound, leaving the versions directory and the staged folder as they were", async () => {
      for (const code of ["EPERM", "EACCES", "EBUSY"]) {
        const dataDir = dataDirectory();
        const staged = stageVersion(dataDir, "0.6.0");
        const versions = treeOf(join(dataDir, "versions"));
        const stagedFiles = treeOf(staged);
        const timer = fakeTimer();
        const { fs } = heldFs(dataDir, code, Infinity);
        const { install, lines } = installer(dataDir, { fs, timer, platform: "win32" });
        const answer = install("0.6.0", staged);
        let waited = 0;
        let settled = false;
        void answer.then(() => (settled = true));
        // Each wait between tries is run as soon as it is asked for, until the install is answered.
        const retryWait = () => timer.pending().find((ms) => ms <= MOVE_RETRY_LONGEST_WAIT_MS);
        while (!settled) {
          await until("a try failed or the install was answered", () => settled || retryWait() !== undefined);
          const wait = retryWait();
          if (settled || wait === undefined) break;
          waited += wait;
          timer.run(wait);
        }
        expect(await answer, code).toEqual({ type: "refused", reason: "io" });
        expect(waited, code).toBeLessThanOrEqual(MOVE_RETRY_MS);
        expect(waited, code).toBeGreaterThan(MOVE_RETRY_MS - MOVE_RETRY_LONGEST_WAIT_MS);
        expect(treeOf(join(dataDir, "versions")), code).toEqual(versions);
        expect(treeOf(staged), code).toEqual(stagedFiles);
        expect(lines.at(-1), code).toMatch(`refuses install? of 0.6.0 from ${staged}: io, as it could not be moved into ${join(dataDir, "versions")}: ${code}`);
      }
    });

    it("refuses at once, trying nothing again, a failure that is not a hold, or a hold on another platform", async () => {
      const cases: [code: string, platform: NodeJS.Platform, answer: InstallAnswer][] = [
        ["ENOSPC", "win32", { type: "refused", reason: "disk" }],
        ["EIO", "win32", { type: "refused", reason: "io" }],
        ["EPERM", "linux", { type: "refused", reason: "io" }],
        ["EBUSY", "darwin", { type: "refused", reason: "io" }],
      ];
      for (const [code, platform, refused] of cases) {
        const dataDir = dataDirectory();
        const staged = stageVersion(dataDir, "0.6.0");
        const timer = fakeTimer();
        const { fs, tries } = heldFs(dataDir, code, Infinity);
        const { install } = installer(dataDir, { fs, timer, platform });
        expect(await install("0.6.0", staged), `${code} on ${platform}`).toEqual(refused);
        expect(tries(), `${code} on ${platform}`).toBe(1);
        expect(completeVersions(dataDir), `${code} on ${platform}`).toEqual(["0.5.0"]);
      }
    });

    /** A recording fs on which the sentinel's temporary file in versions/0.6.0 cannot be opened its first `sentinelTimes` tries, nor versions/0.6.0 renamed back its first `backTimes`, both with EPERM. */
    const heldAfterRename = (dataDir: string, sentinelTimes: number, backTimes: number) => {
      const recorded = recordingFs(dataDir);
      const target = join(dataDir, "versions", "0.6.0");
      let sentinelTries = 0;
      let backTries = 0;
      const held = (what: string) => Object.assign(new Error(`EPERM: operation not permitted, ${what}`), { code: "EPERM" });
      const fs: DurableFs = {
        ...recorded.fs,
        openSync: (path, flags, mode) => {
          if (path.startsWith(join(target, "..complete.")) && sentinelTries++ < sentinelTimes) throw held("open the sentinel");
          return recorded.fs.openSync(path, flags, mode);
        },
        renameSync: (from, to) => {
          if (from === target && backTries++ < backTimes) throw held("rename back");
          recorded.fs.renameSync(from, to);
        },
      };
      return { fs, backTries: () => backTries };
    };

    it("tries the rename back to the staging area again when the sentinel's write meets a hold after the rename, then the move, and installs", async () => {
      const dataDir = dataDirectory();
      const staged = stageVersion(dataDir, "0.6.0");
      const timer = fakeTimer();
      const { fs, backTries } = heldAfterRename(dataDir, 1, 1);
      const { install, lines } = installer(dataDir, { fs, timer, platform: "win32" });
      const answer = install("0.6.0", staged);
      // The rename back waits first, then the whole move, each from the first wait, on the one budget.
      await until("the rename back failed", () => timer.pending().includes(MOVE_RETRY_FIRST_WAIT_MS));
      timer.run(MOVE_RETRY_FIRST_WAIT_MS);
      await until("the move failed", () => timer.pending().includes(MOVE_RETRY_FIRST_WAIT_MS));
      timer.run(MOVE_RETRY_FIRST_WAIT_MS);
      expect(await answer).toEqual({ type: "installed" });
      expect(backTries()).toBe(2);
      expect(completeVersions(dataDir)).toEqual(["0.5.0", "0.6.0"]);
      expect(lines.filter((line) => line.includes("trying again"))).toEqual([
        `${join(dataDir, "versions", "0.6.0")} could not be moved back to ${staged} yet, as a file of it is still held (EPERM: operation not permitted, rename back); trying again in ${MOVE_RETRY_FIRST_WAIT_MS} ms`,
        `${staged} could not be moved into ${join(dataDir, "versions")} yet, as a file of it is still held (EPERM: operation not permitted, open the sentinel); trying again in ${MOVE_RETRY_FIRST_WAIT_MS} ms`,
      ]);
    });

    it("refuses io naming the sentinel's hold, not a missing folder, when the holds outlast the bound", async () => {
      const dataDir = dataDirectory();
      const staged = stageVersion(dataDir, "0.6.0");
      const versions = treeOf(join(dataDir, "versions"));
      const timer = fakeTimer();
      const { fs } = heldAfterRename(dataDir, Infinity, 3);
      const { install, lines } = installer(dataDir, { fs, timer, platform: "win32" });
      const answer = install("0.6.0", staged);
      let settled = false;
      void answer.then(() => (settled = true));
      const retryWait = () => timer.pending().find((ms) => ms <= MOVE_RETRY_LONGEST_WAIT_MS);
      while (!settled) {
        await until("a try failed or the install was answered", () => settled || retryWait() !== undefined);
        const wait = retryWait();
        if (settled || wait === undefined) break;
        timer.run(wait);
      }
      expect(await answer).toEqual({ type: "refused", reason: "io" });
      expect(lines.at(-1)).toBe(`refuses install? of 0.6.0 from ${staged}: io, as it could not be moved into ${join(dataDir, "versions")}: EPERM: operation not permitted, open the sentinel`);
      expect(treeOf(join(dataDir, "versions"))).toEqual(versions);
      expect(completeVersions(dataDir)).toEqual(["0.5.0"]);
    });

    it("answers nothing and installs nothing when the launcher stops while it waits to try again", async () => {
      const dataDir = dataDirectory();
      const staged = stageVersion(dataDir, "0.6.0");
      const timer = fakeTimer();
      const { fs, tries } = heldFs(dataDir, "EPERM", Infinity);
      const installing = createInstaller({ dataDir, timer, freeBytes: () => 2 ** 40, log: () => undefined, fs, platform: "win32" });
      const answer = installing.install("0.6.0", staged);
      await until("the first try failed", () => timer.pending().includes(MOVE_RETRY_FIRST_WAIT_MS));
      installing.stop();
      expect(await answer).toBeUndefined();
      expect(tries()).toBe(1);
      expect(timer.pending()).not.toContain(MOVE_RETRY_FIRST_WAIT_MS);
      expect(completeVersions(dataDir)).toEqual(["0.5.0"]);
    });
  });

  it("runs one install at a time, in the order asked", async () => {
    const dataDir = dataDirectory();
    const first = stageVersion(dataDir, "0.6.0");
    const second = stageVersion(dataDir, "0.7.0");
    const { install, lines } = installer(dataDir);
    const answers = await Promise.all([install("0.6.0", first), install("0.7.0", second), install("0.6.0", first)]);
    expect(answers).toEqual([{ type: "installed" }, { type: "installed" }, { type: "installed" }]);
    expect(preflightRuns(dataDir).map((run) => run.version)).toEqual(["0.6.0", "0.7.0"]);
    expect(lines.filter((line) => !line.startsWith("preflight of"))).toEqual([
      "running the preflight of 0.6.0",
      `installed 0.6.0 into ${join(dataDir, "versions")}: its preflight passed`,
      "running the preflight of 0.7.0",
      `installed 0.7.0 into ${join(dataDir, "versions")}: its preflight passed`,
      `0.6.0 is installed already, so ${first} is not installed again`,
    ]);
  });

  it("refuses launcher-protocol after the preflight when its report names a higher launcher protocol than its package declares", async () => {
    const dataDir = dataDirectory();
    const staged = stageVersion(dataDir, "0.6.0", { preflight: { reports: { launcherProtocol: LAUNCHER_PROTOCOL + 1 } } });
    const { install, lines } = installer(dataDir);
    expect(await install("0.6.0", staged)).toEqual({ type: "refused", reason: "launcher-protocol" });
    expect(lines.at(-1)).toBe(`refuses install? of 0.6.0 from ${staged}: launcher-protocol, as 0.6.0 needs launcher protocol ${LAUNCHER_PROTOCOL + 1} and this launcher speaks ${LAUNCHER_PROTOCOL}`);
    expect(completeVersions(dataDir)).toEqual(["0.5.0"]);
  });
});

describe("this build's CLI package", () => {
  it("declares the launcher protocol this build speaks, which a launcher reads before it runs anything of the version", () => {
    const declared = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { launcherProtocol?: unknown };
    expect(declared.launcherProtocol).toBe(LAUNCHER_PROTOCOL);
  });
});
