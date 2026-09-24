import type { EndReason, EventEnvelope } from "@agent-harness/contracts";
import { SocketClosedError, type SubscriptionMessage } from "../connections/connection.js";
import { NotConnectedError, type ConnectionSeams } from "../connections/registry.js";
import { backoffDelay } from "../connections/state-machine.js";
import { writable, type Writable } from "../observable.js";
import type { Clock, Timer } from "../platform.js";
import type { CachedPair, StreamCache } from "./cache.js";
import { emptyStream, step, type StreamInput, type StreamKind, type StreamState, type StreamStep } from "./stream.js";

/**
 * Attaching streams to a connection (docs/specs/client-runtime.md,
 * "Subscriptions, cursor cache and snapshots"): a subscription per stream
 * through the registry's seams, from the cursor (`afterSequence` 0, the
 * cursor before the first event, when nothing is cached: the contract's
 * params require one), each message through the stream reducer, and the
 * write the reducer asks for through the cache. The rules:
 *
 * - `end` with `overflow` resubscribes from the cursor at once, after one
 *   second if it is the second overflow within a minute of the one before,
 *   then on the backoff ladder (two seconds, four, ... thirty, each with
 *   its jitter), counted again from the first once a minute passes quietly;
 * - any other `end` waits for the next `ready`, when every stream attaches
 *   again (the composition in `streams.ts` does that);
 * - a subscription the environment refuses, or leaves unanswered for 30
 *   seconds, on a healthy socket is a stream fault on the stream, never a
 *   connection phase; it is tried again on the next `ready`;
 * - an event or snapshot the stream cannot apply faults it without moving
 *   its cursor, and it is resubscribed once asking for a snapshot (a cursor
 *   past any head, which the environment answers with its snapshot: the
 *   "snapshot please" convention);
 * - a stream whose state has outgrown its kind's bound (a session holding
 *   every event since its snapshot) is resubscribed the same way, once per
 *   `ready`, so the snapshot folds what it held;
 * - while the session list is catching up the connection is `syncing`.
 */

/** How long a subscription waits for `subscribed` before it is a fault: the stream's own timer, since a request on the socket has none; the 30 seconds the specification chose for `requests.call`. */
export const SUBSCRIBE_TIMEOUT_MS = 30_000;
/** An overflow within this long of the one before counts as another in a row. */
export const OVERFLOW_WINDOW_MS = 60_000;
/** A cursor past any head: the environment answers it with its snapshot. */
export const SNAPSHOT_CURSOR = Number.MAX_SAFE_INTEGER;

/** The wait before resubscribing after the `run`th overflow in a row: none, then the ladder from its first rung (one second). */
export const overflowDelay = (run: number, random: number): number => (run <= 1 ? 0 : backoffDelay(run - 1, random));

/** One stream of one environment, as the runtime holds it. */
export interface LiveStream<D> {
  readonly environmentId: string;
  /** `list`, `environment` or `session.<id>`: its cache document's last part. */
  readonly name: string;
  /** Its cache document. */
  readonly key: string;
  readonly kind: StreamKind<D>;
  readonly method: string;
  /** The subscription's params but the cursor. */
  readonly params: Record<string, unknown>;
  /** Whether it is the session list, whose catching up is the connection's `syncing`. */
  readonly list: boolean;
  /** The committed state: what projections read, and what a write takes. */
  readonly value: Writable<StreamState<D>>;
  /** The subscription in use, by identity; null when none is. A message for another is dropped. */
  attachment: object | null;
  subscription: string | null;
  /** Waiting to resubscribe after an overflow. */
  retry: Timer | null;
  /** Waiting for `subscribed`. */
  answer: Timer | null;
  overflows: { readonly run: number; readonly at: number } | null;
  /** Resubscribed for a snapshot after an apply failed; a second failure waits for the next `ready`. */
  recovering: boolean;
  /** Resubscribed for a snapshot since the last `ready` because its state outgrew its kind's bound; not again until a snapshot comes or the next `ready`. */
  trimming: boolean;
  /** The stream held a cursor when this subscription began: what it replays happened since this client last saw the stream. */
  resumed: boolean;
}

export const liveStream = <D>(fields: Pick<LiveStream<D>, "environmentId" | "name" | "key" | "kind" | "method" | "params" | "list">, report: (error: unknown) => void): LiveStream<D> => ({
  ...fields,
  value: writable<StreamState<D>>(emptyStream(), report),
  attachment: null,
  subscription: null,
  retry: null,
  answer: null,
  overflows: null,
  recovering: false,
  trimming: false,
  resumed: false,
});

