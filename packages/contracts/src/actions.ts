import { z } from "zod";

/**
 * The shared action list (ADR 0004; the tui spec's "Shortcuts: the shared
 * action list, the defaults, the keybindings file"; #144). Every key a client
 * answers is a named action here: its id, the context it is answered in, its
 * default keys, a one-line description, and whether the harness wires it or
 * keeps its keys absent with a reason. The defaults are the reference
 * terminal map exactly, which a contract test holds as a fixture, plus the
 * actions the harness adds. The terminal UI's map is a projection of this
 * list and its keybindings file remaps it by id.
 *
 * Beside the terminal's fields each action has a GUI column (`gui`; the GUI
 * spec's "Keyboard: the GUI column"; ADR 0022, #388): the GUI's default keys,
 * wired or absent with a reason, a condition of its own, and `off` for keys
 * written but unbound until turned on. Its defaults are the GUI map the
 * surfaces port audit pins, a second fixture, with one row changed: Esc's
 * stop is `off`. An action only the GUI answers has an empty terminal
 * column (no keys, absent), which the terminal UI's help leaves out.
 *
 * The list is data in groups: the order is the order the help overlay draws,
 * each group one context. Sigils typed into the
 * composer (`/`, `@`, `;;`, `!`, `!!`) are syntax, not keys: only their menu
 * triggers are actions (`SIGILS`).
 */

/**
 * The twelve places a key means what it means: the reference keymap's eight
 * (`anywhere` is the handful no component may take) plus the terminal pane,
 * the parked-asks card, the one-line yes or no offers and the routines card.
 */
export const ACTION_CONTEXTS = [
  "anywhere",
  "composer",
  "transcript",
  "sidebar",
  "delegated",
  "picker",
  "permission",
  "pager",
  "terminal",
  "asks",
  "confirm",
  "routines",
] as const;

export const ActionContext = z.enum(ACTION_CONTEXTS).meta({
  description:
    "Where a key means what it means: anywhere (keys no component may take), composer, transcript, sidebar (the rail), delegated (the delegated-work strip), picker (a list to choose from), permission (a permission or question card), pager, terminal (the terminal pane), asks (the parked-asks card), confirm (a one-line yes or no offer), routines (the routines card: the list, a routine's history, the webhook endpoints). A key is claimed at most once per context.",
});
export type ActionContext = z.infer<typeof ActionContext>;

/**
 * The first word of an action id, and the context it names. Most are the
 * context's own name; `app` is `anywhere`, `row` is `transcript` (a row under
 * the transcript's cursor), `rail` is `sidebar`, and `command` is a slash
 * command, typed at the composer.
 */
export const ACTION_ID_PREFIXES = {
  app: "anywhere",
  composer: "composer",
  command: "composer",
  transcript: "transcript",
  row: "transcript",
  rail: "sidebar",
  delegated: "delegated",
  picker: "picker",
  permission: "permission",
  pager: "pager",
  terminal: "terminal",
  asks: "asks",
  confirm: "confirm",
  routines: "routines",
} as const satisfies Record<string, ActionContext>;

const ACTION_ID_PATTERN = new RegExp(`^(${Object.keys(ACTION_ID_PREFIXES).join("|")})(\\.[a-z][A-Za-z]*)+$`);

/**
 * The conditions an action's keys may be declared under (#231), in either
 * column: each named `<context>.<state>`, answered only in its own context,
 * with the words the help overlay and the specs' tables write after the keys
 * and what the condition means. A condition may lie `within` a wider one,
 * holding only where that one holds (an empty composer's caret is at its
 * start). A conditioned action is asked for its key before one holding the
 * same key in the same context under a wider condition or none, and the key
 * falls to that one when the condition does not hold (the clash rule,
 * `keyClashes`). The JSON Schema export carries the table in the
 * condition's description, so a client in another language draws the same
 * words.
 */
export const ACTION_CONDITIONS = {
  "composer.empty": {
    context: "composer",
    words: "empty composer",
    description: "Nothing is typed in the composer, nothing is attached, and no search of its history is open.",
    within: "composer.atStart",
  },
  "composer.atStart": {
    context: "composer",
    words: "from the start of the box",
    description: "The caret is at the very start of the composer, with nothing selected.",
  },
  "picker.queryEmpty": {
    context: "picker",
    words: "empty query",
    description: "Nothing is typed in the list's query.",
  },
  "transcript.finding": {
    context: "transcript",
    words: "find bar",
    description: "The transcript's find bar is open and has the keys.",
  },
} as const satisfies Record<string, { readonly context: ActionContext; readonly words: string; readonly description: string; readonly within?: string }>;

type ConditionName = keyof typeof ACTION_CONDITIONS;

/** Each condition as the schema's description lists it: its id, the words written after the keys, what it lies within, and what it means. */
const conditionTable = Object.entries(ACTION_CONDITIONS)
  .map(
    ([id, condition]) =>
      `${id} (written "${condition.words}" after the keys, in the ${condition.context} context${"within" in condition ? `, within ${condition.within}` : ""}): ${condition.description}`,
  )
  .join(" ");

export const ActionCondition = z.enum(Object.keys(ACTION_CONDITIONS) as [ConditionName, ...ConditionName[]]).meta({
  description: `A condition an action's keys are answered under, named <context>.<state>. ${conditionTable} A conditioned action is asked first for a key it shares with an action of its context under a wider condition or none; the key falls to that one when the condition does not hold.`,
});
export type ActionCondition = z.infer<typeof ActionCondition>;

/**
 * Whether `inner` holds only where `outer` holds: the same condition, one
 * lying within it (in turn), or any condition within none (`undefined`,
 * the key's whenever its context has the keys).
 */
export const conditionWithin = (inner: ActionCondition | undefined, outer: ActionCondition | undefined): boolean => {
  if (outer === undefined) return true;
  for (let at: ActionCondition | undefined = inner; at !== undefined; at = (ACTION_CONDITIONS[at] as { readonly within?: ActionCondition }).within) {
    if (at === outer) return true;
  }
  return false;
};

