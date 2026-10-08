import { z } from "zod";
import type { EventTypeEntry } from "./event-types.js";
import { CommandId } from "./primitives.js";
import { SettingsRowId } from "./settings-rows.js";
import { StepId } from "./steps.js";

/**
 * The state import (setup spec, "2. Carry over", the state-import section;
 * ADR 0036): what the source's data folder and its terminal client's state
 * folder hold on the environment's machine, carried through the services
 * that own each kind. `stateImport.detect` answers whether either folder is
 * there and what the data folder holds (#581); `stateImport.run`'s report
 * and the `state-import.finished` notice are the contract the switch-over
 * build (#94) serves and the Carry over card (#583) reads. The import's own
 * evidence goes on the `state-import` stream: `state-import.started` before
 * it applies anything, and one `state-import.item-carried` per item it
 * carried, committed with the item's own events (#1165).
 */

const count = (description: string) => z.int().nonnegative().meta({ description });

/** A count of what one of the data folder's files lists: null when the file is there but could not be read. */
const listed = (description: string) =>
  z
    .int()
    .nonnegative()
    .nullable()
    .meta({ description: `${description} Zero when its file is absent; null when its file is there but could not be read.` });

/** What a source data folder holds, by kind: what the Carry over card's state-import section says it found. */
export const StateImportHoldings = z
  .object({
    profiles: listed("The provider logins it lists, one per config directory, of every provider."),
    banks: listed("The memory banks its registry lists."),
    routines: listed("The routines it lists, both those of the source's desktop and those of its headless service."),
    instructions: listed("The custom instructions it lists, and the built-in ones whose text was taken over."),
    skillSources: listed("The tracked skill repositories it lists."),
    connections: listed("The key-manager connections it lists."),
  })
  .meta({ description: "What a source data folder holds, by kind: profiles, banks, routines, instructions, skill sources and key-manager connections." });
export type StateImportHoldings = z.infer<typeof StateImportHoldings>;

const folderPath = z.string().min(1).meta({ description: "The folder's absolute path on the environment's machine." });

/** A source data folder found on the environment's machine, and what it holds. */
export const StateImportDataFolder = z
  .object({ path: folderPath, holds: StateImportHoldings })
  .meta({ description: "A source data folder found on the environment's machine: where, and what it holds by kind." });
export type StateImportDataFolder = z.infer<typeof StateImportDataFolder>;

/** A source terminal client's state folder found on the environment's machine: its prompt history, snippets and preferences. */
export const StateImportTerminalFolder = z
  .object({ path: folderPath })
  .meta({ description: "A source terminal client's state folder found on the environment's machine, holding its prompt history, snippets or preferences." });
export type StateImportTerminalFolder = z.infer<typeof StateImportTerminalFolder>;

/** What `stateImport.detect` answers: the source data folder and the terminal-client state folder, each null when none is found. */
export const StateImportDetection = z
  .object({
    dataFolder: StateImportDataFolder.nullable().meta({ description: "The source data folder found on the environment's machine; null when none is." }),
    terminalFolder: StateImportTerminalFolder.nullable().meta({
      description: "The source terminal client's state folder found on the environment's machine; null when none is.",
    }),
  })
  .meta({
    description:
      "Whether a source data folder or a terminal-client state folder is on the environment's machine, and what the data folder holds: the Carry over card shows its state-import section when either is found.",
  });
export type StateImportDetection = z.infer<typeof StateImportDetection>;

/** What an import carried, counted per kind (ADR 0036's rules per kind, each written through its owning service with origin `import`). */
export const StateImportCarried = z
  .object({
    accounts: count("Config directories adopted in place as accounts."),
    archived: count("Sessions archived by a leftover archive key."),
    pins: count("Sessions pinned."),
    groups: count("Groups carried by name, merged into same-named ones."),
    forgeAccounts: count("Forge accounts made from per-bank forge credentials."),
    keyManagerConnections: count("Key-manager connections carried as records awaiting sign-in."),
    banks: count("Memory banks pointing at their existing checkouts."),
    routines: count("Routines, each imported disabled."),
    instructions: count("Owned instructions made from custom or taken-over prompts."),
    skillSources: count("Skill sources made from tracked repositories."),
    alwaysOnSkills: count("Always-on skill names applied per mapped account."),
    drafts: count("Drafts carried into empty session drafts."),
    devSites: count("Dev sites carried into the page policy."),
  })
  .meta({ description: "What a state import carried, counted per kind." });
export type StateImportCarried = z.infer<typeof StateImportCarried>;

const label = z.string().min(1).meta({ description: "What it is, for a person." });

/** Something the person must enter again, with the step whose card takes it: a sign-in or an encrypted token. */
export const StateImportReEnter = z
  .object({ label, step: StepId.meta({ description: "The step whose card takes it: Account, Forges, Key manager or Memory bank." }) })
  .meta({ description: "Something a state import needs the person to enter again: what, and the step that takes it." });
