import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";

/**
 * Shortcuts (docs/specs/tui.md, "Shortcuts: the shared action list, the
 * defaults, the keybindings file"): every key a named action of the shared
 * list, dispatched through the keymap in force; `keybindings.json` read at
 * launch and on `/reload`, an unknown id or key name reported and ignored, a
 * clash refused whole with the map in force kept; a remapped key firing
 * through Ink's own parser; `/help` and `?` drawing the effective map.
 */

let apps: RenderedApp[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  apps = [];
  dirs = [];
});
const launch = async (...args: Parameters<typeof renderApp>) => {
  const app = await renderApp(...args);
  apps.push(app);
  return app;
};

const DESK = { script: { environments: [{ name: "desk", reach: "local" as const }] } };

/** A keybindings file holding `mapping`, in a directory of its own. */
const keybindings = (mapping: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-shortcuts-"));
  dirs.push(dir);
  const path = join(dir, "keybindings.json");
  writeFileSync(path, JSON.stringify(mapping));
  return path;
};

/**
 * Launches on the local environment with the keybindings file at `path`: named by `--keybindings`, or, `inStateDir`,
 * as the state directory's own `keybindings.json`.
 */
const launchWith = async (path: string, inStateDir = false) => {
  const app = await launch({ ...DESK, keybindings: inStateDir ? { stateDir: dirname(path) } : { stateDir: dirname(path), flag: path } });
  await app.waitFor("● desk ready");
  return app;
};

const rowsWith = (frame: string, text: string) => frame.split("\n").filter((row) => row.includes(text));
const HELP_ROW = "Round the composer, the rail, the pane and the transcript";

/** Types a slash command and sends it. */
const run = async (app: RenderedApp, typed: string) => {
  await app.type(typed);
  await app.press(KEY.enter);
};

/** Pages the open help overlay down until the frame shows `text`. */
const pageTo = async (app: RenderedApp, text: string) => {
  for (let i = 0; i < 40 && !app.frame().includes(text); i++) await app.press(KEY.pageDown);
  expect(app.frame()).toContain(text);
};

describe("the help overlay", () => {
  it("opens on ? from an empty composer and on /help, and closes on Esc, q, or ? again", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    await app.press("?");
    await app.waitFor(HELP_ROW);
    expect(app.frame()).toContain("Anywhere");
    await app.press(KEY.esc);
    expect(app.frame()).not.toContain(HELP_ROW);
    await run(app, "/help");
    await app.waitFor(HELP_ROW);
    await app.press("q");
    expect(app.frame()).not.toContain(HELP_ROW);
    await app.press("?");
    await app.waitFor(HELP_ROW);
    await app.press("?");
    expect(app.frame()).not.toContain(HELP_ROW);
  });

  it("types ? into a composer with text in it, since the help map opens only from an empty composer", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    await app.type("why");
    await app.press("?");
    expect(app.frame()).toContain("› why?");
    expect(app.frame()).not.toContain(HELP_ROW);
  });

  it("scrolls a line with the move keys and pages with PgDn and PgUp, down to the slash commands", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    await app.press("?");
    await app.waitFor(HELP_ROW);
    await app.press(KEY.down, "j");
    expect(app.frame()).not.toContain("Anywhere");
    await app.press(KEY.up, "k");
    expect(app.frame()).toContain("Anywhere");
    await pageTo(app, "/reload");
    expect(rowsWith(app.frame(), "/reload")[0]).toContain("Read the keybindings file again");
    expect(app.frame()).not.toContain("/profile");
    await app.press(KEY.pageUp);
    expect(app.frame()).not.toContain("/reload");
  });

  it("draws a row the harness lacks dim with its reason, and a row this build does not answer yet as soon", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    await app.press("?");
    await pageTo(app, "Edit the rule that row would save");
    expect(app.frame()).toContain("Rules are per session on the harness");
    expect(rowsWith(app.frame(), "Edit the rule that row would save")[0]).not.toContain("(soon)");
    await pageTo(app, "Open the conversation in your editor");
    expect(rowsWith(app.frame(), "Open the conversation in your editor")[0]).toContain("(soon)");
  });

  it("leaves out every action only the GUI answers, on ? and on /help, from the top of the map to its slash commands (#388)", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    const GUI_ONLY = ["Open the command palette", "Split the focused pane to the right", "Allow it once, send the answer, or approve the plan", "Close the find bar", "Back out of a page of the list"];
    for (const open of [() => app.press("?"), () => run(app, "/help")]) {
      await open();
      await app.waitFor(HELP_ROW);
      const seen = [app.frame()];
      for (let i = 0; i < 40 && !app.frame().includes("/rewind"); i++) {
        await app.press(KEY.pageDown);
        seen.push(app.frame());
      }
      const map = seen.join("\n");
      expect(map).toContain("/rewind");
      expect(map).toContain("Deny it; on a question, skip it");
      for (const words of GUI_ONLY) expect(map, words).not.toContain(words);
      await app.press(KEY.esc);
      expect(app.frame()).not.toContain(HELP_ROW);
    }
  });

  it("shows the effective map: a remapped row with its new key, marked", async () => {
    const app = await launchWith(keybindings({ "app.help": ["Ctrl+X"] }));
    await app.press(KEY.ctrlX);
    await app.waitFor(HELP_ROW);
    const row = rowsWith(app.frame(), "Open this map, from an empty composer")[0];
    expect(row).toContain("Ctrl+X");
    expect(row).toContain("(remapped)");
    expect(rowsWith(app.frame(), "Clear the text or close the card; else interrupt, then quit")[0]).not.toContain("(remapped)");
  });
});

