import { z } from "zod";
import { DENYLIST_SECTIONS } from "./denylist.js";
import { GH_MINIMUM_VERSION } from "./forge-gh.js";
import { BYPASS_SENTENCE } from "./permissions.js";
import { SETTINGS, type SettingsKey } from "./settings.js";
import type { SettingsRowId } from "./settings-rows.js";
import type { SetupAction } from "./setup.js";

/**
 * The step registry (ADR 0016; CONTEXT.md, "Step registry"): every step of
 * Set up with the settings it writes, the health checks that say whether
 * they hold, and the row of Settings it lives on (ADR 0027). A settings key
 * no step writes fails the contract test (`steps.test.ts`), so a feature
 * cannot add a setting without a step; a step with no home row fails the row
 * registry's (`settings-rows.test.ts`).
 *
 * Its shape is the Set up specification's (#88, "The registry entry"; #568):
 * the settings a step writes and the state it writes through methods of its
 * own, the values it confirms, its home row and links (#389), the value
 * checks of its keys and the checks of the environment's state, whether it
 * may be skipped and the state check that skips it, and ADR 0031's budget
 * class, cadence and triggers. It grew from the stub the session-state
 * workstream (#117) needed, which #141 and #308 extended; the entries
 * carried over.
 */

/**
 * Every step of the milestone-1 checklist, in its order: ADR 0016's ten,
 * with Forges after Your machines (ADR 0020) and Key manager moved before
 * Memory bank (ADR 0034). Only some are registered yet; the registry lists
 * those it has in this order.
 */
export const STEP_ORDER = [
  "account",
  "carry-over",
  "your-machines",
  "forges",
  "key-manager",
  "memory-bank",
  "skills",
  "instructions",
  "browser",
  "permissions",
  "appearance",
] as const;

/** What every client names each step, whether or not an environment registers it (the Set up specification, "The steps"). */
export const STEP_LABELS: { readonly [Id in (typeof STEP_ORDER)[number]]: string } = {
  account: "Account",
  "carry-over": "Carry over",
  "your-machines": "Your machines",
  forges: "Forges",
  "key-manager": "Key manager",
  "memory-bank": "Memory bank",
  skills: "Skills",
  instructions: "Instructions",
  browser: "Browser",
  permissions: "Permissions",
  appearance: "Appearance",
};

/** The outcome each checklist step explains to the person setting up (docs/specs/look.md §13.2), in setup-copy.md §4.4's words. */
export const STEP_HINTS: { readonly [Id in (typeof STEP_ORDER)[number]]: string } = {
  account: "Sign in to Claude",
  "carry-over": "Bring your past chats",
  "your-machines": "Use it from other devices",
  forges: "Connect GitHub and others",
  "key-manager": "Use your key manager",
  "memory-bank": "A notebook agents keep",
  skills: "Ready-made agent skills",
  instructions: "Notes every agent reads",
  browser: "Let agents use Chrome",
  permissions: "When agents ask",
  appearance: "Light, dark and colours",
};

export const StepId = z.enum(STEP_ORDER).meta({
  description: `A step of the milestone-1 checklist, registered or not, each with the label every client names it by: ${STEP_ORDER.map((id) => `${id} (${STEP_LABELS[id]})`).join(", ")}.`,
});
export type StepId = z.infer<typeof StepId>;

/** What a value check says of a value the step cannot use: the plain line, and the raw facts behind it for Details (setup-copy.md §3). */
export interface ValueProblem {
  readonly reason: string;
  readonly details: readonly string[];
}

/**
 * A health check of one setting: `true` when the value the environment
 * holds lets the step count as done, else what needs attention, for the
 * step's card to show.
 */
export type HealthCheck = (value: unknown) => true | ValueProblem;

/** A link from a step to a row of Settings beside its home: the Account step's to `accounts.default-model`, where its keys sit. */
export interface RowLink {
  readonly row: SettingsRowId;
}

/** A link from one step to another: the Permissions step's to Your machines, for another environment's containment availability. */
export interface StepLink {
  readonly step: StepId;
}

/**
 * State a step writes that is no settings key, through a method of its own:
 * the method, and the parts of that state the step's form covers (the
 * Permissions step: `permissions.denylist.set` and the denylist's four
 * sections).
 */
export interface StateWrite {
  readonly method: `${string}.${string}`;
  readonly parts: readonly string[];
}

/**
 * A value the step's form confirms before it writes it: the one sentence it
 * shows (ADR 0006: choosing bypass shows one sentence), the parameter that
 * carries the person's acknowledgement, and the key the environment records
 * the first acknowledgement in.
 */
