import { describe, expect, it } from "vitest";
import { NO_PAGERS, ONE_OFF_LINE, ONE_OFF_VARIABLE, oneOffEnv, oneOffOutput, oneOffScript } from "./one-off.js";

/**
 * A one-off command's convention over a terminal (#148): the variables and
 * the line a client sends, and the reading of what came back. The terminal
 * UI's run of it is tested in its `terminal/one-off.test.ts`, and the real
 * shell's side in the environment's `terminals/one-off.test.ts`.
 */

const MARKER = "agent-harness-one-off-t1";

describe("the script and its variables", () => {
  it("print the marker, then take no input and tell every pager to print, then run the command as typed", () => {
    expect(oneOffScript("git log", MARKER).split("\n")).toEqual([
      `printf '%s\\n' '${MARKER}'`,
      "exec </dev/null",
      "PAGER=cat GIT_PAGER=cat MANPAGER=cat SYSTEMD_PAGER=cat; export PAGER GIT_PAGER MANPAGER SYSTEMD_PAGER",
      "git log",
    ]);
    expect(oneOffEnv("git log", MARKER)).toEqual({ ...NO_PAGERS, [ONE_OFF_VARIABLE]: oneOffScript("git log", MARKER) });
    expect(NO_PAGERS).toEqual({ PAGER: "cat", GIT_PAGER: "cat", MANPAGER: "cat", SYSTEMD_PAGER: "cat" });
  });

  it("are handed over by a line that starts with a space, which keeps it out of the shell's history", () => {
    expect(ONE_OFF_LINE).toBe(` exec /bin/sh -c "$${ONE_OFF_VARIABLE}"\r`);
  });
});

describe("the output after the marker", () => {
  it("is what came after the marker's line, found when it arrives in pieces; what came before is kept apart", () => {
    const heard = oneOffOutput(MARKER);
    heard.take("motd\r\n$ agent-harness-one-");
    expect(heard.said()).toBeNull();
    heard.take("off-t1\r");
    heard.take("\nhi\r\n");
    expect(heard.said()).toEqual({ text: "hi\r\n", cut: false, dropped: false });
    expect(heard.before()).toBe("motd\r\n$ ");
  });

  it("keeps only the last 16K characters of what came before the marker, and still finds a marker arriving across the cut", () => {
    const heard = oneOffOutput(MARKER);
    heard.take(`${"x".repeat(20 * 1024)}motd end\r\n`);
    expect(heard.before()).toHaveLength(16 * 1024);
    expect(heard.before().endsWith("x".repeat(100) + "motd end\r\n")).toBe(true);
    heard.take(`$ ${MARKER.slice(0, 5)}`);
    heard.take(`${MARKER.slice(5)}\r\nhi\r\n`);
    expect(heard.said()).toEqual({ text: "hi\r\n", cut: false, dropped: false });
    expect(heard.before().endsWith("x".repeat(100) + "motd end\r\n$ ")).toBe(true);
  });

  it("holds up to its limit and marks the cut", () => {
    const heard = oneOffOutput(MARKER, 4);
    heard.take(`${MARKER}\r\nabcdef`);
    expect(heard.said()).toEqual({ text: "abcd", cut: true, dropped: false });
  });

  it("reads a snapshot that no longer holds the marker, once it had come, as all the command's, its start dropped", () => {
    const heard = oneOffOutput(MARKER);
    heard.take(`${MARKER}\r\nstep 1\r\n`);
    heard.reset("step 4000\r\n");
    expect(heard.said()).toEqual({ text: "step 4000\r\n", cut: false, dropped: true });
  });
});
