import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * The machine's git as the 2026-09-18 hang left it (forge spec, "Testing
 * Decisions"): a global configuration, the test's own, whose credential
 * helper and askpass each record that they were asked and then answer
 * nobody for twenty seconds, as Git Credential Manager did with an expired
 * browser token. `HOME`, which the harness's scrubbed git environment keeps,
 * is pointed at it for the test.
 */

export interface HostileGit {
  /** What asked the hostile programs, in order: `helper <verb>` or `askpass <prompt>`. */
  asked(): string[];
}

/** How long a hostile program hangs: longer than any test here waits for git. */
const HANG_SECONDS = 20;

export const hostileMachineGit = (tempDir: (prefix?: string) => string, onCleanup: (cleanup: () => void) => void): HostileGit => {
  const home = tempDir("agent-harness-hostile-home-");
  const record = join(home, "asked");
  const helper = join(home, "hostile-helper");
  const askpass = join(home, "hostile-askpass");
  writeFileSync(helper, `#!/bin/sh\necho "helper $*" >> '${record}'\nsleep ${HANG_SECONDS}\n`);
  writeFileSync(askpass, `#!/bin/sh\necho "askpass $*" >> '${record}'\nsleep ${HANG_SECONDS}\n`);
  chmodSync(helper, 0o755);
  chmodSync(askpass, 0o755);
  const config = join(home, ".gitconfig");
  const set = (key: string, value: string) => execFileSync("git", ["config", "--file", config, key, value], { env: { PATH: process.env["PATH"] } });
  set("credential.helper", `!'${helper}'`);
  set("core.askPass", askpass);
  const before = process.env["HOME"];
  process.env["HOME"] = home;
  onCleanup(() => void (before === undefined ? delete process.env["HOME"] : (process.env["HOME"] = before)));
  return { asked: () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : []) };
};