export interface Confirmation {
  readonly key: SettingsKey;
  readonly value: unknown;
  readonly sentence: string;
  readonly acknowledgement: string;
  readonly records: SettingsKey;
}

/**
 * A check of the environment's own state, beyond the values of the keys a
 * step writes (ADR 0031: a check runs on the environment being checked):
 * the environment answers each by its id (`setup.check`), and a result
 * names the ones that failed.
 */
export interface StateCheck {
  /** `<step id>.<what it checks>`. */
  readonly id: string;
  /** What holds when it passes, as one sentence: the rule it checks, which the step's line when done does not repeat (#1698). */
  readonly holds: string;
  /** The actions a result offers when it fails, from ADR 0031's vocabulary. */
  readonly actions: readonly SetupAction[];
}

/**
 * The three budget classes a step's check declares, with the seconds each
 * gives it (ADR 0031): `local`, five, for a local read or version probe;
 * `network`, ten, for a network call; `git`, thirty, for a git probe or
 * clone. Past its budget a check answers that it timed out after that many
 * seconds.
 */
export const CHECK_BUDGET_SECONDS = { local: 5, network: 10, git: 30 } as const;
export type CheckBudget = keyof typeof CHECK_BUDGET_SECONDS;

/** How often a step is checked unasked unless its entry states a reason for another cadence (ADR 0031: David set the hour). */
export const DEFAULT_CADENCE_MINUTES = 60;

/**
 * How often the environment checks a step with nobody asking (ADR 0031):
 * every hour, or another whole number of minutes with the reason why. ADR
 * 0031 gives the Key manager and Account steps fifteen, because the
 * orientation block reports token and sign-in freshness, and the forge spec
 * gives Forges the same for its forge accounts' status (#319); each entry
 * takes it with the checks that report it (#574 for Account). The runs on
 * start, on the cadence and on a step's triggers are the Set up
 * specification's scheduler (#88).
 */
export interface Cadence {
  readonly minutes: number;
  /** Why the step leaves the hour: required when `minutes` is not 60. */
  readonly reason?: string;
}

/**
 * Whether an event or notice of `type` fires `trigger`: a trigger names one
 * type, or ends in `*` and names a family, every type it prefixes
 * (`forge.account.*`, `environment.update-*`).
 */
export const triggerMatches = (trigger: string, type: string): boolean =>
  trigger.endsWith("*") ? type.startsWith(trigger.slice(0, -1)) : type === trigger;

/** One step of the checklist. */
export interface Step {
  readonly id: StepId;
  /** The row of Settings the step lives on (ADR 0027), which the row registry lists as home to it: its health dot shows there. */
  readonly home: SettingsRowId;
  /** The settings keys the step writes. */
  readonly writes: readonly SettingsKey[];
  /** The state the step writes through methods of its own, which no settings key holds. */
  readonly writesState?: readonly StateWrite[];
  /** The values its form confirms before writing them. */
  readonly confirms?: readonly Confirmation[];
  /** The step's health checks, one per key it writes. */
  readonly checks: readonly { readonly key: SettingsKey; readonly check: HealthCheck }[];
  /** The checks of the environment's state its health check runs beside them. */
  readonly stateChecks: readonly StateCheck[];
  /**
   * The step's line when every check holds, as one short sentence of what
   * was found, unless the environment says more of what it found (#1698):
   * never its state checks' conditions joined, whose alternatives say what
   * would pass rather than what is there. Its words are the step's done line
   * in setup-copy.md §5, without the values the environment fills in when it
   * says more.
   */
  readonly done: string;
  /** The rows beside its home the step links to (every row its keys sit on is its home or one of these), and the other steps. */
  readonly links: readonly (RowLink | StepLink)[];
  /** Whether it may be skipped (ADR 0031: a skipped step passes a re-run); a preference step never is. */
  readonly skippable: boolean;
  /**
   * On a skippable step, the one of its state checks that holds when
   * something is set up here (`<step>.present`): when it fails, the step
   * answers skipped with that check's line and runs no other check. Skipped
   * is derived from state this way and never recorded (the Set up
   * specification, "Skipped"); a skippable step names one, and no other
   * step does.
   */
  readonly skip?: string;
  /** The budget class of the step's checks: how long `setup.check` awaits them before answering that they timed out (ADR 0031). */
  readonly budget: CheckBudget;
  /** How often it is checked unasked. */
  readonly cadence: Cadence;
  /**
   * The event and notice types whose arrival re-runs the step's check at
   * once (ADR 0031): each a type the log carries, or a family ending in `*`
   * (`triggerMatches`).
   */
  readonly triggers: readonly string[];
  /**
   * On an LLM step, a step whose artefact has to be authored rather than
   * filled in, the prompt its minted sessions start with: the id of one of
   * `STEP_PROMPTS` (ADR 0019; `setup-prompts.ts`). Every run end of a
   * session tagged `setup` and the step's id checks the step again.
   */
  readonly llm?: string;
}

