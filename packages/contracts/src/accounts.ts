import { z } from "zod";
import { AccountIdentity, ProviderId } from "./adapter.js";
import type { EventTypeEntry } from "./event-types.js";
import { setOf, Timestamp } from "./primitives.js";

/**
 * The account store (claude-adapter spec, "The account store"; ADR 0018):
 * the accounts an environment holds, each a provider login in one config
 * directory of its own, adopted in place from the machine's own provider
 * directory or owned by the environment under its data directory. Every
 * change is an event on the account's stream (stream kind `account`, stream
 * id the account's id); the record `accounts.list` answers is the store's
 * read model of them. One account per identity per environment, and a
 * label unique on the environment ignoring case.
 */

/** The stream kind of an account's events; the stream id is the account's id. */
export const ACCOUNT_STREAM_KIND = "account";

/** An account's id: a version 4 UUID the environment mints, or the id an account carried over from configuration had (#119). */
export const AccountId = z
  .string()
  .min(1)
  .max(200)
  .meta({
    description:
      "An account's id on its environment: a version 4 UUID the environment mints when it adopts or adds the account; an account carried over from configuration keeps the id it was configured with.",
  });
export type AccountId = z.infer<typeof AccountId>;

/** The longest label an account takes. */
export const MAX_ACCOUNT_LABEL = 200;

/**
 * An account's label: what a client shows it as, preset to the email it
 * signed in as, editable, and unique on its environment ignoring case.
 */
export const AccountLabel = z
  .string()
  .min(1)
  .max(MAX_ACCOUNT_LABEL)
  .regex(/^\S(?:.*\S)?$/)
  .meta({
    description: `An account's label: 1 to ${MAX_ACCOUNT_LABEL} characters on one line, with no space at either end; unique on its environment ignoring case, preset to the email the account signed in as.`,
  });
export type AccountLabel = z.infer<typeof AccountLabel>;

/** Whose directory an account's is: the machine's own provider directory, adopted in place, or one the environment made under its data directory. */
export const ACCOUNT_DIRECTORY_KINDS = ["adopted", "owned"] as const;
export const AccountDirectoryKind = z.enum(ACCOUNT_DIRECTORY_KINDS).meta({
  description:
    "Whose config directory an account's is: adopted (the machine's own provider directory, registered in place and never moved, linked or deleted by the environment) or owned (made by the environment under its data directory for a fresh sign-in).",
});
export type AccountDirectoryKind = z.infer<typeof AccountDirectoryKind>;

export const AccountDirectory = z
  .object({
    kind: AccountDirectoryKind,
    path: z.string().min(1).meta({ description: "The directory's absolute path on the environment's machine." }),
  })
  .meta({ description: "An account's config directory: whose it is, and where." });
export type AccountDirectory = z.infer<typeof AccountDirectory>;

/** What an account's status read found. */
export const ACCOUNT_STATUS_STATES = ["signed-in", "signed-out", "expired", "unreadable", "unavailable"] as const;
export const AccountStatusState = z.enum(ACCOUNT_STATUS_STATES).meta({
  description:
    "What an account's status read found: signed-in (it can run), signed-out, expired (the provider says its login has lapsed), unreadable (the provider read failed), or unavailable (a deadline elapsed; automatically retried). Only a signed-in account runs.",
});
export type AccountStatusState = z.infer<typeof AccountStatusState>;

export const AccountStatus = z
  .object({
    state: AccountStatusState,
    checkedAt: Timestamp.nullable().meta({ description: "When the status was last read; null until the first read." }),
    detail: z.string().min(1).nullable().meta({ description: "Why the status is what it is, when the read said: the provider's error or a temporary deadline and retry diagnostic." }),
  })
  .meta({ description: "An account's status: what its last read found, when, and why when the read said." });
export type AccountStatus = z.infer<typeof AccountStatus>;

/** One account as `accounts.list` answers it. */
export const AccountRecord = z
  .object({
    id: AccountId,
    provider: ProviderId,
    label: AccountLabel,
    nameByEmail: z.boolean().optional().meta({ description: "True only while this account still has an automatically supplied name, eligible to become its email. An explicit rename clears it." }),
    directory: AccountDirectory,
    identity: AccountIdentity.nullable().meta({ description: "Who the account is signed in as, once a status read has said; null until then." }),
    status: AccountStatus,
    createdAt: Timestamp.meta({ description: "When the account was adopted or added." }),
  })
  .meta({ description: "An account the environment holds: its id, provider, label, directory, identity, status and when it was adopted or added." });
