import { describe, expect, it } from "vitest";
import { REFERENCE_GUI_KEYMAP } from "../test/reference-gui-keymap.js";
import { REFERENCE_COMMANDS, REFERENCE_KEYMAP } from "../test/reference-keymap.js";
import {
  ACTIONS,
  ACTION_CONTEXTS,
  ACTION_GROUPS,
  ACTION_ID_PREFIXES,
  ACTION_CONDITIONS,
  Action,
  RUN_STOPPING_ACTIONS,
  SIGILS,
  SLASH_COMMANDS_TITLE,
  actionById,
  conditionWithin,
  isActionId,
  isCommandId,
  isGuiOnly,
  keyClashes,
  reservedGuiKey,
} from "./index.js";

/**
 * The shared action list (ADR 0004, the tui spec's "Shortcuts"; ADR 0017's
 * shortcut contract test). The fixture holds the reference keymap's rows and
 * commands entries as data; the list must carry every one with the same keys
 * and context, every command with the same usage line, claim no key twice in
 * one context, and name no id outside itself. The reference map's own
 * honesty checks carry as well.
 */

const commandName = (id: string) => id.slice("command.".length);
/** Each key more than one action holds in one context, as `<context> <key>` with the actions holding it. */
const sharedKeys = (actions: readonly { readonly id: string; readonly context: string; readonly keys: readonly string[] }[]): [string, string[]][] => {
  const holders = new Map<string, string[]>();
  for (const { id, context, keys } of actions) {
    for (const key of keys) {
      const slot = `${context} ${key}`;
      holders.set(slot, [...(holders.get(slot) ?? []), id]);
    }
  }
  return [...holders].filter(([, ids]) => ids.length > 1);
};
const commands = ACTIONS.filter((a) => a.id.startsWith("command."));
const keyActions = ACTIONS.filter((a) => !a.id.startsWith("command."));
/** The pressed actions with a terminal column: every one but those only the GUI answers. */
const terminalKeyActions = keyActions.filter((a) => a.keys.length > 0);

/** The actions the harness adds to the reference rows, with their chosen defaults (the tui spec's list under the table). */
const ADDED_KEYS: Record<string, readonly string[]> = {
  "app.runInfo.toggle": ["Alt+I"],
  "composer.readNow": ["Ctrl+Enter"],
  "composer.withdrawLast": ["↑"],
  "row.rewind": ["w"],
  "row.fork": ["f"],
  "row.rewindUndo": ["u"],
  "row.checkFailure.send": ["s"],
  "picker.branch": ["b"],
  "picker.hide": ["Ctrl+D"],
  "rail.settle": ["s"],
  "rail.snooze": ["z"],
  "rail.tag": ["t"],
  "rail.group": ["g"],
  "rail.moveUp": ["Shift+↑"],
  "rail.moveDown": ["Shift+↓"],
  // A merged group's heading renamed or deleted, one command per member group (#752): the window's heading has its context menu.
  "rail.renameGroup": ["R"],
  "rail.deleteGroup": ["D"],
  "terminal.leave": ["Ctrl+\\"],
  "terminal.scrollback": ["Ctrl+O"],
  "asks.move": ["↑", "↓"],
  "asks.open": ["Enter"],
  "asks.allow": ["y"],
  "asks.deny": ["n"],
  "asks.allowAll": ["a"],
  "asks.denyAll": ["N"],
  "asks.close": ["Esc"],
  "confirm.yes": ["y"],
  "confirm.no": ["n", "Esc"],
  // A file or document read in the pager is copied whole (#427): the pager has the keys, so a typed `/copy` would be its search.
  "pager.copy": ["y"],
  // The routines card's row verbs (#533), and its webhook endpoints' (David, 2026-09-28): Enter, the moves and Esc are the picker's.
  "routines.runNow": ["r"],
  "routines.enable": ["Space"],
  "routines.move": ["m"],
  "routines.history": ["h"],
  "routines.export": ["x"],
  "routines.edit": ["e"],
  "routines.endpoint.add": ["a"],
  "routines.endpoint.test": ["t"],
  "routines.endpoint.remove": ["d"],
};

/** The slash commands the harness adds (the tui spec's "The composer"), and the one rename. */
const ADDED_COMMANDS = [
  "browser",
  "account",
  "environment",
  "pair",
  "containment",
  "setup",
  "settings",
  "review",
  "archive",
  "group",
  "tag",
  "settle",
  "snooze",
  "restore",
  "search",
  "terminal",
  "files",
  "documents",
  "trust",
  "notices",
  "reload",
  "fork",
  "rewind",
  "routines",
];

