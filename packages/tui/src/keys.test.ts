import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIONS, isCommandId, keyClashes } from "@agent-harness/contracts";
import {
  DEFAULT_KEYMAP,
  DEFAULT_KEYS,
  DOUBLE_PRESS_MS,
  FIRST_ANYWHERE,
  conditionOf,
  contextOf,
  direction,
  dispatch,
  eventName,
  keysText,
  loadKeybindings,
  parseKeyName,
  pressedBefore,
  resolveKeymap,
  type InkKey,
  type Press,
} from "./keys.js";

/** Each key more than one action holds in one context, as `<context> <key>` with the actions holding it. */
const sharedKeys = (bindings: readonly { readonly id: string; readonly context: string; readonly keys: readonly string[] }[]): [string, string[]][] => {
  const holders = new Map<string, string[]>();
  for (const { id, context, keys } of bindings) {
    for (const key of keys) {
      const slot = `${context} ${key}`;
      holders.set(slot, [...(holders.get(slot) ?? []), id]);
    }
  }
  return [...holders].filter(([, ids]) => ids.length > 1);
};

/**
 * The keys this build wires (docs/specs/tui.md, "Shortcuts"): named actions
 * with default keys, the keybindings file that remaps them (an
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
  it("carry the default keys for the actions this build wires", () => {
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

  it("give no key to two actions in one context, but for ↑, withdrawLast's on an empty composer beside navigate's", () => {
    const bindings = Object.entries(DEFAULT_KEYS).map(([id, keys]) => ({ id, context: contextOf(id), keys, when: conditionOf(id) }));
    expect(keyClashes(bindings)).toEqual([]);
    expect(sharedKeys(bindings)).toEqual([["composer ↑", ["composer.navigate", "composer.withdrawLast"]]]);
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
    // An arrow is a named key: Shift on it is a modifier, not a case.
    ["", key({ upArrow: true, shift: true }), "Shift+↑"],
    ["", key({ downArrow: true, shift: true }), "Shift+↓"],
    // The control bytes Ink hands over unmarked.
    ["\u001C", key(), "Ctrl+\\"],
    ["\u001D", key(), "Ctrl+]"],
    ["\u001F", key(), "Ctrl+_"],
    ["\n", key(), "Ctrl+J"],
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
    expect(loaded.problems).toEqual([expect.stringContaining('"Hyper+Q" is not a key name; confirm.yes has no key left; its default keys stand.')]);
  });

  it.each([[["↓"]], [["PgUp", "PgDn", "Home"]], [["k", "k"]], [["Down", "↓"]]])("keeps a move action's default keys when it is not given exactly two different keys, up and down: %j", (written) => {
    const loaded = loadKeybindings(file(JSON.stringify({ "picker.move": written, "picker.moveVi": ["i", "m"] })), { required: true });
    expect(loaded.keymap.keys["picker.move"]).toEqual(["↑", "↓"]);
    expect(loaded.keymap.keys["picker.moveVi"]).toEqual(["i", "m"]);
    expect([...loaded.keymap.remapped]).toEqual(["picker.moveVi"]);
    expect(loaded.problems).toEqual([expect.stringContaining("picker.move takes two different keys, up then down; its default keys stand.")]);
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

describe("the default keys as a projection of the shared action list", () => {
  it("are every pressed action's keys in the list, and no slash command's", () => {
    const pressed = ACTIONS.filter((a) => !isCommandId(a.id));
    expect(Object.keys(DEFAULT_KEYS).sort()).toEqual(pressed.map((a) => a.id).sort());
    for (const action of pressed) expect(DEFAULT_KEYS[action.id as keyof typeof DEFAULT_KEYS], action.id).toEqual(action.keys);
  });

  it("take an action's context from the list: row is the transcript's, rail the sidebar's, app is anywhere", () => {
    expect(contextOf("row.open")).toBe("transcript");
    expect(contextOf("rail.pin")).toBe("sidebar");
    expect(contextOf("app.help")).toBe("anywhere");
    expect(contextOf("confirm.yes")).toBe("confirm");
  });

  it("read every key the table writes as itself: a key name as written in the table is a key name", () => {
    const written = [...new Set(ACTIONS.flatMap((a) => a.keys))];
    expect(written.length).toBeGreaterThan(60);
    for (const k of written) expect(parseKeyName(k), k).toBe(k);
  });
});

describe("key names the table writes for more than one press", () => {
  it.each([
    ["esc esc", "Esc Esc"],
    ["\\ enter", "\\ Enter"],
    [";;", ";;"],
    ["1-4", "1–4"],
    ["letters", "Letters"],
    ["Ctrl+X Ctrl+E", "Ctrl+X Ctrl+E"],
  ])("reads %j as %j", (written, name) => {
    expect(parseKeyName(written)).toBe(name);
  });

  it.each(["Esc Escc", "Ctrl+ Esc"])("refuses %j", (written) => {
    expect(parseKeyName(written)).toBeUndefined();
  });
});

describe("the keybindings file over the whole list", () => {
  it("reports a slash command's id and ignores it: a command is typed, not pressed", () => {
    const loaded = resolveKeymap({ "command.help": ["F"], "app.help": ["Ctrl+X"] });
    expect(loaded.problems).toEqual([expect.stringContaining("command.help is a slash command")]);
    expect(loaded.keymap.keys["app.help"]).toEqual(["Ctrl+X"]);
  });

  it("reports an action only the GUI answers and ignores it: it has no terminal column to remap (#388)", () => {
    const loaded = resolveKeymap({ "app.palette": ["Ctrl+K"], "app.help": ["Ctrl+X"] });
    expect(loaded.problems).toEqual([expect.stringContaining("app.palette is the GUI's alone")]);
    expect(loaded.keymap.keys["app.palette"]).toEqual([]);
    expect(loaded.keymap.keys["app.help"]).toEqual(["Ctrl+X"]);
  });

  it("checks a clash in the list's context, whatever the id's first word: row and transcript are one context", () => {
    const loaded = resolveKeymap({ "transcript.follow": ["o"] });
    expect(loaded.problems).toEqual([expect.stringMatching(/refused: o is both transcript\.follow and row\.open in transcript|refused: o is both row\.open and transcript\.follow in transcript/)]);
    expect(loaded.keymap).toBe(DEFAULT_KEYMAP);
  });

  it("counts an absent action's keys: they are kept, so a key cannot be given to another action there", () => {
    const loaded = resolveKeymap({ "permission.tick": ["e"] });
    expect(loaded.problems).toEqual([expect.stringContaining("permission.rule.edit")]);
  });

  it("names every clash of a refused file in its one line", () => {
    const loaded = resolveKeymap({ "confirm.yes": ["n"], "pager.top": ["q"] });
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]).toContain("n is both confirm.yes and confirm.no in confirm");
    expect(loaded.problems[0]).toContain("q is both pager.top and pager.close in pager");
  });

  it("keeps the map in force, not the defaults, when a file is refused on a later read", () => {
    const first = resolveKeymap({ "app.help": ["Ctrl+X"] }).keymap;
    const refused = resolveKeymap({ "app.help": ["Ctrl+B"], "confirm.yes": ["n"] }, "keybindings.json", first);
    expect(refused.keymap).toBe(first);
    expect(refused.problems).toEqual([expect.stringContaining("the keys in force stand")]);
    expect(resolveKeymap([], "keybindings.json", first).keymap).toBe(first);
  });

  it("reads a file again against the defaults: what the new file leaves out is back to its default", () => {
    const first = resolveKeymap({ "app.help": ["Ctrl+X"] }).keymap;
    const second = resolveKeymap({ "confirm.yes": ["Y"] }, "keybindings.json", first).keymap;
    expect(second.keys["app.help"]).toEqual(["?"]);
    expect(second.keys["confirm.yes"]).toEqual(["Y"]);
  });

  it("keeps the map in force when the file cannot be read or is not JSON on a later read, and falls back to the defaults when it is gone", () => {
    const first = resolveKeymap({ "app.help": ["Ctrl+X"] }).keymap;
    expect(loadKeybindings(file("{"), { required: true }, first).keymap).toBe(first);
    expect(loadKeybindings(join(tmpdir(), "no-such-dir-agent-harness", "k.json"), { required: true }, first).keymap).toBe(first);
    expect(loadKeybindings(join(tmpdir(), "no-such-dir-agent-harness", "keybindings.json"), { required: false }, first).keymap).toBe(DEFAULT_KEYMAP);
  });
});

describe("suggestion key class (#251)", () => {
  it("dispatches each digit with its own name and detects a remapped digit clash", () => {
    const taken: string[] = [];
    for (const digit of ["1", "2", "3", "4"]) {
      expect(dispatch(DEFAULT_KEYMAP, ["composer"], { "composer.suggestion.take": (name) => void taken.push(name) }, digit, key())).toBe(true);
    }
    expect(taken).toEqual(["1", "2", "3", "4"]);
    expect(resolveKeymap({ "composer.editor": ["1"] }).problems.length).toBeGreaterThan(0);
  });
});

describe("dispatch through the action list", () => {
  it("finds the action a key is in each context in turn, and runs the first handler that takes it", () => {
    const ran: string[] = [];
    const handlers = { "app.interrupt": () => false as const, "picker.leave": () => void ran.push("picker.leave"), "pager.close": () => void ran.push("pager.close") };
    expect(dispatch(DEFAULT_KEYMAP, ["anywhere", "picker", "pager"], handlers, "", key({ escape: true }))).toBe(true);
    expect(ran).toEqual(["picker.leave"]);
  });

  it("answers nothing for a key no handler takes", () => {
    expect(dispatch(DEFAULT_KEYMAP, ["anywhere", "composer"], {}, "", key({ tab: true }))).toBe(false);
    expect(dispatch(DEFAULT_KEYMAP, ["confirm"], { "confirm.yes": () => undefined }, "x", key())).toBe(false);
  });

  it("follows the keymap in force: a remapped key runs its action and the old default no longer does", () => {
    const { keymap } = resolveKeymap({ "app.help": ["Ctrl+X"] });
    let opened = 0;
    const handlers = { "app.help": () => void opened++ };
    expect(dispatch(keymap, ["anywhere"], handlers, "?", key())).toBe(false);
    expect(dispatch(keymap, ["anywhere"], handlers, "x", key({ ctrl: true }))).toBe(true);
    expect(opened).toBe(1);
  });

  it("reads a move action's first key as up and its second as down", () => {
    const { keymap } = resolveKeymap({ "picker.moveVi": ["i", "m"] });
    expect(direction(keymap, "picker.moveVi", "i")).toBe(-1);
    expect(direction(keymap, "picker.moveVi", "m")).toBe(1);
    expect(direction(keymap, "picker.moveVi", "k")).toBe(0);
  });

  it("writes an action's keys for a hint line: a move pair together, alternatives with a slash", () => {
    expect(keysText(DEFAULT_KEYMAP, "picker.move")).toBe("↑↓");
    expect(keysText(DEFAULT_KEYMAP, "pager.close")).toBe("q/Esc");
    expect(keysText(resolveKeymap({ "picker.leave": ["q"] }).keymap, "picker.leave")).toBe("q");
  });
});

describe("key names that only some actions take", () => {
  it("refuses a class of keys for an action whose defaults are not that class, in one line, leaving its defaults", () => {
    const loaded = resolveKeymap({ "confirm.yes": ["Letters"] });
    expect(loaded.problems).toEqual([expect.stringMatching(/"Letters" is a class of keys.*; confirm\.yes has no key left; its default keys stand\.$/)]);
    expect(loaded.keymap.keys["confirm.yes"]).toEqual(["y"]);
    for (const written of ["1-4", ";;"]) expect(resolveKeymap({ "confirm.no": [written] }).keymap.keys["confirm.no"]).toEqual(["n", "Esc"]);
  });

  it("refuses keys pressed in turn for an action whose defaults are single presses, and ignores them beside a key that stands", () => {
    const loaded = resolveKeymap({ "confirm.no": ["Esc Esc", "q"] });
    expect(loaded.problems).toEqual([expect.stringContaining('"Esc Esc" is keys pressed in turn')]);
    expect(loaded.keymap.keys["confirm.no"]).toEqual(["q"]);
  });

  it("takes a class or keys pressed in turn where the defaults are one", () => {
    const loaded = resolveKeymap({ "app.prompt.back": ["Ctrl+X Ctrl+B"], "picker.filter": ["Letters"], "composer.suggestion.take": ["1-4"] });
    expect(loaded.problems).toEqual([]);
    expect(loaded.keymap.keys["app.prompt.back"]).toEqual(["Ctrl+X Ctrl+B"]);
  });

  it.each([
    ["Ctrl+I", "Tab"],
    ["Ctrl+M", "Enter"],
    ["Ctrl+H", "Backspace"],
    ["Ctrl+[", "Esc"],
  ])("refuses %s, which a terminal sends as the byte of %s, and says so", (written, as) => {
    const loaded = resolveKeymap({ "app.help": [written, "Ctrl+X"] });
    expect(loaded.problems).toEqual([expect.stringContaining(`"${written}" is sent as the byte of ${as}`)]);
    expect(loaded.keymap.keys["app.help"]).toEqual(["Ctrl+X"]);
  });
});

describe("what counts as remapped", () => {
  it("is only an action whose keys differ from its defaults", () => {
    const loaded = resolveKeymap({ "app.help": ["?"], "confirm.no": ["n", "Esc"], "confirm.yes": ["Y"] });
    expect([...loaded.keymap.remapped]).toEqual(["confirm.yes"]);
  });

  it("says a state directory with no file is the defaults", () => {
    const loaded = loadKeybindings(join(tmpdir(), "no-such-dir-agent-harness", "keybindings.json"), { required: false });
    expect(loaded.missing).toBe(true);
    expect(loadKeybindings(file("{}"), { required: false }).missing).toBeUndefined();
  });
});

describe("a conditioned action beside an unconditioned one on the same key (#231)", () => {
  const empty = (condition: string) => condition === "composer.empty";
  const never = () => false;

  it("asks the conditioned action first while its condition holds, and the key falls to the other when it declines", () => {
    const ran: string[] = [];
    const handlers = { "composer.withdrawLast": () => void ran.push("withdraw"), "composer.navigate": () => void ran.push("navigate") };
    expect(dispatch(DEFAULT_KEYMAP, ["composer"], handlers, "", key({ upArrow: true }), { holds: empty })).toBe(true);
    const declining = { ...handlers, "composer.withdrawLast": () => false as const };
    expect(dispatch(DEFAULT_KEYMAP, ["composer"], declining, "", key({ upArrow: true }), { holds: empty })).toBe(true);
    expect(ran).toEqual(["withdraw", "navigate"]);
  });

  it("never asks the conditioned action while its condition does not hold, nor when nobody says it does", () => {
    const ran: string[] = [];
    const handlers = { "composer.withdrawLast": () => void ran.push("withdraw"), "composer.navigate": () => void ran.push("navigate") };
    expect(dispatch(DEFAULT_KEYMAP, ["composer"], handlers, "", key({ upArrow: true }), { holds: never })).toBe(true);
    expect(dispatch(DEFAULT_KEYMAP, ["composer"], handlers, "", key({ upArrow: true }))).toBe(true);
    expect(ran).toEqual(["navigate", "navigate"]);
  });

  it("remaps the conditioned action apart from the other: its new key keeps the condition, and ↑ is navigate's alone", () => {
    const loaded = resolveKeymap({ "composer.withdrawLast": ["Alt+W"] });
    expect(loaded.problems).toEqual([]);
    expect(loaded.keymap.keys["composer.withdrawLast"]).toEqual(["Alt+W"]);
    expect(loaded.keymap.keys["composer.navigate"]).toEqual(["↑", "↓"]);
    expect([...loaded.keymap.remapped]).toEqual(["composer.withdrawLast"]);
    const ran: string[] = [];
    const handlers = { "composer.withdrawLast": () => void ran.push("withdraw"), "composer.navigate": () => void ran.push("navigate") };
    dispatch(loaded.keymap, ["composer"], handlers, "", key({ upArrow: true }), { holds: empty });
    dispatch(loaded.keymap, ["composer"], handlers, "w", key({ meta: true }), { holds: empty });
    dispatch(loaded.keymap, ["composer"], handlers, "w", key({ meta: true }), { holds: never });
    expect(ran).toEqual(["navigate", "withdraw"]);
  });

  it("remaps the unconditioned one apart too, leaving ↑ to the conditioned one alone", () => {
    const loaded = resolveKeymap({ "composer.navigate": ["Ctrl+P", "Ctrl+N"] });
    expect(loaded.problems).toEqual([]);
    expect(loaded.keymap.keys["composer.withdrawLast"]).toEqual(["↑"]);
  });

  it("still refuses a file that gives the key two unconditioned actions in one context, naming the clash", () => {
    const loaded = resolveKeymap({ "composer.send": ["Enter", "↑"] });
    expect(loaded.problems).toEqual([expect.stringMatching(/refused: ↑ is both composer\.(send and composer\.navigate|navigate and composer\.send) in composer/)]);
    expect(loaded.keymap).toBe(DEFAULT_KEYMAP);
  });
});

describe("dispatch with part of a context", () => {
  it("looks up only the actions `only` holds, or all but `except`'s", () => {
    const ran: string[] = [];
    const handlers = { "app.help": () => void ran.push("app.help"), "app.interruptOrQuit": () => void ran.push("quit") };
    expect(dispatch(DEFAULT_KEYMAP, [{ context: "anywhere", only: FIRST_ANYWHERE }], handlers, "?", key())).toBe(false);
    expect(dispatch(DEFAULT_KEYMAP, [{ context: "anywhere", only: FIRST_ANYWHERE }], handlers, "c", key({ ctrl: true }))).toBe(true);
    expect(dispatch(DEFAULT_KEYMAP, [{ context: "anywhere", except: FIRST_ANYWHERE }], handlers, "c", key({ ctrl: true }))).toBe(false);
    expect(dispatch(DEFAULT_KEYMAP, [{ context: "anywhere", except: FIRST_ANYWHERE }], handlers, "?", key())).toBe(true);
    expect(ran).toEqual(["quit", "app.help"]);
  });
});

describe("keys pressed in turn, as the screen hears them (#232)", () => {
  const at = (name: string, time: number, place = "none"): Press => ({ name, at: time, place });

  it("counts the press before in the same place, and a key pressed twice only within DOUBLE_PRESS_MS", () => {
    expect(pressedBefore(at("Esc", 1000), "Esc", 1000 + DOUBLE_PRESS_MS, "none")).toBe("Esc");
    expect(pressedBefore(at("Esc", 1000), "Esc", 1001 + DOUBLE_PRESS_MS, "none")).toBeUndefined();
    // Two different keys have no window: a backslash then Enter a while later is still `\ Enter`.
    expect(pressedBefore(at("\\", 1000), "Enter", 60_000, "none")).toBe("\\");
  });

  it("does not count the same key pressed again in another place: an Esc that closed a card, or left the transcript", () => {
    expect(pressedBefore(at("Esc", 1000, "card:help"), "Esc", 1010, "none")).toBeUndefined();
    expect(pressedBefore(at("Esc", 1000, "none"), "Esc", 1010, "none")).toBe("Esc");
    expect(pressedBefore(undefined, "Esc", 1010, "none")).toBeUndefined();
  });

  it("looks up only the keys pressed in turn with pairOnly, never the key alone again", () => {
    const ran: string[] = [];
    const handlers = { "app.prompt.back": () => false as const, "app.interrupt": () => void ran.push("interrupt") };
    expect(dispatch(DEFAULT_KEYMAP, ["anywhere"], handlers, "", key({ escape: true }), { previous: "Esc", pairOnly: true })).toBe(false);
    expect(ran).toEqual([]);
    expect(dispatch(DEFAULT_KEYMAP, ["anywhere"], handlers, "", key({ escape: true }), { previous: "Esc" })).toBe(true);
    expect(ran).toEqual(["interrupt"]);
  });

  it("counts keys in turn that differ wherever each was heard: a backslash, a question arriving, then Enter is still `\\ Enter`", () => {
    expect(pressedBefore(at("\\", 1000, "none composer"), "Enter", 60_000, "none question composer")).toBe("\\");
  });
});
