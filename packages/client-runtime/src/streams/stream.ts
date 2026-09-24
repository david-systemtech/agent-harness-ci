import type { EndReason, EventEnvelope } from "@agent-harness/contracts";

/**
 * One subscribed stream as a pure reducer (docs/specs/client-runtime.md,
 * "Subscriptions, cursor cache and snapshots"): its cursor (`lastSequence`),
 * the state the cursor belongs to, its freshness and its fault. `step`
 * answers the next state for each message and whether it is to be written:
 * soon (debounced), now (on `synchronized`, an end, a detach), or not at
 * all. What a stream's state is and how an event changes it is its kind's
 * (`kinds.ts`); the rules here are the same for every stream:
 *
 * - an event at or below the cursor is dropped (the environment attaches the
 *   live feed before catch-up, so the overlap is expected);
 * - a `snapshot` replaces the state and the cursor whole;
 * - `synchronized` makes the stream live and moves the cursor to the head it
 *   names, since every event of the stream up to it has been sent;
 * - an apply that throws changes nothing, the cursor included, and faults
 *   the stream: a cancelled apply never advances the cursor.
 */

/** How current a stream's state is: nothing held; held from the cache; catching up on a subscription; live. */
export type Freshness = "empty" | "cached" | "catching-up" | "live";

export interface StreamState<D> {
  /** The sequence the state is as of: the stream's `lastSequence`; null when nothing is held. */
  readonly cursor: number | null;
  /** The state; null when nothing is held. */
  readonly data: D | null;
  readonly freshness: Freshness;
  /** Why the stream's subscription failed on a healthy socket, until it synchronizes again: a stream fault, never a connection phase. */
  readonly fault: string | null;
}

/** What one kind of stream is: its empty state, its snapshot, how an event changes it, and its stored form. */
export interface StreamKind<D> {
  empty(): D;
  /** The state a `snapshot` payload is; throws on a payload it cannot read. */
  fromSnapshot(payload: Record<string, unknown>): D;
  /** The state after `event`; throws when it cannot apply it. Never mutates `data`. */
  apply(data: D, event: EventEnvelope): D;
  /** The state as plain JSON, for the cache document. */
  encode(data: D): unknown;
  /** The state from its cache document; throws on one it cannot read. */
  decode(value: unknown): D;
}

export type StreamInput =
  /** A subscription was asked for. */
  | { readonly type: "attaching" }
  | { readonly type: "snapshot"; readonly sequence: number; readonly payload: Record<string, unknown> }
  | { readonly type: "event"; readonly sequence: number; readonly event: EventEnvelope }
  | { readonly type: "synchronized"; readonly sequence: number }
  | { readonly type: "end"; readonly reason: EndReason }
  /** The subscription failed on a healthy socket, or an apply could not finish. */
  | { readonly type: "fault"; readonly message: string }
  /** The socket went: no subscription any more. */
  | { readonly type: "detached" };

/** When the state is to be written: not at all, debounced, or at once. */
export type Persist = "none" | "soon" | "now";

export interface StreamStep<D> {
  readonly state: StreamState<D>;
  readonly persist: Persist;
  /** Why an apply failed, when one did: the state is unchanged but for the fault. */
  readonly failed?: string;
}

export const emptyStream = <D>(): StreamState<D> => ({ cursor: null, data: null, freshness: "empty", fault: null });

/** A stream as the cache holds it: its cursor and state, not subscribed. */
export const cachedStream = <D>(_kind: StreamKind<D>, cursor: number, data: D): StreamState<D> => ({ cursor, data, freshness: "cached", fault: null });

/** Where a stream rests with no subscription: cached if it holds anything, else empty. */
const resting = <D>(state: StreamState<D>): StreamState<D>["freshness"] => (state.data === null ? "empty" : "cached");

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const step = <D>(kind: StreamKind<D>, state: StreamState<D>, input: StreamInput): StreamStep<D> => {
  switch (input.type) {
    case "attaching":
      return { state: { ...state, freshness: "catching-up" }, persist: "none" };
    case "snapshot": {
      let data: D;
      try {
        data = kind.fromSnapshot(input.payload);
      } catch (error) {
        const failed = `The snapshot could not be read: ${messageOf(error)}`;
        return { state: { ...state, fault: failed }, persist: "none", failed };
      }
      return { state: { ...state, cursor: input.sequence, data }, persist: "soon" };
    }
    case "event": {
      if (state.cursor !== null && input.sequence <= state.cursor) return { state, persist: "none" };
      let data: D;
      try {
        data = kind.apply(state.data ?? kind.empty(), input.event);
      } catch (error) {
        const failed = `Event ${input.sequence} (${input.event.type}) could not be applied: ${messageOf(error)}`;
        return { state: { ...state, fault: failed }, persist: "none", failed };
      }
      return { state: { ...state, cursor: input.sequence, data }, persist: "soon" };
    }
    case "synchronized":
      return {
        state: {
          cursor: Math.max(state.cursor ?? 0, input.sequence),
          data: state.data ?? kind.empty(),
          freshness: "live",
          fault: null,
        },
        persist: "now",
      };
    case "end":
    case "detached":
      return { state: { ...state, freshness: resting(state) }, persist: state.data === null ? "none" : "now" };
    case "fault":
      return { state: { ...state, freshness: resting(state), fault: input.message }, persist: "none" };
  }
};
