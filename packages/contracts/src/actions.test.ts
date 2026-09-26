import { describe, expect, it } from "vitest";
import { ARTEMIS_COMMANDS, ARTEMIS_KEYMAP } from "../test/artemis-keymap.js";
import {
  ACTIONS,
  ACTION_CONTEXTS,
  ACTION_GROUPS,
  ACTION_ID_PREFIXES,
  ACTION_CONDITIONS,
  Action,
  SIGILS,
  SLASH_COMMANDS_TITLE,
  actionById,
  isActionId,
  isCommandId,
  keyClashes,
} from "./index.js";

/**
 * The shared action list (ADR 0004, the tui spec's "Shortcuts"; ADR 0017's
 * shortcut contract test). The fixture holds Artemis's `KEYMAP` rows and
 * `COMMANDS` entries at 443cf2e as data; the list must carry every one with
 * the same keys and context, every command with the same usage line, claim
 * no key twice in one context, and name no id outside itself. Artemis's own
 * honesty checks on its map carry as well.
 */

const commandName = (id: string) => id.slice("command.".length);
const commands = ACTIONS.filter((a) => a.id.startsWith("command."));
const keyActions = ACTIONS.filter((a) => !a.id.startsWith("command."));

/** The actions the harness adds to Artemis's rows, with their chosen defaults (the tui spec's list under the table). */
const ADDED_KEYS: Record<string, readonly string[]> = {
  "composer.readNow": ["Ctrl+Enter"],
  "composer.withdrawLast": ["↑"],
  "row.rewind": ["w"],
  "row.fork": ["f"],
  "row.rewindUndo": ["u"],
  "picker.branch": ["b"],
  "rail.settle": ["s"],
  "rail.snooze": ["z"],
  "rail.tag": ["t"],
  "rail.group": ["g"],
  "rail.moveUp": ["Shift+↑"],
  "rail.moveDown": ["Shift+↓"],
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
};

/** The slash commands the harness adds (the tui spec's "The composer"), and the one rename. */
const ADDED_COMMANDS = [
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
  "notices",
  "reload",
  "fork",
  "rewind",
];

describe("the fixture rule", () => {
  it("gives every row of Artemis's KEYMAP one action with the same keys and context, described in Artemis's words", () => {
    const rows = ARTEMIS_KEYMAP.flatMap((group) => group.rows.map((row) => ({ context: group.context, ...row })));
    expect(rows).toHaveLength(98);
    const missing: string[] = [];
    for (const row of rows) {
      const matches = keyActions.filter((a) => a.context === row.context && JSON.stringify(a.keys) === JSON.stringify(row.keys));
      if (matches.length !== 1) missing.push(`${row.context} ${row.keys.join(", ")}: ${matches.length} actions`);
      else expect(matches[0]?.description, `${row.context} ${row.keys.join(", ")}`).toBe(row.does);
    }
    expect(missing).toEqual([]);
  });

  it("gives every entry of Artemis's COMMANDS its command.<name> with the same usage line", () => {
    expect(ARTEMIS_COMMANDS).toHaveLength(22);
    for (const entry of ARTEMIS_COMMANDS) {
      const action = actionById(`command.${entry.name}`);
      expect(action, entry.name).toBeDefined();
      expect(action?.usage, entry.name).toBe(entry.usage);
      expect(action?.description, entry.name).toBe(entry.summary);
    }
  });

  it("lets no two actions in one context share a default key, but for a conditioned action beside an unconditioned one", () => {
    expect(keyClashes(ACTIONS)).toEqual([]);
    // The one key two actions hold in one context: ↑ in the composer, withdrawLast asked first while the composer is empty.
    const shared = new Map<string, string[]>();
    for (const action of ACTIONS) for (const k of action.keys) shared.set(`${action.context} ${k}`, [...(shared.get(`${action.context} ${k}`) ?? []), action.id]);
    expect([...shared].filter(([, ids]) => ids.length > 1)).toEqual([["composer ↑", ["composer.navigate", "composer.withdrawLast"]]]);
  });

  it("names no id outside the list: each id once, and every group, alias and sigil names ids of the list", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of ACTION_GROUPS) for (const a of g.actions) expect(isActionId(a.id), a.id).toBe(true);
    for (const a of ACTIONS) if (a.aliasOf !== undefined) expect(isActionId(a.aliasOf), `${a.id} aliases ${a.aliasOf}`).toBe(true);
    for (const trigger of Object.values(SIGILS)) if (trigger !== null) expect(isActionId(trigger), trigger).toBe(true);
    expect(isActionId("rail.fly")).toBe(false);
  });

  it("holds Artemis's rows, the harness's added keys and the slash commands, and nothing else", () => {
    const fixtureRows = ARTEMIS_KEYMAP.flatMap((g) => g.rows.map((row) => `${g.context} ${JSON.stringify(row.keys)}`));
    const extra = keyActions.filter((a) => !fixtureRows.includes(`${a.context} ${JSON.stringify(a.keys)}`)).map((a) => a.id);
    expect(extra.sort()).toEqual(Object.keys(ADDED_KEYS).sort());
    for (const [id, keys] of Object.entries(ADDED_KEYS)) expect(actionById(id)?.keys, id).toEqual(keys);
    expect(commands.map((a) => commandName(a.id)).sort()).toEqual([...ARTEMIS_COMMANDS.map((c) => c.name), ...ADDED_COMMANDS].sort());
  });
});

