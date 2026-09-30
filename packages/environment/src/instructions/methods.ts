import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  invalidParams,
  keyBetween,
  normaliseInstructionTitle,
  type AdapterCapabilities,
  type InstructionAccount,
  type InstructionReach,
  type OrientationRow,
  type OwnedInstruction,
} from "@agent-harness/contracts";
import type { AdapterHost, InstructionTarget } from "../adapter/host.js";
import type { EventLog } from "../event-log/event-log.js";
import type { CommandAnswer, CommandContext, CommandRejection, MethodHandlers } from "../serve/methods.js";
import type { OrientationAnswer } from "./composer.js";
import { instructionsStream, type InstructionStore } from "./store.js";

/**
 * The standing-instruction methods on the method table (skills-instructions
 * spec, "Standing instructions and the composer" and "Owned instructions"):
 * `instructions.preview` at `read`, what a run would be handed now, composed
 * by the host as a run's launch composes it
 * (`AdapterHost.previewInstructions`); `instructions.list` at `read`, the
 * Orientation row and the owned instructions, every row with the
 * environment's accounts; and the owned instructions' six commands at
 * `admin`, one per field (ADR 0003), each appending its event on the
 * `instructions` stream and, in the same transaction, `instructions.updated`
 * on the environment's stream. A command that changes nothing appends
 * neither. Nothing here reaches a live run: the host composes a run's text
 * once, as it launches.
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
}

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

  /** Appends `type` on the instructions stream, then the notice, as the command's client session. */
  const record = (context: CommandContext, type: string, payload: Record<string, unknown>): void => {
    const attribution = { tx: context.tx, actor: context.actor, commandId: context.commandId };
    log.append(stream, [{ type, payload }], attribution);
    log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [UPDATED], attribution);
  };

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
    change: (held: OwnedInstruction) => { readonly type: string; readonly payload: Record<string, unknown> } | null | CommandRejection<"not_found">,
  ): CommandAnswer<{ instruction: OwnedInstruction }, Refused> => {
    const id = instructionId.toLowerCase();
    const held = store.get(id);
    if (held === undefined) return { aggregate: stream, rejected: noInstruction(id) };
    const decided = change(held);
    if (decided !== null && "code" in decided) return { aggregate: stream, rejected: decided };
    if (decided !== null) record(context, decided.type, decided.payload);
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
      return { orientation, instructions: store.list().map((instruction) => ({ ...instruction, accounts })) };
    },

    "instructions.create": (params, context): CommandAnswer<{ instruction: OwnedInstruction }, Refused> => {
      const id = params.id.toLowerCase();
      if (store.used(id)) {
        const message = `The id ${id} is taken by an owned instruction, here now or removed.`;
        return { aggregate: stream, rejected: { code: "conflict", message, data: { reason: "exists", instructionId: id } } };
      }
      const scope = params.scope ?? "all";
      const unheld = unheldAccount(scope);
      if (unheld !== null) return { aggregate: stream, rejected: unheld };
      const created: OwnedInstruction = {
        id,
        title: normaliseInstructionTitle(params.title),
        body: params.body,
        origin: null,
        scope,
        enabled: params.enabled ?? true,
        position: params.position ?? keyBetween(store.list().at(-1)?.position ?? null, null),
      };
      record(context, "instructions.created", created);
      return { aggregate: stream, result: { instruction: now(id) } };
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

    "instructions.remove": ({ instructionId }, context): CommandAnswer<{ instructionId: string }, "not_found"> => {
      const id = instructionId.toLowerCase();
      if (store.get(id) === undefined) return { aggregate: stream, rejected: noInstruction(id) };
      record(context, "instructions.removed", { id });
      return { aggregate: stream, result: { instructionId: id } };
    },
  };
};
