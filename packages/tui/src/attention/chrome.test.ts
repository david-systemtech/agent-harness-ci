import { manualClock } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import {
  AttentionTimer,
  FINISHED_IDLE_MS,
  NEEDS_YOU_IDLE_MS,
  TITLE_WIDTH,
  clearTitle,
  notificationMethod,
  notify,
  setTitle,
  terminalChrome,
  titleFor,
  type NotificationMethod,
  type TerminalDeps,
  type TerminalStdout,
  type TitleInput,
} from "./chrome.js";

/**
 * The terminal's contract, carried from Artemis's `terminal.test.ts` at
 * 443cf2e with its variables renamed: what the title says in each state and
 * how wide it is, the exact bytes of every sequence in and out of tmux,
 * which terminal gets which route, the two variables honoured, and that the
 * bell waits for a person to stop typing. Nothing here touches a real
 * terminal: the environment, the stream, the platform and the clock are
 * handed in, and the stream is a list of strings.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const width = (value: string): number => Array.from(value).length;

/** A terminal, its variables, and somewhere to catch what is written to it. */
const terminal = (env: NodeJS.ProcessEnv = {}, options: { readonly isTTY?: boolean; readonly platform?: string } = {}) => {
  const writes: string[] = [];
  const stdout: TerminalStdout = {
    write: (chunk: string) => writes.push(chunk),
    isTTY: options.isTTY ?? true,
  };
  const deps: TerminalDeps = { env, stdout, platform: options.platform ?? "linux" };
  return { writes, deps };
};

/** A stream that has gone away mid-write: a closed pipe, and not news. */
const broken: TerminalStdout = {
  write() {
    throw new Error("EPIPE");
  },
  isTTY: true,
};

describe("titleFor", () => {
  const session = { title: "Rework the parser", folder: "harness" } as const;

  it("draws each state with its own glyph and word", () => {
    expect(titleFor({ state: "ready", ...session }).trimEnd()).toBe("◇ ready · Rework the parser (harness)");
    expect(titleFor({ state: "working", ...session }).trimEnd()).toBe("⠹ working · Rework the parser (harness)");
    expect(titleFor({ state: "needs-you", ...session }).trimEnd()).toBe("⚿ needs you · Rework the parser (harness)");
  });

  it("counts the sessions waiting once more than one is, and caps an implausible count", () => {
    expect(titleFor({ state: "needs-you", ...session, needing: 2 }).trimEnd()).toBe("⚿ 2 need you · Rework the parser (harness)");
    for (const needing of [undefined, 0, 1, -3, Number.NaN]) expect(titleFor({ state: "needs-you", ...session, needing }).startsWith("⚿ needs you · ")).toBe(true);
    expect(titleFor({ state: "needs-you", ...session, needing: 4_000 }).startsWith("⚿ 99+ need you · ")).toBe(true);
  });

  it("lets the folder be the subject when there is no session name, and drops the parentheses with no folder", () => {
    expect(titleFor({ state: "ready", folder: "harness" }).trimEnd()).toBe("◇ ready · harness");
    expect(titleFor({ state: "working", title: "   ", folder: "harness" }).trimEnd()).toBe("⠹ working · harness");
    expect(titleFor({ state: "ready", folder: "" }).trimEnd()).toBe("◇ ready");
    expect(titleFor({ state: "working", title: "Rework the parser", folder: "" }).trimEnd()).toBe("⠹ working · Rework the parser");
  });

  it("is exactly one fixed width whatever it is given, cutting the name and keeping the folder's tail", () => {
    const inputs: readonly TitleInput[] = [
      { state: "ready", folder: "" },
      { state: "working", title: "Fix", folder: "harness" },
      { state: "needs-you", title: "x".repeat(400), folder: "y".repeat(400), needing: 99 },
      { state: "needs-you", title: "🙂".repeat(60), folder: "harness", needing: 2 },
    ];
    for (const input of inputs) expect(width(titleFor(input))).toBe(TITLE_WIDTH);
    const long = titleFor({ state: "working", title: `${"a".repeat(200)} the end`, folder: "harness" });
    expect(long.startsWith("⠹ working · ")).toBe(true);
    expect(long.endsWith(" (harness)")).toBe(true);
    expect(long).not.toContain("the end");
    const folder = "projects/clients/acme/harness-worktree-seventeen";
    expect(titleFor({ state: "ready", title: "Fix", folder })).toContain(`(…${folder.slice(-23)})`);
  });

  it("flattens the control characters that would end the sequence early", () => {
    const title = titleFor({ state: "ready", title: `Fix${BEL}the${ESC}]0;evil${BEL} parser\nnow`, folder: `harness${BEL}` });
    expect(title).not.toContain(ESC);
    expect(title).not.toContain(BEL);
    expect(title.trimEnd()).toBe("◇ ready · Fix the ]0;evil parser now (harness)");
  });
});

