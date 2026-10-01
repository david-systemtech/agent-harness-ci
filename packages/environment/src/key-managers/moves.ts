import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  invalidParams,
  referenceLocator,
  type KeyManagerCannotWriteError,
  type KeyManagerConnectionRecord,
  type KeyManagerMovedPayload,
  type KeyManagerMoveItemKind,
  type KeyManagerMoveItemRef,
  type KeyManagerMoveItemResult,
  type KeyManagerReference,
  type KeyManagerTargetExistsError,
  type ResultOf,
  type WireError,
} from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { CommandRejection, MethodContext, MethodHandler, PreparedCommand } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import { moveTarget } from "./base-path.js";
import { KEY_MANAGER_ACTOR, type HeldLogin, type KeyManagerConnections } from "./connections.js";
import { leftBehind } from "./move-store.js";
import { KEY_MANAGER_BUDGET_MS, PROVIDER_NAMES, type ProviderFailure } from "./provider.js";
import type { KeyManagerRegistry } from "./registry.js";
import { sameValue } from "./same-value.js";

/**
 * Move stored tokens (key-managers spec, "Move stored tokens"; ADR 0028;
 * #371): the items still holding a stored value, which a Move writes into a
 * key manager under the connection's base path and swaps to references.
 *
 * - **Sources.** Each owning service registers a Move source for its items:
 *   it lists those holding a stored value, reads one, swaps one to a
 *   reference through its own command, and deletes the stored value. The
 *   forge's is its forge accounts' (`forge/move-source.ts`); banks (#90) and
 *   routine webhook endpoints (#92) register theirs. An item's target sits
 *   one level below the base path (`base-path.ts`).
 * - **A Move** takes a connection and its items, or all, one item at a time,
 *   and one Move at a time on the environment. For each it reads the stored
 *   value, registered with the scrub registry until the item is done; asks
 *   the key manager whether the login may write the target (#372), and
 *   answers `cannot_write` with nothing written when it may not; writes it
 *   with the connection's login, with its entry's note, service and the day
 *   it was added beside it, refusing a different value there (`conflict`
 *   reason `target_exists`) unless asked to overwrite; reads it back
 *   through the registry's resolve and compares in constant time; swaps the
 *   item through its owner's command; deletes the stored value; and the
 *   command appends `key-manager.moved` for each item moved, in its own
 *   transaction once every item is done. An item that fails says at which
 *   step and why, its stored value left in place, and so is any copy
 *   written; the next item goes on. Every line a key manager's or an
 *   owner's text becomes passes the scrub registry while the value is still
 *   registered: no value reaches an answer, an event, a receipt or a log.
 * - **Copy the value** (ADR 0028; #372): an item a Move answered
 *   `cannot_write` is offered one copy of its stored value on that
 *   connection, which `keyManagers.move.copyValue` answers, the one answer
 *   that ever holds a stored value, appending `key-manager.value-copied`
 *   with the client session. The offer is held in memory until the copy
 *   takes it, the item moves, or a later Move of it that writes answers
 *   otherwise. A Move with `verifyOnly` then writes nothing: it reads back
 *   what a person pasted at each target, and swaps and deletes as above; a
 *   different value there, or none, leaves the item as it was.
 * - **A delete that fails** leaves the item moved: its `key-manager.moved`
 *   names where the stored value is kept still (`undeleted`), and every
 *   start after the gate deletes those again, appending
 *   `key-manager.stored-value-deleted` as `system:key-manager` for each it
 *   deletes (`move-store.ts`).
 */

/** An item a Move source holds a stored value for. */
export interface MoveSourceItem {
  /** Its id with its owner: a forge account's id, in lowercase. */
  readonly id: string;
  /** What people know it by: a forge account's origin. */
  readonly name: string;
  /** Its entry's name one level below a base path: `forge-<slug>`. */
  readonly entry: string;
  /** What the value is a credential for, as its entry's `service` field names it: a forge's host. */
  readonly service: string;
  /** What its entry's `note` says: what the value is, what reads it and how to rotate it. */
  readonly note: string;
}

/** A stored value as its source reads it: the value, and where it is kept (a vault entry), which is never the value. */
export interface StoredValue {
  readonly value: string;
  readonly storedAt: string;
}

