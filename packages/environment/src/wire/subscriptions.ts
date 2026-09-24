import { encodeFrame, type EndReason, type Frame } from "@agent-harness/contracts";
import type { WebSocket } from "ws";
import type { z } from "zod";
import { REPLAY_BOUND, selection, type EventEnvelope, type EventLog, type Selection, type StreamSelector } from "../event-log/event-log.js";
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
  /**
   * The events the subscription carries: one stream (`{ kind, id }`), or
   * every stream of some kinds, of the types named when it names them
   * (`{ kinds, types? }`), as the session list carries the `list`-flagged
   * events of every session and group stream. Replay, the replay bound and
   * the live feed all read the same selection.
   */
  readonly stream: StreamSelector;
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
  beforeCatchUp?(subscription: { readonly id: string; readonly stream: StreamSelector }): void | Promise<void>;
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

/** How much a subscription holds back: events, and their bytes as the replay bound measures them. */
interface Measure {
  count: number;
  bytes: number;
}

/** What every socket's subscriptions share. */
interface Shared {
  readonly log: EventLog;
  readonly hooks: SubscriptionHooks;
  /** Every open subscription, for the count. */
  readonly open: Set<Subscription>;
}

/** One socket's side: where its frames go, and the subscriptions it holds by id. */
interface Channel {
  readonly shared: Shared;
  readonly ws: WebSocket;
  readonly outlet: Outlet;
  readonly subscriptions: Map<string, Subscription>;
  minted: number;
}

interface Subscription {
  readonly channel: Channel;
  readonly id: string;
  /** The request `subscribed` answers. */
  readonly requestId: string;
  readonly stream: StreamSelector;
  /** The stream's test of a live event, from the same description the catch-up reads with. */
  readonly selection: Selection;
  phase: "catching-up" | "live" | "ended";
  /** Whether `subscribed` has been sent: only then does the client know the id, and hear an `end`. */
  announced: boolean;
  /** The sequence the client is synchronized to: every event of the stream at or below it is sent. */
  sent: number;
  /** Events the live feed heard while catching up, released after `synchronized`, and their measure. */
  heard: EventEnvelope[];
  heardMeasure: Measure;
  /** Live events sent and not yet flushed: how far behind the client is. */
  pending: Measure;
  detach(): void;
}

/**
 * The bytes an event counts for against the bound: its payload and metadata
 * as JSON, as the replay bound measures them in SQL.
 */
const sizeOf = (event: EventEnvelope): number =>
  Buffer.byteLength(JSON.stringify(event.payload)) + Buffer.byteLength(JSON.stringify(event.metadata));

/** `measure` with one more event of `bytes`. */
const plus = (measure: Measure, bytes: number): Measure => ({ count: measure.count + 1, bytes: measure.bytes + bytes });

/**
 * Whether `measure` is past the replay bound (1,000 events or 8 MiB). A lone
 * event never is, however large, so every event can be sent on its own.
 */
const passesBound = (measure: Measure): boolean =>
  measure.count > 1 && (measure.count > REPLAY_BOUND.events || measure.bytes > REPLAY_BOUND.bytes);

/** The socket's own outlet: `ws` calls back once a frame is written to the network, or has failed to be. */
const socketOutlet = (ws: WebSocket): Outlet => ({
  send(text, flushed) {
    if (ws.readyState !== ws.OPEN) return flushed();
    ws.send(text, () => flushed());
  },
});

const sendFrame = (channel: Channel, frame: Frame): void => channel.outlet.send(encodeFrame(frame), () => undefined);

const eventFrame = (subscription: Subscription, event: EventEnvelope): string =>
  encodeFrame({ type: "event", subscription: subscription.id, sequence: event.sequence, event: toWireEnvelope(event) });

const announce = (subscription: Subscription): void => {
  sendFrame(subscription.channel, { type: "subscribed", id: subscription.requestId, subscription: subscription.id });
  subscription.announced = true;
};

/** Stops feeding a subscription and forgets it, saying nothing. */
const drop = (subscription: Subscription): void => {
  subscription.phase = "ended";
  subscription.detach();
  subscription.heard = [];
  subscription.channel.subscriptions.delete(subscription.id);
  subscription.channel.shared.open.delete(subscription);
};

/**
 * Ends a subscription and tells the client why, if it can still hear. One
 * that overflowed before it was announced is announced first, so its request
 * is answered and the client resubscribes; one that was not announced when
 * its socket closes or is revoked is only dropped.
 */