describe("the fixture rule", () => {
  it("gives every row of the reference keymap one action with the same keys and context, described in the fixture's own words", () => {
    const rows = REFERENCE_KEYMAP.flatMap((group) => group.rows.map((row) => ({ context: group.context, ...row })));
    expect(rows).toHaveLength(98);
    const missing: string[] = [];
    for (const row of rows) {
      const matches = keyActions.filter((a) => a.context === row.context && JSON.stringify(a.keys) === JSON.stringify(row.keys));
      if (matches.length !== 1) missing.push(`${row.context} ${row.keys.join(", ")}: ${matches.length} actions`);
      else expect(matches[0]?.description, `${row.context} ${row.keys.join(", ")}`).toBe(row.does);
    }
    expect(missing).toEqual([]);
  });

  it("gives every entry of the reference commands its command.<name> with the same usage line", () => {
    expect(REFERENCE_COMMANDS).toHaveLength(22);
    for (const entry of REFERENCE_COMMANDS) {
      const action = actionById(`command.${entry.name}`);
      expect(action, entry.name).toBeDefined();
      expect(action?.usage, entry.name).toBe(entry.usage);
      expect(action?.description, entry.name).toBe(entry.summary);
    }
  });

  it("lets no two actions in one context share a default key, but for a conditioned action beside an unconditioned one", () => {
    expect(keyClashes(ACTIONS)).toEqual([]);
    // The one key two actions hold in one context: ↑ in the composer, withdrawLast asked first while the composer is empty.
    expect(sharedKeys(ACTIONS)).toEqual([["composer ↑", ["composer.navigate", "composer.withdrawLast"]]]);
  });

  it("names no id outside the list: each id once, and every group, alias and sigil names ids of the list", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of ACTION_GROUPS) for (const a of g.actions) expect(isActionId(a.id), a.id).toBe(true);
    for (const a of ACTIONS) if (a.aliasOf !== undefined) expect(isActionId(a.aliasOf), `${a.id} aliases ${a.aliasOf}`).toBe(true);
    for (const trigger of Object.values(SIGILS)) if (trigger !== null) expect(isActionId(trigger), trigger).toBe(true);
    expect(isActionId("rail.fly")).toBe(false);
  });

  it("holds the reference rows, the harness's added keys and the slash commands, and nothing else", () => {
    const fixtureRows = REFERENCE_KEYMAP.flatMap((g) => g.rows.map((row) => `${g.context} ${JSON.stringify(row.keys)}`));
    const extra = terminalKeyActions.filter((a) => !fixtureRows.includes(`${a.context} ${JSON.stringify(a.keys)}`)).map((a) => a.id);
    expect(extra.sort()).toEqual(Object.keys(ADDED_KEYS).sort());
    for (const [id, keys] of Object.entries(ADDED_KEYS)) expect(actionById(id)?.keys, id).toEqual(keys);
    expect(commands.map((a) => commandName(a.id)).sort()).toEqual([...REFERENCE_COMMANDS.map((c) => c.name), ...ADDED_COMMANDS].sort());
  });
});