/** What a swap through an item's owner's command came to: done, or refused with the command's error. */
export type SwapAnswer = { readonly outcome: "swapped" } | { readonly outcome: "refused"; readonly error: WireError };

/** An owning service's items holding a stored value, as a Move takes them. */
export interface MoveSource {
  readonly kind: KeyManagerMoveItemKind;
  /** The key the value sits at in its entry: `token`. */
  readonly key: string;
  /** Every item holding a stored value now, in the owner's order. */
  items(): readonly MoveSourceItem[];
  /** The stored value of item `id` now; null when it holds none, or it cannot be read. */
  read(id: string): Promise<StoredValue | null>;
  /** Swaps item `id` to `reference` through its owner's own command, for the client session that asked for the Move. */
  swap(id: string, reference: KeyManagerReference, caller: MethodContext): Promise<SwapAnswer>;
  /** Deletes the stored value item `id` held at `storedAt`; one gone already is no error, and a failure throws. */
  delete(id: string, storedAt: string): Promise<void>;
}

export interface KeyManagerMovesOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment's id: the id of its stream, where the Move's events go. */
  readonly environmentId: string;
  readonly scrub: ScrubRegistry;
  readonly connections: KeyManagerConnections;
  /** The registry's resolve, which a read-back goes through. */
  readonly registry: KeyManagerRegistry;
  /** How long one write may take, on the wall clock; preset `KEY_MANAGER_BUDGET_MS`. */
  readonly budgetMs?: number;
}

export interface KeyManagerMoves {
  /** Registers an owning service's Move source; one per kind of item. */
  register(source: MoveSource): void;
  /** `keyManagers.move.list`: every item holding a stored value, with its target on each connection that has one. */
  list(): ResultOf<"keyManagers.move.list">;
  readonly move: PreparedCommand<"keyManagers.move">;
  /** `keyManagers.move.copyValue`: the stored value of an item a Move answered `cannot_write`, once. */
  readonly copyValue: PreparedCommand<"keyManagers.move.copyValue">;
  /** After startup's gate: deletes again every stored value a Move left behind, recording each deleted; settles once each was tried. */
  deleteLeftBehind(): Promise<void>;
}

/** How each kind of item is named to people. */
const ITEM_KINDS: Record<KeyManagerMoveItemKind, string> = { "forge-account": "forge account", endpoint: "webhook endpoint" };

/** An item as a Move answers it. */
const refOf = (kind: KeyManagerMoveItemKind, id: string): KeyManagerMoveItemRef => ({ kind, id });

/** The wire error a key manager's failure at a Move's write comes to, naming the connection. */
const WRITE_CODES: Record<ProviderFailure["outcome"], string> = {
  "credential-rejected": "credential_source_unavailable",
  unreachable: "unreachable",
  "rate-limited": "unreachable",
  sealed: "sealed",
  "certificate-rejected": "certificate_rejected",
  denied: "reference_denied",
  "not-found": "reference_not_found",
};

