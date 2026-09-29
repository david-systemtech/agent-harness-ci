import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeToolPath } from "../../test/fake-tools.js";
import { systemClock } from "../serve/clock.js";
import { WINDOWS_PATH_SCRIPT, readLoginPath } from "./login-path.js";
import { systemPackageOwner } from "./package-owner.js";

/**
 * The Managed tools registry's two reads of the machine, below the wire
 * (#373): the login shell's PATH, from a real `/bin/sh -l` over a home
 * whose profile adds to it and prints around it, and the Windows Path from
 * a stand-in `powershell.exe`; and the package owner, from fake `dpkg` and
 * `rpm` answering as the real ones do. None is about time, so each runs on
 * the system clock with room to spare.
 */

const { tempDir } = useCleanups();

/** Far more than either read takes on a loaded runner: the tests are about what is read, never how fast. */
const ROOM_MS = 60_000;

describe.runIf(process.platform !== "win32")("the login shell's PATH", () => {
  it("is what the login shell's profile makes it, whatever the profile prints around it", async () => {
    const home = realpathSync(tempDir());
    writeFileSync(join(home, ".profile"), `echo "Welcome back"\nPATH="${home}/.local/bin:$PATH"\nexport PATH\nprintf 'no newline at the end'\n`);
    const path = await readLoginPath({
      clock: systemClock,
      env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      timeoutMs: ROOM_MS,
      platform: "linux",
      shell: { file: "/bin/sh", args: ["-l"] },
    });
    expect(path.split(":")[0]).toBe(`${home}/.local/bin`);
    expect(path).not.toContain("Welcome");
  });

  it("is refused when the shell prints no PATH", async () => {
    const home = realpathSync(tempDir());
    writeFileSync(join(home, ".profile"), "exit 3\n");
    await expect(
      readLoginPath({ clock: systemClock, env: { HOME: home, PATH: "/usr/bin:/bin" }, timeoutMs: ROOM_MS, platform: "linux", shell: { file: "/bin/sh", args: ["-l"] } }),
    ).rejects.toThrow(/did not give its PATH: it exited with code 3/);
    await expect(
      readLoginPath({ clock: systemClock, env: { HOME: home }, timeoutMs: ROOM_MS, platform: "linux", shell: { file: join(home, "no-such-shell"), args: ["-l"] } }),
    ).rejects.toThrow(/is not installed/);
  });
});

describe.runIf(process.platform !== "win32")("the Windows Path", () => {
  it("is PowerShell's machine then user Path, asked to write it as UTF-8, which the runner reads", async () => {
    // A stand-in powershell.exe on a POSIX PATH: it records what it was asked and answers a Path with a name outside any code page.
    const path = fakeToolPath(realpathSync(tempDir()));
    const powershell = path.install("powershell.exe", { output: "C:\\Windows\\system32;C:\\Users\\Zoë\\AppData\\Local\\Microsoft\\WinGet\\Links" });
    const read = await readLoginPath({ clock: systemClock, env: { PATH: path.path() }, timeoutMs: ROOM_MS, platform: "win32" });
    expect(read).toBe("C:\\Windows\\system32;C:\\Users\\Zoë\\AppData\\Local\\Microsoft\\WinGet\\Links");
    expect(powershell.calls()).toEqual([["-NoProfile", "-NonInteractive", "-Command", ...WINDOWS_PATH_SCRIPT.split(" ")]]);
    expect(WINDOWS_PATH_SCRIPT.startsWith("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;")).toBe(true);
  });
});

describe.runIf(process.platform !== "win32")("the package owner", () => {
  /** A PATH holding a fake `dpkg` and `rpm` answering as the test says; either may be left out. */
  const managers = (answers: { readonly dpkg?: { output: string; exitCode: number }; readonly rpm?: { output: string; exitCode: number } }) => {
    const path = fakeToolPath(realpathSync(tempDir()));
    const dpkg = answers.dpkg === undefined ? undefined : path.install("dpkg", answers.dpkg);
    const rpm = answers.rpm === undefined ? undefined : path.install("rpm", answers.rpm);
    const lookup = systemPackageOwner({ clock: systemClock, env: () => ({ PATH: path.path() }), timeoutMs: ROOM_MS, platform: "linux" });
    return { lookup, dpkg, rpm };
  };

  it("is dpkg's package, asked with dpkg -S", async () => {
    const { lookup, dpkg, rpm } = managers({ dpkg: { output: "gh: /usr/bin/gh", exitCode: 0 }, rpm: { output: "", exitCode: 1 } });
    expect(await lookup("/usr/bin/gh")).toEqual({ kind: "owned", manager: "dpkg", package: "gh" });
    expect(dpkg?.calls()).toEqual([["-S", "/usr/bin/gh"]]);
    expect(rpm?.calls()).toEqual([]);
  });

  it("is rpm's package, asked with rpm -qf, when dpkg owns the file to none or is not there", async () => {
    const rpmOnly = managers({ rpm: { output: "gh-2.40.0-1.x86_64", exitCode: 0 } });
    expect(await rpmOnly.lookup("/usr/bin/gh")).toEqual({ kind: "owned", manager: "rpm", package: "gh-2.40.0-1.x86_64" });
    expect(rpmOnly.rpm?.calls()).toEqual([["-qf", "/usr/bin/gh"]]);
    const both = managers({ dpkg: { output: "dpkg-query: no path found matching pattern /usr/bin/gh", exitCode: 1 }, rpm: { output: "gh-2.40.0-1.x86_64", exitCode: 0 } });
    expect(await both.lookup("/usr/bin/gh")).toMatchObject({ kind: "owned", manager: "rpm" });
  });

  it("is none when each manager says no package owns it or is not there, and unknown when one could not say", async () => {
    const none = managers({ dpkg: { output: "dpkg-query: no path found matching pattern /usr/local/bin/doppler", exitCode: 1 }, rpm: { output: "file /usr/local/bin/doppler is not owned by any package", exitCode: 1 } });
    expect(await none.lookup("/usr/local/bin/doppler")).toEqual({ kind: "none" });
    expect(await managers({}).lookup("/usr/local/bin/doppler")).toEqual({ kind: "none" });
    expect(await managers({ dpkg: { output: "dpkg: error: database locked", exitCode: 2 } }).lookup("/usr/local/bin/doppler")).toEqual({ kind: "unknown", why: "dpkg exited with code 2" });
  });

  it("is none off Linux, asking nothing", async () => {
    const { dpkg } = managers({ dpkg: { output: "gh: /usr/bin/gh", exitCode: 0 } });
    const lookup = systemPackageOwner({ clock: systemClock, env: () => ({ PATH: "" }), timeoutMs: ROOM_MS, platform: "darwin" });
    expect(await lookup("/opt/homebrew/bin/gh")).toEqual({ kind: "none" });
    expect(dpkg?.calls()).toEqual([]);
  });
});