export interface AttachOptions {
  readonly clock: Clock;
  readonly random: () => number;
  readonly report: (error: unknown) => void;
  readonly seams: Pick<ConnectionSeams, "subscribe" | "unsubscribe" | "setSyncing">;
  readonly cache: StreamCache;
  /** Whether the stream's environment has a ready socket, as far as the streams know. */
  readonly ready: (environmentId: string) => boolean;
  /** Whether the stream is still wanted: the list and the environment's always, a session while held or lingering. */
  readonly wanted: (stream: LiveStream<unknown>) => boolean;
  /**
   * An event applied. `news` is whether it is: the stream synchronized on
   * this subscription already, or held a cursor when the subscription began
   * (a replay of what happened while this client was away). An event
   * replayed onto a stream that held nothing is history, not news.
   */
  readonly applied?: (stream: LiveStream<unknown>, event: EventEnvelope, news: boolean) => void;
  /** The stream committed a new state. */
  readonly changed?: (stream: LiveStream<unknown>) => void;
  /** The subscription ended with a reason no rule here handles: `deleted`. */
  readonly ended?: (stream: LiveStream<unknown>, reason: EndReason) => void;
}

export interface Attacher {
  /** Subscribes the stream from its cursor, or for a snapshot; a subscription it had is let go. */
  attach<D>(stream: LiveStream<D>, options?: { readonly snapshot?: boolean }): void;
  /** The socket went: no subscription any more, and the stream is written at once. */
  detach<D>(stream: LiveStream<D>): void;
  /** Unsubscribes the stream (a session's linger ran out) and writes it at once. */
  release<D>(stream: LiveStream<D>): void;
  /** Lets go of timers and the subscription with nothing said or written: the stream is being forgotten. */
  drop<D>(stream: LiveStream<D>): void;
}

const pairOf =
  <D>(stream: LiveStream<D>) =>
  (): CachedPair | null => {
    const { cursor, data } = stream.value.read();
    return cursor === null || data === null ? null : { cursor, snapshot: stream.kind.encode(data) };
  };