describe("a remapped key", () => {
  it("fires its action through Ink's key parser, and the old default no longer does", async () => {
    const app = await launchWith(keybindings({ "app.help": ["Ctrl+X"] }));
    await app.press("?");
    expect(app.frame()).toContain("› ?");
    expect(app.frame()).not.toContain(HELP_ROW);
    await app.press(KEY.backspace, KEY.ctrlX);
    await app.waitFor(HELP_ROW);
  });

  it("is the one a card's hint names, and the card's old key no longer closes it", async () => {
    const app = await launchWith(keybindings({ "picker.leave": ["q"] }));
    await run(app, "/environment");
    await app.waitFor("↑↓ move · Enter actions · q close");
    await app.press(KEY.esc);
    expect(app.frame()).toContain("Environments");
    await app.press("q");
    expect(app.frame()).not.toContain("Environments");
  });

  it("leaves the composer's sigils alone: a slash command is syntax whatever key opens the menu", async () => {
    const app = await launchWith(keybindings({ "composer.command.menu": ["Ctrl+N"] }));
    await run(app, "/environment");
    await app.waitFor("Environments");
  });
});

describe("the keybindings file", () => {
  it("reports an unknown id and an unknown key name at launch, and applies the rest", async () => {
    const app = await launchWith(keybindings({ "rail.fly": ["f"], "app.help": ["Hyper+Q", "Ctrl+X"] }));
    expect(app.frame()).toContain("there is no action rail.fly; ignored.");
    expect(app.frame()).toContain('"Hyper+Q" is not a key name');
    await app.press(KEY.ctrlX);
    await app.waitFor(HELP_ROW);
  });

  it("is read again on /reload, which reports as launch does and applies what it can", async () => {
    const path = keybindings({ "app.help": ["Ctrl+X"] });
    const app = await launchWith(path);
    writeFileSync(path, JSON.stringify({ "app.help": ["Ctrl+B"], "rail.fly": ["f"] }));
    await run(app, "/reload");
    await app.waitFor("there is no action rail.fly; ignored.");
    await app.press(KEY.ctrlX);
    expect(app.frame()).not.toContain(HELP_ROW);
    await app.press(KEY.ctrlB);
    await app.waitFor(HELP_ROW);
  });

  it("says what it read when the file reads clean", async () => {
    const path = keybindings({});
    const app = await launchWith(path);
    writeFileSync(path, JSON.stringify({ "app.help": ["Ctrl+B"] }));
    await run(app, "/reload");
    await app.waitFor(`Keybindings read again from ${path}: 1 action remapped.`);
  });

  it("is refused whole on /reload when it gives one key to two actions in one context, naming the clash, and the map in force stays", async () => {
    const path = keybindings({ "app.help": ["Ctrl+X"] });
    const app = await launchWith(path);
    writeFileSync(path, JSON.stringify({ "app.help": ["Ctrl+B"], "confirm.yes": ["n"] }));
    await run(app, "/reload");
    await app.waitFor("refused: n is both confirm.yes and confirm.no in confirm; the keys in force stand.");
    await app.press(KEY.ctrlB);
    expect(app.frame()).not.toContain(HELP_ROW);
    await app.press(KEY.ctrlX);
    await app.waitFor(HELP_ROW);
  });

  it("gives the defaults back when the state directory's file is gone at /reload", async () => {
    const path = keybindings({ "app.help": ["Ctrl+X"] });
    const app = await launchWith(path, true);
    unlinkSync(path);
    await run(app, "/reload");
    await app.waitFor(`There is no keybindings file at ${path}; the default keys stand.`);
    await app.press("?");
    await app.waitFor(HELP_ROW);
  });
});

