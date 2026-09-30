import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { MANAGED_TOOL_COMMANDS } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { commandLine } from "./command-line.js";

/**
 * A command of the closed command table as the one line a tool terminal's
 * login shell runs (#376), below the wire: every argument reaches its
 * program whole, whatever it holds, through each POSIX shell this machine
 * has, and the steps and pipes are the table's, not the arguments'.
 */

/** The arguments a table's command can hold that a shell would otherwise read: spaces, quotes, `$`, `&`, `|`, a leading `=`, a backslash. */
const AWKWARD = [
  "deb [arch=& signed-by=/etc/apt/keyrings/a.gpg] https://example.test/debian/& stable main",
  "baseurl=https://example.test/rpm/$basearch",
  'gpgkey="https://example.test/key.asc"',
  "it's",
  "=https",
  "%s\\n",
  "a|b && c; d > e",
  "~/not-home",
  "*.asc",
];

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/dash", "/bin/zsh", "/usr/bin/zsh", "/usr/bin/fish", "/bin/tcsh", "/usr/bin/tcsh"].filter((shell) => existsSync(shell));

describe.runIf(process.platform !== "win32")("a command's line", () => {
  it("gives each argument to its program as one word, whatever it holds, in every POSIX shell here", () => {
    const line = commandLine([[["printf", "[%s]\\n", ...AWKWARD]]], "linux");
    expect(SHELLS.length).toBeGreaterThan(0);
    for (const shell of SHELLS) {
      expect(execFileSync(shell, ["-c", line], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" } }), shell).toBe(AWKWARD.map((word) => `[${word}]\n`).join(""));
    }
  });

  it("pipes a step's programs one into the next, and runs a step only once the one before it has succeeded", () => {
    expect(execFileSync("/bin/sh", ["-c", commandLine([[["printf", "%s\\n", "b", "a"], ["sort"]], [["printf", "%s\\n", "done"]]], "linux")], { encoding: "utf8" })).toBe("a\nb\ndone\n");
    expect(execFileSync("/bin/sh", ["-c", `${commandLine([[["false"]], [["printf", "%s\\n", "ran"]]], "linux")}; printf 'after\\n'`], { encoding: "utf8" })).toBe("after\n");
  });

  it("reads as the table's commands read: plain words bare, and a repository line quoted", () => {
    const gh = MANAGED_TOOL_COMMANDS.find((entry) => entry.tool === "gh" && entry.method === "apt");
    expect(commandLine([[["brew", "install", "--cask", "claude-code"]]], "darwin")).toBe("brew install --cask claude-code");
    expect(commandLine(gh?.update ?? [], "linux")).toBe("sudo apt-get update && sudo apt-get install --only-upgrade gh");
    expect(commandLine(gh?.install ?? [], "linux")).toContain(
      "dpkg --print-architecture | sed 's|.*|deb [arch=& signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main|' | sudo tee /etc/apt/sources.list.d/github-cli.list",
    );
    expect(commandLine([[["curl", "-Ls", "--proto", "=https", "https://cli.doppler.com/install.sh"], ["sh"]]], "linux")).toBe("curl -Ls --proto '=https' https://cli.doppler.com/install.sh | sh");
  });
});

describe("a command's line on Windows", () => {
  it("is PowerShell's: single quotes, one doubled inside, around anything PowerShell would read, and one step", () => {
    expect(commandLine([[["winget", "install", "--exact", "--id", "OpenBao.OpenBao"]]], "win32")).toBe("winget install --exact --id OpenBao.OpenBao");
    expect(commandLine([[["irm", "https://claude.ai/install.ps1"], ["iex"]]], "win32")).toBe("irm https://claude.ai/install.ps1 | iex");
    expect(commandLine([[["echo", "a,b", "@x", "$env:PATH", "it's"]]], "win32")).toBe("echo 'a,b' '@x' '$env:PATH' 'it''s'");
    expect(() => commandLine([[["a"]], [["b"]]], "win32")).toThrow(/one step/);
  });
});
