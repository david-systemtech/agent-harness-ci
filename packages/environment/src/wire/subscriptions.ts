import { encodeFrame, type EndReason, type Frame } from "@agent-harness/contracts";
import type { WebSocket } from "ws";
import type { z } from "zod";
import { REPLAY_BOUND, type EventEnvelope, type EventLog, type StreamRef } from "../event-log/event-log.js";
import { toWireEnvelope } from "./envelope.js";

/**
 * Subscriptions (env spec, "Subscriptions"): a request on a stream method,
 * once dispatch has checked its scope and params and its handler has named a
 * `StreamSource`, becomes a subscription on the socket. The live feed is
 * attached first; then the replay from the client's `afterSequence` cursor is
 * measured against the replay bound, in SQL, before anything is decoded.
 * Within the bound the events after the cursor are sent; beyond it one
 * snapshot of the source's read model is. Then `synchronized`, once, and the
 * live events, each sent once: whatever the live feed heard at or below what
 * catch-up already sent is dropped, by sequence.
 */

/**
 * What a stream method's handler answers: which events the subscription
 * carries, and the read model sent as its snapshot when replay from the
 * cursor would pass the bound. The payload's shape is the method's `result`
 * schema, and is checked against it.
 */
export interface StreamSource<Payload = unknown> {
  /** The one stream whose events the subscription carries. */
  readonly stream: StreamRef;
  /** The state as of the log's head, read when the snapshot is sent. A throw refuses the subscription. */
  snapshot(): Payload;
}

/**
 * Where a socket's subscription frames go: sent as text, with `flushed`
 * called once the frame has left for the network (or can never). What is
 * sent and not yet flushed is how far behind the client is.
 */
export interface Outlet {
  send(text: string, flushed: () => void): void;
}

/** Test seams. Neither is set outside tests. */
export interface SubscriptionHooks {
  /** Awaited once a subscription's live feed is attached and before its catch-up reads: holds the catch-up open. */
  beforeCatchUp?(subscription: { readonly id: string; readonly stream: StreamRef }): void | Promise<void>;
  /** Wraps each socket's outlet: a slow socket, which holds frames back as a slow network would. */
  outlet?(outlet: Outlet): Outlet;
}

/** A stream request that passed dispatch: what opening its subscription needs. */
export interface Opening {
  /** The request's id, which `subscribed` answers. */
  readonly requestId: string;
  readonly source: StreamSource;
  readonly afterSequence: number;
  /** The method's result schema, which the snapshot's payload must match. */
  readonly payloadSchema: z.ZodType;
}

/** One socket's subscriptions. */
export interface SocketSubscriptions {
  /**
   * Opens a subscription: attaches the live feed, catches up, and only then
   * answers `subscribed` and sends the catch-up, `synchronized` and what the
   * feed heard meanwhile, all at once. A throw (the snapshot failed, or did not
   * match its schema) comes before `subscribed`, for dispatch to answer.
   */
  open(opening: Opening): Promise<void>;
  /** Ends the subscription with `unsubscribed`; an id this socket does not hold is ignored. */
  unsubscribe(id: string): void;
  /** Ends every subscription: `revoked` or `closed`, said only when the socket can still hear it. */
  endAll(reason: Extract<EndReason, "revoked" | "closed">): void;
}

export interface Subscriptions {
  /** The subscriptions of one socket, whose frames go out through `ws`. */
  forSocket(ws: WebSocket): SocketSubscriptions;
  /** How many subscriptions are open, catching up or live, across every socket. */
  count(): number;
}

interface Subscription {
  readonly id: string;
  /** The request `subscribed` answers. */
  readonly requestId: string;
  readonly stream: StreamRef;
  phase: "catching-up" | "live" | "ended";
  /** Whether `subscribed` has been sent: only then does the client know the id, and hear an `end`. */
  announced: boolean;
  /** The sequence the client is synchronized to: every event of the stream at or below it is sent. */
  sent: number;
  /** Events the live feed heard while catching up, released after `synchronized`. */
  heard: EventEnvelope[];
  heardBytes: number;
  /** Live frames sent and not yet flushed, and their bytes: how far behind the client is. */
  pending: number;
  pendingBytes: number;
  detach(): void;
}

/** The socket's own outlet: `ws` calls back once a frame is written to the network, or has failed to be. */
const socketOutlet = (ws: WebSocket): Outlet => ({
  send(text, flushed) {
    if (ws.readyState !== ws.OPEN) return flushed();
    ws.send(text, () => flushed());
  },
});

const sameStream = (event: EventEnvelope, stream: StreamRef): boolean =>
  event.streamKind === stream.kind && event.streamId === stream.id;

/**
 * The environment's subscriptions over `log`. A live subscription falls too
 * far behind when the frames it has sent and the socket has not flushed would
 * pass the replay bound (1,000 events or 8 MiB, the same bound replay keeps):
 * it is ended with `overflow`, and the client resubscribes from its cursor.
 * Catch-up's own frames do not count, since the bound already caps them; the
 * events heard while catching up count against the same bound.
 */
