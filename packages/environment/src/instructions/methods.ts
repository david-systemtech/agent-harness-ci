import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  invalidParams,
  keyBetween,
  normaliseInstructionTitle,
  type AdapterCapabilities,
  type Catalogue,
  type CatalogueInstructionEntry,
  type InstructionAccount,
  type InstructionDiff,
  type InstructionOrigin,
  type InstructionReach,
  type OrderKey,
  type OrientationRow,
  type OwnedInstruction,
} from "@agent-harness/contracts";
import type { AdapterHost, InstructionTarget } from "../adapter/host.js";
import type { EventLog } from "../event-log/event-log.js";
import type { CommandAnswer, CommandContext, CommandRejection, MethodHandlers } from "../serve/methods.js";
import type { OrientationAnswer } from "./composer.js";
import { readMintedFile } from "./import.js";
import { instructionsStream, type InstructionStore } from "./store.js";

/**
 * The standing-instruction methods on the method table (skills-instructions
 * spec, "Standing instructions and the composer" and "Owned instructions"):
 * `instructions.preview` at `read`, what a run would be handed now, composed
 * by the host as a run's launch composes it
 * (`AdapterHost.previewInstructions`); `instructions.list` at `read`, the
 * Orientation row and the owned instructions, every row with the
 * environment's accounts, each copy with its entry's newer version, and the
 * dismissed entries; `instructions.diff` at `read`; and the owned
 * instructions' commands at `admin`, one per field (ADR 0003), each
 * appending its events on the `instructions` stream and, in the same
 * transaction, `instructions.updated` on the environment's stream. A command
 * that changes nothing appends neither. Nothing here reaches a live run: the
 * host composes a run's text once, as it launches.
 *
 * Suggested instructions (#509; ADR 0030) keep one rule: a catalogue entry
 * is never both held as a copy and dismissed. Ticking or importing a copy
 * of a dismissed entry restores it; removing the last copy of an entry
 * dismisses it; dismissing an entry held as a copy is refused. Nothing
 * updates a copy but `instructions.resolveVersion`.
 */

/** An account as the list reads it: the record's id, label and provider, and its adapter's descriptor, null when no adapter for its provider is here. */
export interface ListedAccount {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly descriptor: Pick<AdapterCapabilities, "displayName" | "instructionChannel"> | null;
}

export interface InstructionMethodsOptions {
  readonly host: AdapterHost;
  readonly log: EventLog;
  /** The environment's id: the id of its instructions stream and its own. */
  readonly environmentId: string;
  readonly store: InstructionStore;
  /** The environment's accounts now, in the account list's order. */
  readonly accounts: () => readonly ListedAccount[];
  /** The `instructions.orientation` key now. */
  readonly orientationOn: () => boolean;
  /**
   * The orientation block for the Orientation row, as the first run of a new
   * session of the default account started from a client is handed it;
   * null while the environment holds no account.
   */
  readonly orientation: () => Promise<OrientationAnswer | null>;
  /** The catalogue the suggested instructions are read from: this build's, which a test replaces with one holding a newer version. */
  readonly catalogue: () => Catalogue;
}

/** The text of `entry` at `version`: its current text, or an earlier version's; null for a version it does not hold. */
const textAt = (entry: CatalogueInstructionEntry, version: number): string | null =>
  version === entry.version ? entry.text : (entry.earlierVersions.find((earlier) => earlier.version === version)?.text ?? null);

/** The notice every committed change is followed by. */
const UPDATED = { type: "instructions.updated", payload: {} } as const;

const NO_CHANNEL = { kind: "none", maxCharacters: null } as const;

/** An account as every row carries it: its adapter's channel and, with none, why its runs are handed nothing. */
export const instructionAccount = ({ id, label, provider, descriptor }: ListedAccount): InstructionAccount => {
  if (descriptor === null) {
    return { accountId: id, label, channel: NO_CHANNEL, reason: `No adapter for ${provider} is on this environment, so its runs are handed no standing instructions.` };
  }
  const { instructionChannel, displayName } = descriptor;
  const reason = instructionChannel.kind === "none" ? `Its adapter, ${displayName}, has no instruction channel, so its runs are handed no standing instructions.` : null;
  return { accountId: id, label, channel: instructionChannel, reason };
};