describe("the action list's shape", () => {
  it("parses every entry with the Action schema", () => {
    for (const action of ACTIONS) expect(Action.safeParse(action).success, action.id).toBe(true);
  });

  it("refuses an entry whose fields disagree: an id's prefix and its context, keys and usage on the wrong kind", () => {
    const pin = { id: "rail.pin", context: "sidebar", keys: ["p"], description: "Pin it", status: "wired", gui: { status: "absent", reason: "The context menu." } } as const;
    const help = { id: "command.help", context: "composer", keys: [], description: "List these commands", usage: "/help", status: "wired", gui: { status: "wired", keys: [] } } as const;
    expect(Action.safeParse(pin).success).toBe(true);
    expect(Action.safeParse(help).success).toBe(true);
    const refused = [
      { ...pin, context: "transcript" },
      { ...pin, id: "row.pin" },
      { ...pin, keys: [] },
      { ...pin, usage: "/pin" },
      { ...pin, aliasOf: "rail.archive" },
      { ...help, keys: ["F1"] },
      { ...help, usage: undefined },
      { ...help, usage: "/quit" },
      { ...help, context: "anywhere" },
      { ...pin, gui: undefined },
    ];
    for (const entry of refused) expect(Action.safeParse(entry).success, JSON.stringify(entry)).toBe(false);
  });

  it("has twelve contexts: the reference keymap's eight, the terminal pane, the parked asks, the yes or no offers and the routines card", () => {
    expect([...ACTION_CONTEXTS].sort()).toEqual(
      ["anywhere", "composer", "transcript", "sidebar", "delegated", "picker", "permission", "pager", "terminal", "asks", "confirm", "routines"].sort(),
    );
    expect(new Set(ACTIONS.map((a) => a.context))).toEqual(new Set(ACTION_CONTEXTS));
  });

  it("names each action <context>.<verb>, row for the transcript, rail for the sidebar, app for anywhere, command for a slash command", () => {
    expect(ACTION_ID_PREFIXES).toMatchObject({ row: "transcript", rail: "sidebar", app: "anywhere", command: "composer" });
    for (const action of ACTIONS) {
      const prefix = action.id.slice(0, action.id.indexOf(".")) as keyof typeof ACTION_ID_PREFIXES;
      expect(ACTION_ID_PREFIXES[prefix], action.id).toBe(action.context);
    }
  });

  it("gives a slash command a usage line and no key, and every other action a terminal key, unless only the GUI answers it, and no usage line", () => {
    for (const action of commands) {
      expect(action.keys, action.id).toEqual([]);
      expect(action.usage?.startsWith(`/${commandName(action.id)}`), action.id).toBe(true);
      expect(isCommandId(action.id)).toBe(true);
      expect(isGuiOnly(action), action.id).toBe(false);
    }
    for (const action of keyActions) {
      if (!isGuiOnly(action)) expect(action.keys.length, action.id).toBeGreaterThan(0);
      expect(action.usage, action.id).toBeUndefined();
      expect(isCommandId(action.id)).toBe(false);
    }
  });

  it("keeps the rows the harness lacks as absent with their reason, and wires the rest", () => {
    const absent = ACTIONS.filter((a) => a.status === "absent" && !isGuiOnly(a));
    expect(absent.map((a) => a.id)).toEqual(["permission.rule.edit", "permission.scope.walk"]);
    for (const a of absent) expect(a.status === "absent" && a.reason.length > 0, a.id).toBe(true);
    expect(actionById("permission.rule.edit")?.keys).toEqual(["e"]);
    expect(actionById("permission.scope.walk")?.keys).toEqual(["s"]);
  });

  it("keeps /profile as a hidden alias of /account", () => {
    expect(actionById("command.profile")).toMatchObject({ usage: "/profile", aliasOf: "command.account", status: "wired" });
    expect(actionById("command.account")).toMatchObject({ usage: "/account" });
    expect(ACTIONS.filter((a) => a.aliasOf !== undefined).map((a) => a.id)).toEqual(["command.profile"]);
  });

  it("treats the composer's sigils as syntax: only their menu triggers are actions, each on its sigil", () => {
    expect(Object.keys(SIGILS).sort()).toEqual(["!", "!!", ";;", "/", "@"].sort());
    for (const [sigil, trigger] of Object.entries(SIGILS)) {
      if (trigger === null) continue;
      expect(actionById(trigger)).toMatchObject({ context: "composer", keys: [sigil] });
    }
    // `!!` is `!`'s row, not a key of its own.
    expect(ACTIONS.some((a) => a.keys.includes("!!"))).toBe(false);
  });
});