const GuiWired = z
  .object({
    status: z.literal("wired"),
    keys: z.array(z.string().min(1)).meta({
      description:
        "The GUI's default keys, each an alternative, written as the terminal column writes them with `Mod` for ⌘ on macOS and Ctrl elsewhere (`Mod+K`, `Shift+Enter`, `↑`), so Ctrl is written only for macOS's Control key; empty for a slash command, which is typed, and for an action the GUI answers with no default key (it is in the command palette and bindable).",
    }),
    when: ActionCondition.optional().meta({
      description:
        "For keys the GUI answers only under a condition of the action's context: the condition, ruled as in the terminal column. Absent, the keys are the action's whenever its context has the keys.",
    }),
    off: z
      .literal(true)
      .optional()
      .meta({ description: "The keys are written but unbound until turned on: app.interrupt's Esc, under the switch \"Esc stops the run\" (ADR 0022)." }),
  })
  .meta({ description: "An action the GUI answers." });

const GuiAbsent = z
  .object({
    status: z.literal("absent"),
    reason: z.string().min(1).meta({
      description:
        "Why the GUI has no key for it: a text field's own key, a surface the GUI reaches it from otherwise (named), or a decision (ADR 0022 for Ctrl+C). The Keyboard shortcuts pane draws the row dim with this.",
    }),
  })
  .meta({ description: "An action the GUI answers another way, or not at all: absent with the reason." });

const GuiColumn = z.discriminatedUnion("status", [GuiWired, GuiAbsent]).meta({
  description:
    "The GUI's column beside the terminal's (the GUI spec's \"Keyboard: the GUI column\"): its default keys, wired or absent with a reason, a condition of its own, and off for keys written but unbound until turned on.",
});
/** An action's GUI column: the GUI's default keys, wired or absent with a reason. */
export type GuiColumn = z.infer<typeof GuiColumn>;

const ActionFields = {
  id: z.string().regex(ACTION_ID_PATTERN).meta({
    description:
      "`<context>.<verb>`, where the prefix app is the context anywhere, row is transcript and rail is sidebar; `command.<name>` for a slash command.",
  }),
  context: ActionContext,
  keys: z.array(z.string().min(1)).meta({
    description:
      "The terminal's default keys, each an alternative, written as the tui spec's table writes them (`Ctrl+C`, `Esc Esc`, `↑`); empty for a slash command, which is typed rather than pressed, and for an action only the GUI answers (its terminal column is empty: absent, and left out of the terminal UI's help).",
  }),
  description: z.string().min(1).meta({ description: "What the action does, in one line; the reference fixture's words for the rows it carries." }),
  usage: z
    .string()
    .regex(/^\/[a-z]+( .*)?$/)
    .optional()
    .meta({ description: "A slash command's usage line, as the help overlay and the command menu print it; absent for a key." }),
  aliasOf: z
    .string()
    .regex(ACTION_ID_PATTERN)
    .optional()
    .meta({ description: "For a slash command kept as a hidden alias: the command it now names. The help overlay leaves it out." }),
  when: ActionCondition.optional().meta({
    description:
      "For a terminal key answered only under a condition of its own context: the condition. Such an action may share a default key with an action of its context under a wider condition or none, and is asked first; absent, the key is the action's whenever its context has the keys.",
  }),
  gui: GuiColumn,
};

const WiredAction = z.object({ ...ActionFields, status: z.literal("wired") }).meta({ description: "An action the terminal answers." });

const AbsentAction = z
  .object({
    ...ActionFields,
    status: z.literal("absent"),
    reason: z.string().min(1).meta({ description: "Why the terminal answers it absent: the help overlay draws the row dim with this." }),
  })
  .meta({ description: "An action the terminal keeps the keys of but does not answer, drawn dim with its reason; or, with no keys, one only the GUI answers." });

/**
 * One entry of the shared action list. The rules that tie its fields
 * together are zod's half only, as `EventFrame`'s sequence rule is: the id's
 * first word names its context (`row` is `transcript`, `rail` is `sidebar`,
 * `app` is `anywhere`, `command` is `composer`); a slash command has a usage
 * line and no keys or condition in either column, any other action a usage
 * line in neither; a pressed action has a terminal key unless only the GUI
 * answers it (its terminal column empty: absent, no keys, no condition, and
 * wired in the GUI), while a GUI action wired with no key is valid; a
 * condition is one of the action's own context; keys written `off` are
 * keys; only a slash command is an alias. The JSON Schema export cannot
 * state them, so a client in another language checks them itself.
 */
export const Action = z
  .discriminatedUnion("status", [WiredAction, AbsentAction])
  .superRefine((action, ctx) => {
    const prefix = action.id.slice(0, action.id.indexOf(".")) as keyof typeof ACTION_ID_PREFIXES;
    const context = ACTION_ID_PREFIXES[prefix];
    const gui = action.gui.status === "wired" ? action.gui : undefined;
    if (context !== action.context) ctx.addIssue({ code: "custom", path: ["context"], message: `${action.id} is an action of the context ${context}.` });
    for (const [path, when] of [
      [["when"], action.when],
      [["gui", "when"], gui?.when],
    ] as const) {
      if (when !== undefined && ACTION_CONDITIONS[when].context !== action.context)
        ctx.addIssue({ code: "custom", path: [...path], message: `${when} is a condition of the context ${ACTION_CONDITIONS[when].context}.` });
    }
    if (gui?.off === true && gui.keys.length === 0) ctx.addIssue({ code: "custom", path: ["gui", "off"], message: "Only keys are written off: this column has none." });
    if (prefix === "command") {
      if (action.keys.length > 0) ctx.addIssue({ code: "custom", path: ["keys"], message: "A slash command is typed: it has no keys." });
      if (action.when !== undefined) ctx.addIssue({ code: "custom", path: ["when"], message: "A slash command is typed: it has no condition." });
      if (gui !== undefined && (gui.keys.length > 0 || gui.when !== undefined))
        ctx.addIssue({ code: "custom", path: ["gui"], message: "A slash command is typed in the GUI too: it has no keys or condition there." });
      if (action.usage === undefined) ctx.addIssue({ code: "custom", path: ["usage"], message: "A slash command has a usage line." });
      else if (!action.usage.startsWith(`/${action.id.slice("command.".length)}`))
        ctx.addIssue({ code: "custom", path: ["usage"], message: "A slash command's usage line starts with its name." });
    } else {
      if (action.keys.length === 0 && (action.status !== "absent" || action.when !== undefined || gui === undefined))
        ctx.addIssue({
          code: "custom",
          path: ["keys"],
          message: "A pressed action has a terminal key; one with none is the GUI's alone: absent in the terminal, with no condition there, and wired in the GUI.",
        });
      if (action.usage !== undefined) ctx.addIssue({ code: "custom", path: ["usage"], message: "Only a slash command has a usage line." });
      if (action.aliasOf !== undefined) ctx.addIssue({ code: "custom", path: ["aliasOf"], message: "Only a slash command is an alias." });
    }
  })
  .meta({
    description:
      "One named action of the shared list: its id, context and description; the terminal's column (default keys, a condition they are answered under where it has one, wired or absent with a reason); and the GUI's column beside it. The id's first word names its context (row is transcript, rail is sidebar, app is anywhere, command is composer); a slash command has a usage line and no keys or condition in either column, any other action no usage line; a pressed action has a terminal key unless only the GUI answers it (absent in the terminal with no keys or condition, wired in the GUI), while a GUI action wired with no key is valid; a condition is one of the action's own context; keys written off are keys; and only a slash command is an alias: rules the decoder keeps and this schema cannot state.",
  });