/**
 * A check that passes on any value the key's schema accepts: what a setting
 * with no stronger notion of done asks. A value it refuses is named by the
 * setting's label, the key in details (setup-copy.md §3).
 */
export const anyValidValue =
  (key: SettingsKey): HealthCheck =>
  (value) =>
    SETTINGS[key].schema.safeParse(value).success || {
      reason: `A saved setting for this step cannot be used: ${SETTINGS[key].label}. Set it again in Settings.`,
      details: [key],
    };

/**
 * Every step registered so far, in the milestone-1 order: Account, for the
 * default account, model family and effort (#134) and the process idle time
 * (#120), whose accounts it checks (#574); Carry over, which writes no key
 * and imports through its commands (#581); Your machines, for the update
 * settings (#335), whose not-root line #141 adds, the auto-settle keys
 * (session-state spec, "Auto-settle: rules and settings") and the transcript
 * compaction window beside them (#123), which sit on `environments.service`,
 * and the binding keys (#574); Forges, whose forge
 * accounts go through the forge account commands (#319); Key manager, for
 * the injection setting (#367), whose connections go through the
 * key-manager commands; Memory bank, which writes no key and checks the
 * banks the environment registers (#586); Instructions, for the
 * orientation switch, whose owned instructions go through their commands
 * (#505); Browser, for the browser keys (#541); Permissions
 * (#129's keys, #141's entry); and Appearance, for the theme (ADR 0023,
 * #391), whose contrast it checks. The other steps arrive as their features are built,
 * each with its budget class, cadence, triggers and skip check as the Set
 * up specification tables them (#88).
 */
