import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ONE_OFF_LINE, oneOffEnv, oneOffOutput } from "@agent-harness/contracts";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import { follow, openTerminal, sessionIn, typeInto } from "../../test/terminals.js";

/**
 * The terminal UI's one-off command (`!!`, docs/specs/tui.md, "The
 * composer"; #148) run in a real terminal: the command rides
 * `terminals.open`'s variables behind a marker line, the line typed hands
 * the shell over to `/bin/sh` running it, and what came after the marker,
 * read as a terminal shows it, is the command's output and the terminal's
 * exit its status. The shell here is an interactive `/bin/sh`, whose
 * prompt and echo of the typed line come before the marker, as a login
 * shell's would.
 */

const { onCleanup, tempDir } = useCleanups();

const SH = { file: "/bin/sh", args: [] } as const;

/**
 * What came after the marker as plain lines: the pseudo-terminal ends each with `\r\n`, and these commands print no
 * other control. The terminal UI reads it through its emulator (`shownText`), tested there.
 */
const lines = (text: string): string => text.replace(/\r\n/g, "\n").trimEnd();

/** Runs `command` as `!!` does in a directory of its own; resolves with the terminal's text, what came after the marker, and the exit. */
const oneOff = async (command: string, prepare: (dir: string) => void = () => undefined) => {
  const t = await startTestEnvironment({ terminals: { shell: () => SH } });
  onCleanup(() => t.close());
  const client = await t.client();
  const dir = tempDir("agent-harness-one-off-");
  prepare(dir);
  const sessionId = await sessionIn(client, dir);
  const id = randomUUID();
  const marker = `agent-harness-one-off-${id}`;
  await openTerminal(client, sessionId, { id, cols: 120, rows: 40, env: oneOffEnv(command, marker) });
  const view = await follow(client, id);
  await typeInto(client, id, ONE_OFF_LINE);
  await view.until((v) => v.exited !== undefined, `${command} to exit`);
  const heard = oneOffOutput(marker);
  heard.take(view.text);
  const said = heard.said();
  return { raw: view.text, said: said === null ? null : lines(said.text), exitCode: view.exited?.exitCode };
};

describe("a one-off command in a real terminal", () => {
  it("is read from after the marker: the prompt and the echo of the typed line before it are not the command's, and its status is the exit", async () => {
    const ran = await oneOff("printf 'one\\ntwo\\n'; exit 3");
    expect(ran.raw).toContain("exec /bin/sh -c");
    expect(ran.said).toBe("one\ntwo");
    expect(ran.exitCode).toBe(3);
  });

  it("keeps the command's quoting as typed, never read by the login shell", async () => {
    const ran = await oneOff(`echo "it's $((1+1))" '$HOME' ; echo done`);
    expect(ran.said).toBe("it's 2 $HOME\ndone");
    expect(ran.exitCode).toBe(0);
  });

  it("gives a command that reads its input the end of it, rather than waiting for keys nobody will press", async () => {
    const ran = await oneOff('read line; echo "read:[$line] status:$?"');
    expect(ran.said).toBe("read:[] status:1");
  });

  it("tells a pager to print: git's own pager, set in the repository, is never started", async () => {
    const ran = await oneOff("git log --format=%s", (dir) => {
      // A pager that stops after three lines until a key comes from the terminal, as `more` does.
      const pager = join(dir, ".more");
      writeFileSync(pager, "#!/bin/sh\nhead -n 3\nprintf -- '--More--'\nread key </dev/tty\ncat\n");
      chmodSync(pager, 0o755);
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "ignore" });
      git("init", "-q");
      git("config", "core.pager", pager);
      for (let i = 1; i <= 50; i++) git("commit", "-q", "--allow-empty", "-m", `commit ${String(i)}`);
    });
    expect(ran.said?.split("\n")).toHaveLength(50);
    expect(ran.said).not.toContain("--More--");
    expect(ran.exitCode).toBe(0);
  });
});
