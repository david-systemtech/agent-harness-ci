import { describe, expect, it } from "vitest";
import { editorOf } from "./editor.js";
import {
  EMPTY_COMPOSER,
  acceptCommand,
  acceptMention,
  acceptSnippet,
  composerOf,
  continued,
  expandedSnippet,
  matchCommands,
  outgoing,
  pasted,
  pastedImage,
  popupOf,
  rubbedOut,
  searched,
  searching,
  searchClosed,
  sent,
  stashed,
  typed,
  walkStops,
  walked,
  type CommandRow,
  type PopupSources,
} from "./state.js";

/**
 * The composer as data (docs/specs/tui.md, "The composer"): Artemis's
 * composer rules as functions of its state, with no terminal.
 */

const COMMANDS: CommandRow[] = [
  { name: "resume", usage: "/resume", description: "Pick up a session", provider: false },
  { name: "attach", usage: "/attach <path>", description: "Send a file", provider: false },
  { name: "compact", usage: "/compact", description: "Compact the conversation", provider: true },
];
const SOURCES: PopupSources = { commands: COMMANDS, paths: ["src/parser.ts", "README.md"], snippets: [{ name: "explain", body: "Explain @${1:path}." }] };
const TRACE = ["Error: nope", "    at a (a.ts:1:1)", "    at b (b.ts:2:2)", "    at c (c.ts:3:3)"].join("\n");

