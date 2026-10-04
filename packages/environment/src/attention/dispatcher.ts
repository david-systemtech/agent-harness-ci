import { AttentionPayload } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { Clock, Timer } from "../serve/clock.js";
import { attentionProjector, attentionStore, attentionStream, type PendingDelivery } from "./store.js";
import type { AttentionTransports } from "./targets.js";

export interface AttentionDispatcherOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  readonly environmentId: string;
  readonly webOrigin: () => string | undefined;
  readonly transports: AttentionTransports;
}
const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
const ACTOR = "system:attention";

/** Delivery runs outside the log's transaction and never propagates a transport failure into a run. */
export const createAttentionDispatcher = ({ log, clock, environmentId, webOrigin, transports }: AttentionDispatcherOptions) => {
  log.registerProjector(attentionProjector);
  const store = attentionStore(log);
  const inFlight = new Map<string, { readonly controller: AbortController; readonly done: Promise<void>; readonly version: string }>();
  let closed = false;
  let timer: Timer | undefined;
  const remove = (id: string) => log.append(attentionStream, [{ type: "attention.target.removed", payload: { id } }], { actor: ACTOR });
  const prune = () => {
    const live = new Set(log.clientSessions.all().filter(client => client.revokedAt === null && Date.parse(client.expiresAt) > clock.now().getTime()).map(client => client.id));
    for (const { target, owner } of store.targets()) if (owner !== null && !live.has(owner)) remove(target.id);
  };
  const valid = (d: PendingDelivery) => !closed && d.state === "pending" && d.expiresAt > clock.now().getTime() && store.targets().some(t => t.target.id === d.targetId && t.target.enabled && (d.promptId !== null || t.target.completion));
  const result = (d: PendingDelivery, state: PendingDelivery["state"], attempts: number, nextAt: number, failure: string | null) => {
    log.append(attentionStream, [{ type: "attention.delivery.result", payload: { id: d.id, targetId: d.targetId, state, attempts, nextAt, failure } }], { actor: ACTOR, causationId: d.eventId });
  };
  const cancelStale = () => {
    const pending = store.deliveries("pending");
    for (const d of pending) if (!valid(d)) result(d, "cancelled", d.attempts, d.nextAt, null);
    for (const [id, flight] of inFlight) if (!pending.some(d => d.id === id && valid(d) && store.targets().some(t => t.target.id === d.targetId && t.version === flight.version))) flight.controller.abort();
  };
  const send = async (d: PendingDelivery, version: string, signal: AbortSignal) => {
    const stored = store.targets().find(t => t.target.id === d.targetId);
    const origin = webOrigin();
    const currentBeforeSend = store.deliveries("pending").find(item => item.id === d.id);
    if (!stored || stored.version !== version || !origin || signal.aborted || !currentBeforeSend || !valid(currentBeforeSend)) return;
    const transport = transports[stored.target.transport];
    if (!transport) return;
    const payload = AttentionPayload.safeParse({ message: "A session needs you", url: `${origin}/#/session/${encodeURIComponent(environmentId)}/${encodeURIComponent(d.sessionId)}` });
    let outcome: "sent" | "retry" | "retire" = "retry";
    try {
      if (payload.success && !transport.validate(stored.target)) outcome = (await transport.send({ id: d.id, payload: payload.data, target: stored.target, signal })).status;
    } catch { /* A safe generic failure, never the transport's exception or endpoint. */ }
    const current = store.deliveries("pending").find(item => item.id === d.id);
    if (!current || !valid(current) || signal.aborted || !store.targets().some(t => t.target.id === d.targetId && t.version === version)) return;
    if (outcome === "retire") { remove(d.targetId); return; }
    const attempts = d.attempts + 1;
    if (outcome === "sent") result(d, "sent", attempts, d.nextAt, null);
    else {
      const delay = RETRY_MS[d.attempts];
      result(d, delay === undefined ? "failed" : "pending", attempts, clock.now().getTime() + (delay ?? 0), "Delivery failed. Check the configured transport.");
    }
  };
  const tick = () => {
    if (closed) return;
    prune(); cancelStale();
    for (const d of store.deliveries("pending")) {
      if (!valid(d) || d.nextAt > clock.now().getTime() || inFlight.has(d.id)) continue;
      const stored = store.targets().find(t => t.target.id === d.targetId);
      if (!stored) continue;
      const controller = new AbortController();
      const done = Promise.resolve().then(() => send(d, stored.version, controller.signal)).finally(() => { inFlight.delete(d.id); schedule(); });
      inFlight.set(d.id, { controller, done, version: stored.version });
    }
    schedule();
  };
  const schedule = () => {
    timer?.cancel(); timer = undefined;
    if (closed) return;
    const now = clock.now().getTime();
    let next = Infinity;
    for (const d of store.deliveries("pending")) {
      next = Math.min(next, d.expiresAt);
      if (!inFlight.has(d.id)) next = Math.min(next, d.nextAt > now ? d.nextAt : now + 1000);
    }
    const owners = new Set(store.targets().flatMap(t => t.owner === null ? [] : [t.owner]));
    if (owners.size) for (const client of log.clientSessions.all()) if (owners.has(client.id)) next = Math.min(next, Date.parse(client.expiresAt));
    // Timers preserve their delay across sleep/clock adjustments; recheck wall deadlines while work exists.
    if (Number.isFinite(next)) timer = clock.setTimeout(tick, Math.max(1, Math.min(next - now, 60_000)));
  };
  const unsubscribe = log.subscribe(event => {
    if (!closed && (event.streamKind === "access" || event.type.startsWith("attention.") || ["prompt.opened", "prompt.answered", "routine.firing-ended", "session.deleted", "session.purged"].includes(event.type))) {
      prune(); cancelStale(); schedule();
    }
  });
  tick();
  return { store, remove, flush: async () => { tick(); await Promise.all([...inFlight.values()].map(item => item.done)); },
    close: () => { closed = true; timer?.cancel(); unsubscribe(); for (const item of inFlight.values()) item.controller.abort(); },
  };
};
