import type { EventEnvelope, EventFrame } from "@agent-harness/contracts";
import type { WireClient } from "./wire-client.js";

/** The notices of `type` a client reads on `environment.subscribe` after `afterSequence`, up to where it is synchronized. */
export const noticesOf = async (client: WireClient, type: string, afterSequence: number): Promise<EventEnvelope[]> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence });
  const events: EventEnvelope[] = [];
  for (;;) {
    const frame = await client.next((f) => "subscription" in f && f.subscription === subscription && (f.type === "event" || f.type === "synchronized"));
    if (frame.type === "synchronized") return events.filter((event) => event.type === type);
    events.push((frame as EventFrame).event);
  }
};