export type StateImportReEnter = z.infer<typeof StateImportReEnter>;

/** A profile of a provider whose adapter arrives in milestone 2, carried with its sessions by a re-run then. */
export const StateImportLater = z
  .object({ label, provider: z.string().min(1).meta({ description: "The provider its adapter serves." }) })
  .meta({ description: "A profile of a provider whose adapter arrives in milestone 2: a re-run then carries it with its sessions." });
export type StateImportLater = z.infer<typeof StateImportLater>;

/** Something the state import never carries, with how many and, where one takes its place, the step that does. */
export const StateImportNotCarried = z
  .object({
    label,
    count: count("How many the source held."),
    step: StepId.nullable().meta({ description: "The step to set it up again on (Your machines for saved connections, Browser for pairings); null when none does." }),
  })
  .meta({ description: "Something a state import never carries: what, how many, and the step to set it up on again, if any." });
export type StateImportNotCarried = z.infer<typeof StateImportNotCarried>;

/** One thing an import could not do, which a re-run tries again. */
export const StateImportFailure = z
  .object({
    label,
    message: z.string().min(1).meta({ description: "What went wrong, for a person." }),
  })
  .meta({ description: "What a state import could not carry: the item, and why." });
export type StateImportFailure = z.infer<typeof StateImportFailure>;

/**
 * The client-local values the source kept that have a settings row (ADR
 * 0036), which the client that ran the import applies only when it runs on
 * the environment's machine and otherwise lists as not applied. Each is
 * absent when the source held none.
 */
export const StateImportClientLocal = z
  .object({
    mode: z.enum(["light", "dark", "system"]).optional().meta({ description: "The light, dark or system mode." }),
    fontSize: z.int().positive().optional().meta({ description: "The conversation's font size, in pixels." }),
    conversationWidth: z.enum(["comfortable", "wide", "full"]).optional().meta({ description: "The conversation's width." }),
    showThinking: z.boolean().optional().meta({ description: "Whether a run's thinking shows." }),
    settingsRow: SettingsRowId.optional().meta({ description: "The row of Settings last open, mapped through the address table." }),
  })
  .meta({ description: "The client-local values a state import carries: applied by the client that ran it only on the environment's machine." });
export type StateImportClientLocal = z.infer<typeof StateImportClientLocal>;

/** A source profile sharing its real projects folder with another, each named by its source id and its label (#1726). */
const SharedProjects = z.object({
  sourceId: z.string().min(1).meta({ description: "The source profile whose projects folder is the owner's." }),
  label: z.string().min(1).meta({ description: "That profile's label: what the report names it by." }),
  ownerSourceId: z.string().min(1).meta({ description: "The source profile its sessions and memory carry with." }),
  ownerLabel: z.string().min(1).meta({ description: "The owner's label." }),
});
const sharedProjectsDescription = "Source profiles sharing a real projects folder with another: their sessions and memory carry once, with the owner, and not again with them.";

/**
 * `state-import.finished`: a state import ended, on the environment stream
 * as the client session that ran it: its four groups and what failed, which
 * a re-run tries again. Carry over's step re-runs on it, and a client reads
 * `stateImport.detect` again.
 */
export const StateImportFinishedPayload = z
  .object({
    carried: StateImportCarried,
    sharedProjects: z.array(SharedProjects.partial({ label: true, ownerLabel: true })).optional().meta({ description: `${sharedProjectsDescription} A notice an older environment wrote names them by source id alone.` }),
    reEnter: z.array(StateImportReEnter).meta({ description: "What must be entered again, each with the step that takes it." }),
    later: z.array(StateImportLater).meta({ description: "What arrives in milestone 2: other providers' profiles." }),
    notCarried: z.array(StateImportNotCarried).meta({ description: "What never carries." }),
    failed: z.array(StateImportFailure).meta({ description: "What could not be carried, each with why; empty when everything was." }),
  })
  .meta({
    description: "state-import.finished: a state import ended: what it carried, what must be entered again, what arrives in milestone 2, what never carries, and what failed.",
  });
export type StateImportFinishedPayload = z.infer<typeof StateImportFinishedPayload>;

/** What `stateImport.run` answers: the report's four groups and what failed, the client-local values, and whether it was a dry run. */
export const StateImportReport = StateImportFinishedPayload.extend({
  sharedProjects: z.array(SharedProjects).optional().meta({ description: sharedProjectsDescription }),
  clientLocal: StateImportClientLocal,
  dryRun: z.boolean().meta({ description: "Whether it was a dry run: the report of what an import would do, with nothing written." }),
}).meta({
  description:
    "What a state import did, or, in a dry run, would do: carried (counts per kind), re-enter, arriving in milestone 2, not carried, what failed, and the client-local values.",
});
export type StateImportReport = z.infer<typeof StateImportReport>;

