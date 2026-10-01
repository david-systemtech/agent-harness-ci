import { describe, expect, it } from "vitest";
import { baseEnvironment, loginShell, oneOffShell, processUser, throughShell, type ShellUser } from "./shell.js";

const user = (shell: string | null): ShellUser => ({ username: "david", homedir: "/home/david", shell });
const everyFile = () => true;

describe("the login shell", () => {
  it("is the passwd entry's shell, as a login shell when it is one whose -l is known", () => {
    expect(loginShell("linux", user("/bin/bash"), everyFile)).toEqual({ file: "/bin/bash", args: ["-l"] });
    expect(loginShell("darwin", user("/bin/zsh"), everyFile)).toEqual({ file: "/bin/zsh", args: ["-l"] });
    expect(loginShell("linux", user("/usr/bin/fish"), everyFile)).toEqual({ file: "/usr/bin/fish", args: ["-l"] });
    // A shell whose login flag is not known is started as it is.
    expect(loginShell("linux", user("/opt/bin/xonsh"), everyFile)).toEqual({ file: "/opt/bin/xonsh", args: [] });
  });

  it("falls back to /bin/sh as a login shell when the entry names none, a refusal, a relative path or a file that is not there", () => {
    const fallback = { file: "/bin/sh", args: ["-l"] };
    expect(loginShell("linux", user(null), everyFile)).toEqual(fallback);
    expect(loginShell("linux", user(""), everyFile)).toEqual(fallback);
    expect(loginShell("linux", user("/usr/sbin/nologin"), everyFile)).toEqual(fallback);
    expect(loginShell("linux", user("/bin/false"), everyFile)).toEqual(fallback);
    expect(loginShell("linux", user("bash"), everyFile)).toEqual(fallback);
    expect(loginShell("linux", user("/bin/bash"), () => false)).toEqual(fallback);
  });

  it("is PowerShell on Windows, which has no login flag", () => {
    expect(loginShell("win32", user(null), everyFile)).toEqual({ file: "powershell.exe", args: [] });
  });
});

describe("a command run through the login shell", () => {
  it("is the command line after -c, keeping the login flag; alone for csh and tcsh, whose -l takes no other flag; after -Command for PowerShell", () => {
    expect(throughShell({ file: "/bin/zsh", args: ["-l"] }, "brew upgrade gh")).toEqual({ file: "/bin/zsh", args: ["-l", "-c", "brew upgrade gh"] });
    expect(throughShell({ file: "/bin/sh", args: [] }, "doppler update")).toEqual({ file: "/bin/sh", args: ["-c", "doppler update"] });
    expect(throughShell({ file: "/bin/tcsh", args: ["-l"] }, "gh --version")).toEqual({ file: "/bin/tcsh", args: ["-c", "gh --version"] });
    expect(throughShell({ file: "/usr/bin/csh", args: ["-l"] }, "gh --version")).toEqual({ file: "/usr/bin/csh", args: ["-c", "gh --version"] });
    expect(throughShell({ file: "powershell.exe", args: [] }, "winget upgrade --exact --id GitHub.cli")).toEqual({
      file: "powershell.exe",
      args: ["-Command", "winget upgrade --exact --id GitHub.cli"],
    });
  });
});

describe("a terminal's base environment", () => {
  it("is TERM, PATH, HOME, LANG and the user's names, and nothing else of the environment's own (SHELL is the shell started, set beside it)", () => {
    const own = { PATH: "/usr/bin:/bin", HOME: "/home/david", LANG: "en_GB.UTF-8", CLAUDE_CONFIG_DIR: "/secret", OPENBAO_TOKEN: "s.xyz", SHELL: "/bin/zsh" };
    expect(baseEnvironment("linux", own, user("/bin/bash"))).toEqual({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PATH: "/usr/bin:/bin",
      HOME: "/home/david",
      LANG: "en_GB.UTF-8",
      USER: "david",
      LOGNAME: "david",
    });
  });

  it("fills a PATH, HOME and LANG the environment lacks from the passwd entry and plain defaults", () => {
    expect(baseEnvironment("linux", {}, user(null))).toEqual({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/david",
      LANG: "C.UTF-8",
      USER: "david",
      LOGNAME: "david",
    });
  });

  it("keeps the few variables Windows needs to run anything, and still no other", () => {
    const own = { Path: "C:\\Windows", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\david", APPDATA: "C:\\a", SECRET: "x" };
    const env = baseEnvironment("win32", own, user(null));
    expect(env).toMatchObject({ PATH: "C:\\Windows", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\david", APPDATA: "C:\\a" });
    expect(env).not.toHaveProperty("SECRET");
  });
});

describe("the passwd entry", () => {
  it("falls back to the environment's names and the uid when the uid has none, so the shell is /bin/sh -l and nothing throws", () => {
    const missing = () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, uv_os_get_passwd"), { code: "ENOENT" });
    };
    expect(processUser(missing, { USER: "david", HOME: "/home/david" }, 1234)).toEqual({ username: "david", homedir: "/home/david", shell: null });
    expect(processUser(missing, { LOGNAME: "seth" }, 1234)).toEqual({ username: "seth", homedir: "/", shell: null });
    expect(processUser(missing, {}, 1234)).toEqual({ username: "1234", homedir: "/", shell: null });
    expect(loginShell("linux", processUser(missing, {}, 1234))).toEqual({ file: "/bin/sh", args: ["-l"] });
  });
});


describe("the one-off shell", () => {
  it("runs a command without login startup on POSIX and PowerShell profiles on Windows", () => {
    expect(oneOffShell("echo hi", "linux")).toEqual({ file: "/bin/sh", args: ["-c", "echo hi"] });
    expect(oneOffShell("Write-Output hi; exit 7", "win32")).toEqual({ file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Write-Output hi; exit 7"] });
  });
});