export type Action = z.infer<typeof Action>;

/** Whether only the GUI answers `action`: pressed, with an empty terminal column, which the terminal UI's help leaves out. */
export const isGuiOnly = (action: { readonly id: string; readonly keys: readonly string[] }): boolean => !action.id.startsWith("command.") && action.keys.length === 0;

/* ------------------------------------------------------------------------------------------------------------ */

interface Row<Id extends string> {
  readonly id: Id;
  readonly keys: readonly string[];
  readonly description: string;
  readonly status: "wired" | "absent";
  readonly reason?: string;
  readonly usage?: string;
  readonly aliasOf?: string;
  readonly when?: ActionCondition;
  readonly gui: GuiColumn;
}

/** A GUI column that wires `keys`: with the condition they are answered under, or written `off` until turned on. */
const inGui = (keys: readonly string[], more: { readonly when?: ActionCondition; readonly off?: true } = {}): GuiColumn => ({ status: "wired", keys: [...keys], ...more });

/** A GUI column absent with its reason. */
const notInGui = (reason: string): GuiColumn => ({ status: "absent", reason });

/** A key the terminal answers, and its GUI column; `when`, a condition its terminal keys are answered under. */
const key = <const Id extends string>(id: Id, keys: readonly string[], description: string, column: GuiColumn, when?: ActionCondition): Row<Id> => ({
  id,
  keys,
  description,
  status: "wired",
  ...(when !== undefined && { when }),
  gui: column,
});

/** A key the terminal keeps but answers absent, with the reason, and its GUI column. */
const absent = <const Id extends string>(id: Id, keys: readonly string[], description: string, reason: string, column: GuiColumn): Row<Id> => ({
  id,
  keys,
  description,
  status: "absent",
  reason,
  gui: column,
});

const GUI_ONLY = "Only the GUI answers it: the terminal UI has no key for it, and its help leaves it out.";

/** An action only the GUI answers: an empty terminal column (no keys, absent) beside the GUI's. */
const guiOnly = <const Id extends string>(id: Id, description: string, column: GuiColumn): Row<Id> => ({
  id,
  keys: [],
  description,
  status: "absent",
  reason: GUI_ONLY,
  gui: column,
});

/**
 * A slash command: typed, so it has no keys; its usage line is what the menu
 * and the overlay print. The GUI wires it, typed in its composer, unless
 * `guiAbsent` says why not.
 */
const command = <const Name extends string>(
  name: Name,
  usage: string,
  description: string,
  more: { readonly absent?: string; readonly aliasOf?: string; readonly guiAbsent?: string } = {},
): Row<`command.${Name}`> => ({
  id: `command.${name}`,
  keys: [],
  description,
  usage,
  ...(more.absent === undefined ? { status: "wired" as const } : { status: "absent" as const, reason: more.absent }),
  ...(more.aliasOf !== undefined && { aliasOf: more.aliasOf }),
  gui: more.guiAbsent === undefined ? inGui([]) : notInGui(more.guiAbsent),
});

/** A group of the list: a title the help overlay draws, one context, and its actions in order. */
export interface ActionGroup<Id extends string = string> {
  readonly title: string;
  readonly context: ActionContext;
  readonly actions: readonly (Row<Id> & { readonly context: ActionContext })[];
}

const group = <const Id extends string>(title: string, context: ActionContext, rows: readonly Row<Id>[]): ActionGroup<Id> => ({
  title,
  context,
  actions: rows.map((row) => ({ ...row, context })),
});

const RULES_PER_SESSION = "Rules are per session on the harness: a prompt never saves a rule (docs/specs/permissions.md).";

/*
 * The GUI column's reasons for the keys it leaves to something else (the GUI
 * spec's "Keyboard: the GUI column"): a text field's own key, or the surface
 * the GUI reaches the action from, named.
 */
const TEXT_FIELD = notInGui("A text field's own key in the GUI.");
const TYPED_AT = notInGui("Typed into the query in the GUI, whose lists are typed at.");
const CONTEXT_MENU = notInGui("The GUI does it from the session's context menu in the sidebar.");
const GROUP_MENU = notInGui("The GUI does it from the group heading's context menu in the sidebar.");
const FORK_REWIND = notInGui("The GUI does it with the Fork and Rewind buttons under each message you sent.");
const SCROLL_BAR = notInGui("The GUI moves through the transcript with its scroll bar.");
const ROW_POINTER = notInGui("The GUI has no row cursor: a row's controls answer the pointer.");
const SIDEBAR_POINTER = notInGui("The GUI opens and previews a session with the pointer, in the sidebar.");
const TASKS_PANE = notInGui("The GUI shows delegated work in the Tasks pane, with a stop on each task.");
const CARD_CONTROLS = notInGui("The GUI's card answers with its buttons and fields, reached with the pointer or the window's Tab.");
const NO_PAGER = notInGui("The GUI has no pager: the transcript is whole, with its scroll bar.");
const FIND_BAR = notInGui("The GUI has no pager: the transcript's find bar (Mod+F) searches it.");
const SELECTED_TEXT = notInGui("The GUI has no pager: a file's or a document's text is selected and copied in its pane.");
const PARKED_ASKS = notInGui("The GUI answers parked asks in the Parked asks view, with the pointer.");
const CONFIRM_DIALOG = notInGui("The GUI asks yes or no in a dialog, with a button for each.");
const ROUTINES_PANE = notInGui("The GUI's Routines pane has a button for each, with the pointer.");
const NO_SNIPPETS = notInGui("Typed as text in the GUI: snippets and their slots are the terminal UI's own.");