export const createAttacher = (options: AttachOptions): Attacher => {
  const { clock, seams, cache, report } = options;

  const commit = <D>(stream: LiveStream<D>, next: StreamStep<D>): void => {
    const before = stream.value.read();
    stream.value.set(next.state);
    if (next.state !== before) options.changed?.(stream as LiveStream<unknown>);
    if (next.persist === "soon") cache.soon(stream.key, pairOf(stream));
    else if (next.persist === "now") void cache.now(stream.key, pairOf(stream));
  };

  const input = <D>(stream: LiveStream<D>, message: StreamInput): StreamStep<D> => {
    const next = step(stream.kind, stream.value.read(), message);
    if (!next.failed) commit(stream, next);
    return next;
  };

  const syncing = (stream: LiveStream<unknown>, on: boolean) => {
    if (stream.list) seams.setSyncing(stream.environmentId, on);
  };

  /** Lets go of the subscription in use, unsubscribing it when the socket still has it. */
  const letGo = (stream: LiveStream<unknown>, unsubscribe: boolean) => {
    stream.answer?.cancel();
    stream.answer = null;
    if (unsubscribe && stream.subscription !== null) seams.unsubscribe(stream.environmentId, stream.subscription);
    stream.attachment = null;
    stream.subscription = null;
  };

  /** The stream cannot go on with its subscription: faulted, and let go. */
  const fault = (stream: LiveStream<unknown>, message: string) => {
    letGo(stream, true);
    input(stream, { type: "fault", message });
    syncing(stream, false);
  };

  /** An apply failed: the cursor stays; resubscribe once for a snapshot, else wait for the next `ready`. */
  const failed = (stream: LiveStream<unknown>, message: string) => {
    if (stream.recovering) return fault(stream, message);
    letGo(stream, true);
    stream.recovering = true;
    stream.value.set({ ...stream.value.read(), fault: message });
    attacher.attach(stream, { snapshot: true });
  };

  const overflowed = (stream: LiveStream<unknown>) => {
    const now = clock.now().getTime();
    const run = stream.overflows !== null && now - stream.overflows.at <= OVERFLOW_WINDOW_MS ? stream.overflows.run + 1 : 1;
    stream.overflows = { run, at: now };
    const delay = overflowDelay(run, options.random());
    if (delay === 0) return attacher.attach(stream);
    stream.retry = clock.setTimeout(() => {
      stream.retry = null;
      if (stream.attachment === null && options.ready(stream.environmentId) && options.wanted(stream)) attacher.attach(stream);
    }, delay);
  };

  const hear = (stream: LiveStream<unknown>, token: object, message: SubscriptionMessage): void => {
    if (stream.attachment !== token) return;
    switch (message.type) {
      case "snapshot": {
        const next = input(stream, { type: "snapshot", sequence: message.sequence, payload: message.payload });
        if (next.failed) return failed(stream, next.failed);
        stream.trimming = false;
        return;
      }
      case "event": {
        const before = stream.value.read();
        const next = input(stream, { type: "event", sequence: message.sequence, event: message.event });
        if (next.failed) return failed(stream, next.failed);
        if (next.state === before) return;
        options.applied?.(stream, message.event, stream.resumed || before.freshness === "live");
        const { data } = next.state;
        if (!stream.trimming && data !== null && stream.kind.outgrown?.(data) === true) {
          stream.trimming = true;
          attacher.attach(stream, { snapshot: true });
        }
        return;
      }
      case "synchronized":
        // Never a failed step: it only moves the cursor forward (a head at or below it leaves it) and reads no payload.
        input(stream, { type: "synchronized", sequence: message.sequence });
        stream.recovering = false;
        return syncing(stream, false);
      case "end":
        letGo(stream, false);
        input(stream, { type: "end", reason: message.reason });
        syncing(stream, false);
        if (message.reason === "overflow") return overflowed(stream);
        if (message.reason === "deleted") options.ended?.(stream, message.reason);
        return;
      default: {
        const unheard: never = message;
        throw new Error(`A subscription message this runtime does not know: ${JSON.stringify(unheard)}`);
      }
    }
  };

  const attacher: Attacher = {
    attach(stream, attachOptions = {}) {
      const s = stream as LiveStream<unknown>;
      s.retry?.cancel();
      s.retry = null;
      letGo(s, true);
      const token = {};
      s.attachment = token;
      s.resumed = s.value.read().cursor !== null;
      input(s, { type: "attaching" });
      syncing(s, true);
      const afterSequence = attachOptions.snapshot ? SNAPSHOT_CURSOR : (s.value.read().cursor ?? 0);
      s.answer = clock.setTimeout(() => {
        if (s.attachment !== token || s.subscription !== null) return;
        s.answer = null;
        fault(s, `The environment did not answer ${s.method} within ${SUBSCRIBE_TIMEOUT_MS / 1000} seconds.`);
      }, SUBSCRIBE_TIMEOUT_MS);
      let answered: ReturnType<ConnectionSeams["subscribe"]>;
      try {
        answered = seams.subscribe(s.environmentId, s.method, { ...s.params, afterSequence }, (message) => {
          try {
            hear(s, token, message);
          } catch (error) {
            report(error);
          }
        });
      } catch (error) {
        answered = Promise.reject(error);
      }
      answered.then(
        (answer) => {
          if (s.attachment !== token) {
            // Let go of meanwhile (released, detached, ended): a subscription that came anyway is ended.
            if (answer.ok) seams.unsubscribe(s.environmentId, answer.subscription);
            return;
          }
          s.answer?.cancel();
          s.answer = null;
          if (answer.ok) s.subscription = answer.subscription;
          else fault(s, answer.error.message);
        },
        (error: unknown) => {
          if (s.attachment !== token) return;
          // The socket went first: the connection's phase says so, and the next `ready` attaches again.
          if (error instanceof SocketClosedError || error instanceof NotConnectedError) return attacher.detach(s);
          fault(s, error instanceof Error ? error.message : String(error));
        },
      );
    },
    detach(stream) {
      const s = stream as LiveStream<unknown>;
      s.retry?.cancel();
      s.retry = null;
      letGo(s, false);
      input(s, { type: "detached" });
      syncing(s, false);
    },
    release(stream) {
      const s = stream as LiveStream<unknown>;
      s.retry?.cancel();
      s.retry = null;
      letGo(s, true);
      input(s, { type: "detached" });
    },
    drop(stream) {
      const s = stream as LiveStream<unknown>;
      s.retry?.cancel();
      s.retry = null;
      letGo(s, false);
    },
  };
  return attacher;
};