export type AccountRecord = z.infer<typeof AccountRecord>;

/** Why an account was removed: a person asked, or its sign-in yielded an identity another account holds. */
export const ACCOUNT_REMOVAL_REASONS = ["user", "duplicate-identity"] as const;
export const AccountRemovalReason = z.enum(ACCOUNT_REMOVAL_REASONS).meta({
  description:
    "Why an account was removed: user (accounts.remove), or duplicate-identity (its sign-in yielded an identity another account on the environment holds, so the account and its new directory went).",
});
export type AccountRemovalReason = z.infer<typeof AccountRemovalReason>;

const accountPart = { accountId: AccountId };

export const AccountAdoptedPayload = z
  .object({
    ...accountPart,
    provider: ProviderId,
    label: AccountLabel,
    directory: z.string().min(1).meta({ description: "The provider directory registered in place: never moved, linked or deleted." }),
  })
  .meta({ description: "account.adopted: the machine's own provider directory was registered in place as an account." });
export type AccountAdoptedPayload = z.infer<typeof AccountAdoptedPayload>;

export const AccountAddedPayload = z
  .object({
    ...accountPart,
    provider: ProviderId,
    label: AccountLabel,
    nameByEmail: z.boolean().optional().meta({ description: "Whether the supplied label was generated rather than chosen, to be replaced by its email after sign-in." }),
    directory: z.string().min(1).meta({ description: "The directory the environment made for the account under its data directory." }),
  })
  .meta({ description: "account.added: an account was added with a directory of the environment's own, for a fresh sign-in." });
export type AccountAddedPayload = z.infer<typeof AccountAddedPayload>;

export const AccountIdentitySetPayload = z
  .object({ ...accountPart, identity: AccountIdentity })
  .meta({ description: "account.identity-set: a status read said who the account is signed in as, and it was not what the store held." });
export type AccountIdentitySetPayload = z.infer<typeof AccountIdentitySetPayload>;

export const AccountStatusChangedPayload = z
  .object({
    ...accountPart,
    status: AccountStatusState,
    previous: AccountStatusState,
    detail: z.string().min(1).nullable().meta({ description: "Why, when the read said: the provider's error or a temporary deadline and retry diagnostic." }),
  })
  .meta({ description: "account.status-changed: a status read found the account in another state than the last; appended only on a change." });
export type AccountStatusChangedPayload = z.infer<typeof AccountStatusChangedPayload>;

export const AccountRelabelledPayload = z
  .object({ ...accountPart, label: AccountLabel, previous: AccountLabel })
  .meta({ description: "account.relabelled: the account's label was changed." });
export type AccountRelabelledPayload = z.infer<typeof AccountRelabelledPayload>;

export const AccountRemovedPayload = z
  .object({ ...accountPart, reason: AccountRemovalReason })
  .meta({ description: "account.removed: the environment no longer holds the account; its directory stays unless account.directory-deleted follows." });
export type AccountRemovedPayload = z.infer<typeof AccountRemovedPayload>;

export const AccountDirectoryDeletedPayload = z
  .object({ ...accountPart, directory: z.string().min(1).meta({ description: "The owned directory deleted, with the sign-in and history it held." }) })
  .meta({ description: "account.directory-deleted: a removed owned account's directory was deleted, on the explicit second choice or a duplicate identity's refusal." });
export type AccountDirectoryDeletedPayload = z.infer<typeof AccountDirectoryDeletedPayload>;

/** The event types of an account's stream: none changes the session list. */
export const ACCOUNT_EVENT_TYPES = {
  "account.adopted": { list: false, payload: AccountAdoptedPayload },
  "account.added": { list: false, payload: AccountAddedPayload },
  "account.identity-set": { list: false, payload: AccountIdentitySetPayload },
  "account.status-changed": { list: false, payload: AccountStatusChangedPayload },
  "account.relabelled": { list: false, payload: AccountRelabelledPayload },
  "account.removed": { list: false, payload: AccountRemovedPayload },
  "account.directory-deleted": { list: false, payload: AccountDirectoryDeletedPayload },
} as const satisfies Record<string, EventTypeEntry>;

export type AccountEventType = keyof typeof ACCOUNT_EVENT_TYPES;
export const AccountEventType = z.enum(Object.keys(ACCOUNT_EVENT_TYPES) as [AccountEventType, ...AccountEventType[]]).meta({
  description:
    "The event types of an account's stream: account.adopted, account.added, account.identity-set, account.status-changed, account.relabelled, account.removed, account.directory-deleted.",
});