describe("the clash rule", () => {
  const navigate = { id: "composer.navigate", context: "composer", keys: ["↑", "↓"] } as const;
  const withdraw = { id: "composer.withdrawLast", context: "composer", keys: ["↑"], when: "composer.empty" } as const;

  it("admits a conditioned action beside an unconditioned one on the same key in one context", () => {
    expect(keyClashes([navigate, withdraw])).toEqual([]);
    expect(keyClashes([withdraw, navigate])).toEqual([]);
  });

  it("refuses two unconditioned actions on one key in one context, naming the key, the context and both", () => {
    expect(keyClashes([navigate, { id: "composer.send", context: "composer", keys: ["Enter", "↓"] }])).toEqual([
      { context: "composer", key: "↓", ids: ["composer.navigate", "composer.send"] },
    ]);
  });

  it("refuses two conditioned actions on one key in one context, since both conditions may hold at once", () => {
    expect(keyClashes([withdraw, { ...withdraw, id: "composer.readNow" }])).toEqual([{ context: "composer", key: "↑", ids: ["composer.withdrawLast", "composer.readNow"] }]);
  });

  it("lets one key mean one action in each of two contexts, and an action repeat its own key", () => {
    expect(keyClashes([navigate, { id: "transcript.cursor", context: "transcript", keys: ["↑", "↓"] }])).toEqual([]);
    expect(keyClashes([{ ...navigate, keys: ["↑", "↑"] }])).toEqual([]);
  });

  it("admits two conditioned actions on one key when one condition lies within the other, the narrower asked first: ↑ in an empty composer, then from the start of the box", () => {
    const atStart = { ...navigate, when: "composer.atStart" } as const;
    expect(ACTION_CONDITIONS["composer.empty"].within).toBe("composer.atStart");
    expect(conditionWithin("composer.empty", "composer.atStart")).toBe(true);
    expect(conditionWithin("composer.atStart", "composer.empty")).toBe(false);
    expect(conditionWithin("composer.atStart", undefined)).toBe(true);
    expect(keyClashes([atStart, withdraw])).toEqual([]);
    expect(keyClashes([withdraw, atStart, { id: "composer.recall", context: "composer", keys: ["↑"] }])).toEqual([]);
    // Two holders under one condition still clash, however wide it is.
    expect(keyClashes([atStart, { ...atStart, id: "composer.recall", keys: ["↑"] }])).toEqual([{ context: "composer", key: "↑", ids: ["composer.navigate", "composer.recall"] }]);
  });

  it("refuses two conditioned actions whose conditions neither lies within the other", () => {
    const back = { id: "picker.back", context: "picker", keys: ["Backspace"], when: "picker.queryEmpty" } as const;
    expect(keyClashes([back, { id: "picker.erase", context: "picker", keys: ["Backspace"], when: "picker.queryEmpty" }])).toHaveLength(1);
    expect(conditionWithin("picker.queryEmpty", "composer.empty")).toBe(false);
  });
});

/** The GUI column's keys as the clash rule reads them: the wired actions', with their GUI conditions, `off` keys counted. */
const guiBindings = (actions: readonly Action[]) =>
  actions.flatMap((a) => (a.gui.status === "wired" ? [{ id: a.id, context: a.context, keys: a.gui.keys, when: a.gui.when }] : []));

describe("the clash rule, column by column", () => {
  it("finds no clash in either column's defaults", () => {
    expect(keyClashes(ACTIONS)).toEqual([]);
    expect(keyClashes(guiBindings(ACTIONS))).toEqual([]);
  });

  it("shares keys in the GUI column only where a condition sets them apart: ↑ and Enter, Shift+Enter and Esc of the find bar, the composer's and the palette's", () => {
    expect(sharedKeys(guiBindings(ACTIONS))).toEqual([["composer ↑", ["composer.navigate", "composer.withdrawLast"]]]);
    // Keys that mean one thing in the terminal and another in the GUI are no clash: each column is checked on its own.
    expect(actionById("app.interruptOrQuit")?.keys).toEqual(["Ctrl+C"]);
    expect(guiBindings(ACTIONS).some((b) => b.keys.includes("Ctrl+C"))).toBe(false);
  });

  it("counts a key written off: turned on, app.interrupt's Esc must not clash", () => {
    expect(keyClashes([...guiBindings(ACTIONS), { id: "app.palette", context: "anywhere", keys: ["Esc"], when: undefined }])).toEqual([
      { context: "anywhere", key: "Esc", ids: ["app.interrupt", "app.palette"] },
    ]);
  });

  it("refuses a GUI remap that gives the composer's ↑ to a third action under the same condition", () => {
    const remapped = [...guiBindings(ACTIONS), { id: "composer.complete", context: "composer", keys: ["↑"], when: "composer.atStart" as const }];
    expect(keyClashes(remapped)).toEqual([{ context: "composer", key: "↑", ids: ["composer.navigate", "composer.complete"] }]);
  });
});