/** The title of the slash-command group, which the help overlay draws last. */
export const SLASH_COMMANDS_TITLE = "Slash commands";

/**
 * The list, in groups. The reference keymap's rows come first in each of its
 * groups, in its order and with its words; the harness's additions follow
 * them (ADR 0022's fork, rewind, read-now and withdraw keys, the rail's
 * organisation keys), then the actions only the GUI answers, then the three
 * contexts the harness adds, then the slash commands: the reference's, in
 * its order, then the harness's.
 */
export const ACTION_GROUPS = [
  group("Anywhere", "anywhere", [
    key("app.focus.next", ["Tab"], "Round the composer, the list, the strip and the rows", notInGui("The GUI focuses a pane with a click, and Tab walks the window's controls.")),
    key("app.mode.step", ["Shift+Tab"], "Step the permission mode on", notInGui("The GUI steps the mode from the mode badge on the status line.")),
    key("app.interrupt", ["Esc"], "Interrupt; or follow the end again", inGui(["Esc"], { off: true })),
    key("app.prompt.back", ["Esc Esc"], "Go back to an earlier prompt", FORK_REWIND),
    key(
      "app.interruptOrQuit",
      ["Ctrl+C"],
      "Interrupt; again in a moment to quit",
      notInGui("Ctrl+C copies in the GUI and never stops a run (ADR 0022): the Stop button and the palette stop it."),
    ),
    key("app.pager.open", ["Ctrl+O"], "Unfold the whole transcript", NO_PAGER),
    key("app.checklist.toggle", ["Ctrl+T"], "Show or hide the checklist", notInGui("The GUI has no checklist strip: the checklist is drawn in the transcript.")),
    key(
      "app.attention.next",
      ["Ctrl+]"],
      "Go to the next conversation that needs you",
      notInGui("The GUI reaches what needs you from Parked asks, the sidebar's activity and its notifications."),
    ),
    key(
      "app.handoff",
      ["Alt+H"],
      "Hand this conversation to another account",
      notInGui("The GUI hands over from the status line's offer and Fork onto another account under a message."),
    ),
    key("app.help", ["?"], "Open this map, from an empty composer", notInGui("Typed as text in the GUI: the Keyboard shortcuts pane in Settings lists the keys.")),
    guiOnly("app.palette", "Open the command palette", inGui(["Mod+K"])),
    guiOnly("app.find", "Find in the conversation", inGui(["Mod+F"])),
    guiOnly("app.session.new", "Start a new session in the focused pane", inGui(["Mod+N"])),
    guiOnly("app.session.newInPane", "Start a new session in a new pane", inGui(["Mod+Shift+N"])),
    guiOnly("app.zoom.in", "Zoom in", inGui(["Mod++", "Mod+=", "Mod+Shift+="])),
    guiOnly("app.zoom.out", "Zoom out", inGui(["Mod+-"])),
    guiOnly("app.zoom.reset", "Actual size", inGui(["Mod+0"])),
    guiOnly("app.sidebar.toggle", "Show or hide the sidebar", inGui(["Mod+B"])),
    guiOnly("app.terminal.toggle", "Show or hide the terminal", inGui(["Mod+J"])),
    guiOnly("app.browser.unpair", "Choose a paired Chrome to unpair", inGui([])),
    guiOnly("app.browser.allowRuns", "Change whether runs may use the headless browser", inGui([])),
    guiOnly("app.browser.default", "Change an account's default browser", inGui([])),
    guiOnly("app.browser.pair", "Pair another Chrome on this machine", inGui([])),
    guiOnly("app.browser.choose", "Choose the session browser for the next run", inGui([])),
    guiOnly("app.browser.toggle", "Show or hide the browser", inGui(["Mod+Shift+B"])),
    guiOnly("app.pane.splitRight", "Split the focused pane to the right", inGui(["Mod+\\"])),
    guiOnly("app.pane.splitDown", "Split the focused pane downwards", inGui(["Mod+Shift+\\"])),
    guiOnly("app.settings.toggle", "Open or close Settings", inGui(["Mod+,"])),
    key("app.runInfo.toggle", ["Alt+I"], "Show or hide the run's details", inGui(["Mod+I"])),
  ]),
  group("Writing a message", "composer", [
    key("composer.send", ["Enter"], "Send it, steer a turn, run a row, send a failed check", inGui(["Enter"])),
    key("composer.newline", ["Shift+Enter", "Ctrl+J"], "A newline instead of sending", inGui(["Shift+Enter"])),
    key("composer.continueLine", ["\\ Enter"], "A backslash keeps the line open", notInGui("Typed as text in the GUI, where Shift+Enter breaks the line.")),
    key("composer.navigate", ["↑", "↓"], "The text, then the queue, then history", inGui(["↑", "↓"], { when: "composer.atStart" })),
    key("composer.command.menu", ["/"], "Start a command, and see the menu", inGui(["/"])),
    key("composer.file.mention", ["@"], "Name a file, and see the paths", inGui(["@"])),
    key("composer.snippet.expand", [";;"], "Expand a saved snippet; Tab walks its slots", NO_SNIPPETS),
    key("composer.complete", ["Tab"], "Fill in the highlighted row, or the next slot", inGui(["Tab"])),
    key("composer.slot.back", ["Shift+Tab"], "Back to the slot before, in a snippet", NO_SNIPPETS),
    key("composer.shell", ["!"], "Run a shell command; !! sends the output", inGui(["!"])),
    key("composer.paste", ["Ctrl+V"], "Paste an image, or the text there", inGui(["Mod+V"])),
    key("composer.editor", ["Ctrl+G"], "Edit the draft in $EDITOR", notInGui("The GUI edits the draft in its composer, and opens no $EDITOR.")),
    key(
      "composer.suggestion.take",
      ["1–4"],
      "Take one of the follow-ups the agent offered",
      notInGui("The GUI draws no follow-up chips: nothing carries the follow-ups (#146)."),
    ),
    key("composer.readNow", ["Ctrl+Enter"], "Have the queued message read now, mid-turn", inGui([])),
    key("composer.withdrawLast", ["↑"], "Take the newest queued message back to edit", inGui(["↑"], { when: "composer.empty" }), "composer.empty"),
  ]),
  group("Moving and editing", "composer", [
    key("composer.line.start", ["Ctrl+A", "Home"], "The start of the line", TEXT_FIELD),
    key("composer.line.end", ["Ctrl+E", "End"], "The end of it", TEXT_FIELD),
    key("composer.buffer.start", ["Ctrl+Home"], "The start of everything typed", TEXT_FIELD),
    key("composer.buffer.end", ["Ctrl+End"], "The end of everything typed", TEXT_FIELD),
    key("composer.word.back", ["Alt+B", "Ctrl+←"], "A word back", TEXT_FIELD),
    key("composer.word.forward", ["Alt+F", "Ctrl+→"], "A word on", TEXT_FIELD),
    key("composer.word.deleteBack", ["Ctrl+W"], "Rub out the word before the cursor", TEXT_FIELD),
    key("composer.word.deleteForward", ["Alt+D"], "Delete the word after it", TEXT_FIELD),
    key("composer.cut.toStart", ["Ctrl+U"], "Cut back to the start of the line", TEXT_FIELD),
    key("composer.cut.toEnd", ["Ctrl+K"], "Cut on to the end of it", TEXT_FIELD),
    key("composer.yank", ["Ctrl+Y"], "Put back the last thing cut", TEXT_FIELD),
    key("composer.undo", ["Ctrl+_"], "Undo", TEXT_FIELD),
    key("composer.backspace", ["Backspace"], "A whole paste chip; or the search query", TEXT_FIELD),
  ]),
  group("What you typed before", "composer", [
    key(
      "composer.history.search",
      ["Ctrl+R"],
      "Search back through past prompts",
      notInGui("The GUI walks past prompts with ↑ from the start of the box, and has no search of them."),
    ),
    key(
      "composer.history.scopeOrStash",
      ["Ctrl+S"],
      "What the search looks at; outside one, stash the draft",
      notInGui("The GUI has no search of past prompts, and keeps the draft as it is typed."),
    ),
  ]),
  group("The conversation", "transcript", [
    key("transcript.pageUp", ["PgUp", "Shift+↑", "Ctrl+↑"], "Half a screen back", SCROLL_BAR),
    key("transcript.pageDown", ["PgDn", "Shift+↓", "Ctrl+↓"], "Half a screen on", SCROLL_BAR),
    key("transcript.cursor", ["↑", "↓"], "The cursor’s row here; a line, from the box", ROW_POINTER),
    key("transcript.follow", ["End"], "Back to the end, and follow it", SCROLL_BAR),
    guiOnly("transcript.findNext", "The next match", inGui(["Enter"], { when: "transcript.finding" })),
    guiOnly("transcript.findPrevious", "The match before", inGui(["Shift+Enter"], { when: "transcript.finding" })),
    guiOnly("transcript.findClose", "Close the find bar", inGui(["Esc"], { when: "transcript.finding" })),
  ]),
  group("A row of the conversation", "transcript", [
    key("row.open", ["o"], "Open the file it touched, at the line", ROW_POINTER),
    key("row.recall", ["r"], "Put the command it ran back in the composer", ROW_POINTER),
    key("row.copy", ["y"], "Copy the row — a diff as a diff", ROW_POINTER),
    key("row.diff", ["d"], "The whole diff it wrote", ROW_POINTER),
    key("row.checkFailure.send", ["s"], "Send the offered check failure", notInGui("Use Send failure beside the composer, or Enter with an empty composer.")),
    key("row.unfold", ["Enter"], "Unfold what the row is holding back", ROW_POINTER),
    key("row.stop", ["x"], "Stop the call that is still running", ROW_POINTER),
    key("row.leave", ["Esc"], "Put the cursor away, back to the composer", ROW_POINTER),
    key("row.rewind", ["w"], "Rewind to this prompt", FORK_REWIND),
    key("row.fork", ["f"], "Fork a new session from this prompt", FORK_REWIND),
    key("row.rewindUndo", ["u"], "Undo the rewind, on the rewound fold", notInGui("The GUI undoes a rewind with Undo rewind, on the rewound fold and over the composer.")),
  ]),
  group("The conversation list", "sidebar", [
    key("rail.move", ["↑", "↓"], "Move the cursor", SIDEBAR_POINTER),
    key("rail.moveVi", ["k", "j"], "The same — until a filter is being typed", SIDEBAR_POINTER),
    key("rail.open", ["Enter"], "Open it, or fold the folder", SIDEBAR_POINTER),
    key("rail.filter", ["/"], "Filter the list by what you type", notInGui("The GUI filters the sidebar in its filter field, and the palette (Mod+K) searches every session.")),
    key("rail.filter.erase", ["Backspace"], "Rub a letter off the filter", TEXT_FIELD),
    key("rail.preview", ["Space"], "Show what a conversation is, unopened", SIDEBAR_POINTER),
    key("rail.archive", ["a"], "Archive the one under the cursor", CONTEXT_MENU),
    key("rail.delete", ["d"], "Delete it", CONTEXT_MENU),
    key("rail.pin", ["p"], "Pin it to the top of its folder", CONTEXT_MENU),
    key("rail.archive.filtering", ["Ctrl+A"], "Archive it, while a filter is being typed", CONTEXT_MENU),
    key("rail.delete.filtering", ["Ctrl+D"], "Delete it, while filtering", CONTEXT_MENU),
    key("rail.pin.filtering", ["Ctrl+P"], "Pin it, while filtering", CONTEXT_MENU),
    key("rail.leave", ["Esc"], "Clear the filter; then back to the composer", SIDEBAR_POINTER),
    key("rail.settle", ["s"], "Settle it, or unsettle it", CONTEXT_MENU),
    key("rail.snooze", ["z"], "Snooze it until a time you pick", CONTEXT_MENU),
    key("rail.tag", ["t"], "Tag it", CONTEXT_MENU),
    key("rail.group", ["g"], "Put it in a group, or a new one", CONTEXT_MENU),
    key("rail.moveUp", ["Shift+↑"], "Move it up, among the pinned or the active", notInGui("The GUI moves a session by dragging it in the sidebar.")),
    key("rail.moveDown", ["Shift+↓"], "Move it down, among the pinned or the active", notInGui("The GUI moves a session by dragging it in the sidebar.")),
    key("rail.renameGroup", ["R"], "Rename the group under the cursor, on every environment", GROUP_MENU),
    key("rail.deleteGroup", ["D"], "Delete the group under the cursor, on every environment; its sessions stay", GROUP_MENU),
  ]),
  group("Delegated work", "delegated", [
    key("delegated.enter", ["Tab"], "Reached after the list, while work is running", TASKS_PANE),
    key("delegated.move", ["↑", "↓"], "Move down the strip", TASKS_PANE),
    key("delegated.open", ["Enter"], "Open what that agent did", TASKS_PANE),
    key("delegated.stop", ["x"], "Stop the task under the cursor", TASKS_PANE),
    key("delegated.unfold", ["→"], "Unfold a workflow's agents", TASKS_PANE),
    key("delegated.fold", ["←"], "Fold them again", TASKS_PANE),
    key("delegated.leave", ["Esc"], "Back to the composer", TASKS_PANE),
  ]),
  group("A list to choose from", "picker", [
    key("picker.move", ["↑", "↓"], "Move the cursor", inGui(["↑", "↓"])),
    key("picker.moveVi", ["k", "j"], "The same, in a list that is not typed at", TYPED_AT),
    key("picker.filter", ["Letters"], "Type to filter a long list", TEXT_FIELD),
    key("picker.choose", ["Enter"], "Choose the row under the cursor", inGui(["Enter"])),
    key("picker.preview", ["Space"], "Preview it without opening it", TYPED_AT),
    key("picker.rename", ["Ctrl+R"], "Rename the conversation under the cursor", CONTEXT_MENU),
    key("picker.archive", ["Ctrl+A"], "Archive it", CONTEXT_MENU),
    key("picker.pin", ["Ctrl+P"], "Pin it", CONTEXT_MENU),
    key("picker.leave", ["Esc"], "Clear the query; then close the list", inGui(["Esc"])),
    key("picker.branch", ["b"], "Branch a new session here, in the prompt picker", FORK_REWIND),
    key(
      "picker.hide",
      ["Ctrl+D"],
      "Hide the directory under the cursor from the workspace step, until a session works there again",
      notInGui("The GUI's workspace picker hides a directory from its row, with the pointer."),
    ),
    guiOnly("picker.back", "Back out of a page of the list", inGui(["Backspace"], { when: "picker.queryEmpty" })),
  ]),
  group("A permission card", "permission", [
    key("permission.move", ["↑", "↓", "k", "j"], "Move down the answers", CARD_CONTROLS),
    key("permission.choose", ["Enter"], "Choose the one under the cursor", notInGui("A bare Enter never approves in the GUI: Mod+Enter allows, and each answer is a button.")),
    key("permission.deny", ["Esc"], "Deny it; on a question, skip it", inGui(["Esc"])),
    key("permission.note", ["Tab"], "A line: why, or what to do after", CARD_CONTROLS),
    absent("permission.rule.edit", ["e"], "Edit the rule that row would save", RULES_PER_SESSION, notInGui(RULES_PER_SESSION)),
    absent("permission.scope.walk", ["s"], "Walk the scope it is saved at", RULES_PER_SESSION, notInGui(RULES_PER_SESSION)),
    key("permission.tick", ["Space"], "Tick one of several options", CARD_CONTROLS),
    guiOnly("permission.allow", "Allow it once, send the answer, or approve the plan", inGui(["Mod+Enter"])),
  ]),
  group("The whole transcript", "pager", [
    key("pager.line", ["j", "k", "↑", "↓"], "A line", NO_PAGER),
    key("pager.screenDown", ["Space"], "A screen on", NO_PAGER),
    key("pager.screenUp", ["b"], "A screen back", NO_PAGER),
    key("pager.halfDown", ["PgDn", "Ctrl+D"], "Half a screen on", NO_PAGER),
    key("pager.halfUp", ["PgUp", "Ctrl+U"], "Half a screen back", NO_PAGER),
    key("pager.top", ["g", "Home"], "The top", NO_PAGER),
    key("pager.bottom", ["G", "End"], "The bottom", NO_PAGER),
    key("pager.turn.next", ["}"], "The next turn", NO_PAGER),
    key("pager.turn.prev", ["{"], "The turn before", NO_PAGER),
    key("pager.search", ["/"], "Search the whole conversation", FIND_BAR),
    key("pager.match", ["n", "N"], "The next match, the one before", FIND_BAR),
    key("pager.editor", ["v"], "Open the conversation in your editor", NO_PAGER),
    key("pager.copy", ["y"], "Copy the file or document the page reads, whole", SELECTED_TEXT),
    key("pager.close", ["q", "Esc"], "Close it", NO_PAGER),
  ]),
  group("A terminal pane", "terminal", [
    key("terminal.leave", ["Ctrl+\\"], "Leave the pane; twice sends the key to the shell", notInGui("The GUI leaves the terminal pane with a click, and every key in it goes to the shell.")),
    key("terminal.scrollback", ["Ctrl+O"], "Open the retained scrollback in the pager", notInGui("The GUI's terminal pane keeps its scrollback, with its scroll bar.")),
  ]),
  group("The parked asks", "asks", [
    key("asks.move", ["↑", "↓"], "Move the cursor", PARKED_ASKS),
    key("asks.open", ["Enter"], "Open the session it came from", PARKED_ASKS),
    key("asks.allow", ["y"], "Allow it once", PARKED_ASKS),
    key("asks.deny", ["n"], "Deny it", PARKED_ASKS),
    key("asks.allowAll", ["a"], "Allow every approval listed, once confirmed", PARKED_ASKS),
    key("asks.denyAll", ["N"], "Deny every approval listed, once confirmed", PARKED_ASKS),
    key("asks.close", ["Esc"], "Close, deciding nothing", PARKED_ASKS),
  ]),
  group("A yes or no offer", "confirm", [key("confirm.yes", ["y"], "Yes", CONFIRM_DIALOG), key("confirm.no", ["n", "Esc"], "No", CONFIRM_DIALOG)]),
  group("The routines", "routines", [
    key("routines.runNow", ["r"], "Run the routine now", ROUTINES_PANE),
    key("routines.enable", ["Space"], "Enable the routine, or disable it", ROUTINES_PANE),
    key("routines.move", ["m"], "Move the routine to another environment", ROUTINES_PANE),
    key("routines.history", ["h"], "Its firings and skips, newest first", ROUTINES_PANE),
    key("routines.export", ["x"], "Export it to a file, as YAML", ROUTINES_PANE),
    key("routines.edit", ["e"], "Edit it as YAML in your editor", ROUTINES_PANE),
    key("routines.endpoint.add", ["a"], "Add a webhook endpoint, or replace one", ROUTINES_PANE),
    key("routines.endpoint.test", ["t"], "Post a test to the endpoint", ROUTINES_PANE),
    key("routines.endpoint.remove", ["d"], "Remove the endpoint, once confirmed", ROUTINES_PANE),
  ]),
  group(SLASH_COMMANDS_TITLE, "composer", [
    command("profile", "/profile", "Switch the account the next conversation runs as", { aliasOf: "command.account" }),
    command("model", "/model", "Choose the model, and its effort where it has one"),
    command("mode", "/mode", "Set the permission mode for the next turn"),
    command("resume", "/resume", "Pick up a stored conversation from this directory"),
    command("attach", "/attach <path>", "Send an image or file with the next message"),
    command("copy", "/copy", "Copy the last reply, or one of its code blocks, to the clipboard"),
    command("export", "/export [file]", "Write this conversation to a markdown file"),
    command("diff", "/diff", "What this conversation changed, and the working tree's diff"),
    command("undo", "/undo", "Take back the last file change the agent made"),
    command("check", "/check [command|off|now]", "Run this project's own lint or tests after the agent edits"),
    command("pin", "/pin", "Keep this conversation at the top of its folder"),
    command("title", "/title <name>", "Name this conversation"),
    command("asks", "/asks", "Every conversation waiting on a permission, answerable in one list"),
    command("timeline", "/timeline", "One line per turn: when, what, how long, what it cost, what it touched", {
      guiAbsent: "The GUI shows each turn's cost line in the transcript, and the run's details in run info (Mod+I).",
    }),
    command("snip", "/snip [name] [words]", "Expand a saved snippet, or list them; save, rm and --examples keep them", {
      guiAbsent: "Snippets are the terminal UI's own, kept in its state directory.",
    }),
    command("tasks", "/tasks", "Background work: what is running, and what a delegated agent did"),
    command("usage", "/usage", "The account's plan windows and how full they are"),
    command("handoff", "/handoff", "Move this conversation to another account, or start it fresh there"),
    command("cwd", "/cwd", "Choose where to work: a folder you have used, or browse for one"),
    command("new", "/new", "Start a fresh conversation on the same account"),
    command("help", "/help", "List these commands"),
    command("quit", "/quit", "Leave", { guiAbsent: "The GUI's window closes as the platform's windows do." }),
    command("account", "/account", "Switch the account this session's next run uses, or add one"),
    command("environment", "/environment [rename <name> | icon [icon] | colour [colour]]", "The environments: enable, disable, remove, set primary, client sessions; rename one, set its icon or colour; its version and update"),
    command("pair", "/pair <link> | <address> <code> | create", "Pair with an environment, or create a code for another client"),
    command("containment", "/containment", "Set how contained this session's runs are"),
    command("setup", "/setup [environment]", "How far Set up is on an environment, and where to run it"),
    command("settings", "/settings [row]", "Every environment setting under its row, in a generic editor; a row's id opens that row"),
    command("review", "/review", "Runs to review: unattended ones, and what was denied"),
    command("archive", "/archive", "Archive this session, or unarchive it"),
    command("group", "/group [name]", "Put this session in a group, or a new one"),
    command("tag", "/tag <tag>", "Tag this session"),
    command("settle", "/settle", "Settle this session, or unsettle it"),
    command("snooze", "/snooze [when]", "Snooze this session until a time you pick"),
    command("restore", "/restore", "Bring back a session deleted within the grace period"),
    command("search", "/search <text>", "Search the sessions on every environment"),
    command("terminal", "/terminal", "Open a terminal on the session's environment, in a pane"),
    command("files", "/files [path]", "Browse the workspace's files, and read one in the pager"),
    command("browser", "/browser", "Choose this session's browser for its next run, or pair Chrome"),
    command("documents", "/documents", "The pages, SVGs and markdown this session wrote, newest first"),
    command("trust", "/trust [decline]", "Trust this session's repository, or decline its offer", { guiAbsent: "Trust is decided in the session's trust question." }),
    command("notices", "/notices", "Every notice this terminal has shown"),
    command("reload", "/reload", "Read the keybindings file again", {
      guiAbsent: "The GUI reads no keybindings file: its keys are remapped in the Keyboard shortcuts pane.",
    }),
    command("fork", "/fork [n]", "Fork this session n prompts back; bare, at the end"),
    command("rewind", "/rewind [n | undo]", "Rewind n prompts, one by default; undo takes the rewind back"),
    command(
      "routines",
      "/routines [new | import <path> | endpoints | test-precheck <name>]",
      "Every environment's routines: run, enable, history, export and edit; a new one, an import, the webhook endpoints, a pre-check's test",
    ),
  ]),
] as const satisfies readonly ActionGroup[];