export type AccountEventPayload<T extends AccountEventType> = z.infer<(typeof ACCOUNT_EVENT_TYPES)[T]["payload"]>;

/**
 * What an `account.updated` notice on `environment.subscribe` says changed,
 * so a client refreshes its cached account list: an account adopted, added,
 * given its identity, found in another status, relabelled or removed, or a
 * run's provider naming another login than the store holds.
 */
export const ACCOUNT_CHANGES = ["adopted", "added", "identity-set", "status-changed", "relabelled", "removed", "identity-mismatch"] as const;
export const AccountChange = z.enum(ACCOUNT_CHANGES).meta({
  description:
    "What changed on an account: adopted, added, identity-set, status-changed, relabelled, removed, or identity-mismatch (a run's provider, or a status read, named a login other than the one the store holds, or one another account holds; the notice carries a warning).",
});
export type AccountChange = z.infer<typeof AccountChange>;

/** The `account.updated` notice's payload. */
export const AccountUpdatedPayload = z
  .object({
    ...accountPart,
    change: AccountChange,
    warning: z.string().min(1).nullable().meta({ description: "What a person should know, when something is wrong: a mismatched identity, a sign-in refused as a duplicate." }),
  })
  .meta({ description: "account.updated: an account changed; a client refreshes what it caches of the accounts." });
export type AccountUpdatedPayload = z.infer<typeof AccountUpdatedPayload>;

/** What `accounts.probe` reports of the machine's own provider directory. */
export const AmbientProbe = z
  .object({
    provider: ProviderId,
    directory: z.string().min(1).nullable().meta({ description: "The machine's own provider directory; null when the provider has none on this environment." }),
    present: z.boolean().meta({ description: "Whether the directory exists." }),
    signedIn: z.boolean().meta({ description: "Whether its status read says it is signed in." }),
    identity: AccountIdentity.nullable().meta({ description: "Who it is signed in as; null when signed out or not read." }),
    accountId: AccountId.nullable().meta({ description: "The account that already holds the directory, adopted; null when none does." }),
    detail: z.string().min(1).nullable().meta({ description: "Why the status could not be read, when it could not." }),
    checkedAt: Timestamp.meta({ description: "When the directory was read." }),
  })
  .meta({ description: "The machine's own provider directory as accounts.probe read it: present or not, signed in as whom, and the account adopting it holds, if any." });
export type AmbientProbe = z.infer<typeof AmbientProbe>;

/** One model of an account's catalogue: its id, family, ordinal tier (higher is stronger) and the efforts it takes. */
export const ModelEntry = z
  .object({
    id: z.string().min(1).meta({ description: "The model's id, as a run or a session names it." }),
    family: z.string().min(1).meta({ description: "The model's family (opus, sonnet), which accounts.defaultModelFamily names." }),
    tier: z.int().meta({ description: "An ordinal the adapter supplies: higher is stronger; a family it cannot place ranks below every known one." }),
    efforts: z.array(z.string().min(1)).meta({ description: "The reasoning efforts the model takes, weakest first; empty when it takes none." }),
    label: z.string().min(1).nullable().meta({ description: "The model's name as a client shows it, when the adapter gives one." }),
    contextWindow: z.int().positive().nullable().optional().meta({ description: "The context window only when the provider reports it; absent for static catalogue entries." }),
  })
  .meta({ description: "One model of an account's catalogue: its id, family, ordinal tier and efforts." });
export type ModelEntry = z.infer<typeof ModelEntry>;

/** An account's models, listed live from the provider or the adapter's static list. */
export const AccountCatalogue = z
  .object({
    accountId: AccountId,
    live: z.boolean().meta({ description: "True when the provider enumerated the models; false for the adapter's static list." }),
    models: z.array(ModelEntry),
  })
  .meta({ description: "The models an account can use: enumerated live from its provider, or the adapter's static list." });
export type AccountCatalogue = z.infer<typeof AccountCatalogue>;

/**
 * A command entry of `commands.list` (skills spec, "Materialisation and the
 * Claude mapping"): a slash command the provider offers of its own, flagged
 * when it is the provider's built-in, which a member's `/name` never
 * shadows (skills spec, "Slash resolution").
 */
