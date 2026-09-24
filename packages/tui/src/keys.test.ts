import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_KEYS, contextOf, eventName, loadKeybindings, parseKeyName, resolveKeymap, type InkKey } from "./keys.js";

/**
 * The keys this build wires (docs/specs/tui.md, "Shortcuts"): named actions
 * with Artemis's default keys, the keybindings file that remaps them (an
 * unknown id or key name reported and ignored, a clash in one context
 * refused whole with the clash named), and the names of the keys Ink hears.
 */

const key = (overrides: Partial<InkKey> = {}): InkKey => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  ...overrides,
});

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const file = (text: string) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-keys-"));
  dirs.push(dir);
  const path = join(dir, "keybindings.json");
  writeFileSync(path, text);
  return path;
};

describe("the default keys", () => {
  it("carry Artemis's keys for the actions this build wires", () => {
    expect(DEFAULT_KEYS).toMatchObject({
      "app.interruptOrQuit": ["Ctrl+C"],
      "composer.send": ["Enter"],
      "composer.backspace": ["Backspace"],
      "picker.move": ["↑", "↓"],
      "picker.moveVi": ["k", "j"],
      "picker.choose": ["Enter"],
      "picker.leave": ["Esc"],
      "confirm.yes": ["y"],
      "confirm.no": ["n", "Esc"],
    });
  });

  it("give no key to two actions in one context", () => {
    const seen = new Map<string, string>();
    for (const [id, keys] of Object.entries(DEFAULT_KEYS)) {
      for (const k of keys) {
        const slot = `${contextOf(id)} ${k}`;
        expect(seen.get(slot), `${k} in ${contextOf(id)}`).toBeUndefined();
        seen.set(slot, id);
      }
    }
  });
});

describe("key names", () => {
  it.each([
    ["ctrl+c", "Ctrl+C"],
    ["Escape", "Esc"],
    ["return", "Enter"],
    ["Up", "↑"],
    ["shift+tab", "Shift+Tab"],
    ["y", "y"],
    ["J", "J"],
    // Shift on a letter is its capital, as the terminal sends it and `eventName` names it.
    ["Shift+a", "A"],
    ["shift+Y", "Y"],
    ["Ctrl+Shift+a", "Ctrl+A"],
  ])("reads %s as %s", (written, name) => {
    expect(parseKeyName(written)).toBe(name);
  });

  // Shift on any other printable character names a character the keyboard layout decides.
  it.each(["Hyper+Q", "Ctrl+", "Enterr", "", "Shift+1", "Shift+/"])("refuses %j", (written) => {
    expect(parseKeyName(written)).toBeUndefined();
  });

  it.each([
    ["c", key({ ctrl: true }), "Ctrl+C"],
    ["", key({ return: true }), "Enter"],
    ["", key({ escape: true }), "Esc"],
    ["", key({ upArrow: true }), "↑"],
    ["", key({ backspace: true }), "Backspace"],
    ["", key({ delete: true }), "Backspace"],
    ["", key({ tab: true, shift: true }), "Shift+Tab"],
    ["y", key(), "y"],
    ["Y", key({ shift: true }), "Y"],
  ])("names the key Ink hears for %j", (input, inkKey, name) => {
    expect(eventName(input, inkKey)).toBe(name);
  });
});