type Listed = (typeof ACTION_GROUPS)[number]["actions"][number];

/** Every id of the shared list. */
export type ActionId = Listed["id"];
/** A slash command's id: `command.<name>`. */
export type CommandActionId = Extract<ActionId, `command.${string}`>;
/** An id of an action pressed rather than typed. */
export type KeyActionId = Exclude<ActionId, CommandActionId>;

/** An entry of the list, its id one of the list's. */
export type ListedAction = Action & { readonly id: ActionId };

/** The desktop shell owns these fixed keys; a web client leaves them to its browser. */
export const DESKTOP_ZOOM_ACTIONS = ["app.zoom.in", "app.zoom.out", "app.zoom.reset"] as const satisfies readonly KeyActionId[];
export const isDesktopZoomAction = (id: string): boolean => DESKTOP_ZOOM_ACTIONS.some((action) => action === id);

/** The shared action list, in the help overlay's order. */
export const ACTIONS: readonly ListedAction[] = ACTION_GROUPS.flatMap((g) => g.actions as readonly Action[]) as readonly ListedAction[];

const BY_ID = new Map<string, ListedAction>(ACTIONS.map((action) => [action.id, action]));

/** Whether `id` names an action of the list. */
export const isActionId = (id: string): id is ActionId => BY_ID.has(id);