/** The line under the composer names what has the keys: the composer's own hint, or the rail's, or the transcript's. */
const COMPOSER_HINT = "Ctrl+C quits";
const RAIL_HINT = "The rail has the keys";
const TRANSCRIPT_HINT = "The transcript has the keys";

describe("focus", () => {
  it("walks Tab round the composer, the rail and the transcript, and Esc brings it back to the composer from either", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    expect(app.frame()).toContain(COMPOSER_HINT);
    await app.press(KEY.tab);
    await app.waitFor(RAIL_HINT);
    expect(app.frame()).toContain("Esc back to the composer");
    await app.press(KEY.tab);
    await app.waitFor(TRANSCRIPT_HINT);
    await app.press(KEY.tab);
    await app.waitFor(COMPOSER_HINT);
    await app.press(KEY.tab, KEY.tab);
    await app.waitFor(TRANSCRIPT_HINT);
    await app.press(KEY.esc);
    await app.waitFor(COMPOSER_HINT);
    await app.press(KEY.tab);
    await app.waitFor(RAIL_HINT);
    await app.press(KEY.esc);
    await app.waitFor(COMPOSER_HINT);
  });

  it("on a terminal too narrow to draw the rail beside the pane, brings it up in the pane's place (#145)", async () => {
    const app = await launch({ ...DESK, size: { columns: 80, rows: 30 } });
    await app.waitFor("● desk ready");
    expect(app.frame()).not.toContain("Sessions");
    await app.press(KEY.tab);
    await app.waitFor(RAIL_HINT);
    expect(app.frame()).toContain("Sessions");
    await app.press(KEY.tab);
    await app.waitFor(TRANSCRIPT_HINT);
    expect(app.frame()).not.toContain("Sessions");
    await app.press(KEY.tab);
    await app.waitFor(COMPOSER_HINT);
  });

  it("types nothing into the composer while the rail or the transcript has the keys, and sends nothing on Enter", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    await app.type("draft");
    await app.press(KEY.tab);
    await app.waitFor(RAIL_HINT);
    // The rail's own keys act on the rail (#145: Enter there starts a session on the heading, so it is left out here).
    await app.press("a", "p", "/", "x", KEY.backspace, KEY.backspace, KEY.up);
    expect(app.frame()).toContain("› draft");
    expect(app.frame()).not.toContain("There is no session open to send to.");
    await app.press(KEY.tab);
    await app.waitFor(TRANSCRIPT_HINT);
    await app.press("x", "o", KEY.backspace, KEY.enter, KEY.down);
    expect(app.frame()).toContain("› draft");
    expect(app.frame()).not.toContain("There is no session open to send to.");
    await app.press(KEY.esc);
    await app.waitFor(COMPOSER_HINT);
    await app.type("!");
    expect(app.frame()).toContain("› draft!");
  });

  it("opens the map on ? from the rail even with text in the composer, since the composer is not being typed at", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    await app.type("why");
    await app.press(KEY.tab);
    await app.waitFor(RAIL_HINT);
    await app.press("?");
    await app.waitFor(HELP_ROW);
    expect(app.frame()).toContain("› why");
    expect(app.frame()).not.toContain("› why?");
  });

  it("leaves the keys with an open card whatever had the focus, and gives them back to it when the card closes", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    await app.press(KEY.tab);
    await app.waitFor(RAIL_HINT);
    await app.press("?");
    await app.waitFor(HELP_ROW);
    await app.press(KEY.tab);
    expect(app.frame()).toContain(HELP_ROW);
    await app.press(KEY.esc);
    expect(app.frame()).not.toContain(HELP_ROW);
    expect(app.frame()).toContain(RAIL_HINT);
    await app.press(KEY.esc);
    await app.waitFor(COMPOSER_HINT);
  });

  it("answers y and n of a yes or no offer from the rail as from the composer", async () => {
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", discovery: "nothing" }] } });
    await app.waitFor("Start it? y/n");
    await app.press(KEY.tab);
    await app.waitFor(RAIL_HINT);
    await app.press("n");
    await app.waitFor("Not started");
  });

  it("follows a remapped focus key: Tab no longer moves it, and the new key does", async () => {
    const app = await launchWith(keybindings({ "app.focus.next": ["Ctrl+B"], "rail.leave": ["q"] }));
    await app.press(KEY.tab);
    expect(app.frame()).toContain(COMPOSER_HINT);
    await app.press(KEY.ctrlB);
    await app.waitFor(RAIL_HINT);
    expect(app.frame()).toContain("q back to the composer · Ctrl+B next");
    await app.press(KEY.esc);
    expect(app.frame()).toContain(RAIL_HINT);
    await app.press("q");
    await app.waitFor(COMPOSER_HINT);
  });
});

