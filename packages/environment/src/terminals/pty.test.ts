import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { nodePty, type PtyProcess } from "./pty.js";

/**
 * The pty port over `node-pty`, with real pseudo-terminals running
 * `/bin/sh` (#648): what a process printed before it exited is heard before
 * its exit, all of it, even when the environment was too busy to read it as
 * it came (the unread-output regression is Linux-specific).
 */

const { onCleanup } = useCleanups();

const spawn = (script: string): PtyProcess =>
  nodePty.spawn("/bin/sh", ["-c", script], { cwd: tmpdir(), cols: 80, rows: 24, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } });

/** What the process printed up to the moment its exit was heard, and the exit. */
const heardUntilExit = (child: PtyProcess): Promise<{ text: string; exitCode: number }> => {
  let text = "";
  child.onData((data) => (text += data));
  return new Promise((resolve) => child.onExit(({ exitCode }) => resolve({ text, exitCode })));
};

/**
 * Keeps the event loop from running, as an environment busy elsewhere (or a
 * starved runner) does, until the process `pid` has exited and been reaped:
 * everything it printed is then in the kernel, unread. Waits on that, not on
 * a time; the deadline only stops a test that would otherwise hang.
 * Linux only: macOS's unread capacity and process reaping do not support
 * this wait with JavaScript's reader blocked, so it can prevent completion.
 */
const busyUntilGone = (pid: number): void => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`Process ${pid} did not exit: did it print more than the kernel takes unread?`);
  }
};

describe("a pseudo-terminal's output", () => {
  it.runIf(process.platform === "linux")("is all heard before its process's exit, even when the process printed it and exited while nothing read", async () => {
    // More than the line discipline's 4 KiB, well under the 12 KiB or so a Linux pty takes unread before its writer waits.
    const child = spawn("head -c 6000 /dev/zero | tr '\\0' x; echo; echo end-$((1+1)); exit 3");
    const heard = heardUntilExit(child);

    busyUntilGone(child.pid);

    const { text, exitCode } = await heard;
    expect(exitCode).toBe(3);
    expect(text.replace(/[^x]/g, "")).toHaveLength(6000);
    expect(text).toContain("end-2");
  });

  it.runIf(process.platform === "linux")("keeps a character whole when the kernel's line discipline cut it between what was read and what was left", async () => {
    // 2,500 two-byte characters with no newline: the first read takes an odd 4,095 bytes, half of one é.
    const child = spawn("yes é | head -n 2500 | tr -d '\\n'; echo; echo end-$((1+1)); exit 3");
    const heard = heardUntilExit(child);

    busyUntilGone(child.pid);

    const { text } = await heard;
    expect(text).not.toContain("\uFFFD");
    expect(text.replace(/[^é]/g, "")).toHaveLength(2500);
    expect(text).toContain("end-2");
  });

  it("hears complete output and Unicode before exit while the event loop reads the terminal", async () => {
    // On macOS as well as Linux, let the real terminal drain as the process writes.
    const child = spawn("head -c 6000 /dev/zero | tr '\\0' x; echo; yes é | head -n 2500 | tr -d '\\n'; echo; echo end-$((1+1)); exit 3");

    const { text, exitCode } = await heardUntilExit(child);

    expect(exitCode).toBe(3);
    expect(text.replace(/\r\n/g, "\n")).toBe(`${"x".repeat(6000)}\n${"é".repeat(2500)}\nend-2\n`);
  });

  it("still comes to its process's exit when something else holds the terminal open and writes to it after that exited", async () => {
    // A writer that ignores the hang-up keeps the terminal open: node-pty's own wait for it runs out, and what is left is read, not waited for.
    const child = spawn("(trap '' HUP; exec yes) & exit 3");
    onCleanup(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    });

    const { exitCode } = await heardUntilExit(child);

    expect(exitCode).toBe(3);
  });
});