/** The action `id` names; undefined when the list has none. */
export const actionById = (id: string): ListedAction | undefined => BY_ID.get(id);

/** Whether `id` is a slash command's. */
export const isCommandId = (id: string): id is CommandActionId => id.startsWith("command.") && BY_ID.has(id);

/** One action's keys in its context, as the clash rule reads them: a column's defaults, or a client's remap of that column. */
export interface KeyBinding {
  readonly id: string;
  readonly context: string;
  readonly keys: readonly string[];
  readonly when?: ActionCondition | undefined;
}

/** A key two actions hold in one context where the rule admits only one of them: the one that held it, then the other. */
export interface KeyClash {
  readonly context: string;
  readonly key: string;
  readonly ids: readonly [string, string];
}

/**
 * The clash rule (the tui spec's "Shortcuts"; #144, #231; the GUI spec's
 * "Binding rules"), run on one column at a time: the terminal's defaults and
 * keybindings file, or the GUI's defaults and remaps (`off` keys counted,
 * since turning them on must not clash). In one context the actions holding
 * a key nest: of any two, one's condition lies within the other's
 * (`conditionWithin`; no condition is the widest). The narrowest is asked
 * first, and the key falls to the next wider when its condition does not
 * hold, so `↑` is `composer.withdrawLast` on an empty composer and
 * `composer.navigate` otherwise (in the GUI, from the start of the box).
 * Two holders under one condition clash, two unconditioned ones included,
 * and so do two whose conditions neither lies within the other, since both
 * could hold at once. The same action holding a key twice is no clash. The
 * list's defaults keep the rule in both columns (a contract test), and a
 * keybindings file that breaks it is refused whole.
 */
