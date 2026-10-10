import { DenylistSection, ManagedToolName, SETTINGS, type MethodName, type RegisteredStepId, type RunnableToolAction, type SettingsRowId, type SetupAction, type SetupTarget, type StepId, type UpdateWhen } from "@agent-harness/contracts";
import type { Runtime } from "../runtime.js";
import { restoreDenylistPresets, type DenylistRestored } from "../permissions/actions.js";
import { adminCall } from "../status/actions.js";
import { uuidv7 } from "../ids.js";
import { plainRefusal, type PlainRefusal } from "../words/refusal.js";
import { isRegisteredStep } from "./checklist.js";

/**
 * What each named action a step's result offers does (the Set up
 * specification, "Actions"; ADR 0031: actions are commands, so every
 * renderer runs them alike; #413, #573), on the items its result names as
 * its targets (#568): `check-again` is `setup.check` of the step;
 * `restore` the step's restore (the denylist's presets put back in the
 * sections it names, the preset theme written back); `start-service`
 * `connections.startService`; `set-up-this-machine` the checklist switched
 * to the environment it names; `sign-in-again` the sign-in of the account it
 * names (a forge account's Forges, a key-manager connection's Key managers);
 * `update` on Your machines `updates.apply`, and `how-to-set-up` there the
 * host-side updater's setup (#1883); `turn-sandbox-off` on Permissions the
 * containment default written off, which the step's card does (#1858); `install` and `update` of a
 * tool `tools.run` in a tool terminal; `pull-now` `skills.sources.pull` for
 * each source named (#733); `move` the Key manager step's Move card, on
 * Key managers; `check-certificate` Key managers, where each connection's
 * certificate check is (#1852); `choose-folders` the Skills card's look
 * for a moved collection's folders, else its home row (#1855). The authoring and import verbs are the
 * step's card's (`card`). Every other verb opens the step's home row;
 * Browser's card binds its verbs to the browser's methods (#548, #593).
 */

/** Each action in words, as a button names it: ADR 0031's names and the step decisions' verbs, as setup-copy.md words them. */
export const SETUP_ACTION_WORDS: { readonly [Action in SetupAction]: string } = {
  "sign-in-again": "Sign in again",
  "pull-now": "Update now",
  "check-again": "Check again",
  unpair: "Unpair",
  "pair-another": "Pair another",
  install: "Install",
  update: "Update",
  reload: "Reload",
  "set-up-this-machine": "Set up this machine",
  restore: "Restore",
  move: "Move",
  "start-service": "Start",
  "import-again": "Bring them over",
  "try-again": "Continue it",
  "write-it-myself": "Write it myself",
  "start-over": "Start again",
  revise: "Fix the description",
  "check-certificate": "Check certificate",
  "how-to-set-up": "How to set it up",
  "choose-folders": "Choose folders",
  "turn-sandbox-off": "Turn the sandbox off",
};

/** The steps with a restore of their own: the Permissions step's denylist presets and the Appearance step's preset theme. */
export type RestorableStep = Extract<StepId, "permissions" | "appearance">;

/** The method each step's restore calls (`restoreStep`), whose capability says whether a connection may restore it. */
export const RESTORE_METHODS: { readonly [Step in RestorableStep]: MethodName } = {
  permissions: "permissions.denylist.restorePresets",
  appearance: "settings.update",
};

/** The verbs a step's card carries out itself (the Set up specification, "Actions" and "The LLM step"): an import run again, and an authoring session's. */
export type CardAction = Extract<SetupAction, "import-again" | "try-again" | "write-it-myself" | "start-over" | "revise">;

const CARD_ACTIONS: readonly SetupAction[] = ["import-again", "try-again", "write-it-myself", "start-over", "revise"] satisfies readonly CardAction[];
const isCardAction = (action: SetupAction): action is CardAction => CARD_ACTIONS.includes(action);

/** An item an action applies to, as a person reads it. */
export interface NamedItem {
  readonly id: string;
  readonly label: string;
}