export const createKeyManagerMoves = (options: KeyManagerMovesOptions): KeyManagerMoves => {
  const { log, clock, scrub, connections, registry } = options;
  const budgetMs = options.budgetMs ?? KEY_MANAGER_BUDGET_MS;
  const stream: StreamRef = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const sources = new Map<KeyManagerMoveItemKind, MoveSource>();

  /** The Move under way: the next waits for it. */
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const answer = turn.then(work, work);
    turn = answer.catch(() => undefined);
    return answer;
  };

  /**
   * The copies offered (#372): each item a Move answered `cannot_write`, on
   * its connection, until its value is copied, the item moves, or a later
   * Move of it that writes answers otherwise. Held in memory: a start offers
   * none until a Move answers `cannot_write` again.
   */
  const offered = new Set<string>();
  const offerOf = (connectionId: string, item: KeyManagerMoveItemRef): string => JSON.stringify([connectionId, item.kind, item.id]);

  /** Each item holding a stored value, with its source. */
  const everyItem = (): { readonly source: MoveSource; readonly item: MoveSourceItem }[] =>
    [...sources.values()].flatMap((source) => source.items().map((item) => ({ source, item })));

  /** An item's failure at `step`, `written` saying whether a copy was left at the target. */
  const failed = (
    item: KeyManagerMoveItemRef,
    step: Extract<KeyManagerMoveItemResult, { outcome: "failed" }>["step"],
    written: boolean,
    error: WireError | KeyManagerTargetExistsError | KeyManagerCannotWriteError,
  ): KeyManagerMoveItemResult => ({
    item,
    outcome: "failed",
    step,
    written,
    error,
  });

  /** What a Move did with one item, and the event it appends when the item moved. */
  interface Moved {
    readonly result: KeyManagerMoveItemResult;
    readonly event: KeyManagerMovedPayload | null;
  }

  /** How a Move takes its items: whether a different value at a target is replaced, or nothing is written and what a person pasted there only verified (#372). */
  interface MoveMode {
    readonly overwrite: boolean;
    readonly verifyOnly: boolean;
  }

  /**
   * Moves one item to its target on the connection: read, ask whether the
   * login may write the target, write, read back, swap, delete; with
   * `verifyOnly`, read, read back, swap, delete. The value is registered for
   * scrubbing from its read until the item is done, and every line said of
   * it is scrubbed meanwhile.
   */
  const moveOne = async (source: MoveSource, item: MoveSourceItem, record: KeyManagerConnectionRecord, login: HeldLogin, mode: MoveMode, caller: MethodContext): Promise<Moved> => {
    const ref = refOf(source.kind, item.id);
    const reference = moveTarget(record, item.entry, source.key);
    if (reference === null) throw new Error(`The key-manager connection ${record.id} has no target for ${item.entry}.`);
    const named = `${PROVIDER_NAMES[record.provider]} at ${referenceLocator(reference)}`;
    const connectionId = record.id;
    const kind = ITEM_KINDS[source.kind];
    const offer = offerOf(connectionId, ref);
    const stored = await source.read(item.id);
    if (stored === null) {
      return { result: failed(ref, "read", false, { code: "not_found", message: `The ${kind} ${item.name} holds no stored token to move now.`, data: { kind: source.kind, id: item.id } }), event: null };
    }
    const release = scrub.register(stored.value, { owner: `key-manager:move:${source.kind}:${item.id}` });
    try {
      const said = (message: string): string => scrub.scrubOutput(message);
      const keeps = `the ${kind} ${item.name} keeps its stored token`;
      if (!mode.verifyOnly) {
        // Each call's budget runs on the wall clock, never the environment's, which a test may hold still.
        const location =
          reference.provider === "openbao"
            ? { mount: reference.mount, path: reference.path }
            : reference.provider === "onepassword"
              ? { mount: reference.vault, path: reference.item }
              : { mount: reference.project ?? "", path: reference.config ?? "" };
        const checked = await login.provider.canWrite(login.target, login.token, location, AbortSignal.timeout(budgetMs));
        if (checked.outcome !== "checked") {
          return { result: failed(ref, "write", false, { code: WRITE_CODES[checked.outcome], message: `${said(checked.message)} Nothing was written, and ${keeps}.`, data: { connectionId } }), event: null };
        }
        if (!checked.writable) {
          offered.add(offer);
          const message = `The login of ${record.label} may not write ${named}: nothing was written, and ${keeps}. Copy the value to paste it there by hand, then verify it to finish the move.`;
          return { result: failed(ref, "write", false, { code: "cannot_write", message, data: { connectionId, reference } }), event: null };
        }
        // `added` is the environment's day.
        const fields = { note: item.note, service: item.service, added: clock.now().toISOString().slice(0, 10) };
        const written = await login.provider.write(login.target, login.token, { reference, value: stored.value, fields, overwrite: mode.overwrite }, AbortSignal.timeout(budgetMs));
        if (written.outcome === "exists") {
          const message = `A different value is at ${named} already: nothing was written, and ${keeps}. Move it with overwrite to replace that value.`;
          return { result: failed(ref, "write", false, { code: "conflict", message, data: { reason: "target_exists", connectionId, reference } }), event: null };
        }
        if (written.outcome !== "written") {
          return { result: failed(ref, "write", false, { code: WRITE_CODES[written.outcome], message: `${said(written.message)} Nothing was written, and ${keeps}.`, data: { connectionId } }), event: null };
        }
      }
      // A copy this Move wrote is left at the target when the item goes no further; with verifyOnly it wrote none.
      const wrote = !mode.verifyOnly;
      const left = wrote
        ? `The copy written to ${named} and the stored token of the ${kind} ${item.name} are both left in place.`
        : "The value there and the stored token are both left as they were.";
      const back = await registry.resolve({ reference, owner: `key-manager:move:${source.kind}:${item.id}`, purpose: "read back a move" });
      if (back.outcome === "unavailable") {
        const message =
          mode.verifyOnly && back.code === "reference_not_found"
            ? `${said(back.message)} Nothing is pasted at ${named} yet: paste the value there, then verify it again. The ${kind} ${item.name} keeps its stored token.`
            : `${said(back.message)} ${left}`;
        return { result: failed(ref, "read-back", wrote, { code: back.code, message, data: { connectionId } }), event: null };
      }
      const same = sameValue(back.value, stored.value);
      back.release();
      if (!same) {
        const message = wrote
          ? `${named} answered another value than the one written, so the ${kind} was not swapped to it. ${left}`
          : `${named} holds another value than the stored token of the ${kind} ${item.name}, so the ${kind} was not swapped to it. ${left}`;
        return { result: failed(ref, "read-back", wrote, { code: "conflict", message, data: { reason: "read_back_differs", connectionId, reference } }), event: null };
      }
      const swapped = await source.swap(item.id, reference, caller);
      if (swapped.outcome !== "swapped") {
        return { result: failed(ref, "swap", wrote, { code: swapped.error.code, message: `${said(swapped.error.message)} ${left}`, data: swapped.error.data }), event: null };
      }
      offered.delete(offer);
      let deleted = true;
      try {
        await source.delete(item.id, stored.storedAt);
      } catch (error) {
        deleted = false;
        console.error(`Deleting the stored token of the ${kind} ${item.id} a Move took failed; the next start deletes it:`, error);
      }
      const how = wrote ? `Moved to ${named}` : `Verified the value pasted at ${named} and moved to it`;
      const message = `${how}; ${deleted ? "the stored token was deleted." : "deleting the stored token failed, and the next start deletes it."}`;
      return {
        result: { item: ref, outcome: "moved", reference, storedValueDeleted: deleted, message },
        event: { connectionId, item: ref, reference, undeleted: deleted ? null : stored.storedAt },
      };
    } finally {
      release();
    }
  };

  /** Answers `invalid_params` for the param at `path`. */
  const invalid = (path: readonly string[], message: string): never => {
    throw new ContractError(invalidParams([{ code: "custom", path: [...path], message }], message));
  };

  /** The handler of a command refused with `rejected`, whose code is one of the method's. */
  const rejecting =
    <Code extends string>(rejected: CommandRejection<Code>) =>
    (): { readonly aggregate: StreamRef; readonly rejected: CommandRejection<Code> } => ({ aggregate: stream, rejected });

  /** The refusal of a connection the environment does not hold. */
  const noConnection = (connectionId: string): CommandRejection<"not_found"> => ({
    code: "not_found",
    message: `No key-manager connection ${connectionId} is on this environment.`,
    data: { kind: "key_manager_connection", connectionId },
  });

  const move: KeyManagerMoves["move"] = {
    prepare: (params, context) =>
      inTurn(async (): Promise<MethodHandler<"keyManagers.move">> => {
        const connectionId = params.connectionId.toLowerCase();
        const held = connections.readable(connectionId);
        if (held === null) return rejecting(noConnection(connectionId));
        const { record, login } = held;
        if (record.provider !== "openbao" && record.provider !== "onepassword" && record.provider !== "doppler") {
          return rejecting({ code: "provider_unavailable", message: `This environment cannot move stored tokens into ${PROVIDER_NAMES[record.provider]} yet.`, data: { provider: record.provider } });
        }
        if (record.basePath === null) invalid(["connectionId"], `The key-manager connection ${record.label} has no base path: set where Move keeps the harness's secrets first.`);
        if (params.verifyOnly === true && params.overwrite === true) invalid(["overwrite"], "A Move with verifyOnly writes nothing, so it has nothing to overwrite.");
        if (record.status.kind !== "signed-in" || login === null) {
          return rejecting({
            code: "credential_source_unavailable",
            message: `The key-manager connection ${record.label} is not signed in (${record.status.message}), so nothing can be moved into it.`,
            data: { connectionId },
          });
        }
        const chosen =
          params.items === "all"
            ? everyItem().map(({ source, item }) => ({ ref: refOf(source.kind, item.id), source, item }))
            : [...new Map(params.items.map((ref) => [JSON.stringify([ref.kind, ref.id.toLowerCase()]), refOf(ref.kind, ref.id.toLowerCase())])).values()].map((ref) => {
                const source = sources.get(ref.kind);
                return { ref, source, item: source?.items().find((each) => each.id === ref.id) };
              });
        const done: Moved[] = [];
        for (const { ref, source, item } of chosen) {
          // A Move that writes answers afresh whether a copy is offered, whatever it answers; one that only verifies leaves an offer as it is.
          if (params.verifyOnly !== true) offered.delete(offerOf(record.id, ref));
          if (source === undefined || item === undefined) {
            done.push({ result: failed(ref, "read", false, { code: "not_found", message: `No ${ITEM_KINDS[ref.kind]} ${ref.id} holds a stored token on this environment.`, data: { kind: ref.kind, id: ref.id } }), event: null });
            continue;
          }
          done.push(await moveOne(source, item, record, login, { overwrite: params.overwrite === true, verifyOnly: params.verifyOnly === true }, context));
        }
        return (_params, command) => {
          const at = { tx: command.tx, actor: command.actor, commandId: command.commandId };
          for (const { event } of done) if (event !== null) log.append(stream, [{ type: "key-manager.moved", payload: event }], at);
          return { aggregate: stream, result: { items: done.map(({ result }) => result) } };
        };
      }),
  };

  const copyValue: KeyManagerMoves["copyValue"] = {
    prepare: (params, context) =>
      inTurn(async (): Promise<MethodHandler<"keyManagers.move.copyValue">> => {
        const connectionId = params.connectionId.toLowerCase();
        const held = connections.readable(connectionId);
        if (held === null) return rejecting(noConnection(connectionId));
        const ref = refOf(params.item.kind, params.item.id.toLowerCase());
        const source = sources.get(ref.kind);
        const item = source?.items().find((each) => each.id === ref.id);
        const none = (message: string) => rejecting({ code: "not_found", message, data: { ...ref } });
        if (source === undefined || item === undefined) return none(`No ${ITEM_KINDS[ref.kind]} ${ref.id} holds a stored token on this environment.`);
        const offer = offerOf(held.record.id, ref);
        if (!offered.has(offer)) {
          return none(`No copy of the stored token of the ${ITEM_KINDS[ref.kind]} ${item.name} is offered on ${held.record.label}: move it first, and a Move that may not write its target offers one.`);
        }
        const reference = moveTarget(held.record, item.entry, source.key);
        if (reference === null) throw new Error(`The key-manager connection ${connectionId} has no target for ${item.entry}.`);
        // Taken now, so a second copy waits for another cannot_write; given back when this one is not accepted.
        offered.delete(offer);
        context.onUndo(() => void offered.add(offer));
        const stored = await source.read(item.id);
        if (stored === null) return none(`The ${ITEM_KINDS[ref.kind]} ${item.name} holds no stored token to copy now.`);
        return (_params, command) => ({
          aggregate: stream,
          result: { item: ref, reference, value: stored.value },
          events: [{ type: "key-manager.value-copied", payload: { connectionId, item: ref, reference, clientSessionId: command.clientSession.id } }],
        });
      }),
  };

  return {
    register(source) {
      if (sources.has(source.kind)) throw new Error(`A Move source for ${source.kind} is registered already.`);
      sources.set(source.kind, source);
    },

    list() {
      const held = connections.list();
      return {
        items: everyItem().map(({ source, item }) => ({
          kind: source.kind,
          id: item.id,
          name: item.name,
          targets: held.flatMap((record) => {
            const reference = moveTarget(record, item.entry, source.key);
            return reference === null ? [] : [{ connectionId: record.id, reference }];
          }),
        })),
      };
    },

    move,

    copyValue,

    async deleteLeftBehind() {
      for (const { kind, itemId, storedAt } of leftBehind(reader)) {
        const source = sources.get(kind);
        if (source === undefined) continue;
        try {
          await source.delete(itemId, storedAt);
          log.atomically((tx) => log.append(stream, [{ type: "key-manager.stored-value-deleted", payload: { item: refOf(kind, itemId), storedAt } }], { tx, actor: KEY_MANAGER_ACTOR }));
        } catch (error) {
          console.error(`Deleting the stored token of the ${ITEM_KINDS[kind]} ${itemId} a Move left behind failed; the next start tries again:`, error);
        }
      }
    },
  };
};
