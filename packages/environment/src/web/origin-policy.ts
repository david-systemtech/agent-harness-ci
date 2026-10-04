import type { EventLog } from "../event-log/event-log.js";
import type { HttpSurface } from "../serve/http.js";
import type { MethodHandlers } from "../serve/methods.js";

/** Leaf slot for explicit trusted-admin origins, never a wildcard or proxy-derived origin. */
export const webOriginPolicy = (_log: EventLog, _http: HttpSurface): { readonly allows: (origin: string) => boolean; readonly handlers: MethodHandlers; readonly connectOrigins: () => readonly string[] } => {
  void _log; void _http;
  return { allows: () => false, handlers: {}, connectOrigins: () => [] };
};
