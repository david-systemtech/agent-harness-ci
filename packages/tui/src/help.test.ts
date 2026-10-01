import { ACTIONS, ACTION_GROUPS, SLASH_COMMANDS_TITLE, actionById, isCommandId, isGuiOnly, type KeyActionId } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { ANSWERED, BUILD_WORDS } from "./answered.js";
import { helpLines, type HelpLine } from "./help.js";
import { DEFAULT_KEYMAP, resolveKeymap } from "./keys.js";

/**
 * The help overlay's lines (docs/specs/tui.md, "Shortcuts"): the effective
 * map drawn from the shared action list, group by group, the slash commands
 * echoed from the list, remapped rows marked, `absent` rows dim with their
 * reason, and a row this build does not answer yet dim with "(soon)".
 */

const rows = (lines: readonly HelpLine[]) => lines.flatMap((line) => (line.kind === "row" ? [line] : []));
const rowOf = (lines: readonly HelpLine[], id: string) => rows(lines).find((line) => line.id === id);

describe("the help lines", () => {
  const lines = helpLines(DEFAULT_KEYMAP, ANSWERED);

  it("draw every group of the list as a heading with its actions under it, in the list's order", () => {
    expect(lines.filter((line) => line.kind === "heading").map((line) => line.kind === "heading" && line.text)).toEqual(ACTION_GROUPS.map((g) => g.title));
    expect(rows(lines).map((line) => line.id)).toEqual(ACTIONS.filter((a) => a.aliasOf === undefined && !isGuiOnly(a)).map((a) => a.id));
    expect(lines[0]).toEqual({ kind: "heading", text: "Anywhere" });
  });

  it("give every action of the list with a terminal column a default binding and a help line: its keys, or a slash command's usage line; only a hidden alias goes undrawn", () => {
    for (const action of ACTIONS.filter((a) => !isGuiOnly(a))) {
      const binding = isCommandId(action.id) ? action.usage : DEFAULT_KEYMAP.keys[action.id as KeyActionId].join(", ");
      expect(binding, action.id).toBeTruthy();
      if (action.aliasOf === undefined) expect(rowOf(lines, action.id), action.id).toMatchObject({ keys: binding, description: action.description });
      else expect(rowOf(lines, action.id), action.id).toBeUndefined();
    }
  });

  it("leave out every action whose terminal column is empty: the actions only the GUI answers, in whichever group they sit (#388)", () => {
    const guiOnly = ACTIONS.filter(isGuiOnly).map((a) => a.id);
    expect(guiOnly).toEqual(expect.arrayContaining(["app.palette", "app.pane.splitRight", "permission.allow", "picker.back", "transcript.findClose"]));
    for (const id of guiOnly) expect(rowOf(lines, id), id).toBeUndefined();
    expect(lines.some((line) => line.kind === "reason" && guiOnly.includes(line.id))).toBe(false);
    // Their groups stay, with the actions the terminal answers.
    expect(rowOf(lines, "app.help")).toBeDefined();
    expect(rowOf(lines, "permission.deny")).toBeDefined();
  });

  it("echo the slash commands from the list: each command's usage line and description, and no hidden alias", () => {
    const commands = ACTIONS.filter((a) => a.id.startsWith("command.") && a.aliasOf === undefined);
    const heading = lines.findIndex((line) => line.kind === "heading" && line.text === SLASH_COMMANDS_TITLE);
    expect(rows(lines.slice(heading)).map((line) => [line.keys, line.description])).toEqual(commands.map((a) => [a.usage, a.description]));
    expect(rowOf(lines, "command.profile")).toBeUndefined();
  });

  it("write a key action's keys as the table does, alternatives after commas", () => {
    expect(rowOf(lines, "composer.newline")?.keys).toBe("Shift+Enter, Ctrl+J");
    expect(rowOf(lines, "app.prompt.back")?.keys).toBe("Esc Esc");
  });

  it("draw an absent row dim with its reason on the line under it", () => {
    const at = lines.findIndex((line) => line.kind === "row" && line.id === "permission.rule.edit");
    expect(lines[at]).toMatchObject({ state: "absent", keys: "e" });
    expect(lines[at + 1]).toEqual({ kind: "reason", id: "permission.rule.edit", text: (actionById("permission.rule.edit") as { reason: string }).reason });
  });

  it("tell the actions this build answers from the ones it does not yet", () => {
    expect(rowOf(lines, "app.help")?.state).toBe("answered");
    expect(rowOf(lines, "command.reload")?.state).toBe("answered");
    expect(rowOf(lines, "command.browser")).toMatchObject({ state: "answered", keys: "/browser" });
    expect(rowOf(lines, "rail.pin")?.state).toBe("answered");
    expect(rowOf(lines, "command.search")?.state).toBe("answered");
    expect(rowOf(lines, "picker.filter")?.state).toBe("answered");
    expect(rowOf(lines, "rail.preview")?.state).toBe("soon");
    // Fork and rewind (#232): the prompt picker, its branch, the row verbs and both commands.
    for (const id of ["app.prompt.back", "picker.branch", "row.rewind", "row.fork", "row.rewindUndo", "command.fork", "command.rewind"]) expect(rowOf(lines, id)?.state, id).toBe("answered");
    expect(rowOf(lines, "command.model")?.state).toBe("answered");
    expect(rowOf(lines, "command.terminal")?.state).toBe("answered");
  });

  it("show the effective map: a remapped row with its new keys, marked", () => {
    const remapped = helpLines(resolveKeymap({ "app.help": ["Ctrl+X", "F"] }).keymap, ANSWERED);
    expect(rowOf(remapped, "app.help")).toMatchObject({ keys: "Ctrl+X, F", remapped: true });
    expect(rowOf(remapped, "confirm.yes")).toMatchObject({ keys: "y", remapped: false });
  });

  it("say what this build does where it does less than the list's words, and nowhere else", () => {
    const built = helpLines(DEFAULT_KEYMAP, ANSWERED, BUILD_WORDS);
    expect(rowOf(built, "app.interruptOrQuit")?.description).toBe("Clear the text or close the card; else interrupt, then quit");
    expect(rowOf(built, "composer.send")?.description).toBe(actionById("composer.send")?.description);
    // The pin is the global pinned block, not a place in a folder.
    expect(rowOf(built, "rail.pin")?.description).toBe("Pin it to the pinned block at the top, across environments; or unpin it");
    for (const id of Object.keys(BUILD_WORDS)) expect(ANSWERED.has(id as never), id).toBe(true);
  });

  it("draw the pager's rows as answered now the pager is drawn, and the ones it does not do yet as soon", () => {
    for (const id of ["pager.line", "pager.halfDown", "pager.turn.next", "pager.search", "pager.match", "pager.close"]) expect(rowOf(lines, id)?.state, id).toBe("answered");
    expect(rowOf(lines, "pager.editor")?.state).toBe("soon");
  });

  it("draw the suggestion keys with key 1 answered, Ctrl+Enter as answered, and ↑ with what it does in this build", () => {
    const built = helpLines(DEFAULT_KEYMAP, ANSWERED, BUILD_WORDS);
    expect(rowOf(built, "composer.suggestion.take")).toMatchObject({ state: "answered", description: "1 sends the predicted next message from an empty composer; 2–4 type text" });
    expect(rowOf(built, "composer.readNow")?.state).toBe("answered");
    expect(rowOf(built, "composer.navigate")).toMatchObject({ state: "answered", description: "The text, then history" });
    expect(rowOf(built, "transcript.follow")?.state).toBe("answered");
  });

  it("draw a conditioned row with its condition after its keys, answered, and keep it when remapped (#231)", () => {
    const built = helpLines(DEFAULT_KEYMAP, ANSWERED, BUILD_WORDS);
    expect(rowOf(built, "composer.withdrawLast")).toMatchObject({ keys: "↑", condition: "empty composer", state: "answered", remapped: false });
    expect(rowOf(built, "composer.navigate")?.condition).toBeUndefined();
    const remapped = helpLines(resolveKeymap({ "composer.withdrawLast": ["Alt+W"] }).keymap, ANSWERED);
    expect(rowOf(remapped, "composer.withdrawLast")).toMatchObject({ keys: "Alt+W", condition: "empty composer", remapped: true });
  });

  it("name only actions of the list as answered", () => {
    for (const id of ANSWERED) expect(actionById(id), id).toBeDefined();
  });
});
