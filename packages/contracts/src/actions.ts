import { z } from "zod";

/**
 * The shared action list (ADR 0004; the tui spec's "Shortcuts: the shared
 * action list, the defaults, the keybindings file"; #144). Every key a client
 * answers is a named action here: its id, the context it is answered in, its
 * default keys, a one-line description, and whether the harness wires it or
 * keeps its keys absent with a reason. The defaults are the reference
 * terminal map exactly, which a contract test holds as a fixture, plus the
 * actions the harness adds. The terminal UI's map is a projection of this
 * list and its keybindings file remaps it by id; the GUI's defaults for the
 * same ids are its own column, not written here.
 *
 * The list is data in groups: the order is the order the help overlay draws,
 * each group one context. Sigils typed into the
 * composer (`/`, `@`, `;;`, `!`, `!!`) are syntax, not keys: only their menu
 * triggers are actions (`SIGILS`).
 */

/**
 * The eleven places a key means what it means: the reference keymap's eight
 * (`anywhere` is the handful no component may take) plus the terminal pane,
 * the parked-asks card and the one-line yes or no offers.
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
] as const;

export const ActionContext = z.enum(ACTION_CONTEXTS).meta({
  description:
    "Where a key means what it means: anywhere (keys no component may take), composer, transcript, sidebar (the rail), delegated (the delegated-work strip), picker (a list to choose from), permission (a permission or question card), pager, terminal (the terminal pane), asks (the parked-asks card), confirm (a one-line yes or no offer). A key is claimed at most once per context.",
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
} as const satisfies Record<string, ActionContext>;

const ACTION_ID_PATTERN = new RegExp(`^(${Object.keys(ACTION_ID_PREFIXES).join("|")})(\\.[a-z][A-Za-z]*)+$`);

/**
 * The conditions an action's keys may be declared under (#231): each named
 * `<context>.<state>`, answered only in its own context, with the words the
 * help overlay and the tui spec's table write after the keys and what the
 * condition means. A conditioned action is asked for its key before an
 * unconditioned one holding the same key in the same context, and the key
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
  },
} as const satisfies Record<string, { readonly context: ActionContext; readonly words: string; readonly description: string }>;

/** Each condition as the schema's description lists it: its id, the words written after the keys, and what it means. */
const conditionTable = Object.entries(ACTION_CONDITIONS)
  .map(([id, condition]) => `${id} (written "${condition.words}" after the keys, in the ${condition.context} context): ${condition.description}`)
  .join(" ");

export const ActionCondition = z.enum(Object.keys(ACTION_CONDITIONS) as [keyof typeof ACTION_CONDITIONS, ...(keyof typeof ACTION_CONDITIONS)[]]).meta({
  description: `A condition an action's keys are answered under, named <context>.<state>. ${conditionTable} A conditioned action is asked first for a key it shares with an unconditioned action of its context; the key falls to that one when the condition does not hold.`,
});
export type ActionCondition = z.infer<typeof ActionCondition>;

const ActionFields = {
  id: z.string().regex(ACTION_ID_PATTERN).meta({
    description:
      "`<context>.<verb>`, where the prefix app is the context anywhere, row is transcript and rail is sidebar; `command.<name>` for a slash command.",
  }),
  context: ActionContext,
  keys: z.array(z.string().min(1)).meta({
    description:
      "The default keys, each an alternative, written as the tui spec's table writes them (`Ctrl+C`, `Esc Esc`, `↑`); empty for a slash command, which is typed rather than pressed.",
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
      "For a key answered only under a condition of its own context: the condition. Such an action may share a default key with one unconditioned action of its context, and is asked first; absent, the key is the action's whenever its context has the keys.",
  }),
};

const WiredAction = z.object({ ...ActionFields, status: z.literal("wired") }).meta({ description: "An action the harness answers." });

const AbsentAction = z
  .object({
    ...ActionFields,
    status: z.literal("absent"),
    reason: z.string().min(1).meta({ description: "Why the harness answers it absent: the help overlay draws the row dim with this." }),
  })
  .meta({ description: "An action the harness keeps the keys of but does not answer: drawn dim with its reason." });