export const keyClashes = (bindings: Iterable<KeyBinding>): KeyClash[] => {
  const holders = new Map<string, { readonly id: string; readonly when: ActionCondition | undefined }[]>();
  const clashes: KeyClash[] = [];
  const nest = (a: ActionCondition | undefined, b: ActionCondition | undefined) => a !== b && (conditionWithin(a, b) || conditionWithin(b, a));
  for (const binding of bindings) {
    for (const k of binding.keys) {
      const slot = `${binding.context} ${k}`;
      const held = holders.get(slot) ?? [];
      if (held.some((holder) => holder.id === binding.id)) continue;
      const other = held.find((holder) => !nest(holder.when, binding.when));
      if (other !== undefined) clashes.push({ context: binding.context, key: k, ids: [other.id, binding.id] });
      else holders.set(slot, [...held, { id: binding.id, when: binding.when }]);
    }
  }
  return clashes;
};

/**
 * The actions that stop a live run, which no Ctrl+C or Mod+C may be (ADR
 * 0022: Ctrl+C is copy and never stops a run): the interrupt in both its
 * terminal keys, and read-now, which interrupts the run to read the queue.
 */
export const RUN_STOPPING_ACTIONS: ReadonlySet<KeyActionId> = new Set<KeyActionId>(["app.interrupt", "app.interruptOrQuit", "composer.readNow"]);