describe("conditions", () => {
  it("carries composer.withdrawLast on ↑ while the composer is empty, beside composer.navigate on the same key", () => {
    expect(actionById("composer.withdrawLast")).toMatchObject({ context: "composer", keys: ["↑"], when: "composer.empty", status: "wired" });
    expect(actionById("composer.navigate")?.when).toBeUndefined();
  });

  it("names every condition an action declares, each with the words the help overlay writes after the keys", () => {
    for (const action of ACTIONS) if (action.when !== undefined) expect(Object.keys(ACTION_CONDITIONS), action.id).toContain(action.when);
    expect(ACTION_CONDITIONS["composer.empty"]).toMatchObject({ context: "composer", words: "empty composer" });
  });

  it("refuses a condition on a slash command, one of another context, and one the list does not name", () => {
    const pressed = {
      id: "composer.withdrawLast",
      context: "composer",
      keys: ["↑"],
      description: "Take it back",
      status: "wired",
      when: "composer.empty",
      gui: { status: "wired", keys: ["↑"], when: "composer.empty" },
    } as const;
    expect(Action.safeParse(pressed).success).toBe(true);
    const refused = [
      { id: "command.help", context: "composer", keys: [], description: "List these commands", usage: "/help", status: "wired", when: "composer.empty", gui: { status: "wired", keys: [] } },
      { ...pressed, id: "row.fork", context: "transcript", gui: { status: "wired", keys: ["↑"] } },
      { ...pressed, when: "composer.full" },
      { ...pressed, gui: { status: "wired", keys: ["↑"], when: "picker.queryEmpty" } },
    ];
    for (const entry of refused) expect(Action.safeParse(entry).success, JSON.stringify(entry)).toBe(false);
  });
});

/** The GUI keys of the actions both clients answer, as the GUI spec's table writes them ("Keyboard: the GUI column"), with the condition each is answered under. */
const GUI_KEYS_OF_SHARED: Record<string, { readonly keys: readonly string[]; readonly when?: string; readonly off?: true }> = {
  "app.runInfo.toggle": { keys: ["Mod+I"] },
  "app.interrupt": { keys: ["Esc"], off: true },
  "composer.send": { keys: ["Enter"] },
  "composer.newline": { keys: ["Shift+Enter"] },
  "composer.navigate": { keys: ["↑", "↓"], when: "composer.atStart" },
  "composer.withdrawLast": { keys: ["↑"], when: "composer.empty" },
  "composer.complete": { keys: ["Tab"] },
  "composer.command.menu": { keys: ["/"] },
  "composer.file.mention": { keys: ["@"] },
  // Not in the spec's table, but the GUI spec's composer runs `!` and `!!` as the terminal UI does (#409): a decision of this build.
  "composer.shell": { keys: ["!"] },
  "composer.paste": { keys: ["Mod+V"] },
  "composer.readNow": { keys: [] },
  "permission.deny": { keys: ["Esc"] },
  "picker.move": { keys: ["↑", "↓"] },
  "picker.choose": { keys: ["Enter"] },
  "picker.leave": { keys: ["Esc"] },
};

/** The actions only the GUI answers, with the GUI keys the spec's table gives them. */
const GUI_ONLY_KEYS: Record<string, { readonly keys: readonly string[]; readonly when?: string }> = {
  "app.zoom.in": { keys: ["Mod++", "Mod+=", "Mod+Shift+="] },
  "app.zoom.out": { keys: ["Mod+-"] },
  "app.zoom.reset": { keys: ["Mod+0"] },
  "app.palette": { keys: ["Mod+K"] },
  "app.find": { keys: ["Mod+F"] },
  "app.session.new": { keys: ["Mod+N"] },
  "app.session.newInPane": { keys: ["Mod+Shift+N"] },
  "app.sidebar.toggle": { keys: ["Mod+B"] },
  "app.terminal.toggle": { keys: ["Mod+J"] },
  "app.browser.choose": { keys: [] },
  "app.browser.pair": { keys: [] },
  "app.browser.unpair": { keys: [] },
  "app.browser.allowRuns": { keys: [] },
  "app.browser.default": { keys: [] },
  "app.browser.toggle": { keys: ["Mod+Shift+B"] },
  "app.pane.splitRight": { keys: ["Mod+\\"] },
  "app.pane.splitDown": { keys: ["Mod+Shift+\\"] },
  "app.settings.toggle": { keys: ["Mod+,"] },
  "permission.allow": { keys: ["Mod+Enter"] },
  "picker.back": { keys: ["Backspace"], when: "picker.queryEmpty" },
  "transcript.findNext": { keys: ["Enter"], when: "transcript.finding" },
  "transcript.findPrevious": { keys: ["Shift+Enter"], when: "transcript.finding" },
  "transcript.findClose": { keys: ["Esc"], when: "transcript.finding" },
};

/** The slash commands the GUI leaves absent: neither a session verb nor a GUI surface, or deferred as in the terminal. */
const GUI_ABSENT_COMMANDS = ["command.timeline", "command.snip", "command.quit", "command.reload", "command.trust"];