/**
 * One entry of the shared action list. The rules that tie its fields
 * together are zod's half only, as `EventFrame`'s sequence rule is: the id's
 * first word names its context (`row` is `transcript`, `rail` is `sidebar`,
 * `app` is `anywhere`, `command` is `composer`); a slash command has a usage
 * line and no keys or condition, any other action keys and no usage line;
 * a condition is one of the action's own context; only a slash command is an
 * alias. The JSON Schema export cannot state them, so a client in another
 * language checks them itself.
 */
export const Action = z
  .discriminatedUnion("status", [WiredAction, AbsentAction])
  .superRefine((action, ctx) => {
    const prefix = action.id.slice(0, action.id.indexOf(".")) as keyof typeof ACTION_ID_PREFIXES;
    const context = ACTION_ID_PREFIXES[prefix];
    if (context !== action.context) ctx.addIssue({ code: "custom", path: ["context"], message: `${action.id} is an action of the context ${context}.` });
    if (action.when !== undefined && ACTION_CONDITIONS[action.when].context !== action.context)
      ctx.addIssue({ code: "custom", path: ["when"], message: `${action.when} is a condition of the context ${ACTION_CONDITIONS[action.when].context}.` });
    if (prefix === "command") {
      if (action.keys.length > 0) ctx.addIssue({ code: "custom", path: ["keys"], message: "A slash command is typed: it has no keys." });
      if (action.when !== undefined) ctx.addIssue({ code: "custom", path: ["when"], message: "A slash command is typed: it has no condition." });
      if (action.usage === undefined) ctx.addIssue({ code: "custom", path: ["usage"], message: "A slash command has a usage line." });
      else if (!action.usage.startsWith(`/${action.id.slice("command.".length)}`))
        ctx.addIssue({ code: "custom", path: ["usage"], message: "A slash command's usage line starts with its name." });
    } else {
      if (action.keys.length === 0) ctx.addIssue({ code: "custom", path: ["keys"], message: "An action that is pressed has at least one key." });
      if (action.usage !== undefined) ctx.addIssue({ code: "custom", path: ["usage"], message: "Only a slash command has a usage line." });
      if (action.aliasOf !== undefined) ctx.addIssue({ code: "custom", path: ["aliasOf"], message: "Only a slash command is an alias." });
    }
  })
  .meta({
    description:
      "One named action of the shared list: its id, context, default keys and description, a condition its keys are answered under where it has one, and wired or absent with a reason. The id's first word names its context (row is transcript, rail is sidebar, app is anywhere, command is composer); a slash command has a usage line and no keys or condition, any other action keys and no usage line, a condition is one of the action's own context, and only a slash command is an alias: rules the decoder keeps and this schema cannot state.",
  });
export type Action = z.infer<typeof Action>;

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
}

/** A key the harness answers; `when`, a condition it is answered under. */
const key = <const Id extends string>(id: Id, keys: readonly string[], description: string, when?: ActionCondition): Row<Id> => ({
  id,
  keys,
  description,
  status: "wired",
  ...(when !== undefined && { when }),
});

/** A key the harness keeps but answers absent, with the reason. */
const absent = <const Id extends string>(id: Id, keys: readonly string[], description: string, reason: string): Row<Id> => ({
  id,
  keys,
  description,
  status: "absent",
  reason,
});