describe("the action list's shape", () => {
  it("parses every entry with the Action schema", () => {
    for (const action of ACTIONS) expect(Action.safeParse(action).success, action.id).toBe(true);
  });

  it("refuses an entry whose fields disagree: an id's prefix and its context, keys and usage on the wrong kind", () => {
    const pin = { id: "rail.pin", context: "sidebar", keys: ["p"], description: "Pin it", status: "wired" } as const;
    const help = { id: "command.help", context: "composer", keys: [], description: "List these commands", usage: "/help", status: "wired" } as const;
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
    ];
    for (const entry of refused) expect(Action.safeParse(entry).success, JSON.stringify(entry)).toBe(false);
  });

  it("has eleven contexts, Artemis's eight and the terminal pane, the parked asks and the yes or no offers", () => {
    expect([...ACTION_CONTEXTS].sort()).toEqual(
      ["anywhere", "composer", "transcript", "sidebar", "delegated", "picker", "permission", "pager", "terminal", "asks", "confirm"].sort(),
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

  it("gives a slash command a usage line and no key, and every other action a key and no usage line", () => {
    for (const action of commands) {
      expect(action.keys, action.id).toEqual([]);
      expect(action.usage?.startsWith(`/${commandName(action.id)}`), action.id).toBe(true);
      expect(isCommandId(action.id)).toBe(true);
    }
    for (const action of keyActions) {
      expect(action.keys.length, action.id).toBeGreaterThan(0);
      expect(action.usage, action.id).toBeUndefined();
      expect(isCommandId(action.id)).toBe(false);
    }
  });

  it("keeps the rows the harness lacks as absent with their reason, and wires the rest", () => {
    const absent = ACTIONS.filter((a) => a.status === "absent");
    expect(absent.map((a) => a.id)).toEqual(["permission.rule.edit", "permission.scope.walk", "command.undo", "command.check"]);
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
    const pressed = { id: "composer.withdrawLast", context: "composer", keys: ["↑"], description: "Take it back", status: "wired", when: "composer.empty" } as const;
    expect(Action.safeParse(pressed).success).toBe(true);
    const refused = [
      { id: "command.help", context: "composer", keys: [], description: "List these commands", usage: "/help", status: "wired", when: "composer.empty" },
      { ...pressed, id: "row.fork", context: "transcript" },
      { ...pressed, when: "composer.full" },
    ];
    for (const entry of refused) expect(Action.safeParse(entry).success, JSON.stringify(entry)).toBe(false);
  });
});

describe("Artemis's honesty checks", () => {
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

  it("keeps Artemis's groups, with their titles and contexts, in its order", () => {
    const carried = ACTION_GROUPS.filter((g) => ARTEMIS_KEYMAP.some((a) => a.title === g.title));
    expect(carried.map((g) => [g.title, g.context])).toEqual(ARTEMIS_KEYMAP.map((g) => [g.title, g.context]));
  });

  it("echoes the slash commands from the list: the last group is every command, in the list's order", () => {
    const last = ACTION_GROUPS.at(-1);
    expect(last?.title).toBe(SLASH_COMMANDS_TITLE);
    expect(last?.context).toBe("composer");
    expect(last?.actions.map((a) => a.id)).toEqual(commands.map((a) => a.id));
    // Artemis's commands first, in its order; the harness's after them.
    expect(commands.slice(0, ARTEMIS_COMMANDS.length).map((a) => commandName(a.id))).toEqual(ARTEMIS_COMMANDS.map((c) => c.name));
  });
});