describe("the GUI column", () => {
  const wired = (id: string) => {
    const gui = actionById(id)?.gui;
    return gui?.status === "wired" ? gui : undefined;
  };

  it("gives every action a GUI column: wired with its keys, or absent with a reason", () => {
    for (const action of ACTIONS) {
      if (action.gui.status === "wired") expect(Array.isArray(action.gui.keys), action.id).toBe(true);
      else expect(action.gui.reason.trim(), action.id).not.toBe("");
    }
  });

  it("gives the actions both clients answer the GUI keys the spec's table writes, each with its condition, and app.interrupt's Esc off", () => {
    for (const [id, expected] of Object.entries(GUI_KEYS_OF_SHARED)) {
      expect(wired(id), id).toEqual({ status: "wired", ...expected });
      expect(actionById(id)?.keys.length, id).toBeGreaterThan(0);
    }
  });

  it("adds the actions only the GUI answers with an empty terminal column, which is absent, and the spec's GUI keys", () => {
    for (const [id, expected] of Object.entries(GUI_ONLY_KEYS)) {
      const action = actionById(id);
      expect(action, id).toMatchObject({ keys: [], status: "absent" });
      expect(action?.when, id).toBeUndefined();
      expect(isGuiOnly(action!), id).toBe(true);
      expect(wired(id), id).toEqual({ status: "wired", ...expected });
    }
    expect(ACTIONS.filter(isGuiOnly).map((a) => a.id).sort()).toEqual(Object.keys(GUI_ONLY_KEYS).sort());
  });

  it("keeps every other pressed action absent in the GUI with its reason, app.interruptOrQuit's naming ADR 0022", () => {
    const wiredPressed = keyActions.filter((a) => a.gui.status === "wired").map((a) => a.id);
    expect(wiredPressed.sort()).toEqual([...Object.keys(GUI_KEYS_OF_SHARED), ...Object.keys(GUI_ONLY_KEYS)].sort());
    const quit = actionById("app.interruptOrQuit")?.gui;
    expect(quit?.status === "absent" && quit.reason).toMatch(/ADR 0022/);
    expect(quit?.status === "absent" && quit.reason).toMatch(/Ctrl\+C copies/);
  });

  it("wires every slash command that names a session verb or opens a GUI surface, and keeps /quit, /reload and the rest absent with their reasons", () => {
    const absent = commands.filter((a) => a.gui.status === "absent").map((a) => a.id);
    expect(absent.sort()).toEqual([...GUI_ABSENT_COMMANDS].sort());
    for (const action of commands) if (action.gui.status === "wired") expect(action.gui, action.id).toEqual({ status: "wired", keys: [] });
  });

  it("holds a pressed action's terminal key for the terminal column only: a GUI action wired with no key is valid, and an empty terminal column is the GUI's alone", () => {
    const palette = { id: "app.palette", context: "anywhere", keys: [], description: "Open the command palette", status: "absent", reason: "Only the GUI.", gui: { status: "wired", keys: ["Mod+K"] } } as const;
    const readNow = { id: "composer.readNow", context: "composer", keys: ["Ctrl+Enter"], description: "Read it now", status: "wired", gui: { status: "wired", keys: [] } } as const;
    expect(Action.safeParse(palette).success).toBe(true);
    expect(Action.safeParse(readNow).success).toBe(true);
    const refused = [
      // An empty terminal column is absent, has no condition, and the GUI answers the action.
      { ...palette, status: "wired", reason: undefined },
      { ...palette, gui: { status: "absent", reason: "Nobody answers it." } },
      { ...palette, id: "composer.palette", context: "composer", when: "composer.empty" },
      // A slash command is typed in the GUI too; off marks keys; a GUI condition is one of the action's context.
      { id: "command.help", context: "composer", keys: [], description: "List these commands", usage: "/help", status: "wired", gui: { status: "wired", keys: ["F1"] } },
      { ...readNow, gui: { status: "wired", keys: [], off: true } },
      { ...readNow, gui: { status: "wired", keys: ["Mod+Enter"], when: "transcript.finding" } },
      { ...readNow, gui: { status: "absent" } },
      { ...readNow, gui: { status: "wired", keys: ["Mod+Enter"], off: false } },
    ];
    for (const entry of refused) expect(Action.safeParse(entry).success, JSON.stringify(entry)).toBe(false);
  });

  it("names the conditions the GUI keys are answered under, each with the words its table writes after the keys", () => {
    expect(ACTION_CONDITIONS["composer.atStart"]).toMatchObject({ context: "composer", words: "from the start of the box" });
    expect(ACTION_CONDITIONS["picker.queryEmpty"]).toMatchObject({ context: "picker", words: "empty query" });
    expect(ACTION_CONDITIONS["transcript.finding"]).toMatchObject({ context: "transcript", words: "find bar" });
    for (const action of ACTIONS) if (action.gui.status === "wired" && action.gui.when !== undefined) expect(ACTION_CONDITIONS[action.gui.when].context, action.id).toBe(action.context);
  });

  it("leaves the terminal fields as they were: the reference rows and the harness's added keys keep their keys, conditions and status", () => {
    expect(actionById("app.interrupt")).toMatchObject({ keys: ["Esc"], status: "wired" });
    expect(actionById("app.interruptOrQuit")).toMatchObject({ keys: ["Ctrl+C"], status: "wired" });
    expect(actionById("composer.withdrawLast")).toMatchObject({ keys: ["↑"], when: "composer.empty", status: "wired" });
    expect(actionById("composer.navigate")?.when).toBeUndefined();
  });
});