describe("setTitle and clearTitle", () => {
  it("write OSC 0, BEL-terminated, with the padding intact, and an empty title to hand it back", () => {
    const term = terminal();
    const title = titleFor({ state: "ready", title: "Fix", folder: "harness" });
    expect(setTitle(title, term.deps)).toBe(true);
    expect(clearTitle(term.deps)).toBe(true);
    expect(term.writes).toEqual([`${ESC}]0;${title}${BEL}`, `${ESC}]0;${BEL}`]);
  });

  it("wrap the sequence for tmux, doubling the escape inside it", () => {
    const term = terminal({ TMUX: "/tmp/tmux-1000/default,123,0" });
    setTitle("◇ ready", term.deps);
    expect(term.writes).toEqual([`${ESC}Ptmux;${ESC}${ESC}]0;◇ ready${BEL}${ESC}\\`]);
  });

  it("write nothing when AGENT_HARNESS_TUI_NO_TITLE is 1, and write when it is anything else", () => {
    const off = terminal({ AGENT_HARNESS_TUI_NO_TITLE: "1" });
    expect(setTitle("◇ ready", off.deps)).toBe(false);
    expect(clearTitle(off.deps)).toBe(false);
    expect(off.writes).toEqual([]);
    const on = terminal({ AGENT_HARNESS_TUI_NO_TITLE: "0" });
    expect(setTitle("◇ ready", on.deps)).toBe(true);
    // Artemis's own name for it is not this build's.
    const artemis = terminal({ ARTEMIS_TUI_NO_TITLE: "1" });
    expect(setTitle("◇ ready", artemis.deps)).toBe(true);
  });

  it("write nothing off a terminal, strip a control character passed straight through, and survive a broken stream", () => {
    const piped = terminal({}, { isTTY: false });
    expect(setTitle("◇ ready", piped.deps)).toBe(false);
    expect(piped.writes).toEqual([]);
    const term = terminal();
    setTitle(`ready${BEL}${ESC}]0;evil`, term.deps);
    expect(term.writes).toEqual([`${ESC}]0;ready  ]0;evil${BEL}`]);
    expect(setTitle("◇ ready", { env: {}, stdout: broken, platform: "linux" })).toBe(false);
  });
});

describe("notificationMethod", () => {
  const routes: readonly (readonly [string, NodeJS.ProcessEnv, NotificationMethod])[] = [
    ["iTerm2", { TERM_PROGRAM: "iTerm.app" }, "osc9"],
    ["Ghostty", { TERM_PROGRAM: "ghostty" }, "osc9"],
    ["WezTerm by its program", { TERM_PROGRAM: "WezTerm" }, "osc9"],
    ["WezTerm by its pane", { WEZTERM_PANE: "3" }, "osc9"],
    ["Warp", { TERM_PROGRAM: "WarpTerminal" }, "osc9"],
    ["kitty by its window id", { KITTY_WINDOW_ID: "1" }, "osc9"],
    ["kitty by its terminfo", { TERM: "xterm-kitty" }, "osc9"],
    ["Alacritty by its window id", { ALACRITTY_WINDOW_ID: "9" }, "bell"],
    ["Alacritty by its terminfo", { TERM: "alacritty" }, "bell"],
    ["the macOS Terminal", { TERM_PROGRAM: "Apple_Terminal" }, "bell"],
    ["VS Code", { TERM_PROGRAM: "vscode" }, "bell"],
    ["Windows Terminal", { WT_SESSION: "x" }, "bell"],
    ["a bare xterm on a Linux desktop", { TERM: "xterm-256color" }, "osc777"],
    ["a terminal that says nothing about itself", {}, "osc777"],
  ];

  it.each(routes)("rings %s", (_name, env, expected) => {
    expect(notificationMethod(terminal(env).deps)).toBe(expected);
  });

  it("falls back to the bell on Windows, and is none off a terminal whatever the terminal claimed", () => {
    expect(notificationMethod(terminal({}, { platform: "win32" }).deps)).toBe("bell");
    expect(notificationMethod(terminal({ TERM_PROGRAM: "ghostty" }, { isTTY: false }).deps)).toBe("none");
  });

  it("is none when AGENT_HARNESS_TUI_NOTIFY switches it off", () => {
    for (const value of ["off", "OFF", " off ", "0", "false"]) {
      expect(notificationMethod(terminal({ AGENT_HARNESS_TUI_NOTIFY: value, TERM_PROGRAM: "ghostty" }).deps)).toBe("none");
    }
  });

  it("takes the method AGENT_HARNESS_TUI_NOTIFY names, for the SSH hop that loses every clue, and ignores one it does not know", () => {
    expect(notificationMethod(terminal({ AGENT_HARNESS_TUI_NOTIFY: "osc9", TERM: "xterm-256color" }).deps)).toBe("osc9");
    expect(notificationMethod(terminal({ AGENT_HARNESS_TUI_NOTIFY: "BELL", TERM_PROGRAM: "ghostty" }).deps)).toBe("bell");
    expect(notificationMethod(terminal({ AGENT_HARNESS_TUI_NOTIFY: "osc777", TERM_PROGRAM: "iTerm.app" }).deps)).toBe("osc777");
    expect(notificationMethod(terminal({ AGENT_HARNESS_TUI_NOTIFY: "yes please", TERM_PROGRAM: "ghostty" }).deps)).toBe("osc9");
    expect(notificationMethod(terminal({ ARTEMIS_TUI_NOTIFY: "off", TERM_PROGRAM: "ghostty" }).deps)).toBe("osc9");
  });
});

