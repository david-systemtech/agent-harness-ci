import type { EndReason, EventEnvelope } from "@agent-harness/contracts";
import type { FakeWire } from "../src/testing/fake-wire.js";

/** One subscription as the environment scripts it on the fake wire: answered `subscribed`, then whatever the test sends on it. */
export interface Scripted {
  readonly params: Record<string, unknown>;
  snapshot(sequence: number, payload: Record<string, unknown>): void;
  event(event: EventEnvelope): void;
  synchronized(sequence: number): void;
  end(reason: EndReason): void;
}

let minted = 0;

/** Waits for the client to ask `method`, answers it `subscribed` with a fresh id, and hands back its script. */
export const subscription = async (wire: FakeWire, method: string): Promise<Scripted> => {
  const request = await wire.server.request(method);
  const id = `sub-${++minted}`;
  wire.server.send({ type: "subscribed", id: request.id, subscription: id });
  return {
    params: request.params,
    snapshot: (sequence, payload) => wire.server.send({ type: "snapshot", subscription: id, sequence, payload }),
    event: (event) => wire.server.send({ type: "event", subscription: id, sequence: event.sequence, event }),
    synchronized: (sequence) => wire.server.send({ type: "synchronized", subscription: id, sequence }),
    end: (reason) => wire.server.send({ type: "end", subscription: id, reason }),
  };
};