/** What a text field does with Mod and each letter the GUI reserves to it. */
const TEXT_FIELD_CHORDS: Readonly<Record<string, string>> = { C: "copies", X: "cuts", A: "selects all", Z: "undoes", V: "pastes" };

/** A key name's modifiers, lower-cased and sorted, and its key, a letter upper-cased: `mod+shift c` for `Shift+Mod+c`. */
const chordOf = (key: string): { readonly modifiers: string; readonly key: string } => {
  const parts = key.split("+");
  const last = parts.at(-1) ?? "";
  return { modifiers: parts.slice(0, -1).map((part) => part.toLowerCase()).sort().join("+"), key: /^[a-z]$/i.test(last) ? last.toUpperCase() : last };
};

/**
 * Why `key` may not be one of the GUI keys of the action `id`, or undefined
 * when it may: the GUI spec's binding rules, which a client checks before
 * saving a remap. Ctrl+C and Mod+C never stop a run (ADR 0022); Mod+C,
 * Mod+X, Mod+A and Mod+Z are a text field's copy, cut, select-all and undo,
 * which no action takes; Mod+V is its paste, which only `composer.paste`
 * takes. Keys are read as the column writes them, `Mod` being the
 * platform's command key, so a client writes Ctrl only for macOS's Control
 * key; modifiers in any order, a letter in either case.
 */
export const reservedGuiKey = (id: string, key: string): string | undefined => {
  const chord = chordOf(key);
  const stops = RUN_STOPPING_ACTIONS.has(id as KeyActionId);
  if (stops && chord.key === "C" && (chord.modifiers === "mod" || chord.modifiers === "ctrl"))
    return `${key} is copy, and Ctrl+C or Mod+C never stops a run (ADR 0022).`;
  const does = chord.modifiers === "mod" ? TEXT_FIELD_CHORDS[chord.key] : undefined;
  if (does === undefined || (chord.key === "V" && id === "composer.paste")) return undefined;
  return chord.key === "V" ? `${key} pastes into a text field: only composer.paste takes it.` : `${key} ${does} in a text field: no action takes it.`;
};

/**
 * The composer's sigils: syntax, not keys. What is typed after one is parsed
 * as a command, a path, a snippet or a shell line whatever the keymap says;
 * only the menu each opens as it is typed is an action, named here, and `!!`
 * opens none of its own (it is `!`'s row).
 */
export const SIGILS = {
  "/": "composer.command.menu",
  "@": "composer.file.mention",
  ";;": "composer.snippet.expand",
  "!": "composer.shell",
  "!!": null,
} as const satisfies Record<string, KeyActionId | null>;