/** What doing an action is, for a renderer to carry out. */
export type SetupActionPlan =
  /** `setup.check` of the step, or of every step when this build cannot ask about it alone. */
  | { readonly kind: "check"; readonly step: RegisteredStepId | undefined }
  /** The step's restore (`restoreStep`), of the denylist sections named or of every one, then its check again. */
  | { readonly kind: "restore"; readonly step: RestorableStep; readonly sections: readonly DenylistSection[] | undefined }
  /** `connections.startService` of the environment checked. */
  | { readonly kind: "start-service" }
  /** The checklist switched to another environment. */
  | { readonly kind: "pick"; readonly environmentId: string }
  /** The sign-in of an account of the environment checked (`accounts.signin.start`, through the sign-in card). */
  | { readonly kind: "sign-in"; readonly account: NamedItem }
  /** The environment checked updated, under its idle rules (`updateEnvironment`). */
  | { readonly kind: "update" }
  /** `skills.sources.pull` of each source the result names. */
  | { readonly kind: "pull-sources"; readonly sources: readonly NamedItem[] }
  /** `tools.run` for this tool's Install or Update, opening its tool terminal. */
  | { readonly kind: "run-tool"; readonly tool: ManagedToolName; readonly action: RunnableToolAction }
  /** About's Managed tools on the environment checked, where a tool's Install or Update runs in a tool terminal (#426). */
  | { readonly kind: "managed-tools" }
  /** How to set up the host-side updater, which a container no updater has polled needs (`HOST_UPDATER_SETUP`, #1883). */
  | { readonly kind: "host-updater-setup" }
  /** A verb the step's card carries out on the items named; on a step with no card of its own, its home row. */
  | { readonly kind: "card"; readonly action: CardAction; readonly targets: readonly SetupTarget[]; readonly home: SettingsRowId }
  /** A row of Settings opened on the environment checked. */
  | { readonly kind: "row"; readonly row: SettingsRowId };

/** A step as an action reads it: which step, and its home row. */
export interface ActingStep {
  readonly id: StepId;
  readonly home: SettingsRowId;
}

/** Where the sign-in of an item that is no provider account is given until its card is built: the row it lives on. */
const SIGN_IN_ROWS: { readonly [Kind in SetupTarget["kind"]]?: SettingsRowId } = {
  "forge-account": "access.forges",
  "key-manager-connection": "access.key-managers",
};

/**
 * What `action`, offered by `step`'s result, does on those of `targets`
 * that serve it: the one item a button acts on, or every item Restore
 * names.
 */
export const planSetupAction = (step: ActingStep, action: SetupAction, given: readonly SetupTarget[] = []): SetupActionPlan => {
  const targets = given.filter((target) => target.action === action);
  const [first] = targets;
  if (isCardAction(action)) return { kind: "card", action, targets, home: step.home };
  switch (action) {
    case "check-again":
      return { kind: "check", step: isRegisteredStep(step.id) ? step.id : undefined };
    case "restore": {
      if (step.id === "appearance") return { kind: "restore", step: "appearance", sections: undefined };
      if (step.id !== "permissions") return { kind: "row", row: step.home };
      const sections = targets.flatMap((target) => {
        const section = DenylistSection.safeParse(target.id);
        return target.kind === "denylist-section" && section.success ? [section.data] : [];
      });
      return { kind: "restore", step: "permissions", sections: sections.length === 0 ? undefined : sections };
    }
    case "start-service":
      return { kind: "start-service" };
    case "set-up-this-machine":
      return first?.kind === "environment" ? { kind: "pick", environmentId: first.id } : { kind: "row", row: "environments.machines" };
    case "sign-in-again":
      if (first?.kind === "account") return { kind: "sign-in", account: { id: first.id, label: first.label } };
      return { kind: "row", row: (first === undefined ? undefined : SIGN_IN_ROWS[first.kind]) ?? step.home };
    case "pull-now": {
      const sources = targets.filter((target) => target.kind === "skill-source").map(({ id, label }) => ({ id, label }));
      return sources.length === 0 ? { kind: "row", row: step.home } : { kind: "pull-sources", sources };
    }
    case "install":
    case "update":
      if (first?.kind === "tool") {
        const tool = ManagedToolName.safeParse(first.id);
        return tool.success ? { kind: "run-tool", tool: tool.data, action } : { kind: "managed-tools" };
      }
      return action === "update" && step.id === "your-machines" ? { kind: "update" } : { kind: "row", row: step.home };
    case "move":
    case "check-certificate":
      return { kind: "row", row: "access.key-managers" };
    case "how-to-set-up":
      return step.id === "your-machines" ? { kind: "host-updater-setup" } : { kind: "row", row: step.home };
    default:
      return { kind: "row", row: step.home };
  }
};

