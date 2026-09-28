import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { credentialHelper, gitConfigVariables, helperChain } from "./git-helper.js";

/**
 * git's side of the helper at its lower seam (#314): the value git's
 * configuration names the helper by, run by a real git through its own
 * `sh`, and the Windows form, which no machine here can run (the PR records
 * that check as David's).
 */

const { tempDir } = useCleanups();

describe("the credential helper's value", () => {
  it("runs the command with git-credential, the slug and git's verb, from a path holding a space and a quote", () => {
    const dir = join(tempDir(), "David's tools", "agent harness");
    mkdirSync(dir, { recursive: true });
    const program = join(dir, "agent-harness");
    writeFileSync(program, `#!/bin/sh\ncat > /dev/null\necho username=from-helper\necho "password=$*"\n`);
    chmodSync(program, 0o755);

    const origin = "https://git.example.com:5526";
    const env = {
      PATH: process.env["PATH"],
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...gitConfigVariables(helperChain([origin], credentialHelper([program, "--flag=a b"], "git_example_com"))),
    };
    const filled = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=git.example.com:5526\n\n", env, encoding: "utf8" });
    expect(filled).toContain("username=from-helper\n");
    expect(filled).toContain("password=--flag=a b git-credential git_example_com get\n");
  });

  it("names a launcher's shim alone, the one agent-harness path that outlives every version (#459), a macOS data directory's space quoted", () => {
    expect(credentialHelper(["/Users/david/Library/Application Support/agent-harness/bin/agent-harness"], "github", "darwin")).toBe(
      "!'/Users/david/Library/Application Support/agent-harness/bin/agent-harness' git-credential github",
    );
    expect(credentialHelper(["C:\\Users\\david\\AppData\\Local\\agent-harness\\bin\\agent-harness.cmd"], "github", "win32")).toBe(
      "!C:/Users/david/AppData/Local/agent-harness/bin/agent-harness.cmd git-credential github",
    );
  });

  it("quotes each word for sh and writes a Windows path with forward slashes, which Git for Windows' sh runs", () => {
    expect(credentialHelper(["/opt/agent-harness/bin/agent-harness"], "github", "linux")).toBe("!/opt/agent-harness/bin/agent-harness git-credential github");
    expect(credentialHelper(["C:\\Program Files\\agent-harness\\node.exe", "C:\\Users\\David\\main.js"], "github", "win32")).toBe(
      "!'C:/Program Files/agent-harness/node.exe' C:/Users/David/main.js git-credential github",
    );
  });

  it("resets the chain for each origin before naming the helper, and names none when there is no helper", () => {
    expect(helperChain(["https://github.com", "http://100.64.0.7:3000"], "!helper")).toEqual([
      ["credential.https://github.com.helper", ""],
      ["credential.https://github.com.helper", "!helper"],
      ["credential.http://100.64.0.7:3000.helper", ""],
      ["credential.http://100.64.0.7:3000.helper", "!helper"],
    ]);
    expect(gitConfigVariables(helperChain(["https://codeberg.org"], null))).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.https://codeberg.org.helper",
      GIT_CONFIG_VALUE_0: "",
    });
  });
});
