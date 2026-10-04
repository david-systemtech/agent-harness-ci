import { z } from "zod";
import { commandParams, defineMethod } from "../method.js";

/** Exact canonical HTTPS origins only; no paths, credentials, wildcards or implicit trust. */
const canonicalUrl = z.url({ protocol: /^https$/, normalize: true });
const origin = z.url().regex(/^https:\/\/(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(?!443$)[1-9][0-9]{0,4})?$/).refine(value => {
  const parsed = canonicalUrl.safeParse(value);
  return parsed.success && parsed.data === `${value}/`;
}, "Use an exact HTTPS origin without a path, credentials or wildcard.");
const origins = z.array(origin).max(32).refine(values => new Set(values).size === values.length, "Origins must be unique.").meta({ uniqueItems: true });
const settings = { clientOrigins: origins, connectOrigins: origins };
const get = defineMethod({ name: "web.origins.get", scope: "read", kind: "query", params: z.object({}), result: z.object(settings), errors: [] });
const set = defineMethod({ name: "web.origins.set", scope: "admin", kind: "command", params: commandParams(settings), result: z.object(settings), errors: [] });
/** Incoming browser clients and outgoing browser connections are separate deliberate admin choices. */
export const webOriginMethods = [get, set] as const;