/** One button a step's card offers: its words and what it does. */
export interface OfferedSetupAction {
  /** Unique among the step's: the action, and the item it acts on. */
  readonly key: string;
  readonly action: SetupAction;
  /** Its name: the verb's words, and the item it acts on after a colon. */
  readonly words: string;
  /** The items this individual button acts on. */
  readonly targets: readonly SetupTarget[];
  readonly plan: SetupActionPlan;
}

/** The verbs that act on every item they name at once, one button for all: Restore's sections, Pull now's sources. The rest act on one item at a time. */
const ALL_AT_ONCE: readonly SetupAction[] = ["restore", "pull-now"];

/**
 * The buttons a step's result offers, in its actions' order: an action with
 * no item, one button in the verb's words ("Update now" on Your machines,
 * which updates the machine); one acting on each item it names alone (a
 * sign-in, an unpairing, an authoring session), a button an item, named for
 * it ("Sign in again: Work"); Restore and Pull now, one button for every item
 * they name ("Update now: team-skills, house-skills"), the Permissions step's
 * Restore "Restore them", since its line names the lists.
 */
export const setupActions = (step: ActingStep, result: { readonly actions: readonly SetupAction[]; readonly targets?: readonly SetupTarget[] | undefined }): readonly OfferedSetupAction[] =>
  result.actions.flatMap((action): OfferedSetupAction[] => {
    const offer = (key: string, targets: readonly SetupTarget[]): OfferedSetupAction => {
      const plan = planSetupAction(step, action, targets);
      // The Permissions step's line names the lists it restores (setup-copy.md §5.12), so its button need not.
      if (plan.kind === "restore" && plan.step === "permissions") return { key, action, targets, words: "Restore them", plan };
      const verb = plan.kind === "update" ? "Update now" : SETUP_ACTION_WORDS[action];
      if (plan.kind === "run-tool") return { key, action, targets, words: `${verb} ${targets[0]!.label} in a tool terminal`, plan };
      return { key, action, targets, words: targets.length === 0 ? verb : `${verb}: ${targets.map((target) => target.label).join(", ")}`, plan };
    };
    const targets = (result.targets ?? []).filter((target) => target.action === action);
    if (targets.length === 0 || ALL_AT_ONCE.includes(action)) return [offer(action, targets)];
    return targets.map((target) => offer(`${action} ${target.kind} ${target.id}`, [target]));
  });

/** How an action carried out on the environment went, in one line, with the raw words behind a refusal for Details. */
export interface ActionOutcome {
  readonly ok: boolean;
  readonly line: string;
  readonly details?: readonly string[];
}

/** An outcome where a surface says one line: its line, then its raw words as Details (setup-copy.md §3). */
export const outcomeWords = ({ line, details = [] }: ActionOutcome): string => (details.length === 0 ? line : `${line} Details: ${details.join("; ")}`);

/** A refused action's outcome: the refusal in plain words (setup-copy.md §3), for the button `action` names. */
const refusedOutcome = ({ line, details }: PlainRefusal): ActionOutcome & { readonly ok: false } => ({ ok: false, line, details });

/** What Update now did: its line and, when taken, the update it took. */
export interface UpdateNowOutcome extends ActionOutcome {
  readonly updateId?: string;
}

/**
 * Update now on each named collection (`skills.sources.pull`), continuing
 * past refusals, each reported by its sync rather than its command receipt,
 * in the Skills step's words (setup-copy.md §5.9): a refusal through the
 * refusal mapper, a failed sync `{collection} could not update.`, its words
 * in Details, each named by its collection.
 */