export const CommandEntry = z
  .object({
    kind: z.literal("command"),
    name: z.string().min(1).meta({ description: "The command's name, without its slash." }),
    description: z.string().meta({ description: "The provider's one-line description of it." }),
    builtin: z.boolean().meta({
      description:
        "Whether it is the provider's own built-in command, rather than one a user, a project or a plugin defined: /<name> stays the built-in's, and a skill of that name is reached as /skill:<name>.",
    }),
  })
  .meta({ description: "A command entry of commands.list: a slash command the provider offers of its own, its built-ins flagged." });
export type CommandEntry = z.infer<typeof CommandEntry>;

/** Why `accounts.add` did not start the account's sign-in: another sign-in holds the environment's one, or this environment cannot sign the provider in. */
export const SIGN_IN_NOT_STARTED_REASONS = ["signin_running", "signin_unavailable"] as const;

/** Whether `accounts.add` started the account's sign-in, and what to tell a person when it did not. */
export const SignInStart = z
  .object({
    started: z.boolean().meta({ description: "Whether the environment started signing the account in." }),
    message: z.string().min(1).nullable().meta({ description: "What to tell a person when it did not: why, and what to do instead." }),
    reason: z.enum(SIGN_IN_NOT_STARTED_REASONS).optional().meta({
      description:
        "Why it did not start, as accounts.signin.start's refusal names it: signin_running (another account's sign-in is running) or signin_unavailable; absent when it started, and from environments that do not say.",
    }),
  })
  .meta({ description: "Whether accounts.add started the account's sign-in, and why not when it did not." });
export type SignInStart = z.infer<typeof SignInStart>;

/**
 * `accounts.defaultAccount`: the account a session with none of its own
 * runs on; null for the first account adopted or added. An account the
 * environment no longer holds is passed over the same way.
 */
export const DefaultAccount = AccountId.nullable().meta({
  description:
    "The account a session with none of its own runs on (ADR 0018); null, or an account the environment no longer holds, for the first account adopted or added that it still holds.",
});

/** `accounts.defaultModelFamily`: the family a run with no model of its own or its session's takes the strongest model of; null for the strongest model. */
export const DefaultModelFamily = z
  .string()
  .min(1)
  .nullable()
  .meta({
    description:
      "The model family (opus, sonnet) whose strongest model a run takes when neither it nor its session names a model; null, or a family the account does not offer, for the account's strongest model. The Account step presets it to the highest tier's family.",
  });

/** `accounts.defaultEffort`: the effort a run with none of its own takes when its model takes it; null for the model's own. */
export const DefaultEffort = z
  .string()
  .min(1)
  .nullable()
  .meta({
    description:
      "The reasoning effort a run with none of its own takes, when its model takes that effort; null, or an effort the model does not take, for the model's own. The Account step presets it to high.",
  });

/** The most models `accounts.favouriteModels` holds: a short list of quick picks, never the catalogue again. */
export const FAVOURITE_MODELS_MAX = 20;

/**
 * `accounts.favouriteModels` (#1821): the models a person pinned, in the
 * order they put them, which the account and model picker offers first as
 * one-click picks, every other model the account offers under Other models.
 * Model ids, not families, each once; a model no account lists any more
 * stays until it is removed, and the picker passes it over.
 */
export const FavouriteModels = setOf(z.string().min(1))
  .max(FAVOURITE_MODELS_MAX)
  .meta({
    description: `The model ids the account and model picker offers first, in the order the person put them, each once, at most ${FAVOURITE_MODELS_MAX}; empty for the provider's recommended models. A model the selected account does not list is passed over.`,
  });
export type FavouriteModels = z.infer<typeof FavouriteModels>;

/**
 * The sign-in director (claude-adapter spec, "Sign-in and status through the
 * bundled binary"; ADR 0018): one sign-in at a time per environment, which
 * runs the provider's CLI with the account's directory, publishes the
 * verification URL and takes the code back from any client.
 */

/**
 * Where a sign-in is: `starting` (the CLI is being chosen and started),
 * `awaiting-code` (the verification URL is published), `submitting` (a code
 * was written to the CLI), then one of the ends: `done`, `failed`, `expired`
 * (ten minutes without a code, or a submission that never finished) or
 * `cancelled`.
 */
export const SIGN_IN_STATES = ["starting", "awaiting-code", "submitting", "done", "failed", "expired", "cancelled"] as const;
export const SignInState = z.enum(SIGN_IN_STATES).meta({
  description:
    "Where a sign-in is: starting, awaiting-code (the verification URL is published), submitting (a code was written to the provider's CLI), or ended: done (the status read found the account signed in), failed, expired (ten minutes without a code, or a submission that never finished) or cancelled.",
});
export type SignInState = z.infer<typeof SignInState>;

