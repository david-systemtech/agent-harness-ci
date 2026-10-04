import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { createECDH } from "node:crypto";
import webpush from "web-push";
import { AttentionPayload, ContractError, addressClassOf, hostPatternMatches } from "@agent-harness/contracts";
import type { Vault } from "../serve/vault.js";
import type { Clock } from "../serve/clock.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { WebAttentionContext } from "../web/attention.js";
import { readSessionState } from "../sessions/session-reads.js";
import { sessionNotFound } from "../sessions/decider.js";
import { readDenylist } from "../permissions/denylist-store.js";
import { attentionStore, attentionStream } from "./store.js";
import type { AttentionTransport } from "./targets.js";

/** Exact vendor authorities, never a caller-chosen proxy, port, userinfo or redirect. */
export const pushEndpointAllowed = (endpoint: string): boolean => {
  if (!/^https:\/\/[a-z0-9.-]+\//.test(endpoint) || /[\s\\]/.test(endpoint)) return false;
  try {
    const url = new URL(endpoint);
    if (url.port || url.username || url.password || url.hash || url.search) return false;
    if (url.hostname === "fcm.googleapis.com") return /^\/fcm\/send\/[^/]+$/.test(url.pathname);
    if (url.hostname === "updates.push.services.mozilla.com") return /^\/wpush\/v2\/[^/]+$/.test(url.pathname);
    return url.hostname === "web.push.apple.com" && /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(url.pathname);
  } catch { return false; }
};
type PushPost = (url: string, body: Buffer, headers: Record<string, string>, signal: AbortSignal) => Promise<number>;
/** Pin a vetted public DNS result for this request, so a second resolution cannot reach a private host. */
const post: PushPost = async (endpoint, body, headers, signal) => {
  const addresses = await lookup(new URL(endpoint).hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => addressClassOf(address) !== "public")) throw new Error("Push gateway unavailable.");
  const address = addresses[0]!;
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(endpoint, { method: "POST", headers, signal, lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family) }, response => {
      response.destroy(); resolve(response.statusCode ?? 0);
    });
    outgoing.on("error", () => reject(new Error("Push delivery failed.")));
    outgoing.end(body);
  });
};
const bytes = (encoded: string | undefined, length: number): Buffer | undefined => {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  const value = Buffer.from(encoded, "base64url");
  return value.length === length && value.toString("base64url") === encoded ? value : undefined;
};
export interface PushTransport extends AttentionTransport { readonly publicKey: string }
/** Encryption and VAPID signing use web-push; only the private key stays in the environment vault. */
export const createPushTransport = async ({ vault, clock, subject, post: deliver = post, allowed = () => true }: {
  readonly vault: Vault; readonly clock: Clock; readonly subject: string; readonly post?: PushPost;
  readonly allowed?: (endpoint: string) => boolean;
}): Promise<PushTransport> => {
  let serialized = await vault.get("web-push:vapid");
  if (!serialized) { serialized = JSON.stringify(webpush.generateVAPIDKeys()); await vault.set("web-push:vapid", serialized); }
  const keys = JSON.parse(serialized) as { publicKey: string; privateKey: string };
  const validate: AttentionTransport["validate"] = target => {
    const { endpoint, p256dh, auth } = target.configuration;
    if (target.transport !== "push" || Object.keys(target.configuration).sort().join(",") !== "auth,endpoint,p256dh" || !endpoint || !pushEndpointAllowed(endpoint) || !allowed(endpoint)) return "Choose a supported HTTPS browser push gateway.";
    const publicKey = bytes(p256dh, 65);
    if (!publicKey || publicKey[0] !== 4 || !bytes(auth, 16)) return "The browser push subscription is invalid. Enable push again.";
    try { const ecdh = createECDH("prime256v1"); ecdh.generateKeys(); ecdh.computeSecret(publicKey); }
    catch { return "The browser push subscription is invalid. Enable push again."; }
    return undefined;
  };
  return {
    publicKey: keys.publicKey, validate,
    async send(delivery) {
      if (delivery.signal.aborted || validate(delivery.target) || !AttentionPayload.safeParse(delivery.payload).success) return { status: "retry" };
      const controller = new AbortController();
      const abort = () => controller.abort();
      delivery.signal.addEventListener("abort", abort, { once: true });
      const timer = clock.setTimeout(abort, 10_000);
      try {
        const configuration = delivery.target.configuration;
        const details = webpush.generateRequestDetails({ endpoint: configuration["endpoint"]!, keys: { p256dh: configuration["p256dh"]!, auth: configuration["auth"]! } }, JSON.stringify(delivery.payload), {
          vapidDetails: { subject, ...keys }, contentEncoding: "aes128gcm", TTL: 60, urgency: "normal",
        });
        const status = await deliver(details.endpoint, details.body, details.headers, controller.signal);
        return { status: status >= 200 && status < 300 ? "sent" : status === 404 || status === 410 ? "retire" : "retry" };
      } catch { return { status: "retry" }; }
      finally { timer.cancel(); delivery.signal.removeEventListener("abort", abort); }
    },
  };
};
/** Startup discovers this transport leaf; dispatch/store remain the shared owner's modules. */
export const createAttentionTransport = async (context: WebAttentionContext, network: { readonly post?: PushPost } = {}): Promise<PushTransport & { readonly handlers: MethodHandlers }> => {
  const requireSession = (sessionId: string) => {
    const session = readSessionState({ all: (sql, ...params) => context.log.read(sql, ...params) }, sessionId);
    if (!session || session.deleted) throw new ContractError(sessionNotFound(sessionId));
  };
  const origin = context.webOrigin();
  if (!origin) {
    const unavailable = () => { throw new ContractError({ code: "not_found", data: {}, message: "Web Push needs a canonical HTTPS origin configured by an environment admin." }); };
    return { publicKey: "", validate: () => "Configure a canonical HTTPS origin before enabling Web Push.", send: async () => ({ status: "retry" }), handlers: { "attention.push.key": unavailable, "attention.push.test": ({ sessionId }) => { requireSession(sessionId); return unavailable(); } } };
  }
  const transport = await createPushTransport({ vault: context.vault, clock: context.clock, subject: origin, ...network, allowed: endpoint => !readDenylist({ all: (sql, ...params) => context.log.read(sql, ...params) }).hosts.some(entry => entry.enabled && hostPatternMatches(entry.pattern, new URL(endpoint).hostname)) });
  const handlers: MethodHandlers = {
    "attention.push.key": () => ({ publicKey: transport.publicKey }),
    "attention.push.test": async ({ id, sessionId }, command) => {
      requireSession(sessionId);
      const stored = attentionStore(context.log).targets().find(row => row.target.id === id && row.owner === command.clientSession.id);
      if (!stored || stored.target.transport !== "push" || !stored.target.enabled) throw new ContractError({ code: "forbidden", data: {}, message: "Enable your own push registration first." });
      const result = await transport.send({ id: "push-test", target: stored.target, signal: new AbortController().signal, payload: { message: "A session needs you", url: `${origin}/#/session/${encodeURIComponent(context.environmentId)}/${encodeURIComponent(sessionId)}` } });
      if (result.status === "retire" && attentionStore(context.log).targets().some(row => row.target.id === id && row.owner === command.clientSession.id && row.version === stored.version)) context.log.append(attentionStream, [{ type: "attention.target.removed", payload: { id } }], { actor: "system:attention" });
      return { status: result.status };
    },
  };
  return { ...transport, handlers };
};