export const createSubscriptions = (log: EventLog, hooks: SubscriptionHooks = {}): Subscriptions => {
  const open = new Set<Subscription>();

  const forSocket = (ws: WebSocket): SocketSubscriptions => {
    const outlet = hooks.outlet ? hooks.outlet(socketOutlet(ws)) : socketOutlet(ws);
    const mine = new Map<string, Subscription>();
    let minted = 0;

    const send = (frame: Frame, flushed: () => void = () => undefined): void => outlet.send(encodeFrame(frame), flushed);

    const announce = (subscription: Subscription): void => {
      send({ type: "subscribed", id: subscription.requestId, subscription: subscription.id });
      subscription.announced = true;
    };

    /** Stops feeding a subscription and forgets it, saying nothing. */
    const drop = (subscription: Subscription): void => {
      subscription.phase = "ended";
      subscription.detach();
      subscription.heard = [];
      mine.delete(subscription.id);
      open.delete(subscription);
    };

    /**
     * Ends a subscription and tells the client why, if it can still hear. One
     * that overflowed before it was announced is announced first, so its
     * request is answered and the client resubscribes; one that was not
     * announced when its socket closes or is revoked is only dropped.
     */
    const end = (subscription: Subscription, reason: EndReason): void => {
      if (subscription.phase === "ended") return;
      drop(subscription);
      if (ws.readyState !== ws.OPEN) return;
      if (!subscription.announced) {
        if (reason !== "overflow") return;
        announce(subscription);
      }
      send({ type: "end", subscription: subscription.id, reason });
    };

    const eventFrame = (subscription: Subscription, event: EventEnvelope): string =>
      encodeFrame({ type: "event", subscription: subscription.id, sequence: event.sequence, event: toWireEnvelope(event) });

    /** Whether one more frame of `bytes` would put a subscription with `count` frames of `total` bytes past the bound. */
    const passesBound = (count: number, total: number, bytes: number): boolean =>
      count > 0 && (count + 1 > REPLAY_BOUND.events || total + bytes > REPLAY_BOUND.bytes);

    /** Sends one live event, once, in order; a client too far behind is ended instead. */
    const deliver = (subscription: Subscription, event: EventEnvelope): void => {
      if (event.sequence <= subscription.sent) return;
      const text = eventFrame(subscription, event);
      const bytes = Buffer.byteLength(text);
      if (passesBound(subscription.pending, subscription.pendingBytes, bytes)) return end(subscription, "overflow");
      subscription.pending += 1;
      subscription.pendingBytes += bytes;
      subscription.sent = event.sequence;
      outlet.send(text, () => {
        subscription.pending -= 1;
        subscription.pendingBytes -= bytes;
      });
    };

    const hear = (subscription: Subscription, event: EventEnvelope): void => {
      if (subscription.phase === "ended" || !sameStream(event, subscription.stream)) return;
      if (subscription.phase === "live") return deliver(subscription, event);
      const bytes = Buffer.byteLength(JSON.stringify(event.payload)) + Buffer.byteLength(JSON.stringify(event.metadata));
      if (passesBound(subscription.heard.length, subscription.heardBytes, bytes)) return end(subscription, "overflow");
      subscription.heard.push(event);
      subscription.heardBytes += bytes;
    };

    /**
     * Reads what the client missed and sends it, with `subscribed` first and
     * `synchronized` last. Synchronous from the head read to the last frame,
     * so no append falls between them; everything appended since the live feed
     * was attached was heard, and is released after, less what was read.
     */
    const catchUp = (subscription: Subscription, opening: Opening): void => {
      const head = log.head();
      const frames: string[] = [];
      let synchronizedAt = head;
      // A cursor past the head is not this log's (its data directory was replaced): the snapshot resets the client.
      const replayable = opening.afterSequence <= head && log.replayBound(subscription.stream, opening.afterSequence).withinBound;
      if (replayable) {
        for (const event of log.readStream(subscription.stream, opening.afterSequence)) {
          frames.push(eventFrame(subscription, event));
          synchronizedAt = Math.max(synchronizedAt, event.sequence);
        }
      } else {
        // A read model that fails, or does not match its schema, throws here: before `subscribed`, for dispatch to answer.
        const payload = opening.payloadSchema.parse(opening.source.snapshot()) as Record<string, unknown>;
        frames.push(encodeFrame({ type: "snapshot", subscription: subscription.id, sequence: head, payload }));
        synchronizedAt = head;
      }

      announce(subscription);
      for (const text of frames) outlet.send(text, () => undefined);
      subscription.sent = synchronizedAt;
      send({ type: "synchronized", subscription: subscription.id, sequence: synchronizedAt });
      subscription.phase = "live";
      const heard = subscription.heard;
      subscription.heard = [];
      subscription.heardBytes = 0;
      for (const event of heard) deliver(subscription, event);
    };

    return {
      async open(opening) {
        // The socket went while dispatch awaited the handler: its subscriptions were ended, and this one never starts.
        if (ws.readyState !== ws.OPEN) return;
        const subscription: Subscription = {
          id: `sub-${++minted}`,
          requestId: opening.requestId,
          stream: opening.source.stream,
          phase: "catching-up",
          announced: false,
          sent: opening.afterSequence,
          heard: [],
          heardBytes: 0,
          pending: 0,
          pendingBytes: 0,
          detach: () => undefined,
        };
        mine.set(subscription.id, subscription);
        open.add(subscription);
        // The live feed first: nothing appended from here on is missed, whenever catch-up reads.
        subscription.detach = log.subscribe((event) => hear(subscription, event));
        try {
          await hooks.beforeCatchUp?.({ id: subscription.id, stream: subscription.stream });
          // Ended while held (the socket closed, or the feed overflowed): nothing more to send.
          if (subscription.phase !== "catching-up") return;
          catchUp(subscription, opening);
        } catch (error) {
          drop(subscription);
          throw error;
        }
      },

      unsubscribe(id) {
        const subscription = mine.get(id);
        if (subscription?.announced) end(subscription, "unsubscribed");
      },

      endAll(reason) {
        for (const subscription of [...mine.values()]) end(subscription, reason);
      },
    };
  };

  return { forSocket, count: () => open.size };
};