describe("notify", () => {
  const notice = { kind: "needs-you", title: "agent-harness", body: "Rework the parser needs you" } as const;

  it("sends OSC 9 with the body alone, OSC 777 with a title and a body, and the bell with nothing", () => {
    const osc9 = terminal({ TERM_PROGRAM: "ghostty" });
    expect(notify(notice, osc9.deps)).toBe("osc9");
    expect(osc9.writes).toEqual([`${ESC}]9;Rework the parser needs you${BEL}`]);
    const osc777 = terminal({ TERM: "xterm-256color" });
    expect(notify({ ...notice, kind: "finished" }, osc777.deps)).toBe("osc777");
    expect(osc777.writes).toEqual([`${ESC}]777;notify;agent-harness;Rework the parser needs you${BEL}`]);
    const bell = terminal({ TERM_PROGRAM: "Apple_Terminal" });
    expect(notify(notice, bell.deps)).toBe("bell");
    expect(bell.writes).toEqual([BEL]);
  });

  it("wraps an OSC for tmux but leaves the bell for tmux to handle", () => {
    const osc = terminal({ TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux-1000/default,123,0" });
    notify({ ...notice, body: "done" }, osc.deps);
    expect(osc.writes).toEqual([`${ESC}Ptmux;${ESC}${ESC}]9;done${BEL}${ESC}\\`]);
    const bell = terminal({ TERM_PROGRAM: "vscode", TMUX: "/tmp/tmux-1000/default,123,0" });
    notify(notice, bell.deps);
    expect(bell.writes).toEqual([BEL]);
  });

  it("keeps a semicolon out of the OSC 777 title and flattens a control character out of either field", () => {
    const term = terminal({ TERM: "xterm-256color" });
    notify({ kind: "finished", title: "Receipts; really", body: "a; b" }, term.deps);
    notify({ kind: "finished", title: `Rec${ESC}eipts`, body: `done${BEL}\nat last` }, term.deps);
    expect(term.writes).toEqual([`${ESC}]777;notify;Receipts, really;a; b${BEL}`, `${ESC}]777;notify;Rec eipts;done at last${BEL}`]);
  });

  it("writes nothing and says none off a terminal, when switched off, or when the write failed", () => {
    const piped = terminal({ TERM_PROGRAM: "ghostty" }, { isTTY: false });
    expect(notify(notice, piped.deps)).toBe("none");
    const off = terminal({ TERM_PROGRAM: "ghostty", AGENT_HARNESS_TUI_NOTIFY: "off" });
    expect(notify(notice, off.deps)).toBe("none");
    expect([...piped.writes, ...off.writes]).toEqual([]);
    expect(notify(notice, { env: { TERM_PROGRAM: "ghostty" }, stdout: broken, platform: "darwin" })).toBe("none");
  });
});

describe("terminalChrome", () => {
  it("is the seam over the same bytes: the title, its clearing and a notification, honouring both variables", () => {
    const term = terminal({ TERM_PROGRAM: "ghostty" });
    const chrome = terminalChrome(term.deps);
    chrome.setTitle("◇ ready");
    chrome.notify({ kind: "finished", title: "Receipts", body: "Done." });
    chrome.clearTitle();
    expect(term.writes).toEqual([`${ESC}]0;◇ ready${BEL}`, `${ESC}]9;Done.${BEL}`, `${ESC}]0;${BEL}`]);

    const quiet = terminal({ TERM_PROGRAM: "ghostty", AGENT_HARNESS_TUI_NO_TITLE: "1", AGENT_HARNESS_TUI_NOTIFY: "off" });
    const muted = terminalChrome(quiet.deps);
    muted.setTitle("◇ ready");
    muted.notify({ kind: "finished", title: "Receipts", body: "Done." });
    muted.clearTitle();
    expect(quiet.writes).toEqual([]);
  });
});

describe("AttentionTimer", () => {
  const timed = () => {
    const clock = manualClock();
    const rung: string[] = [];
    return { clock, rung, timer: new AttentionTimer(clock) };
  };

  it("rings a waiting prompt after six seconds of stillness and a finished turn after a minute", () => {
    const { clock, rung, timer } = timed();
    timer.arm("needs-you", () => rung.push("needs-you"));
    timer.arm("finished", () => rung.push("finished"));
    clock.advance(NEEDS_YOU_IDLE_MS - 1);
    expect(rung).toEqual([]);
    clock.advance(1);
    expect(rung).toEqual(["needs-you"]);
    clock.advance(FINISHED_IDLE_MS - NEEDS_YOU_IDLE_MS - 1);
    expect(rung).toEqual(["needs-you"]);
    clock.advance(1);
    expect(rung).toEqual(["needs-you", "finished"]);
  });

  it("defers both on every keystroke, so it never rings at someone who is typing", () => {
    const { clock, rung, timer } = timed();
    timer.arm("needs-you", () => rung.push("needs-you"));
    timer.arm("finished", () => rung.push("finished"));
    for (let keystroke = 0; keystroke < 40; keystroke++) {
      clock.advance(5_000);
      timer.touch();
    }
    expect(rung).toEqual([]);
    clock.advance(NEEDS_YOU_IDLE_MS);
    expect(rung).toEqual(["needs-you"]);
    clock.advance(FINISHED_IDLE_MS);
    expect(rung).toEqual(["needs-you", "finished"]);
  });

  it("counts from the last keystroke rather than from arming, and never rings synchronously", () => {
    const { clock, rung, timer } = timed();
    timer.touch();
    clock.advance(NEEDS_YOU_IDLE_MS - 1_000);
    timer.arm("needs-you", () => rung.push("needs-you"));
    clock.advance(999);
    expect(rung).toEqual([]);
    clock.advance(1);
    expect(rung).toEqual(["needs-you"]);

    clock.advance(10 * FINISHED_IDLE_MS);
    timer.arm("finished", () => rung.push("finished"));
    expect(rung).toEqual(["needs-you"]);
    clock.advance(0);
    expect(rung).toEqual(["needs-you", "finished"]);
  });

  it("disarms, rings once and disarms itself, replaces a callback armed twice, and leaves no timer behind", () => {
    const { clock, rung, timer } = timed();
    timer.arm("needs-you", () => rung.push("dropped"));
    timer.disarm("needs-you");
    expect(timer.isArmed("needs-you")).toBe(false);
    expect(clock.pending()).toBe(0);

    timer.arm("needs-you", () => rung.push("first"));
    timer.arm("needs-you", () => rung.push("second"));
    expect(clock.pending()).toBe(1);
    clock.advance(NEEDS_YOU_IDLE_MS);
    expect(timer.isArmed("needs-you")).toBe(false);
    timer.touch();
    clock.advance(FINISHED_IDLE_MS);
    expect(rung).toEqual(["second"]);

    timer.arm("needs-you", () => rung.push("never"));
    timer.arm("finished", () => rung.push("never"));
    timer.disarmAll();
    expect(clock.pending()).toBe(0);
  });

  it("reports how long the person has been still, and honours delays a caller overrides", () => {
    const { clock, timer } = timed();
    clock.advance(4_000);
    expect(timer.idleMs()).toBe(4_000);
    timer.touch();
    expect(timer.idleMs()).toBe(0);

    const rung: string[] = [];
    const quick = new AttentionTimer(clock, { "needs-you": 50 });
    quick.arm("needs-you", () => rung.push("needs-you"));
    quick.arm("finished", () => rung.push("finished"));
    clock.advance(50);
    expect(rung).toEqual(["needs-you"]);
  });
});