type Refused = "not_found" | "conflict";

type EventInput = { readonly type: string; readonly payload: Record<string, unknown> };

export const instructionMethods = (options: InstructionMethodsOptions): MethodHandlers => {
  const { host, log, store } = options;
  const stream = instructionsStream(options.environmentId);

  const noInstruction = (instructionId: string): CommandRejection<"not_found"> => ({
    code: "not_found",
    message: `No owned instruction ${instructionId} is on this environment.`,
    data: { kind: "instruction", instructionId },
  });

  /** The first account `scope` names that the environment does not hold, refused; null when it holds every one. */
  const unheldAccount = (scope: InstructionReach): CommandRejection<"not_found"> | null => {
    if (scope === "all") return null;
    const held = new Set(options.accounts().map((account) => account.id));
    const missing = scope.find((accountId) => !held.has(accountId));
    return missing === undefined ? null : { code: "not_found", message: `No account ${missing} is on this environment.`, data: { kind: "account", accountId: missing } };
  };

  /** Appends `events` on the instructions stream, then the notice, as the command's client session. */
  const record = (context: CommandContext, ...events: readonly EventInput[]): void => {
    const attribution = { tx: context.tx, actor: context.actor, commandId: context.commandId };
    log.append(stream, events, attribution);
    log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [UPDATED], attribution);
  };

  /** The catalogue entry `catalogueId` names in this build's catalogue; undefined for one it does not hold. */
  const entryOf = (catalogueId: string): CatalogueInstructionEntry | undefined => options.catalogue().instructions.entries.find((entry) => entry.id === catalogueId);

  const noEntry = (catalogueId: string): CommandRejection<"not_found"> => ({
    code: "not_found",
    message: `The catalogue holds no suggested instruction ${catalogueId}.`,
    data: { kind: "instruction", catalogueId },
  });

  /** The entry's current version while it is newer than the one `origin` holds; null for Custom, a current copy, or an entry no longer held. */
  const newerVersion = (origin: InstructionOrigin | null): number | null => {
    if (origin === null) return null;
    const entry = entryOf(origin.catalogueId);
    return entry !== undefined && entry.version > origin.version ? entry.version : null;
  };

  const isDismissed = (catalogueId: string): boolean => store.dismissed().includes(catalogueId);

  /**
   * Makes a new owned instruction under the client's `id`, as a create or an
   * import makes it: refused `conflict` for an id used before and
   * `not_found` for an account the scope names that is not held; a copy of a
   * dismissed entry restores it in the same command.
   */
  const createOwned = (
    context: CommandContext,
    fields: { readonly id: string; readonly title: string; readonly body: string; readonly origin: InstructionOrigin | null },
    placement: { readonly scope?: InstructionReach | undefined; readonly enabled?: boolean | undefined; readonly position?: OrderKey | undefined },
  ): CommandAnswer<{ instruction: OwnedInstruction }, Refused> => {
    const id = fields.id.toLowerCase();
    if (store.used(id)) {
      const message = `The id ${id} is taken by an owned instruction, here now or removed.`;
      return { aggregate: stream, rejected: { code: "conflict", message, data: { reason: "exists", instructionId: id } } };
    }
    const scope = placement.scope ?? "all";
    const unheld = unheldAccount(scope);
    if (unheld !== null) return { aggregate: stream, rejected: unheld };
    const created: OwnedInstruction = {
      id,
      title: normaliseInstructionTitle(fields.title),
      body: fields.body,
      origin: fields.origin,
      scope,
      enabled: placement.enabled ?? true,
      position: placement.position ?? keyBetween(store.list().at(-1)?.position ?? null, null),
    };
    const restored = fields.origin !== null && isDismissed(fields.origin.catalogueId) ? [{ type: "instructions.suggestion-restored", payload: { catalogueId: fields.origin.catalogueId } }] : [];
    record(context, { type: "instructions.created", payload: created }, ...restored);
    return { aggregate: stream, result: { instruction: now(id) } };
  };

  /** A rejection as a query throws it. */
  const thrown = ({ code, message, data }: CommandRejection): ContractError => new ContractError({ code, message: message ?? "", data: data ?? {} });

  const noOrigin = (instructionId: string): CommandRejection<"conflict"> => ({
    code: "conflict",
    message: `The owned instruction ${instructionId} was written here, not copied from the catalogue.`,
    data: { reason: "no_origin", instructionId },
  });

  /** The instruction as it is now, after a command appended to it. */
  const now = (id: string): OwnedInstruction => {
    const found = store.get(id);
    if (found === undefined) throw new Error(`The owned instruction ${id} is not in the store after a command applied to it.`);
    return found;
  };

  /**
   * Runs a command on one owned instruction: its id in lowercase, refused
   * `not_found` when it is not held; `change` answers the event to append,
   * null when the command changes nothing, or a rejection.
   */
  const onInstruction = (
    instructionId: string,
    context: CommandContext,
    change: (held: OwnedInstruction) => EventInput | null | CommandRejection<Refused>,
  ): CommandAnswer<{ instruction: OwnedInstruction }, Refused> => {
    const id = instructionId.toLowerCase();
    const held = store.get(id);
    if (held === undefined) return { aggregate: stream, rejected: noInstruction(id) };
    const decided = change(held);
    if (decided !== null && "code" in decided) return { aggregate: stream, rejected: decided };
    if (decided !== null) record(context, decided);
    return { aggregate: stream, result: { instruction: now(id) } };
  };

  return {
    "instructions.preview": async ({ sessionId, accountId, workspace }) => {
      // The params' schema takes a session, or an account and a workspace, never both.
      const target: InstructionTarget | undefined =
        sessionId !== undefined ? { sessionId } : accountId !== undefined && workspace !== undefined ? { accountId, workspace } : undefined;
      if (target === undefined) {
        const message = "Name a session, or an account and a workspace.";
        throw new ContractError(invalidParams([{ code: "custom", path: [], message }], message));
      }
      const composed = await host.previewInstructions(target);
      return {
        parts: composed.parts.map(({ layer, id, title, text }) => ({ layer, id, title, text })),
        text: composed.text,
        manifest: composed.manifest,
      };
    },

    "instructions.list": async () => {
      const accounts = options.accounts().map(instructionAccount);
      const block = await options.orientation();
      const orientation: OrientationRow = {
        enabled: options.orientationOn(),
        text: block?.text ?? null,
        unreadRegistries: [...(block?.unreadRegistries ?? [])],
        accounts,
      };
      return {
        orientation,
        instructions: store.list().map((instruction) => ({ ...instruction, newerVersion: newerVersion(instruction.origin), accounts })),
        dismissed: store.dismissed(),
      };
    },

    "instructions.diff": ({ instructionId }): InstructionDiff => {
      const id = instructionId.toLowerCase();
      const held = store.get(id);
      if (held === undefined) throw thrown(noInstruction(id));
      if (held.origin === null) throw thrown(noOrigin(id));
      const { catalogueId, version } = held.origin;
      const entry = entryOf(catalogueId);
      if (entry === undefined) throw thrown(noEntry(catalogueId));
      return { catalogueId, fromVersion: version, toVersion: entry.version, from: textAt(entry, version), to: entry.text, body: held.body };
    },

    "instructions.create": ({ id, catalogueId, title, body, origin, ...placement }, context): CommandAnswer<{ instruction: OwnedInstruction }, Refused> => {
      if (catalogueId === undefined) {
        // The params' schema takes a title and a body with no catalogue id.
        if (title === undefined || body === undefined) throw new ContractError(invalidParams([{ code: "custom", path: [], message: "Give a title and a body, or a catalogue id." }]));
        return createOwned(context, { id, title, body, origin: origin ?? null }, placement);
      }
      const entry = entryOf(catalogueId);
      if (entry === undefined) return { aggregate: stream, rejected: noEntry(catalogueId) };
      return createOwned(context, { id, title: entry.title, body: entry.text, origin: { catalogueId, version: entry.version } }, placement);
    },

    "instructions.import": ({ id, sessionId, path, catalogueId }, context): CommandAnswer<{ instruction: OwnedInstruction }, Refused> => {
      // The log's query-only read: the session's workspace and tags as of the command's transaction.
      const read = readMintedFile({ all: (sql, ...params) => log.read(sql, ...params) }, sessionId, path);
      if ("code" in read) return { aggregate: stream, rejected: read };
      if (catalogueId === undefined) return createOwned(context, { id, ...read, origin: null }, {});
      const entry = entryOf(catalogueId);
      if (entry === undefined) return { aggregate: stream, rejected: noEntry(catalogueId) };
      return createOwned(context, { id, ...read, origin: { catalogueId, version: entry.version } }, {});
    },

    "instructions.edit": ({ instructionId, title, body }, context) =>
      onInstruction(instructionId, context, (held) => {
        const kept = normaliseInstructionTitle(title);
        return kept === held.title && body === held.body ? null : { type: "instructions.edited", payload: { id: held.id, title: kept, body } };
      }),

    "instructions.setScope": ({ instructionId, scope }, context) =>
      onInstruction(instructionId, context, (held) => {
        const unheld = unheldAccount(scope);
        if (unheld !== null) return unheld;
        return JSON.stringify(scope) === JSON.stringify(held.scope) ? null : { type: "instructions.scope-set", payload: { id: held.id, scope } };
      }),

    "instructions.setEnabled": ({ instructionId, enabled }, context) =>
      onInstruction(instructionId, context, (held) => (enabled === held.enabled ? null : { type: "instructions.enabled-set", payload: { id: held.id, enabled } })),

    "instructions.move": ({ instructionId, position }, context) =>
      onInstruction(instructionId, context, (held) => (position === held.position ? null : { type: "instructions.moved", payload: { id: held.id, position } })),

    "instructions.resolveVersion": ({ instructionId, choice }, context) =>
      onInstruction(instructionId, context, (held) => {
        if (held.origin === null) return noOrigin(held.id);
        const entry = entryOf(held.origin.catalogueId);
        if (entry === undefined || entry.version <= held.origin.version) return null;
        const payload = choice === "replace" ? { id: held.id, choice, version: entry.version, body: entry.text } : { id: held.id, choice, version: entry.version };
        return { type: "instructions.version-resolved", payload };
      }),

    "instructions.remove": ({ instructionId }, context): CommandAnswer<{ instructionId: string }, "not_found"> => {
      const id = instructionId.toLowerCase();
      const held = store.get(id);
      if (held === undefined) return { aggregate: stream, rejected: noInstruction(id) };
      // Removing the last copy of an entry dismisses it: a rejected suggestion does not come back.
      const catalogueId = held.origin?.catalogueId;
      const dismisses = catalogueId !== undefined && store.copiesOf(catalogueId).length === 1 && !isDismissed(catalogueId);
      record(context, { type: "instructions.removed", payload: { id } }, ...(dismisses ? [{ type: "instructions.suggestion-dismissed", payload: { catalogueId } }] : []));
      return { aggregate: stream, result: { instructionId: id } };
    },

    "instructions.dismissSuggestion": ({ catalogueId }, context): CommandAnswer<{ catalogueId: string; dismissed: boolean }, Refused> => {
      if (entryOf(catalogueId) === undefined) return { aggregate: stream, rejected: noEntry(catalogueId) };
      const [copy] = store.copiesOf(catalogueId);
      if (copy !== undefined) {
        const message = `The suggested instruction ${catalogueId} is held as the owned instruction ${copy.id}: removing it dismisses the suggestion.`;
        return { aggregate: stream, rejected: { code: "conflict", message, data: { reason: "ticked", catalogueId, instructionId: copy.id } } };
      }
      if (!isDismissed(catalogueId)) record(context, { type: "instructions.suggestion-dismissed", payload: { catalogueId } });
      return { aggregate: stream, result: { catalogueId, dismissed: true } };
    },

    "instructions.restoreSuggestion": ({ catalogueId }, context): CommandAnswer<{ catalogueId: string; dismissed: boolean }, Refused> => {
      if (isDismissed(catalogueId)) record(context, { type: "instructions.suggestion-restored", payload: { catalogueId } });
      return { aggregate: stream, result: { catalogueId, dismissed: false } };
    },
  };
};