/** The state import's own stream, one per environment, its id the environment's: where an import starts and what it carried. */
export const STATE_IMPORT_STREAM_KIND = "state-import";

const importId = CommandId.meta({ description: "The import: the command id of the stateImport.run that applied it, in lowercase." });
const sourceKey = z.string().min(1).meta({ description: "The source data folder's canonical path on the environment's machine: symbolic links resolved." });

/**
 * `state-import.started`: an import is about to apply what it planned,
 * before any item. Its `state-import.finished` notice (correlated by the
 * import's id) follows once it has applied everything; one with none after
 * it, once the import is no longer under way, is an import that stopped part
 * way, which Carry over's last-import check names.
 */
export const StateImportStartedPayload = z
  .object({
    importId,
    sourceKey: z.string().min(1).meta({
      description:
        "The source folder's canonical path on the environment's machine, symbolic links resolved: its data folder, or its terminal-client state folder when it has none.",
    }),
  })
  .meta({
    description:
      "state-import.started: an import is about to apply what it planned: its id and the source folder it reads (its data folder, or its terminal-client state folder when it has none).",
  });
export type StateImportStartedPayload = z.infer<typeof StateImportStartedPayload>;

/** The kinds of item a state import carries, each written through the service that owns it. */
export const StateImportItemKind = z.enum(["instruction", "bank", "bank-default", "forge-account", "key-manager-connection", "dev-site", "page-policy", "account", "account-default", "session", "archive", "pin", "group", "group-membership", "draft", "routine", "skill-source", "skill-always-on", "favourite-models"]).meta({ description: "The owning service kind for a carried Bank/default, instruction, Account/default, provider Session, archive or active decision, pin, Group/membership, draft, Forge account, Key-manager connection, dev site, page policy, a disabled local Routine, tracked Skill repository or Account Skill choice, or the favourite models made of the models chosen in the source." });
export type StateImportItemKind = z.infer<typeof StateImportItemKind>;

/**
 * `state-import.item-carried`: one source item carried, committed in the
 * same transaction as the events its owning service appended for it. The
 * item is named by the source folder, the store it was read from and its id
 * there (or its natural identity when the store gives it none), never its
 * position in a list; a re-run finds it held by this and leaves its target
 * alone, edited or deleted since. It carries no secret.
 */
export const StateImportItemCarriedPayload = z
  .object({
    importId,
    sourceKey,
    store: z.string().min(1).meta({ description: "The source store or organisation decision kind, including banks, banks.default, provider-sessions and organisation.archive/pin/group/group-source/membership/draft." }),
    sourceId: z.string().min(1).meta({ description: "The item's id in its store, or its natural identity where the store gives it none." }),
    kind: StateImportItemKind,
    sourceDirectory: z.string().min(1).optional().meta({ description: "The canonical listed Claude directory retained as an import source for an Account or Session mapping, including a secondary directory. No credentials." }),
    targetId: z.string().min(1).meta({ description: "The target held by its owning service: a Bank, Account, Session, Group or instruction id, a dev-site host pattern, connection id or setting key." }),
    origin: z.literal("import").meta({ description: "Always import: the target was written by a state import." }),
  })
  .meta({
    description:
      "state-import.item-carried: a source item was carried: its folder, store and id there, its kind, the target its owning service made of it, the import that carried it, and origin import.",
  });
export type StateImportItemCarriedPayload = z.infer<typeof StateImportItemCarriedPayload>;

/** A source default waiting for its mapped Account to sign in; no credentials are carried. */
export const StateImportDefaultAccountDeferredPayload = z.object({
  importId,
  sourceKey,
  sourceId: z.string().min(1),
  label,
}).meta({ description: "The source default Account choice retained until its mapped Account signs in." });
export type StateImportDefaultAccountDeferredPayload = z.infer<typeof StateImportDefaultAccountDeferredPayload>;

/** The event types of the `state-import` stream; none is in the session list. */
export const STATE_IMPORT_EVENT_TYPES = {
  "state-import.default-account-deferred": { list: false, payload: StateImportDefaultAccountDeferredPayload },
  "state-import.started": { list: false, payload: StateImportStartedPayload },
  "state-import.item-carried": { list: false, payload: StateImportItemCarriedPayload },
} as const satisfies Record<string, EventTypeEntry>;

export type StateImportEventType = keyof typeof STATE_IMPORT_EVENT_TYPES;
export const StateImportEventType = z
  .enum(Object.keys(STATE_IMPORT_EVENT_TYPES) as [StateImportEventType, ...StateImportEventType[]])
  .meta({ description: "The event types of the state-import stream: started, item-carried and default-account-deferred." });