describe("the keybindings file", () => {
  it("is optional: no file, the defaults", () => {
    const loaded = loadKeybindings(join(tmpdir(), "no-such-dir-agent-harness", "keybindings.json"), { required: false });
    expect(loaded.problems).toEqual([]);
    expect(loaded.keymap.keys["confirm.yes"]).toEqual(["y"]);
  });

  it("is required when named on the command line", () => {
    const loaded = loadKeybindings(join(tmpdir(), "no-such-dir-agent-harness", "k.json"), { required: true });
    expect(loaded.problems).toEqual([expect.stringContaining("could not be read")]);
  });

  it("remaps an action and marks it remapped", () => {
    const loaded = loadKeybindings(file(JSON.stringify({ "confirm.yes": ["Ctrl+Y", "Enter"] })), { required: true });
    expect(loaded.problems).toEqual([]);
    expect(loaded.keymap.keys["confirm.yes"]).toEqual(["Ctrl+Y", "Enter"]);
    expect([...loaded.keymap.remapped]).toEqual(["confirm.yes"]);
  });

  it("reads Shift on a letter as the capital the terminal sends, and refuses Shift on another character", () => {
    const loaded = loadKeybindings(file(JSON.stringify({ "confirm.yes": ["Shift+y"], "confirm.no": ["Shift+1", "n"] })), { required: true });
    expect(loaded.keymap.keys["confirm.yes"]).toEqual(["Y"]);
    expect(loaded.keymap.keys["confirm.no"]).toEqual(["n"]);
    expect([...loaded.keymap.remapped].sort()).toEqual(["confirm.no", "confirm.yes"]);
    expect(loaded.problems).toEqual([expect.stringContaining('"Shift+1" is not a key name')]);
  });

  it("reports an unknown action id and an unknown key name, and ignores them", () => {
    const loaded = loadKeybindings(file(JSON.stringify({ "rail.fly": ["f"], "confirm.yes": ["Hyper+Q", "Y"] })), { required: true });
    expect(loaded.problems).toEqual([expect.stringContaining("rail.fly"), expect.stringContaining("Hyper+Q")]);
    expect(loaded.keymap.keys["confirm.yes"]).toEqual(["Y"]);
  });

  it("keeps an action's default keys when none of the names given it is a key, so it is never left unbound", () => {
    const loaded = loadKeybindings(file(JSON.stringify({ "confirm.yes": ["Hyper+Q"] })), { required: true });
    expect(loaded.keymap.keys["confirm.yes"]).toEqual(["y"]);
    expect(loaded.keymap.remapped.has("confirm.yes")).toBe(false);
    expect(loaded.problems).toEqual([
      expect.stringContaining('"Hyper+Q" is not a key name'),
      expect.stringContaining("confirm.yes has no key left; its default keys stand."),
    ]);
  });

  it.each([[["↓"]], [["PgUp", "PgDn", "Home"]]])("keeps a move action's default keys when it is not given exactly an up and a down key: %j", (written) => {
    const loaded = loadKeybindings(file(JSON.stringify({ "picker.move": written, "picker.moveVi": ["i", "m"] })), { required: true });
    expect(loaded.keymap.keys["picker.move"]).toEqual(["↑", "↓"]);
    expect(loaded.keymap.keys["picker.moveVi"]).toEqual(["i", "m"]);
    expect([...loaded.keymap.remapped]).toEqual(["picker.moveVi"]);
    expect(loaded.problems).toEqual([expect.stringContaining("picker.move takes two keys, up then down; its default keys stand.")]);
  });

  it("refuses a mapping that gives one key to two actions in one context whole, naming the clash", () => {
    const loaded = loadKeybindings(file(JSON.stringify({ "confirm.yes": ["n"], "picker.choose": ["Space"] })), { required: true });
    expect(loaded.problems).toEqual([expect.stringMatching(/refused.*n.*confirm\.yes.*confirm\.no|refused.*n.*confirm\.no.*confirm\.yes/)]);
    expect(loaded.keymap.keys).toEqual(DEFAULT_KEYS);
  });

  it("refuses a file that is not a JSON object of key lists", () => {
    expect(loadKeybindings(file("[1]"), { required: true }).problems).toEqual([expect.stringContaining("not a JSON object")]);
    expect(loadKeybindings(file("{"), { required: true }).problems).toEqual([expect.stringContaining("not JSON")]);
  });

  it("resolves a keymap in memory the same way", () => {
    expect(resolveKeymap({ "picker.leave": ["q"] }).keymap.keys["picker.leave"]).toEqual(["q"]);
  });
});