describe("the reference map's honesty checks", () => {
  it("gives every group a title and rows, names each group once, and puts every action in its group's context", () => {
    expect(ACTION_GROUPS.length).toBeGreaterThan(0);
    const titles = ACTION_GROUPS.map((g) => g.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const g of ACTION_GROUPS) {
      expect(g.title.trim(), g.title).not.toBe("");
      expect(g.actions.length, g.title).toBeGreaterThan(0);
      for (const a of g.actions) {
        expect(a.context, a.id).toBe(g.context);
        expect(a.description.trim(), a.id).not.toBe("");
        for (const k of a.keys) expect(k.trim(), a.id).not.toBe("");
      }
    }
  });

  it("keeps the reference keymap's groups, with their titles and contexts, in its order", () => {
    const carried = ACTION_GROUPS.filter((g) => REFERENCE_KEYMAP.some((a) => a.title === g.title));
    expect(carried.map((g) => [g.title, g.context])).toEqual(REFERENCE_KEYMAP.map((g) => [g.title, g.context]));
  });

  it("echoes the slash commands from the list: the last group is every command, in the list's order", () => {
    const last = ACTION_GROUPS.at(-1);
    expect(last?.title).toBe(SLASH_COMMANDS_TITLE);
    expect(last?.context).toBe("composer");
    expect(last?.actions.map((a) => a.id)).toEqual(commands.map((a) => a.id));
    // The reference commands first, in their order; the harness's after them.
    expect(commands.slice(0, REFERENCE_COMMANDS.length).map((a) => commandName(a.id))).toEqual(REFERENCE_COMMANDS.map((c) => c.name));
  });
});

describe("the GUI's reserved keys (ADR 0022; the GUI spec's binding rules)", () => {
  it("refuses Ctrl+C and Mod+C for app.interrupt and every action that stops a run, saying Ctrl+C is copy", () => {
    expect([...RUN_STOPPING_ACTIONS].sort()).toEqual(["app.interrupt", "app.interruptOrQuit", "composer.readNow"]);
    for (const id of RUN_STOPPING_ACTIONS) {
      for (const k of ["Ctrl+C", "Mod+C", "ctrl+c", "mod+c"]) expect(reservedGuiKey(id, k), `${id} ${k}`).toMatch(/never stops a run/);
    }
    expect(reservedGuiKey("app.interrupt", "Esc")).toBeUndefined();
    expect(reservedGuiKey("app.interrupt", "Mod+.")).toBeUndefined();
  });

  it("refuses Mod+C, Mod+X, Mod+A and Mod+Z for every action, a text field's copy, cut, select-all and undo", () => {
    for (const action of ACTIONS) {
      for (const k of ["Mod+C", "Mod+X", "Mod+A", "Mod+Z"]) expect(reservedGuiKey(action.id, k), `${action.id} ${k}`).toBeDefined();
    }
    expect(reservedGuiKey("app.palette", "Mod+X")).toMatch(/cuts/);
    expect(reservedGuiKey("app.palette", "Mod+A")).toMatch(/selects all/);
    expect(reservedGuiKey("app.palette", "Mod+Z")).toMatch(/undoes/);
    expect(reservedGuiKey("app.palette", "Mod+C")).toMatch(/copies/);
  });

  it("refuses Mod+V for all but composer.paste", () => {
    expect(reservedGuiKey("composer.paste", "Mod+V")).toBeUndefined();
    expect(reservedGuiKey("app.palette", "Mod+V")).toMatch(/pastes/);
    expect(reservedGuiKey("composer.send", "mod+v")).toMatch(/pastes/);
  });

  it("leaves every other key free: a chord with another modifier, Ctrl+C on an action that stops nothing, and the defaults", () => {
    expect(reservedGuiKey("app.palette", "Mod+Shift+C")).toBeUndefined();
    expect(reservedGuiKey("app.palette", "Ctrl+C")).toBeUndefined();
    expect(reservedGuiKey("app.palette", "Alt+X")).toBeUndefined();
    expect(reservedGuiKey("app.palette", "C")).toBeUndefined();
    for (const action of ACTIONS) if (action.gui.status === "wired") for (const k of action.gui.keys) expect(reservedGuiKey(action.id, k), `${action.id} ${k}`).toBeUndefined();
  });
});

