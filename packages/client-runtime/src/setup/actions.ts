import { REGISTERED_STEP_IDS, SETTINGS, type RegisteredStepId, type SettingsRowId, type SetupAction, type SetupTarget, type StepId } from "@agent-harness/contracts";
import type { Runtime } from "../runtime.js";
import { saveSetting } from "../settings/editor.js";
import { adminCall } from "../status/actions.js";

/**
 * What each named action a step's result offers does (the Set up
 * specification, "Actions"; ADR 0031: actions are commands, so every
 * renderer runs them alike; #413): each maps to a command or to a row of
 * Settings. `check-again` is `setup.check` of the step; `restore` the
 * step's restore (the denylist's presets put back, the preset theme written
 * back); `start-service` `connections.startService`; `set-up-this-machine`
 * the checklist switched to the environment it targets. Every other verb
 * opens the step's home row, where its card's controls live, until the
 * method behind it is on the wire (#88): `sign-in-again` the Account step's
 * Accounts (a forge account's Forges, a key-manager connection's Key
 * managers), `pair-another` and `unpair` Browser, `move` Key managers.
 */

/** Each action in words, as a button names it: ADR 0031's names and the step decisions' verbs. */
export const SETUP_ACTION_WORDS: { readonly [Action in SetupAction]: string } = {
  "sign-in-again": "Sign in again",
  "pull-now": "Pull now",
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
  "import-again": "Import again",
  "try-again": "Try again",
  "write-it-myself": "Write it myself",
  "start-over": "Start over",
  revise: "Revise",
};

/** The steps with a restore of their own: the Permissions step's denylist presets and the Appearance step's preset theme. */
export type RestorableStep = Extract<StepId, "permissions" | "appearance">;

/** What doing an action is, for a renderer to carry out. */
export type SetupActionPlan =
  /** `setup.check` of the step, or of every step when this build cannot ask about it alone. */
  | { readonly kind: "check"; readonly step: RegisteredStepId | undefined }
  /** The step's restore (`restoreStep`), then its check again. */
  | { readonly kind: "restore"; readonly step: RestorableStep }
  /** `connections.startService` of the environment checked. */
  | { readonly kind: "start-service" }
  /** The checklist switched to another environment. */
  | { readonly kind: "pick"; readonly environmentId: string }
  /** A row of Settings opened on the environment checked. */
  | { readonly kind: "row"; readonly row: SettingsRowId };

const isRegistered = (step: StepId): step is RegisteredStepId => (REGISTERED_STEP_IDS as readonly StepId[]).includes(step);

/** What `action`, offered by `step`'s result with its `targets`, does. */
export const planSetupAction = (step: { readonly id: StepId; readonly home: SettingsRowId }, action: SetupAction, targets: readonly SetupTarget[] = []): SetupActionPlan => {
  switch (action) {
    case "check-again":
      return { kind: "check", step: isRegistered(step.id) ? step.id : undefined };
    case "restore":
      return step.id === "permissions" || step.id === "appearance" ? { kind: "restore", step: step.id } : { kind: "row", row: step.home };
    case "start-service":
      return { kind: "start-service" };
    case "set-up-this-machine": {
      const machine = targets.find((target) => target.action === action && target.kind === "environment");
      return machine === undefined ? { kind: "row", row: "environments.machines" } : { kind: "pick", environmentId: machine.id };
    }
    default:
      return { kind: "row", row: step.home };
  }
};

/** How a restore went, in one line. */
export interface Restored {
  readonly ok: boolean;
  readonly line: string;
}

/**
 * The step's restore, as a direct `admin` command with `commandId`: the
 * Permissions step's `permissions.denylist.restorePresets`, which puts back
 * the presets a section lost; the Appearance step's `settings.update` of the
 * preset theme (#391). A refusal is "Not restored: <why>".
 */
export const restoreStep = async (runtime: Pick<Runtime, "requests">, environmentId: string, step: RestorableStep, commandId: string): Promise<Restored> => {
  if (step === "appearance") {
    const preset = SETTINGS["appearance.theme"].preset;
    const saved = await saveSetting(runtime, environmentId, "appearance.theme", preset, { commandId });
    return saved.ok ? { ok: true, line: `Restored the ${preset.name} theme.` } : { ok: false, line: `Not restored: ${saved.line}` };
  }
  const answer = await adminCall(() => runtime.requests.call(environmentId, "permissions.denylist.restorePresets", { commandId }));
  if (!answer.ok) return { ok: false, line: `Not restored: ${answer.line}` };
  const count = answer.result?.restored.length;
  return { ok: true, line: count === undefined ? "Restored the denylist's presets." : `Restored the denylist's presets: ${count} put back.` };
};