describe("paste chips", () => {
  it("stands a long paste in the text as one marker and sends what it stood for, fenced as its kind asks", () => {
    const state = pasted(typed(EMPTY_COMPOSER, "Why? "), TRACE);
    expect(state.editor.text).toMatch(/^Why\? \[Pasted #1 · 4 lines · .*\]$/);
    expect(outgoing(state).text).toBe(`Why? \n\`\`\`\n${TRACE}\n\`\`\``);
  });

  it("types a short paste in as it is", () => {
    expect(pasted(EMPTY_COMPOSER, "two\nlines").editor.text).toBe("two\nlines");
  });

  it("rubs a chip out whole with one Backspace", () => {
    const state = rubbedOut(pasted(EMPTY_COMPOSER, TRACE));
    expect(state.editor.text).toBe("");
    expect(outgoing(state).text).toBe("");
  });

  it("puts a pasted image in the text as [Image #n] and sends its attachment, numbering chips on within a message", () => {
    const image = (number: number) => ({ kind: "image" as const, name: `clipboard-${number}.png`, mediaType: "image/png", data: "AQID" });
    const state = pastedImage(pasted(EMPTY_COMPOSER, TRACE), image);
    expect(state.editor.text).toContain("[Image #2]");
    expect(outgoing(state).attachments).toEqual([image(2)]);
    expect(outgoing(sent(state))).toEqual({ text: "", attachments: [] });
  });
});

describe("popups", () => {
  it("opens the slash menu while the text is one word starting with /, prefix matches first", () => {
    const popup = popupOf(composerOf("/c"), SOURCES);
    expect(popup?.kind === "commands" && popup.rows.map((r) => r.name)).toEqual(["compact", "attach"]);
    expect(popupOf(composerOf("/zz"), SOURCES)).toBeNull();
    expect(popupOf(composerOf("/resume now"), SOURCES)).toBeNull();
    expect(matchCommands("rs", COMMANDS).map((r) => r.name)).toEqual(["resume"]);
  });

  it("puts the command named exactly first, so Enter on a whole name runs it and not a longer one it begins (#147: /mode, /model)", () => {
    const rows = (...names: string[]) => names.map((name) => ({ name, usage: `/${name}`, description: "", provider: false }));
    expect(matchCommands("mode", rows("model", "mode")).map((r) => r.name)).toEqual(["mode", "model"]);
    expect(matchCommands("Mode", rows("model", "mode")).map((r) => r.name)).toEqual(["mode", "model"]);
    expect(matchCommands("mo", rows("model", "mode")).map((r) => r.name)).toEqual(["model", "mode"]);
  });

  it("fills a command in on Tab, with a space when it takes arguments", () => {
    const state = composerOf("/at");
    const popup = popupOf(state, SOURCES);
    if (popup?.kind !== "commands") throw new Error("no menu");
    expect(acceptCommand(state, popup).editor.text).toBe("/attach ");
  });

  it("offers the paths an @ names, and writes the chosen one over the token with a space after it", () => {
    const state = composerOf("look at @prs");
    const popup = popupOf(state, SOURCES);
    if (popup?.kind !== "mentions") throw new Error("no mention popup");
    expect(popup.rows.map((r) => r.path)).toEqual(["src/parser.ts"]);
    expect(acceptMention(state, popup)?.state.editor.text).toBe("look at @src/parser.ts ");
    const loading = popupOf(state, { ...SOURCES, paths: null });
    expect(loading?.kind === "mentions" && loading.loading).toBe(true);
  });

  it("expands a snippet over its ;; token, the cursor in its first hole, Tab walking on", () => {
    const state = composerOf("please ;;ex");
    const popup = popupOf(state, SOURCES);
    if (popup?.kind !== "snippets") throw new Error("no snippet popup");
    const expanded = acceptSnippet(state, popup);
    expect(expanded.editor.text).toBe("please Explain @path.");
    expect(expanded.editor.cursor).toBe("please Explain @".length);
    // The default is replaced by the first thing typed into it.
    expect(typed(expanded, "a.ts").editor.text).toBe("please Explain @a.ts.");
  });

  it("walks a snippet's stops with Tab and back, the stops going after the last", () => {
    const state = expandedSnippet(EMPTY_COMPOSER, "$1 and $2 then $0!", []);
    expect(state.editor.cursor).toBe(0);
    const second = walkStops(typed(state, "x"), 1);
    if (second === false) throw new Error("no stops");
    expect(second.editor.cursor).toBe("x and ".length);
    const done = walkStops(second, 1);
    if (done === false) throw new Error("no stops");
    expect(done.stops).toBeNull();
    expect(done.editor.cursor).toBe("x and  then ".length);
    expect(walkStops(done, 1)).toBe(false);
  });
});

describe("history, search and the stash", () => {
  it("walks older prompts with ↑ and back to the text it began from", () => {
    const texts = ["newest", "older"];
    const up = walked(composerOf("mine"), texts, 1);
    if (up === false) throw new Error("no walk");
    expect(up.editor.text).toBe("newest");
    const upAgain = walked(up, texts, 1);
    if (upAgain === false) throw new Error("no walk");
    expect(upAgain.editor.text).toBe("older");
    expect(walked(upAgain, texts, 1)).toBe(false);
    const back = walked(walked(upAgain, texts, -1) as typeof up, texts, -1);
    expect(back !== false && back.editor.text).toBe("mine");
  });

  it("searches the history, Esc giving the text back", () => {
    const matches = (query: string) => ["fix the parser", "fix the tests"].filter((t) => t.includes(query)).map((text) => ({ text, cwd: "/", ts: 0, index: 0 }));
    const open = searching(composerOf("mine"));
    const found = searched(open, { query: "tests" }, (s) => matches(s.query));
    expect(found.editor.text).toBe("fix the tests");
    expect(searchClosed(found, true).editor.text).toBe("mine");
    expect(searchClosed(found, false).editor.text).toBe("fix the tests");
  });

  it("sets the text aside with Ctrl+S and gives it back", () => {
    const aside = stashed(composerOf("half"));
    if (aside === false) throw new Error("nothing set aside");
    expect(aside.editor.text).toBe("");
    const back = stashed(aside);
    expect(back !== false && back.editor.text).toBe("half");
    expect(stashed(EMPTY_COMPOSER)).toBe(false);
  });

  it("keeps a line open on \\\\ Enter, and declines on a line that does not end in a backslash", () => {
    const open = continued({ ...EMPTY_COMPOSER, editor: editorOf("one\\") });
    expect(open !== false && open.editor.text).toBe("one\n");
    expect(continued(composerOf("one"))).toBe(false);
  });
});
