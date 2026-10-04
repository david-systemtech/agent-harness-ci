import type { Clock } from "../serve/clock.js";
import type { EventLog } from "../event-log/event-log.js";
import type { MethodHandlers } from "../serve/methods.js";

/** Dispatch owner fills this leaf; transports attach here without editing startup. */
export interface WebAttentionContext {
  readonly log: EventLog;
  readonly clock: Clock;
  readonly environmentId: string;
  readonly webOrigin: () => string | undefined;
}
export const webAttention = (_context: WebAttentionContext): { readonly handlers: MethodHandlers; readonly close: () => void } => {
  void _context;
  return { handlers: {}, close: () => undefined };
};
