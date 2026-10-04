import { AttentionPayload, EndpointName, EndpointUrl, addressClassOf, hostOf, hostPatternMatches } from "@agent-harness/contracts";
import { readDenylist } from "../permissions/denylist-store.js";
import { postWebhook } from "../routines/webhook-post.js";
import type { WebAttentionContext } from "../web/attention.js";
import type { AttentionTransport } from "./targets.js";

/** Outbound endpoint policy matches routines: HTTPS, or HTTP on loopback/private/tailnet only. */
const clearTextClasses = new Set(["loopback", "private", "cgnat", "unique-local"]);
// Match even empty userinfo, which URL.username/password do not retain.
// eslint-disable-next-line no-control-regex -- URL discards these controls before parsing its authority.
const parserDrops = /^[\u0000-\u0020]+|[\u0000-\u0020]+$|[\t\n\r]/g;
const userinfo = /^https?:[/\\]*[^/\\?#]*@/i;

/** Named endpoints own secrets; the dispatcher owns IDs, retry deadlines and safe failure status. */
export const createAttentionTransport = ({ clock, endpoints, log }: WebAttentionContext): AttentionTransport => {
  const validate: AttentionTransport["validate"] = target => {
    if (target.transport !== "webhook" || Object.keys(target.configuration).length !== 1 || !EndpointName.safeParse(target.configuration["endpoint"]).success) {
      return "Choose a named webhook endpoint configured on this environment.";
    }
    return undefined;
  };
  const allowed = (url: string): boolean => {
    if (!EndpointUrl.safeParse(url).success) return false;
    const parsed = new URL(url);
    const host = hostOf(url);
    if (!host || parsed.username || parsed.password || userinfo.test(url.replace(parserDrops, ""))) return false;
    if (parsed.protocol !== "https:" && !clearTextClasses.has(addressClassOf(host) ?? "") && !host.endsWith(".ts.net")) return false;
    return !readDenylist({ all: (sql, ...params) => log.read(sql, ...params) }).hosts.some(entry => entry.enabled && hostPatternMatches(entry.pattern, host));
  };
  return {
    validate,
    async send(delivery) {
      if (delivery.signal.aborted || validate(delivery.target)) return { status: "retry" };
      const payload = AttentionPayload.safeParse(delivery.payload);
      if (!payload.success) return { status: "retry" };
      try {
        const endpoint = await endpoints.resolve(delivery.target.configuration["endpoint"]!);
        if ("error" in endpoint) return { status: "retry" };
        try {
          if (delivery.signal.aborted || !allowed(endpoint.url)) return { status: "retry" };
          const result = await postWebhook({ ...endpoint, clock, id: delivery.id, body: JSON.stringify(payload.data), signal: delivery.signal });
          return { status: result.error === null ? "sent" : "retry" };
        } finally { endpoint.release?.(); }
      } catch { return { status: "retry" }; }
    },
  };
};