const OFFER = "Start it? y/n";
const DOWN = { script: { environments: [{ name: "desk", reach: "local" as const, discovery: "nothing" as const }] } };

describe("the order a key is looked up in, with a yes or no offer standing", () => {
  it("gives Esc and n on the help overlay to the overlay, never to the offer", async () => {
    const app = await launch(DOWN);
    await app.waitFor(OFFER);
    await app.press("?");
    await app.waitFor(HELP_ROW);
    await app.press("n");
    expect(app.frame()).toContain(HELP_ROW);
    expect(app.frame()).toContain(OFFER);
    await app.press(KEY.esc);
    expect(app.frame()).not.toContain(HELP_ROW);
    expect(app.frame()).toContain(OFFER);
    expect(app.frame()).not.toContain("Not started");
  });

  it("gives Esc and n on the /environment list to the list, never to the offer", async () => {
    const app = await launch(DOWN);
    await app.waitFor(OFFER);
    await run(app, "/environment");
    await app.waitFor("Environments");
    await app.press("n", "y");
    expect(app.frame()).toContain("Environments");
    expect(app.frame()).toContain(OFFER);
    expect(app.service.calls).toEqual([]);
    await app.press(KEY.esc);
    expect(app.frame()).not.toContain("Environments");
    expect(app.frame()).toContain(OFFER);
    expect(app.frame()).not.toContain("Not started");
  });

  it("takes Esc from the rail back to the composer, and only then as the offer's no", async () => {
    const app = await launch(DOWN);
    await app.waitFor(OFFER);
    await app.press(KEY.tab);
    await app.waitFor(RAIL_HINT);
    await app.press(KEY.esc);
    await app.waitFor(COMPOSER_HINT);
    expect(app.frame()).toContain(OFFER);
    expect(app.frame()).not.toContain("Not started");
    await app.press(KEY.esc);
    await app.waitFor("Not started");
  });
});

describe("Ctrl+C with a draft", () => {
  it("keeps the draft while the rail has the keys, closing the card instead", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    await app.type("draft");
    await app.press(KEY.tab);
    await app.waitFor(RAIL_HINT);
    await app.press("?");
    await app.waitFor(HELP_ROW);
    await app.press(KEY.ctrlC);
    expect(app.frame()).not.toContain(HELP_ROW);
    expect(app.frame()).toContain("› draft");
    await app.press(KEY.esc, KEY.ctrlC);
    expect(app.frame()).not.toContain("› draft");
  });
});

describe("the hint line", () => {
  it("says an open card has the keys, and how it closes", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    await run(app, "/environment");
    await app.waitFor("The card has the keys · Esc closes it");
    await app.press(KEY.enter);
    await app.waitFor("The card has the keys · Esc goes back");
  });

  it("keeps what has the keys in sight beside a notice, the composer's own keys on the status line above it (#147)", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    app.fault("The disk is full");
    await app.waitFor("The disk is full");
    expect(app.rows().at(-1)).toContain("The disk is full");
    expect(app.rows().at(-2)).toContain(COMPOSER_HINT);
    await app.press(KEY.tab);
    await app.waitFor(RAIL_HINT);
    expect(app.frame()).toContain("The disk is full");
  });
});