const end = (subscription: Subscription, reason: EndReason): void => {
  if (subscription.phase === "ended") return;
  drop(subscription);
  const { channel } = subscription;
  if (channel.ws.readyState !== channel.ws.OPEN) return;
  if (!subscription.announced) {
    if (reason !== "overflow") return;
    announce(subscription);
  }
  sendFrame(channel, { type: "end", subscription: subscription.id, reason });
};

/**
 * Sends one live event, once and in order. A client whose unflushed live
 * events would pass the replay bound has fallen too far behind: it is ended
 * with `overflow`, and resubscribes from its cursor.
 */
const deliver = (subscription: Subscription, event: EventEnvelope): void => {
  if (event.sequence <= subscription.sent) return;
  const bytes = sizeOf(event);
  const pending = plus(subscription.pending, bytes);
  if (passesBound(pending)) return end(subscription, "overflow");
  subscription.pending = pending;
  subscription.sent = event.sequence;
  subscription.channel.outlet.send(eventFrame(subscription, event), () => {
    subscription.pending.count -= 1;
    subscription.pending.bytes -= bytes;
  });
};

/** The live feed: delivered once live, kept (against the same bound) while catching up. */
const hear = (subscription: Subscription, event: EventEnvelope): void => {
  if (subscription.phase === "ended" || !subscription.selection.matches(event)) return;
  if (subscription.phase === "live") return deliver(subscription, event);
  const heard = plus(subscription.heardMeasure, sizeOf(event));
  if (passesBound(heard)) return end(subscription, "overflow");
  subscription.heard.push(event);
  subscription.heardMeasure = heard;
};

/**
 * Reads what the client missed and sends it, with `subscribed` first and
 * `synchronized` last, then goes live with what the feed heard meanwhile.
 * Synchronous from the head read to the last frame, so no append falls
 * between them: everything appended since the feed was attached was heard,
 * and what the read already sent is dropped from it by sequence.
 */
const catchUp = (subscription: Subscription, opening: Opening): void => {
  const { log } = subscription.channel.shared;
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
  }

  const { channel } = subscription;
  announce(subscription);
  for (const text of frames) channel.outlet.send(text, () => undefined);
  subscription.sent = synchronizedAt;
  sendFrame(channel, { type: "synchronized", subscription: subscription.id, sequence: synchronizedAt });
  subscription.phase = "live";
  const heard = subscription.heard;
  subscription.heard = [];
  subscription.heardMeasure = { count: 0, bytes: 0 };
  for (const event of heard) deliver(subscription, event);
};

/** Opens a subscription on `channel`: the live feed first, then the (possibly held) catch-up. */
const openSubscription = async (channel: Channel, opening: Opening): Promise<void> => {
  // The socket went while dispatch awaited the handler: its subscriptions were ended, and this one never starts.
  if (channel.ws.readyState !== channel.ws.OPEN) return;
  const { shared } = channel;
  const subscription: Subscription = {
    channel,
    id: `sub-${++channel.minted}`,
    requestId: opening.requestId,
    stream: opening.source.stream,
    selection: selection(opening.source.stream),
    phase: "catching-up",
    announced: false,
    sent: opening.afterSequence,
    heard: [],
    heardMeasure: { count: 0, bytes: 0 },
    pending: { count: 0, bytes: 0 },
    detach: () => undefined,
  };
  channel.subscriptions.set(subscription.id, subscription);
  shared.open.add(subscription);
  // The live feed first: nothing appended from here on is missed, whenever catch-up reads.
  subscription.detach = shared.log.subscribe((event) => hear(subscription, event));
  try {
    await shared.hooks.beforeCatchUp?.({ id: subscription.id, stream: subscription.stream });
    // Ended while held (the socket closed, or the feed overflowed): nothing more to send.
    if (subscription.phase !== "catching-up") return;
    catchUp(subscription, opening);
  } catch (error) {
    drop(subscription);
    throw error;
  }
};

/** The environment's subscriptions over `log`. */
export const createSubscriptions = (log: EventLog, hooks: SubscriptionHooks = {}): Subscriptions => {
  const shared: Shared = { log, hooks, open: new Set() };
  return {
    forSocket(ws) {
      const outlet = hooks.outlet ? hooks.outlet(socketOutlet(ws)) : socketOutlet(ws);
      const channel: Channel = { shared, ws, outlet, subscriptions: new Map(), minted: 0 };
      return {
        open: (opening) => openSubscription(channel, opening),
        unsubscribe(id) {
          const subscription = channel.subscriptions.get(id);
          if (subscription?.announced) end(subscription, "unsubscribed");
        },
        endAll(reason) {
          for (const subscription of [...channel.subscriptions.values()]) end(subscription, reason);
        },
      };
    },
    count: () => shared.open.size,
  };
};