/** The states a sign-in ends in: nothing runs after them. */
export const SIGN_IN_ENDED_STATES = ["done", "failed", "expired", "cancelled"] as const satisfies readonly SignInState[];

/** The command a person runs in a terminal on the environment's machine instead, in both shells. */
export const SignInFallback = z
  .object({
    posix: z.string().min(1).meta({ description: "For sh, bash or zsh: the directory variable set on the command, the directory single-quoted." }),
    powershell: z.string().min(1).meta({ description: "For PowerShell: the directory variable set, then the executable called, each path single-quoted." }),
  })
  .meta({ description: "The exact command that signs the account's directory in from a terminal on the environment's machine, in POSIX and PowerShell renderings." });
export type SignInFallback = z.infer<typeof SignInFallback>;

/**
 * Why a sign-in ended, where a client words it apart (setup-copy.md §5.2):
 * `code-refused` (the provider's CLI failed after a code was written to it),
 * `restarted` (the environment restarted while it ran) or `account-removed`.
 */
export const SIGN_IN_CAUSES = ["code-refused", "restarted", "account-removed"] as const;
export type SignInCause = (typeof SIGN_IN_CAUSES)[number];

/** One sign-in as `accounts.signin.get` answers it and `signin.updated` carries it. */
export const SignIn = z
  .object({
    accountId: AccountId.meta({ description: "The account whose directory is being signed in." }),
    state: SignInState,
    url: z.url().nullable().meta({ description: "The verification URL a person opens to sign in, once the provider's CLI has printed it; null until then." }),
    startedAt: Timestamp.meta({ description: "When the sign-in started." }),
    expiresAt: Timestamp.meta({ description: "When the sign-in expires if it is still waiting: ten minutes after it started, or after the code was written." }),
    fallback: SignInFallback,
    error: z.string().min(1).nullable().meta({ description: "Why the sign-in failed, expired or was cancelled, when there is more to say; null otherwise." }),
    cause: z.enum(SIGN_IN_CAUSES).optional().meta({
      description:
        "Why a failed or cancelled sign-in ended, where a client words it apart: code-refused (the provider's CLI failed after the code was written to it), restarted (the environment restarted while it ran), account-removed; absent otherwise, from a person's cancel, and from environments that do not say.",
    }),
  })
  .meta({ description: "A sign-in of an account's directory: its state, the verification URL, when it expires, the fallback command, and why it ended when it did not succeed." });
export type SignIn = z.infer<typeof SignIn>;

/** The code a person copies from the provider's page after signing in. */
export const SignInCode = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^\S+$/)
  .meta({
    description:
      "The code the provider's page shows after signing in: one token, with no space or line break anywhere, so a client trims what a person pasted before sending it.",
  });
export type SignInCode = z.infer<typeof SignInCode>;

/** Which executable sign-ins run: the SDK's bundled binary, or the managed tool when the bundled one does not run a sign-in. */
export const SIGN_IN_EXECUTABLE_SOURCES = ["bundled", "managed-tool"] as const;
export const SignInExecutableSource = z.enum(SIGN_IN_EXECUTABLE_SOURCES).meta({
  description:
    "Which executable sign-ins run: bundled (the provider's binary the SDK ships, which runs use too) or managed-tool (the provider's CLI on the environment's PATH, when the bundled binary does not run a sign-in).",
});
export type SignInExecutableSource = z.infer<typeof SignInExecutableSource>;

/** The `signin.executable-chosen` notice's payload: the choice, made once per environment and bundled binary. */
export const SignInExecutableChosenPayload = z
  .object({
    provider: ProviderId,
    source: SignInExecutableSource,
    executable: z.string().min(1).meta({ description: "The executable chosen, as it was found." }),
    bundled: z.string().min(1).nullable().meta({ description: "The bundled binary the choice was made against; null when this platform has none. A different one is probed again." }),
    detail: z.string().min(1).nullable().meta({ description: "Why the bundled binary was passed over, when it was." }),
  })
  .meta({ description: "signin.executable-chosen: which executable the environment's sign-ins for a provider run, chosen once and recorded." });
export type SignInExecutableChosenPayload = z.infer<typeof SignInExecutableChosenPayload>;