describe("the help overlay over a card", () => {
  it("goes back to the /environment list it was opened over when it closes", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    await run(app, "/environment");
    await app.waitFor("Environments");
    await app.press("?");
    await app.waitFor(HELP_ROW);
    await app.press(KEY.esc);
    await app.waitFor("Environments");
    await app.press("?");
    await app.waitFor(HELP_ROW);
    await app.press("?");
    await app.waitFor("Environments");
    await app.press(KEY.esc);
    expect(app.frame()).not.toContain("Environments");
  });

  it("keeps its place within the map after the terminal is resized, so a scroll moves from what is on screen", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    await app.press("?");
    await app.waitFor(HELP_ROW);
    await app.press("G");
    expect(app.frame()).not.toContain("Anywhere");
    await app.resize({ columns: 100, rows: 400 });
    await app.waitFor("Anywhere");
    await app.resize({ columns: 100, rows: 30 });
    await app.waitFor("Anywhere");
    await app.press("j");
    expect(app.frame()).not.toContain(" Anywhere");
  });
});

describe("the keybindings file's validation, seen on the screen", () => {
  it("refuses a class of keys for a yes or no answer in one line, and y still answers", async () => {
    const app = await launch({ ...DOWN, keybindings: { stateDir: dirname(keybindings({ "confirm.yes": ["Letters"] })) } });
    await app.waitFor(OFFER);
    const lines = rowsWith(app.frame(), "Letters");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("is a class of keys");
    await app.press("y");
    expect(app.service.calls).toEqual(["start"]);
  });

  it("counts as remapped only what differs from the defaults", async () => {
    const path = keybindings({});
    const app = await launchWith(path);
    writeFileSync(path, JSON.stringify({ "app.help": ["?"], "confirm.yes": ["Y"] }));
    await run(app, "/reload");
    await app.waitFor("1 action remapped.");
  });
});

describe("the keybindings a launch reads (keybindingsFor, as runTui reads them)", () => {
  /** A state directory holding `mapping` as its keybindings.json. */
  const stateDirWith = (mapping: unknown) => dirname(keybindings(mapping));

  it("reads keybindings.json in the state directory at launch, and again on /reload", async () => {
    const stateDir = stateDirWith({ "app.help": ["Ctrl+X"], "rail.fly": ["f"] });
    const app = await launch({ ...DESK, keybindings: { stateDir } });
    await app.waitFor("● desk ready");
    expect(app.frame()).toContain("there is no action rail.fly; ignored.");
    await app.press(KEY.ctrlX);
    await app.waitFor(HELP_ROW);
    await app.press(KEY.esc);
    writeFileSync(join(stateDir, "keybindings.json"), JSON.stringify({ "app.help": ["Ctrl+B"] }));
    await run(app, "/reload");
    await app.waitFor(`Keybindings read again from ${join(stateDir, "keybindings.json")}: 1 action remapped.`);
    await app.press(KEY.ctrlB);
    await app.waitFor(HELP_ROW);
  });

  it("reads the file --keybindings names instead of the state directory's", async () => {
    const stateDir = stateDirWith({ "app.help": ["Ctrl+X"] });
    const named = join(stateDir, "mine.json");
    writeFileSync(named, JSON.stringify({ "app.help": ["Ctrl+B"] }));
    const app = await launch({ ...DESK, keybindings: { stateDir, flag: named } });
    await app.waitFor("● desk ready");
    await app.press(KEY.ctrlX);
    expect(app.frame()).not.toContain(HELP_ROW);
    await app.press(KEY.ctrlB);
    await app.waitFor(HELP_ROW);
  });

  it("reports a --keybindings file that is not there, and launches on the defaults", async () => {
    const stateDir = stateDirWith({ "app.help": ["Ctrl+X"] });
    const app = await launch({ ...DESK, keybindings: { stateDir, flag: join(stateDir, "gone.json") } });
    await app.waitFor("could not be read");
    await app.press("?");
    await app.waitFor(HELP_ROW);
  });

  it("launches on the defaults, saying nothing, when the state directory has no keybindings.json", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-harness-shortcuts-"));
    dirs.push(stateDir);
    const app = await launch({ ...DESK, keybindings: { stateDir } });
    await app.waitFor("● desk ready");
    expect(app.frame()).toContain("Ctrl+C quits · ? keys");
    await run(app, "/reload");
    await app.waitFor(`There is no keybindings file at ${join(stateDir, "keybindings.json")}; the default keys stand.`);
  });
});
