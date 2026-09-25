import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Instance } from "ink";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";
import type { AppProps } from "./app.js";
import { runTui } from "./index.js";
import type { LocalService } from "./platform/services.js";

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

/** Launches on the local environment with the keybindings file at `path`, as `--keybindings` names one. */
const launchWith = async (path: string, required = true) => {
  const app = await launch({ ...DESK, keybindings: { path, required } });
  await app.waitFor("● desk ready");
  return app;
};

const rowsWith = (frame: string, text: string) => frame.split("\n").filter((row) => row.includes(text));
const HELP_ROW = "Round the composer, the list, the strip and the rows";

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

  it("types ? into a composer with text in it, as Artemis's map says: only from an empty composer", async () => {
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
    expect(rowsWith(app.frame(), "Tick one of several options")[0]).toContain("(soon)");
    expect(rowsWith(app.frame(), "Edit the rule that row would save")[0]).not.toContain("(soon)");
  });

  it("shows the effective map: a remapped row with its new key, marked", async () => {
    const app = await launchWith(keybindings({ "app.help": ["Ctrl+X"] }));
    await app.press(KEY.ctrlX);
    await app.waitFor(HELP_ROW);
    const row = rowsWith(app.frame(), "Open this map, from an empty composer")[0];
    expect(row).toContain("Ctrl+X");
    expect(row).toContain("(remapped)");
    expect(rowsWith(app.frame(), "Interrupt; again in a moment to quit")[0]).not.toContain("(remapped)");
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
    const app = await launchWith(path, false);
    unlinkSync(path);
    await run(app, "/reload");
    await app.waitFor("0 actions remapped");
    await app.press("?");
    await app.waitFor(HELP_ROW);
  });
});

/** The line under the composer names what has the keys: the composer's own hint, or the rail's, or the conversation's. */
const COMPOSER_HINT = "Ctrl+C quits";
const RAIL_HINT = "The list has the keys";
const TRANSCRIPT_HINT = "The conversation has the keys";

describe("focus", () => {
  it("walks Tab round the composer, the rail and the conversation, and Esc brings it back to the composer from either", async () => {
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

  it("steps over the rail on a terminal too narrow to draw it", async () => {
    const app = await launch({ ...DESK, size: { columns: 80, rows: 30 } });
    await app.waitFor("● desk ready");
    await app.press(KEY.tab);
    await app.waitFor(TRANSCRIPT_HINT);
    await app.press(KEY.tab);
    await app.waitFor(COMPOSER_HINT);
  });

  it("types nothing into the composer while the rail or the conversation has the keys, and sends nothing on Enter", async () => {
    const app = await launch(DESK);
    await app.waitFor("● desk ready");
    await app.type("draft");
    await app.press(KEY.tab);
    await app.waitFor(RAIL_HINT);
    await app.press("a", "p", "/", KEY.backspace, KEY.enter, KEY.up);
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

describe("runTui's keybindings", () => {
  const services: LocalService = {
    installed: async () => false,
    install: async () => ({ ok: false, message: "" }),
    start: async () => ({ ok: false, message: "" }),
    readiness: async () => "nothing",
  };
  const tty = () => Object.assign(Object.create(process.stdout) as NodeJS.WriteStream, { isTTY: true, columns: 100, rows: 30, write: () => true });

  /** Runs the terminal UI with a render that keeps the App's props and exits at once. */
  const propsOf = async (options: { readonly stateDir: string; readonly keybindings?: string }): Promise<AppProps> => {
    let props: AppProps | undefined;
    const render = (element: ReactElement): Instance => {
      props = element.props as AppProps;
      return { waitUntilExit: async () => undefined } as unknown as Instance;
    };
    const stdin = Object.assign(Object.create(process.stdin) as NodeJS.ReadStream, { isTTY: true });
    await runTui({ dataDir: options.stateDir, version: "0.0.0-test", services, stdin, stdout: tty(), stderr: tty(), render, ...options });
    if (!props) throw new Error("runTui rendered nothing");
    return props;
  };

  it("reads keybindings.json in the state directory at launch, and again for /reload", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-harness-tui-keys-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "keybindings.json"), JSON.stringify({ "app.help": ["Ctrl+X"], "rail.fly": ["f"] }));
    const props = await propsOf({ stateDir });
    expect(props.keymap.keys["app.help"]).toEqual(["Ctrl+X"]);
    expect(props.notes).toEqual([expect.stringContaining("rail.fly")]);
    writeFileSync(join(stateDir, "keybindings.json"), JSON.stringify({ "app.help": ["Ctrl+B"] }));
    expect(props.keybindings?.path).toBe(join(stateDir, "keybindings.json"));
    expect(props.keybindings?.reload(props.keymap).keymap.keys["app.help"]).toEqual(["Ctrl+B"]);
  });

  it("reads the file --keybindings names instead, and reports it when it is not there", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-harness-tui-keys-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "keybindings.json"), JSON.stringify({ "app.help": ["Ctrl+X"] }));
    const named = join(stateDir, "mine.json");
    writeFileSync(named, JSON.stringify({ "app.help": ["Ctrl+B"] }));
    expect((await propsOf({ stateDir, keybindings: named })).keymap.keys["app.help"]).toEqual(["Ctrl+B"]);
    const missing = await propsOf({ stateDir, keybindings: join(stateDir, "gone.json") });
    expect(missing.keymap.keys["app.help"]).toEqual(["?"]);
    expect(missing.notes).toEqual([expect.stringContaining("could not be read")]);
  });
});