export const pullSetupSources = async (runtime: Pick<Runtime, "requests">, environmentId: string, sources: readonly NamedItem[], now: () => Date): Promise<ActionOutcome> => {
  const verb = SETUP_ACTION_WORDS["pull-now"];
  const outcomes: ActionOutcome[] = [];
  for (const source of sources) {
    const answer = await adminCall(() => runtime.requests.call(environmentId, "skills.sources.pull", { commandId: uuidv7(now()), sourceId: source.id }));
    if (!answer.ok) {
      const refusal = plainRefusal(answer.refusal, verb);
      outcomes.push({ ok: false, line: `${source.label}: ${refusal.line}`, details: refusal.details.map((detail) => `${source.label}: ${detail}`) });
      continue;
    }
    const sync = answer.result?.source.sync;
    if (sync?.outcome === "ok") outcomes.push({ ok: true, line: `${source.label} is up to date.` });
    else if (sync?.outcome === "layout_moved") outcomes.push({ ok: false, line: `${source.label} no longer has skills where they were. Choose its folders again.` });
    else outcomes.push({ ok: false, line: `${source.label} could not update. Choose ${verb}.`, details: [`${source.label}: ${sync?.outcome === "failed" ? sync.line : "No sync result."}`] });
  }
  return { ok: outcomes.every((outcome) => outcome.ok), line: outcomes.map((outcome) => outcome.line).join(" "), details: outcomes.flatMap((outcome) => outcome.details ?? []) };
};

/** The denylist's restore as the Permissions step says it: its line, or its refusal through the refusal mapper. */
export const restoredOutcome = (restored: DenylistRestored): ActionOutcome =>
  restored.ok ? { ok: true, line: restored.line } : refusedOutcome(plainRefusal(restored.refusal, SETUP_ACTION_WORDS.restore));

/**
 * The step's restore, as a direct `admin` command with `commandId`: the
 * Permissions step's `permissions.denylist.restorePresets`, which puts back
 * the presets the sections named lost, or every section's with none named;
 * the Appearance step's `settings.update` of the preset theme (#391). A
 * refusal is said through the refusal mapper.
 */
export const restoreStep = async (
  runtime: Pick<Runtime, "requests">,
  environmentId: string,
  step: RestorableStep,
  commandId: string,
  sections?: readonly DenylistSection[],
): Promise<ActionOutcome> => {
  const verb = SETUP_ACTION_WORDS.restore;
  if (step === "appearance") {
    const preset = SETTINGS["appearance.theme"].preset;
    const saved = await adminCall(() => runtime.requests.call(environmentId, "settings.update", { commandId, values: { "appearance.theme": preset } }));
    return saved.ok ? { ok: true, line: `Restored the ${preset.name} theme.` } : refusedOutcome(plainRefusal(saved.refusal, verb));
  }
  return restoredOutcome(await restoreDenylistPresets(runtime, environmentId, sections, commandId));
};

/**
 * Your machines' Update now (ADR 0025): `updates.apply` of the version the
 * environment waits on (the pin, else the channel's newest), under the idle
 * rules, as a direct `admin` command with `commandId`; with `when: now`,
 * Drain and update now (#825), which takes the waiting update and drains at
 * once. Says which version it goes to, naming the environment, with the
 * update it took, whose line holds only while that update is pending (#1749);
 * a refusal is said through the refusal mapper.
 */
export const updateEnvironment = async (
  runtime: Pick<Runtime, "requests">,
  environmentId: string,
  name: string,
  commandId: string,
  when: UpdateWhen = "idle",
): Promise<UpdateNowOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "updates.apply", { commandId, when }));
  if (!answer.ok) return refusedOutcome(plainRefusal(answer.refusal, "Update now"));
  const toVersion = answer.result?.toVersion;
  const taken = answer.result === undefined ? {} : { updateId: answer.result.updateId };
  if (when === "now") return { ok: true, ...taken, line: toVersion === undefined ? `Draining ${name} to update it.` : `Draining ${name} to update to ${toVersion}.` };
  return { ok: true, ...taken, line: toVersion === undefined ? `Updating ${name} once it is idle.` : `Updating to ${toVersion} once ${name} is idle.` };
};