export const STEP_REGISTRY = [
  {
    // The Account step (ADR 0018), at home on accounts.accounts beside Carry over: the default account, model family
    // and effort (#134) and the process idle time (#120), which sit on accounts.default-model (ADR 0027). Its health
    // reads the account store's statuses (#134), never a setting: at least one account, with no action since the card's
    // Sign in is the fix, and every account signed in, Sign in again naming each that is not (#574). Checked every
    // fifteen minutes, as often as the store reads each account's status, since the orientation block reports it; never
    // skipped. An account's change and the sign-in's re-run it.
    id: "account",
    home: "accounts.accounts",
    writes: ["accounts.defaultAccount", "accounts.defaultModelFamily", "accounts.defaultEffort", "providers.processIdleMinutes"],
    checks: [
      { key: "accounts.defaultAccount", check: anyValidValue("accounts.defaultAccount") },
      { key: "accounts.defaultModelFamily", check: anyValidValue("accounts.defaultModelFamily") },
      { key: "accounts.defaultEffort", check: anyValidValue("accounts.defaultEffort") },
      { key: "providers.processIdleMinutes", check: anyValidValue("providers.processIdleMinutes") },
    ],
    stateChecks: [
      { id: "account.present", holds: "At least one account is on this environment.", actions: [] },
      // Check again for an account whose status could not be read, Sign in again for one signed out or expired.
      { id: "account.signed-in", holds: "Every account on this environment is signed in.", actions: ["sign-in-again", "check-again"] },
    ],
    done: "All your accounts are signed in.",
    links: [{ row: "accounts.default-model" }],
    skippable: false,
    budget: "local",
    cadence: {
      minutes: 15,
      reason: "The orientation block reports each account's sign-in status (ADR 0011, ADR 0018), so the step is checked as often as the account store reads it.",
    },
    triggers: ["account.updated", "signin.updated"],
  },
  {
    // The Carry over step (ADR 0021, ADR 0036; setup spec, "2. Carry over"; #581), second, at home on accounts.accounts
    // beside Account, linking the Skills and Memory banks rows, where what it copies lands. It writes no settings key:
    // an adopted account's import goes through carryOver.run, its skills through skills.carryOver (#513), and the state
    // import through stateImport.run (#94). Skippable: with nothing to carry in any adopted account's directory and no
    // source data folder or terminal-client state folder, it answers skipped. Done after the click; it needs attention
    // only when an adopted directory cannot be read or an account's last import failed part way, or before its first.
    // A local read, hourly; an account's change and the end of either import re-run it.
    id: "carry-over",
    home: "accounts.accounts",
    writes: [],
    writesState: [
      { method: "carryOver.run", parts: ["importedSessions", "carriedMemory"] },
      { method: "skills.carryOver", parts: ["carriedSkills"] },
      { method: "stateImport.run", parts: ["importedState"] },
    ],
    checks: [],
    stateChecks: [
      {
        id: "carry-over.present",
        holds: "An adopted account's directory holds something to carry, or a source data folder or terminal-client state folder is on this machine.",
        actions: [],
      },
      { id: "carry-over.readable", holds: "Every adopted account's directory can be read.", actions: ["check-again"] },
      {
        id: "carry-over.last-import",
        holds: "Every adopted account with something to carry has been imported, and its last import finished.",
        actions: ["import-again"],
      },
      { id: "carry-over.default-account", holds: "No imported default Account is waiting for sign-in.", actions: ["sign-in-again"] },
    ],
    done: "Everything is already here.",
    links: [{ row: "knowledge.skills" }, { row: "knowledge.banks" }],
    skippable: true,
    skip: "carry-over.present",
    budget: "local",
    cadence: { minutes: 60 },
    triggers: ["account.updated", "carry-over.imported", "state-import.finished", "settings.changed"],
  },
  {
    // The Your machines step (ADR 0025), at home on the Environments band's Your machines row (ADR 0027:
    // environments.machines). It writes the five update keys (#335), through updates.settings.set alone (their
    // writtenBy), and the three session keys the GUI put on environments.service, which it links (moved here from
    // Appearance, as the session-state spec allowed; #568); a preference step's checks pass on any valid value. Its
    // health line reports not-root, read from what permissions.settings.get answers as isRoot (#141), whether the
    // release channel is read (#346), whether this machine is behind (#347) and, in a container whose updates are
    // managed outside, whether the host-side updater polled in the last hour (#348); its checks reach the release
    // channel, so its budget is a network call's. An update's notices and a settings change re-run it, and so does each
    // check of the release channel as it ends, which appends nothing and the environment names to its scheduler (#679).
    // The environment's name, icon and colour are state it writes through their three commands, whose notices re-run it
    // too, and its line says the environment is named (ADR 0025's "named"), which holds from the first start since each
    // has its default (#323). It writes the two binding keys too, on its home row, which settings.update writes and the
    // environment applies at its next start, done on any valid value; and its line says the environment is ready, not
    // draining past its cap (ADR 0025), Check again when it is (#574). No tailnet address is a notice on its card, never
    // a failure. Its line says LAN binding is off or names an address the machine holds now, Check again when it does not:
    // a start skips one it does not hold, so the step names it (#773).
    id: "your-machines",
    home: "environments.machines",
    writes: [
      "updates.autoUpdate",
      "updates.channel",
      "updates.pinnedVersion",
      "updates.idleWindowMinutes",
      "updates.deferralCapHours",
      "sessions.autoSettleAfterIdle",
      "sessions.autoSettleOnMerge",
      "sessions.transcriptCompactAfterDays",
      "network.bindTailnet",
      "network.bindLan",
    ],
    writesState: [
      { method: "environment.rename", parts: ["name"] },
      { method: "environment.setIcon", parts: ["icon"] },
      { method: "environment.setColour", parts: ["colour"] },
    ],
    checks: [
      { key: "updates.autoUpdate", check: anyValidValue("updates.autoUpdate") },
      { key: "updates.channel", check: anyValidValue("updates.channel") },
      { key: "updates.pinnedVersion", check: anyValidValue("updates.pinnedVersion") },
      { key: "updates.idleWindowMinutes", check: anyValidValue("updates.idleWindowMinutes") },
      { key: "updates.deferralCapHours", check: anyValidValue("updates.deferralCapHours") },
      { key: "sessions.autoSettleAfterIdle", check: anyValidValue("sessions.autoSettleAfterIdle") },
      { key: "sessions.autoSettleOnMerge", check: anyValidValue("sessions.autoSettleOnMerge") },
      { key: "sessions.transcriptCompactAfterDays", check: anyValidValue("sessions.transcriptCompactAfterDays") },
      { key: "network.bindTailnet", check: anyValidValue("network.bindTailnet") },
      { key: "network.bindLan", check: anyValidValue("network.bindLan") },
    ],
    stateChecks: [
      { id: "your-machines.not-root", holds: "The environment runs as a non-root user.", actions: [] },
      {
        id: "your-machines.release-channel",
        holds: "Auto-update is off, or the release channel was read in the last 24 hours.",
        actions: ["check-again"],
      },
      {
        id: "your-machines.updates",
        holds: "Auto-update is on or the channel's newest runs, no update is past its cap or blocked, and no failed update left this machine behind.",
        actions: ["update"],
      },
      {
        id: "your-machines.host-updater",
        holds: "No host-side updater manages this environment's updates, or it polled in the last hour.",
        actions: ["check-again"],
      },
      { id: "your-machines.named", holds: "The environment has a name, an icon and a colour.", actions: [] },
      { id: "your-machines.ready", holds: "The environment is ready, and not draining past its cap.", actions: ["check-again"] },
      { id: "your-machines.lan", holds: "LAN binding is off, or the LAN address it names is one this machine holds.", actions: ["check-again"] },
    ],
    done: "This computer is ready.",
    links: [{ row: "environments.service" }],
    skippable: false,
    budget: "network",
    cadence: { minutes: 60 },
    triggers: ["environment.update-*", "settings.updated", "environment.renamed", "environment.icon-set", "environment.colour-set"],
  },
  {
    // The Forges step (forge spec, "The Forges step"; ADR 0020, ADR 0032, ADR 0033; #319), at home on the Access band's
    // Forges row (ADR 0027), linking the Key manager step, whose Move card takes stored tokens (ADR 0028). It writes no
    // settings key: its forge accounts go through the four forge account commands. Skippable: with no forge account it
    // answers skipped, the first step that does (ADR 0020). Its checks read every forge account's last verification, or
    // await one when it is older than the cadence (a network call; #680); every forge.account.* event re-runs it, and
    // tools.updated, since forges.gh reads gh's Managed tools row (#677).
    id: "forges",
    home: "access.forges",
    writes: [],
    writesState: [
      { method: "forge.accounts.add", parts: ["forgeAccounts"] },
      { method: "forge.accounts.update", parts: ["forgeAccounts"] },
      { method: "forge.accounts.remove", parts: ["forgeAccounts"] },
      { method: "forge.accounts.setPrimary", parts: ["forgeAccounts"] },
    ],
    checks: [],
    stateChecks: [
      { id: "forges.present", holds: "At least one forge account is on this environment.", actions: [] },
      // sign-in-again is the vocabulary's word for giving a forge account a new credential (forge spec).
      { id: "forges.identity", holds: "Each forge account answers as the identity it was added with.", actions: ["sign-in-again", "check-again"] },
      { id: "forges.reads", holds: "Every read of each forge account passes.", actions: ["check-again"] },
      // Make primary is the card's own control, no verb of the vocabulary.
      { id: "forges.primary", holds: "Exactly one forge account is primary.", actions: [] },
      {
        id: "forges.gh",
        holds: `Every forge account whose credential is gh finds gh installed, at ${GH_MINIMUM_VERSION} or later, and signed in as its login.`,
        actions: ["install", "update", "sign-in-again"],
      },
      // ADR 0033's thirty days, for every kind that reports an expiry.
      { id: "forges.expiry", holds: "No forge account's token expires within thirty days.", actions: ["sign-in-again"] },
      { id: "forges.coverage", holds: "No origin a harness operation was refused on for want of a forge account counts as missing.", actions: [] },
    ],
    done: "Your forges are connected.",
    links: [{ step: "key-manager" }],
    skippable: true,
    skip: "forges.present",
    budget: "network",
    cadence: {
      minutes: 15,
      reason: "The orientation block reports each forge account's status (ADR 0012), so the step is checked as often as a forge account is verified.",
    },
    triggers: ["forge.account.*", "tools.updated"],
  },
  {
    // The Key manager step (key-managers spec, "The Key manager step"; ADR 0028, ADR 0034; #367), fifth, before Memory
    // bank, at home on the Access band's Key managers pane (ADR 0027). It writes the injection setting's two keys, which
    // settings.update writes and which pass on any valid value, as a preference's do, and its connections and the Move of
    // stored tokens through the key-manager commands. It links the Forges and Memory bank steps, and About, whose Managed
    // tools hold each key manager's CLI (ADR 0026). Skippable: with no connection it answers skipped, never forced (ADR
    // 0028). Its checks await a verification of every connection (a network call), every fifteen minutes (#383); each
    // key-manager.* event and tools.updated re-run it.
    id: "key-manager",
    home: "access.key-managers",
    writes: ["credentials.injection", "credentials.injectionByAccount"],
    writesState: [
      { method: "keyManagers.connections.add", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.signIn", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.update", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.setPolicies", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.setBasePath", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.setInjected", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.signOut", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.remove", parts: ["keyManagerConnections"] },
      { method: "keyManagers.move", parts: ["storedTokens"] },
    ],
    checks: [
      { key: "credentials.injection", check: anyValidValue("credentials.injection") },
      { key: "credentials.injectionByAccount", check: anyValidValue("credentials.injectionByAccount") },
    ],
    stateChecks: [
      { id: "key-manager.present", holds: "At least one key-manager connection is on this environment.", actions: [] },
      // None awaiting its sign-in, its credential rejected, or its token expired (#383).
      { id: "key-manager.signed-in", holds: "Every key-manager connection is signed in.", actions: ["sign-in-again"] },
      // None unreachable, sealed, or with a rejected certificate.
      { id: "key-manager.reachable", holds: "Every key-manager connection is reachable, unsealed, and presents a certificate that verifies.", actions: ["check-again"] },
      { id: "key-manager.run-tokens", holds: "Every injecting OpenBao connection's login can mint run tokens.", actions: ["check-again"] },
      // ADR 0026's Managed tools rows: a key-manager CLI is required while its connection injects.
      {
        id: "key-manager.cli",
        holds: "Each injecting key-manager connection's CLI is installed at its minimum or later, bao or vault for OpenBao.",
        actions: ["install", "update"],
      },
    ],
    done: "Your key managers are connected.",
    links: [{ step: "forges" }, { step: "memory-bank" }, { row: "about.about" }],
    skippable: true,
    skip: "key-manager.present",
    budget: "network",
    cadence: {
      minutes: 15,
      reason: "The orientation block reports each key-manager connection's status (ADR 0011, ADR 0028), so the step is checked as often as a connection is verified.",
    },
    triggers: ["key-manager.*", "tools.updated"],
  },
  {
    // The Memory bank step (setup spec, "6. Memory bank"; banks spec, "The Memory bank step and the orientation block";
    // ADR 0010, ADR 0013, ADR 0019, ADR 0034, ADR 0035, ADR 0037; #586), sixth, after Key manager (ADR 0034), at home on
    // the Knowledge band's Memory banks row (ADR 0027), linking the Key manager and Forges steps, whose connections and
    // forge accounts a bank's credential and repository come from. It writes no settings key: its banks go through the
    // banks spec's methods, which the banks build registers (#937). Skippable: with no registered bank it answers skipped.
    // Its checks await a verification of every bank, a git probe, and answer from what the records' status says; every
    // bank.* notice re-runs it, and so does every run end of its minted describe session (ADR 0019), whose prompt it
    // names.
    id: "memory-bank",
    home: "knowledge.banks",
    writes: [],
    writesState: [
      { method: "banks.create", parts: ["banks"] },
      { method: "banks.join", parts: ["banks"] },
      { method: "banks.publish", parts: ["banks"] },
      { method: "banks.registry.update", parts: ["banks"] },
    ],
    checks: [],
    stateChecks: [
      { id: "memory-bank.present", holds: "At least one memory bank is registered on this environment.", actions: [] },
      { id: "memory-bank.reachable", holds: "Each enabled bank's remote answers, or its local repository exists.", actions: ["check-again"] },
      // ADR 0019: an open pull request holding BANK.md on a bank whose merges are reviewed counts as landed, awaiting review.
      {
        id: "memory-bank.manifest",
        holds: "Each enabled bank's BANK.md on main passes the validator, or waits for review in an open pull request on a bank whose merges are reviewed.",
        actions: ["revise"],
      },
      { id: "memory-bank.orientation", holds: "Every orientation memory each enabled bank names exists.", actions: [] },
      { id: "memory-bank.owners", holds: "Each enabled team bank's owners resolve on its forge.", actions: [] },
      { id: "memory-bank.landing", holds: "No landing on an enabled bank has failed.", actions: ["check-again"] },
    ],
    done: "Your notebook is ready.",
    links: [{ step: "key-manager" }, { step: "forges" }],
    skippable: true,
    skip: "memory-bank.present",
    budget: "git",
    cadence: { minutes: 60 },
    triggers: ["bank.*"],
    llm: "describe-bank",
  },
  {
    // Skills (ADR 0029; #514): local health from the sources' last attempts and the own directory.
    // Its cards belong to the Set up workstream; skills.updated re-runs its local check (#588).
    id: "skills",
    home: "knowledge.skills",
    writes: [],
    writesState: [
      { method: "skills.sources.add", parts: ["skillSources"] },
      { method: "skills.sources.remove", parts: ["skillSources"] },
      { method: "skills.sources.setFollow", parts: ["skillSources"] },
      { method: "skills.sources.pull", parts: ["skillSources"] },
      { method: "skills.setAlwaysOn", parts: ["alwaysOnSkills"] },
      { method: "trust.decide", parts: ["repositoryTrust"] },
      { method: "trust.revoke", parts: ["repositoryTrust"] },
    ],
    checks: [],
    stateChecks: [
      { id: "skills.present", holds: "Skill sources are tracked, or the own directory is nonempty or unreadable.", actions: [] },
      { id: "skills.sources-synced", holds: "Every unpinned source's last attempt succeeded within seven hours.", actions: ["pull-now"] },
      { id: "skills.sources-yield", holds: "Every source yields skills.", actions: ["pull-now"] },
      { id: "skills.source-limit", holds: "At most twenty skill sources are tracked.", actions: [] },
      { id: "skills.own-directory", holds: "The own skills directory is readable.", actions: [] },
    ],
    done: "Your skills are up to date.",
    links: [],
    skippable: true,
    skip: "skills.present",
    budget: "local",
    cadence: { minutes: 60 },
    triggers: ["skills.updated"],
  },
  {
    // The Instructions step (skills spec, "Set up"; ADR 0030; #505), at home on the Knowledge band's Instructions row
    // (ADR 0027): the orientation switch, which settings.update writes and which passes on any valid value, as a
    // preference's does, and the owned instructions and the dismissed suggestions (#509) through their commands. Never
    // skipped. Its state check reads the rendered block (#514). Its instruction events and the events of each registry the block renders re-run it (#586, #588).
    id: "instructions",
    home: "knowledge.instructions",
    writes: ["instructions.orientation"],
    writesState: [
      { method: "instructions.create", parts: ["ownedInstructions", "dismissedSuggestions"] },
      { method: "instructions.edit", parts: ["ownedInstructions"] },
      { method: "instructions.setScope", parts: ["ownedInstructions"] },
      { method: "instructions.setEnabled", parts: ["ownedInstructions"] },
      { method: "instructions.move", parts: ["ownedInstructions"] },
      { method: "instructions.resolveVersion", parts: ["ownedInstructions"] },
      { method: "instructions.remove", parts: ["ownedInstructions", "dismissedSuggestions"] },
      { method: "instructions.dismissSuggestion", parts: ["dismissedSuggestions"] },
      { method: "instructions.restoreSuggestion", parts: ["dismissedSuggestions"] },
      { method: "instructions.import", parts: ["ownedInstructions", "dismissedSuggestions"] },
    ],
    checks: [{ key: "instructions.orientation", check: anyValidValue("instructions.orientation") }],
    stateChecks: [{ id: "instructions.orientation-renders", holds: "The orientation block renders with no failed registry read.", actions: [] }],
    done: "Agents get your notes and a summary of this computer.",
    links: [],
    skippable: false,
    budget: "local",
    cadence: { minutes: 60 },
    triggers: ["bank.*", "instructions.*", "account.updated", "key-manager.*", "forge.account.*", "environment.renamed"],
  },
  {
    // The Browser step (ADR 0024; browser spec, "The Browser step's environment side"), at home on the Access band's
    // Browser row, `access.browser` (ADR 0027): the nine browser keys (#541), which settings.update writes, each done on
    // any valid value. Pairing and unpairing write the paired Chromes (#559); no denylist section belongs here.
    // Skipped with no pairing; otherwise the listener and chrome projection check connection and the shipped version.
    // The local budget and the hour stand; chrome.updated and extension.seen re-run the check.
    id: "browser",
    home: "access.browser",
    writes: [
      "browser.devSites",
      "browser.evaluateEverywhere",
      "browser.deepReadEverywhere",
      "browser.reach",
      "browser.headless.allowRuns",
      "browser.headless.endpoint",
      "browser.headless.executable",
      "browser.headless.limits",
      "browser.internalHosts",
    ],
    writesState: [
      { method: "browser.pairing.code", parts: ["pairedChromes"] },
      { method: "browser.chromes.unpair", parts: ["pairedChromes"] },
    ],
    checks: [
      { key: "browser.devSites", check: anyValidValue("browser.devSites") },
      { key: "browser.evaluateEverywhere", check: anyValidValue("browser.evaluateEverywhere") },
      { key: "browser.deepReadEverywhere", check: anyValidValue("browser.deepReadEverywhere") },
      { key: "browser.reach", check: anyValidValue("browser.reach") },
      { key: "browser.headless.allowRuns", check: anyValidValue("browser.headless.allowRuns") },
      { key: "browser.headless.endpoint", check: anyValidValue("browser.headless.endpoint") },
      { key: "browser.headless.executable", check: anyValidValue("browser.headless.executable") },
      { key: "browser.headless.limits", check: anyValidValue("browser.headless.limits") },
      { key: "browser.internalHosts", check: anyValidValue("browser.internalHosts") },
    ],
    stateChecks: [
      { id: "browser.present", holds: "A Chrome is paired with this environment.", actions: [] },
      { id: "browser.chrome-connected", holds: "A paired Chrome is connected.", actions: ["check-again", "unpair", "pair-another"] },
      { id: "browser.extension-current", holds: "Every paired Chrome last reported the shipped extension version.", actions: ["reload", "check-again"] },
    ],
    done: "Chrome is connected.",
    links: [],
    skippable: true,
    skip: "browser.present",
    budget: "local",
    cadence: { minutes: 60 },
    triggers: ["chrome.updated", "extension.seen"],
  },
  {
    // The Permissions step (permissions spec, "The Permissions step"; #129's keys, #141's entry): at home on the Access
    // band's Permissions row, `access.permissions` (ADR 0027), linking the Your machines step for another environment's
    // containment availability. A preference step: done once set or preset (ADR 0031), so its keys' checks pass on
    // any valid value, and it needs attention only when the environment's state does not hold what they chose. A
    // settings change and a denylist change re-run it.
    id: "permissions",
    home: "access.permissions",
    writes: [
      "permissions.defaultCeiling",
      "permissions.unattended.mode",
      "permissions.unattended.bypassAcknowledgedAt",
      "permissions.parkedPrompt.ttl",
      "permissions.containment.default",
    ],
    writesState: [{ method: "permissions.denylist.set", parts: DENYLIST_SECTIONS }],
    confirms: [
      {
        key: "permissions.unattended.mode",
        value: "bypassPermissions",
        sentence: BYPASS_SENTENCE,
        acknowledgement: "acknowledgeBypass",
        records: "permissions.unattended.bypassAcknowledgedAt",
      },
    ],
    checks: [
      { key: "permissions.defaultCeiling", check: anyValidValue("permissions.defaultCeiling") },
      { key: "permissions.unattended.mode", check: anyValidValue("permissions.unattended.mode") },
      { key: "permissions.unattended.bypassAcknowledgedAt", check: anyValidValue("permissions.unattended.bypassAcknowledgedAt") },
      { key: "permissions.parkedPrompt.ttl", check: anyValidValue("permissions.parkedPrompt.ttl") },
      { key: "permissions.containment.default", check: anyValidValue("permissions.containment.default") },
    ],
    stateChecks: [
      { id: "permissions.containment", holds: "The containment default can be enforced here.", actions: [] },
      { id: "permissions.denylist", holds: "Each denylist section holds its presets, or was emptied on purpose.", actions: ["restore"] },
      { id: "permissions.not-root", holds: "The environment runs as a non-root user.", actions: [] },
    ],
    done: "Set.",
    links: [{ step: "your-machines" }],
    skippable: false,
    budget: "local",
    cadence: { minutes: 60 },
    triggers: ["settings.updated", "denylist.changed"],
  },
  {
    // The Appearance step (ADR 0023), at home on appearance.theme, where the theme it writes sits (#391; its session
    // keys moved to Your machines, #568). The theme is a preference: done once set or preset (ADR 0031), unless a seed
    // of it could not hold the theme package's rules where its role puts it, which the environment's contrast check
    // derives both ladders to find; Restore writes the preset theme back through settings.update. Never skipped; a
    // settings change re-runs it.
    id: "appearance",
    home: "appearance.theme",
    writes: ["appearance.theme"],
    checks: [{ key: "appearance.theme", check: anyValidValue("appearance.theme") }],
    stateChecks: [
      {
        id: "appearance.contrast",
        holds: "Both ladders of the theme meet the contrast, gamut and hue-separation rules with no seed clamped.",
        actions: ["restore"],
      },
    ],
    done: "Your theme is easy to read.",
    links: [],
    skippable: false,
    budget: "local",
    cadence: { minutes: 60 },
    triggers: ["settings.updated"],
  },
] as const satisfies readonly Step[];

export type RegisteredStep = (typeof STEP_REGISTRY)[number];

/**
 * The steps of the milestone-1 order that `steps` (the registry unless
 * given) does not register, in that order: none once every feature has
 * registered its step. The switch-over's done checklist (#94) runs it and
 * passes only on none; until then the package's own contract test checks
 * only the ids it registers.
 */
export const unregisteredSteps = (steps: readonly { readonly id: string }[] = STEP_REGISTRY): StepId[] =>
  STEP_ORDER.filter((id) => !steps.some((step) => step.id === id));

/** The registered steps' ids, in the milestone-1 order (`RegisteredStepId` in `setup.ts` is their schema). */
export const REGISTERED_STEP_IDS = STEP_REGISTRY.map((step) => step.id) as [RegisteredStep["id"], ...RegisteredStep["id"][]];

/** Every state check a registered step runs, by id: what the environment must answer (`setup.check`). */
export type StateCheckId = RegisteredStep["stateChecks"][number]["id"];
