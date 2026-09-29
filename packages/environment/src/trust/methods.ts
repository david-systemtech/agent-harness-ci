import { ContractError, ENVIRONMENT_STREAM_KIND, type TrustDecidedPayload, type TrustRecord, type TrustRevokedPayload } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import { readSessionFacts, type SessionFacts } from "../runs/run-reads.js";
import type { CommandAnswer, CommandContext, CommandRejection, MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import { readTrustOffer } from "./offer.js";
import { trustStream, type TrustStore } from "./store.js";

/**
 * The trust gate's methods (skills spec, "The trust gate" and "Wire
 * summary"): `trust.get` and `trust.list` at `read`, `trust.decide` and
 * `trust.revoke` at `admin`. A decision appends `trust.granted` or
 * `trust.declined` on the trust stream with the record's fields, and a
 * revoke `trust.revoked` for each row the key is read from; either is
 * followed, in the command's transaction, by `trust.updated` on the
 * environment's stream, so every client reads the two queries again once it
 * commits. Nothing here reaches a live run: the host reads a run's trust
 * once, as it launches (`adapter/host.ts`).
 */

export interface TrustMethodsOptions {
  readonly log: EventLog;
  /** The environment's id: the id of its trust stream and its own. */
  readonly environmentId: string;
  readonly store: TrustStore;
  /** A client session's label as it is now; undefined for one the environment no longer holds. */
  readonly clientSessionLabel: (clientSessionId: string) => string | undefined;
}

/** The notice every committed decision and revoke is followed by. */
const UPDATED = { type: "trust.updated", payload: {} } as const;

export const trustMethods = (options: TrustMethodsOptions): MethodHandlers => {
  const { log, store } = options;
  const stream = trustStream(options.environmentId);
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  const noSession = (sessionId: string) => ({ code: "not_found", message: `No session ${sessionId} is on this environment.`, data: { kind: "session", sessionId } }) as const;

  /** The session `sessionId` names, not deleted; null when there is none. */
  const sessionOf = (sessionId: string): SessionFacts | null => {
    const session = readSessionFacts(log, reader, sessionId);
    return session === null || session.deleted ? null : session;
  };

  const noRecord = (key: string): CommandRejection<"not_found"> => ({ code: "not_found", message: `No trust decision is recorded for ${key}.`, data: { kind: "trust", key } });

  /** Appends `events` on the trust stream and the notice after them, as the command's client session. */
  const record = (context: CommandContext, events: readonly { readonly type: string; readonly payload: TrustDecidedPayload | TrustRevokedPayload }[]): void => {
    const attribution = { tx: context.tx, actor: context.actor, commandId: context.commandId };
    log.append(stream, events, attribution);
    log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [UPDATED], attribution);
  };

  return {
    "trust.get": async ({ sessionId }) => {
      const session = sessionOf(sessionId.toLowerCase());
      if (session === null) throw new ContractError(noSession(sessionId));
      const key = store.keyOf(session);
      if (key === null) return { key: null, keyKind: null, decision: "undecided", offer: null };
      return { key: key.value, keyKind: key.kind, decision: store.record(key.value)?.decision ?? "undecided", offer: await readTrustOffer(session.workspace) };
    },

    "trust.list": () => {
      const records = store.records();
      return { trusted: records.filter((found) => found.decision === "trusted"), declined: records.filter((found) => found.decision === "declined") };
    },

    "trust.decide": (params, context): CommandAnswer<{ record: TrustRecord }, "not_found" | "conflict"> => {
      let target: { readonly key: string; readonly keyKind: TrustRecord["keyKind"]; readonly sessionId: string | null };
      if (params.sessionId !== undefined) {
        const sessionId = params.sessionId.toLowerCase();
        const session = sessionOf(sessionId);
        if (session === null) return { aggregate: stream, rejected: noSession(params.sessionId) };
        const key = store.keyOf(session);
        if (key === null) {
          const message = `Session ${sessionId} is in a scratch workspace, which has no trust key and is never asked about.`;
          return { aggregate: stream, rejected: { code: "conflict", message, data: { reason: "no_trust_key", sessionId } } };
        }
        target = { key: key.value, keyKind: key.kind, sessionId };
      } else {
        // The params' schema takes a session or a key: a key named directly is one already recorded, decided again.
        const key = store.canonical(params.key ?? "");
        const held = store.record(key);
        if (held === undefined) return { aggregate: stream, rejected: noRecord(key) };
        target = { key, keyKind: held.keyKind, sessionId: null };
      }
      const held = store.record(target.key);
      if (held?.decision === params.decision) return { aggregate: stream, result: { record: held } };
      const payload: TrustDecidedPayload = {
        key: target.key,
        keyKind: target.keyKind,
        clientSessionId: context.clientSession.id,
        clientLabel: options.clientSessionLabel(context.clientSession.id) ?? "",
        sessionId: target.sessionId,
      };
      record(context, [{ type: params.decision === "trusted" ? "trust.granted" : "trust.declined", payload }]);
      const now = store.record(target.key);
      if (now === undefined) throw new Error(`The decision on ${target.key} was appended but reads as undecided.`);
      return { aggregate: stream, result: { record: now } };
    },

    "trust.revoke": ({ key }, context): CommandAnswer<{ record: TrustRecord }, "not_found"> => {
      const read = store.canonical(key);
      const held = store.record(read);
      if (held === undefined) return { aggregate: stream, rejected: noRecord(read) };
      record(
        context,
        store.recorded(read).map((recorded) => ({ type: "trust.revoked", payload: { key: recorded.key, keyKind: recorded.keyKind } })),
      );
      return { aggregate: stream, result: { record: held } };
    },
  };
};