/** A slash command: typed, so it has no keys; its usage line is what the menu and the overlay print. */
const command = <const Name extends string>(
  name: Name,
  usage: string,
  description: string,
  more: { readonly absent?: string; readonly aliasOf?: string } = {},
): Row<`command.${Name}`> => ({
  id: `command.${name}`,
  keys: [],
  description,
  usage,
  ...(more.absent === undefined ? { status: "wired" as const } : { status: "absent" as const, reason: more.absent }),
  ...(more.aliasOf !== undefined && { aliasOf: more.aliasOf }),
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
const PHASE_D = "Deferred to phase D, carried if Seth relies on it (docs/specs/tui.md, Out of Scope).";

/** The title of the slash-command group, which the help overlay draws last. */
export const SLASH_COMMANDS_TITLE = "Slash commands";

/**
 * The list, in groups. The reference keymap's rows come first in each of its
 * groups, in its order and with its words; the harness's additions follow
 * them (ADR 0022's fork, rewind, read-now and withdraw keys, the rail's
 * organisation keys), then the three contexts the harness adds, then the
 * slash commands: the reference's, in its order, then the harness's.
 */
export const ACTION_GROUPS = [
  group("Anywhere", "anywhere", [
    key("app.focus.next", ["Tab"], "Round the composer, the list, the strip and the rows"),
    key("app.mode.step", ["Shift+Tab"], "Step the permission mode on"),
    key("app.interrupt", ["Esc"], "Interrupt; or follow the end again"),
    key("app.prompt.back", ["Esc Esc"], "Go back to an earlier prompt"),
    key("app.interruptOrQuit", ["Ctrl+C"], "Interrupt; again in a moment to quit"),
    key("app.pager.open", ["Ctrl+O"], "Unfold the whole transcript"),
    key("app.checklist.toggle", ["Ctrl+T"], "Show or hide the checklist"),
    key("app.attention.next", ["Ctrl+]"], "Go to the next conversation that needs you"),
    key("app.handoff", ["Alt+H"], "Hand this conversation to another account"),
    key("app.help", ["?"], "Open this map, from an empty composer"),
  ]),
  group("Writing a message", "composer", [
    key("composer.send", ["Enter"], "Send it, steer a turn, run a row, send a failed check"),
    key("composer.newline", ["Shift+Enter", "Ctrl+J"], "A newline instead of sending"),
    key("composer.continueLine", ["\\ Enter"], "A backslash keeps the line open"),
    key("composer.navigate", ["↑", "↓"], "The text, then the queue, then history"),
    key("composer.command.menu", ["/"], "Start a command, and see the menu"),
    key("composer.file.mention", ["@"], "Name a file, and see the paths"),
    key("composer.snippet.expand", [";;"], "Expand a saved snippet; Tab walks its slots"),
    key("composer.complete", ["Tab"], "Fill in the highlighted row, or the next slot"),
    key("composer.slot.back", ["Shift+Tab"], "Back to the slot before, in a snippet"),
    key("composer.shell", ["!"], "Run a shell command; !! sends the output"),
    key("composer.paste", ["Ctrl+V"], "Paste an image, or the text there"),
    key("composer.editor", ["Ctrl+G"], "Edit the draft in $EDITOR"),
    key("composer.suggestion.take", ["1–4"], "Take one of the follow-ups the agent offered"),
    key("composer.readNow", ["Ctrl+Enter"], "Have the queued message read now, mid-turn"),
    key("composer.withdrawLast", ["↑"], "Take the newest queued message back to edit", "composer.empty"),
  ]),
  group("Moving and editing", "composer", [
    key("composer.line.start", ["Ctrl+A", "Home"], "The start of the line"),
    key("composer.line.end", ["Ctrl+E", "End"], "The end of it"),
    key("composer.buffer.start", ["Ctrl+Home"], "The start of everything typed"),
    key("composer.buffer.end", ["Ctrl+End"], "The end of everything typed"),
    key("composer.word.back", ["Alt+B", "Ctrl+←"], "A word back"),
    key("composer.word.forward", ["Alt+F", "Ctrl+→"], "A word on"),
    key("composer.word.deleteBack", ["Ctrl+W"], "Rub out the word before the cursor"),
    key("composer.word.deleteForward", ["Alt+D"], "Delete the word after it"),
    key("composer.cut.toStart", ["Ctrl+U"], "Cut back to the start of the line"),
    key("composer.cut.toEnd", ["Ctrl+K"], "Cut on to the end of it"),
    key("composer.yank", ["Ctrl+Y"], "Put back the last thing cut"),
    key("composer.undo", ["Ctrl+_"], "Undo"),
    key("composer.backspace", ["Backspace"], "A whole paste chip; or the search query"),
  ]),
  group("What you typed before", "composer", [
    key("composer.history.search", ["Ctrl+R"], "Search back through past prompts"),
    key("composer.history.scopeOrStash", ["Ctrl+S"], "What the search looks at; outside one, stash the draft"),
  ]),
  group("The conversation", "transcript", [
    key("transcript.pageUp", ["PgUp", "Shift+↑", "Ctrl+↑"], "Half a screen back"),
    key("transcript.pageDown", ["PgDn", "Shift+↓", "Ctrl+↓"], "Half a screen on"),
    key("transcript.cursor", ["↑", "↓"], "The cursor’s row here; a line, from the box"),
    key("transcript.follow", ["End"], "Back to the end, and follow it"),
  ]),
  group("A row of the conversation", "transcript", [
    key("row.open", ["o"], "Open the file it touched, at the line"),
    key("row.recall", ["r"], "Put the command it ran back in the composer"),
    key("row.copy", ["y"], "Copy the row — a diff as a diff"),
    key("row.diff", ["d"], "The whole diff it wrote"),
    key("row.unfold", ["Enter"], "Unfold what the row is holding back"),
    key("row.stop", ["x"], "Stop the call that is still running"),
    key("row.leave", ["Esc"], "Put the cursor away, back to the composer"),
    key("row.rewind", ["w"], "Rewind to this prompt"),
    key("row.fork", ["f"], "Fork a new session from this prompt"),
    key("row.rewindUndo", ["u"], "Undo the rewind, on the rewound fold"),
  ]),
  group("The conversation list", "sidebar", [
    key("rail.move", ["↑", "↓"], "Move the cursor"),
    key("rail.moveVi", ["k", "j"], "The same — until a filter is being typed"),
    key("rail.open", ["Enter"], "Open it, or fold the folder"),
    key("rail.filter", ["/"], "Filter the list by what you type"),
    key("rail.filter.erase", ["Backspace"], "Rub a letter off the filter"),
    key("rail.preview", ["Space"], "Show what a conversation is, unopened"),
    key("rail.archive", ["a"], "Archive the one under the cursor"),
    key("rail.delete", ["d"], "Delete it"),
    key("rail.pin", ["p"], "Pin it to the top of its folder"),
    key("rail.archive.filtering", ["Ctrl+A"], "Archive it, while a filter is being typed"),
    key("rail.delete.filtering", ["Ctrl+D"], "Delete it, while filtering"),
    key("rail.pin.filtering", ["Ctrl+P"], "Pin it, while filtering"),
    key("rail.leave", ["Esc"], "Clear the filter; then back to the composer"),
    key("rail.settle", ["s"], "Settle it, or unsettle it"),
    key("rail.snooze", ["z"], "Snooze it until a time you pick"),
    key("rail.tag", ["t"], "Tag it"),
    key("rail.group", ["g"], "Put it in a group, or a new one"),
    key("rail.moveUp", ["Shift+↑"], "Move it up, among the pinned or the active"),
    key("rail.moveDown", ["Shift+↓"], "Move it down, among the pinned or the active"),
  ]),
  group("Delegated work", "delegated", [
    key("delegated.enter", ["Tab"], "Reached after the list, while work is running"),
    key("delegated.move", ["↑", "↓"], "Move down the strip"),
    key("delegated.open", ["Enter"], "Open what that agent did"),
    key("delegated.stop", ["x"], "Stop the task under the cursor"),
    key("delegated.unfold", ["→"], "Unfold a workflow's agents"),
    key("delegated.fold", ["←"], "Fold them again"),
    key("delegated.leave", ["Esc"], "Back to the composer"),
  ]),
  group("A list to choose from", "picker", [
    key("picker.move", ["↑", "↓"], "Move the cursor"),
    key("picker.moveVi", ["k", "j"], "The same, in a list that is not typed at"),
    key("picker.filter", ["Letters"], "Type to filter a long list"),
    key("picker.choose", ["Enter"], "Choose the row under the cursor"),
    key("picker.preview", ["Space"], "Preview it without opening it"),
    key("picker.rename", ["Ctrl+R"], "Rename the conversation under the cursor"),
    key("picker.archive", ["Ctrl+A"], "Archive it"),
    key("picker.pin", ["Ctrl+P"], "Pin it"),
    key("picker.leave", ["Esc"], "Clear the query; then close the list"),
    key("picker.branch", ["b"], "Branch a new session here, in the prompt picker"),
  ]),
  group("A permission card", "permission", [
    key("permission.move", ["↑", "↓", "k", "j"], "Move down the answers"),
    key("permission.choose", ["Enter"], "Choose the one under the cursor"),
    key("permission.deny", ["Esc"], "Deny it; on a question, skip it"),
    key("permission.note", ["Tab"], "A line: why, or what to do after"),
    absent("permission.rule.edit", ["e"], "Edit the rule that row would save", RULES_PER_SESSION),
    absent("permission.scope.walk", ["s"], "Walk the scope it is saved at", RULES_PER_SESSION),
    key("permission.tick", ["Space"], "Tick one of several options"),
  ]),
  group("The whole transcript", "pager", [
    key("pager.line", ["j", "k", "↑", "↓"], "A line"),
    key("pager.screenDown", ["Space"], "A screen on"),
    key("pager.screenUp", ["b"], "A screen back"),
    key("pager.halfDown", ["PgDn", "Ctrl+D"], "Half a screen on"),
    key("pager.halfUp", ["PgUp", "Ctrl+U"], "Half a screen back"),
    key("pager.top", ["g", "Home"], "The top"),
    key("pager.bottom", ["G", "End"], "The bottom"),
    key("pager.turn.next", ["}"], "The next turn"),
    key("pager.turn.prev", ["{"], "The turn before"),
    key("pager.search", ["/"], "Search the whole conversation"),
    key("pager.match", ["n", "N"], "The next match, the one before"),
    key("pager.editor", ["v"], "Open the conversation in your editor"),
    key("pager.close", ["q", "Esc"], "Close it"),
  ]),
  group("A terminal pane", "terminal", [
    key("terminal.leave", ["Ctrl+\\"], "Leave the pane; twice sends the key to the shell"),
    key("terminal.scrollback", ["Ctrl+O"], "Open the retained scrollback in the pager"),
  ]),
  group("The parked asks", "asks", [
    key("asks.move", ["↑", "↓"], "Move the cursor"),
    key("asks.open", ["Enter"], "Open the session it came from"),
    key("asks.allow", ["y"], "Allow it once"),
    key("asks.deny", ["n"], "Deny it"),
    key("asks.allowAll", ["a"], "Allow every approval listed, once confirmed"),
    key("asks.denyAll", ["N"], "Deny every approval listed, once confirmed"),
    key("asks.close", ["Esc"], "Close, deciding nothing"),
  ]),
  group("A yes or no offer", "confirm", [key("confirm.yes", ["y"], "Yes"), key("confirm.no", ["n", "Esc"], "No")]),
  group(SLASH_COMMANDS_TITLE, "composer", [
    command("profile", "/profile", "Switch the account the next conversation runs as", { aliasOf: "command.account" }),
    command("model", "/model", "Choose the model, and its effort where it has one"),
    command("mode", "/mode", "Set the permission mode for the next turn"),
    command("resume", "/resume", "Pick up a stored conversation from this directory"),
    command("attach", "/attach <path>", "Send an image or file with the next message"),
    command("copy", "/copy", "Copy the last reply, or one of its code blocks, to the clipboard"),
    command("export", "/export [file]", "Write this conversation to a markdown file"),
    command("diff", "/diff", "What this conversation changed, and the working tree's diff"),
    command("undo", "/undo", "Take back the last file change the agent made", { absent: PHASE_D }),
    command("check", "/check [command|off|now]", "Run this project's own lint or tests after the agent edits", { absent: PHASE_D }),
    command("pin", "/pin", "Keep this conversation at the top of its folder"),
    command("title", "/title <name>", "Name this conversation"),
    command("asks", "/asks", "Every conversation waiting on a permission, answerable in one list"),
    command("timeline", "/timeline", "One line per turn: when, what, how long, what it cost, what it touched"),
    command("snip", "/snip [name] [words]", "Expand a saved snippet, or list them; save, rm and --examples keep them"),
    command("tasks", "/tasks", "Background work: what is running, and what a delegated agent did"),
    command("usage", "/usage", "The account's plan windows and how full they are"),
    command("handoff", "/handoff", "Move this conversation to another account, or start it fresh there"),
    command("cwd", "/cwd", "Choose where to work: a folder you have used, or browse for one"),
    command("new", "/new", "Start a fresh conversation on the same account"),
    command("help", "/help", "List these commands"),
    command("quit", "/quit", "Leave"),
    command("account", "/account", "Switch the account this session's next run uses, or add one"),
    command("environment", "/environment", "The environments: enable, disable, remove, set primary, client sessions"),
    command("pair", "/pair <link> | <address> <code> | create", "Pair with an environment, or create a code for another client"),
    command("containment", "/containment", "Set how contained this session's runs are"),
    command("setup", "/setup [environment]", "How far Set up is on an environment, and where to run it"),
    command("settings", "/settings", "Every environment setting, in a generic editor"),
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
    command("notices", "/notices", "Every notice this terminal has shown"),
    command("reload", "/reload", "Read the keybindings file again"),
    command("fork", "/fork [n]", "Fork this session n prompts back; bare, at the end"),
    command("rewind", "/rewind [n | undo]", "Rewind n prompts, one by default; undo takes the rewind back"),
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

/** The shared action list, in the help overlay's order. */
export const ACTIONS: readonly ListedAction[] = ACTION_GROUPS.flatMap((g) => g.actions as readonly Action[]) as readonly ListedAction[];

const BY_ID = new Map<string, ListedAction>(ACTIONS.map((action) => [action.id, action]));

/** Whether `id` names an action of the list. */
export const isActionId = (id: string): id is ActionId => BY_ID.has(id);

/** The action `id` names; undefined when the list has none. */
export const actionById = (id: string): ListedAction | undefined => BY_ID.get(id);

/** Whether `id` is a slash command's. */
export const isCommandId = (id: string): id is CommandActionId => id.startsWith("command.") && BY_ID.has(id);

/** One action's keys in its context, as the clash rule reads them: a default of the list, or a keybindings file's remap. */
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
 * The clash rule (the tui spec's "Shortcuts"; #144, #231): in one context a
 * key is held by at most one action with no condition and at most one with a
 * condition. The conditioned one is asked first, and the key falls to the
 * other when its condition does not hold, so `↑` is `composer.withdrawLast`
 * on an empty composer and `composer.navigate` otherwise. Two unconditioned
 * holders clash, and so do two conditioned ones, whose conditions could hold
 * at once. The same action holding a key twice is no clash. The list's
 * defaults keep the rule (a contract test), and a keybindings file that
 * breaks it is refused whole.
 */
export const keyClashes = (bindings: Iterable<KeyBinding>): KeyClash[] => {
  const holders = new Map<string, string>();
  const clashes: KeyClash[] = [];
  for (const binding of bindings) {
    for (const k of binding.keys) {
      const slot = `${binding.context} ${k} ${binding.when === undefined ? "always" : "conditioned"}`;
      const other = holders.get(slot);
      if (other !== undefined && other !== binding.id) clashes.push({ context: binding.context, key: k, ids: [other, binding.id] });
      else holders.set(slot, binding.id);
    }
  }
  return clashes;
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