/**
 * The GUI keys the GUI spec's table gives that the reference GUI map has no
 * row for, each with where it comes from; `composer.readNow` is wired with
 * no key, so no key of it is here.
 */
const ADDED_GUI_KEYS: Record<string, readonly string[]> = {
  // Desktop zoom owns these shortcuts on every platform (#1621).
  "app.zoom.in": ["Mod++", "Mod+=", "Mod+Shift+="],
  "app.zoom.out": ["Mod+-"],
  "app.zoom.reset": ["Mod+0"],
  // Story 28, added at David's request on 2026-09-28: a new session never covers one open in the grid.
  "app.session.newInPane": ["Mod+Shift+N"],
  // The GUI spec's composer: `@` lists files, as in the terminal UI (#400).
  "composer.file.mention": ["@"],
  // ADR 0022: ↑ in an empty composer withdraws the newest queued message, as in the terminal UI.
  "composer.withdrawLast": ["↑"],
  // The GUI spec's composer runs `!` and `!!` as the terminal UI does (#409); a decision of this build, the table not listing it.
  "composer.shell": ["!"],
};

describe("the GUI column against the GUI map the surfaces port audit pins", () => {
  const rows = REFERENCE_GUI_KEYMAP.flatMap((group) => group.rows.map((row) => ({ context: group.context, ...row })));
  const guiKeyed = ACTIONS.flatMap((a) => (a.gui.status === "wired" && a.gui.keys.length > 0 ? [{ action: a, gui: a.gui }] : []));
  const holding = (row: (typeof rows)[number]) => guiKeyed.filter(({ action, gui }) => action.context === row.context && JSON.stringify(gui.keys) === JSON.stringify(row.keys));

  it("gives every row of the reference GUI map one action wired with the same keys in its context, app.interrupt's Esc off the one recorded difference", () => {
    expect(rows).toHaveLength(26);
    const missing = rows.filter((row) => holding(row).length !== 1).map((row) => `${row.context} ${row.keys.join(", ")}: ${holding(row).length} actions`);
    expect(missing).toEqual([]);
    const differing = rows.flatMap((row) => holding(row).filter(({ gui }) => gui.off === true)).map(({ action }) => action.id);
    expect(differing).toEqual(["app.interrupt"]);
    expect(actionById("app.interrupt")?.gui).toEqual({ status: "wired", keys: ["Esc"], off: true });
  });

  it("puts a condition on the GUI keys of each row the reference answers only in part of its place, and on no other row's", () => {
    for (const row of rows) {
      const [held] = holding(row);
      expect(held?.gui.when !== undefined, `${row.context} ${row.keys.join(", ")}`).toBe(row.where !== undefined);
    }
  });

  it("holds the reference map's rows and the keys the GUI spec adds, and no other GUI key", () => {
    const fixtureRows = rows.map((row) => `${row.context} ${JSON.stringify(row.keys)}`);
    const extra = guiKeyed.filter(({ action, gui }) => !fixtureRows.includes(`${action.context} ${JSON.stringify(gui.keys)}`)).map(({ action }) => action.id);
    expect(extra.sort()).toEqual(Object.keys(ADDED_GUI_KEYS).sort());
    for (const [id, keys] of Object.entries(ADDED_GUI_KEYS)) expect(actionById(id)?.gui, id).toMatchObject({ status: "wired", keys });
  });
});
