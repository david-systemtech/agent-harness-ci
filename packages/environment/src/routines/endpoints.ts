import { randomUUID } from "node:crypto";
import {
  ContractError,
  ROUTINE_WEBHOOK_VERSION,
  WEBHOOK_SECRET_PREFIX,
  addressClassOf,
  displayReference,
  hostOf,
  invalidParams,
  webhookKey,
  type AddressClass,
  type ParamsOf,
  type ResultOf,
  type KeyManagerReferenceHolder,
  type RoutineEndpointSetPayload,
  type WebhookEndpoint,
  type WebhookPayload,
} from "@agent-harness/contracts";
import type { KeyManagerRegistry } from "../key-managers/registry.js";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { MoveSource } from "../key-managers/moves.js";
import { createEndpointMoveSource } from "./endpoint-move-source.js";
import type { CommandContext, CommandRejection, MethodHandlers, PreparedCommand } from "../serve/methods.js";
import type { Vault } from "../serve/vault.js";
import type { Reader } from "../sessions/session-tables.js";
import { listStoredEndpoints, storedEndpoint, type EndpointResult, type StoredEndpoint } from "./endpoint-store.js";
import type { DeliveryEndpoint } from "./webhook-delivery.js";
import { attentionStore } from "../attention/store.js";
import { listStoredRoutines } from "./routine-store.js";
import { postWebhook } from "./webhook-post.js";

/**
 * The webhook endpoints (routines spec, "Delivery targets" and "Methods on
 * the wire"; ADR 0008; #522): named once per environment with a URL and a
 * secret, so every routine there delivers to one by name and none holds a
 * secret. `routines.endpoints.set` and `routines.endpoints.remove` at
 * `admin`, direct, each a notice on the environment's stream that the
 * endpoint store projects; `routines.endpoints.list` at `read`;
 * `routines.endpoints.test` at `admin`, a query that POSTs a signed
 * `routine.test` payload.
 *
 * A pasted secret crosses the wire once, in the set, and is kept in the
 * vault under `endpoint:<name>`, which registers it for scrubbing while it
 * holds it (ADR 0020's rule for tokens): no answer, event or log line
 * carries it. It is written before the set's transaction, the value it
 * replaces put back when the set is not accepted; a removal deletes it once
 * it commits, and a start deletes any entry an endpoint with a pasted
 * secret no longer holds. A key-manager reference is resolved afresh for
 * each attempt, held for scrubbing until that attempt ends (#536).
 *
 * The URL is `https`, or `http` only to a host the clear text never leaves
 * the machine or the private network for: loopback (`localhost` among it),
 * a private or tailnet address, or a `.ts.net` name. It carries no
 * userinfo, and its host is checked against the denylist's hosts.
 */

/** Where the vault keeps an endpoint's pasted secret: `endpoint:<name>`. */
const VAULT_PREFIX = "endpoint:";
const secretEntry = (name: string): string => `${VAULT_PREFIX}${name}`;

/** The address classes plain `http` may reach: loopback, the private ranges, and Tailscale's (its IPv4 range is CGNAT's, its IPv6 one unique-local). */
const CLEAR_TEXT_CLASSES: ReadonlySet<AddressClass> = new Set(["loopback", "private", "cgnat", "unique-local"]);

/** The suffix of a name on a tailnet, which MagicDNS answers with a tailnet address. */
const TAILNET_SUFFIX = ".ts.net";

/** What the URL parser drops before it reads: the C0 controls and spaces at either end, and every tab and line break. */
// eslint-disable-next-line no-control-regex -- the C0 controls the parser trims are what is being removed.
const PARSER_DROPS = /^[\u0000-\u0020]+|[\u0000-\u0020]+$|[\t\n\r]/g;

/**
 * Userinfo in a URL's authority, empty included (`https://@host`), read as
 * the URL parser reads an http or https URL: any run of slashes and
 * backslashes after the colon (`https:////user@host`, `https://\user@host`),
 * then the authority up to a slash, backslash, `?` or `#`.
 */
const USERINFO = /^https?:[/\\]*[^/\\?#]*@/i;

/** Why `url` cannot be an endpoint's; null when it can. */
const urlProblem = (url: string): string | null => {
  const parsed = new URL(url);
  if (parsed.username !== "" || parsed.password !== "" || USERINFO.test(url.replace(PARSER_DROPS, ""))) {
    return "An endpoint's URL carries no user name or password: the endpoint's secret signs each POST.";
  }
  if (parsed.protocol === "https:") return null;
  const host = hostOf(url) ?? url;
  const addressClass = addressClassOf(host);
  if ((addressClass !== null && CLEAR_TEXT_CLASSES.has(addressClass)) || host.endsWith(TAILNET_SUFFIX)) return null;
  return `${host} is reached over the internet, which a result sent in the clear must never cross: use https, or http only to loopback, localhost, a private or tailnet address or a .ts.net name.`;
};

const invalid = (path: readonly string[], message: string, data: Record<string, string> = {}): ContractError => {
  const error = invalidParams([{ code: "custom", path: [...path], message }], message);
  return new ContractError({ ...error, data: { ...error.data, ...data } });
};

/** The pasted secret a set carries; undefined for none. Throws for a whsec_ secret that gives no key; a reference is read per attempt. */
const pastedSecret = (secret: ParamsOf<"routines.endpoints.set">["secret"]): string | undefined => {
  if (secret === undefined) return undefined;
  if (secret.kind === "reference") return undefined;
  if (webhookKey(secret.secret) === null) {
    throw invalid(["secret", "secret"], `A ${WEBHOOK_SECRET_PREFIX} secret is the prefix and its key in padded standard base64, which this secret is not.`);
  }
  return secret.secret;
};

const endpointNotFound = (name: string) => ({ code: "not_found" as const, message: `No webhook endpoint ${name} is on this environment.`, data: { kind: "endpoint", name } });

export interface RoutineEndpointsOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment's stream, where the endpoints' notices go. */
  readonly stream: StreamRef;
  readonly environmentId: string;
  /** The environment's name as it is now, which a test's payload carries. */
  readonly name: () => string;
  /** Where pasted secrets are kept: the vault the environment holds, which registers each for scrubbing. */
  readonly vault: Vault;
  /** Reads a reference afresh for each delivery or test; owns its scrub registration until released. */
  readonly keyManagers: KeyManagerRegistry;
  /** Whether the host `url` reaches is on the denylist's hosts, as the denylist is now. */
  readonly denylisted: (url: string) => boolean;
  /** What error text passes before a client reads it. */
  readonly scrub: Pick<ScrubRegistry, "scrubOutput">;
  /** How long a test's POST may take; preset ten seconds. */
  readonly timeoutMs?: number;
  /** The current label of a reference's connection, or null when it is absent. */
  readonly connectionLabel: (id: string) => string | null;
}

type EndpointMethodName = "routines.endpoints.set" | "routines.endpoints.remove" | "routines.endpoints.list" | "routines.endpoints.test";

export interface RoutineEndpoints {
  /** Deletes the vault entries no endpoint with a pasted secret holds: a removal's delete that never ran. Never rejects. */
  start(): Promise<void>;
  /** Resolves the endpoint and its secret per delivery; the caller releases a resolved reference when its attempt ends. */
  resolve(name: string): Promise<DeliveryEndpoint>;
  /** Removes an unused endpoint in the route removal's transaction, checking every client's targets and disabled routines too. */
  removeUnused(name: string, removingRoute: string, context: CommandContext): NonNullable<ResultOf<"attention.routes.remove">["endpoint"]>;
  readonly handlers: Required<Pick<MethodHandlers, EndpointMethodName>>;
  readonly moveSource: MoveSource;
  referenceHolders(connectionId: string): KeyManagerReferenceHolder[];
}

export const createRoutineEndpoints = (options: RoutineEndpointsOptions): RoutineEndpoints => {
  const { log, clock, stream, vault } = options;
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  /** Each endpoint's latest test, with the set it tested: it counts while the endpoint is as that set made it. */
  const tests = new Map<string, { readonly setSequence: number; readonly result: EndpointResult }>();

  /** The endpoint as listed: its last result the later of its latest delivery attempt and its latest test. */
  const listed = (endpoint: StoredEndpoint): WebhookEndpoint => {
    const tested = tests.get(endpoint.name);
    const test = tested?.setSequence === endpoint.setSequence ? tested.result : null;
    const lastResult = test !== null && (endpoint.delivered === null || test.at >= endpoint.delivered.at) ? test : endpoint.delivered;
    return { name: endpoint.name, url: endpoint.url, secretKind: endpoint.secretKind, lastResult,
      ...(endpoint.reference !== null && { reference: displayReference(endpoint.reference, options.connectionLabel(endpoint.reference.connectionId)) }),
    };
  };

  /** Deletes an endpoint's vault entry once its removal committed; one left behind is deleted by the next start. */
  const forget = (name: string): void => {
    tests.delete(name);
    vault.delete(secretEntry(name)).catch((error: unknown) => console.error(`Deleting the vault entry of the webhook endpoint ${name} failed; the next start deletes it:`, error));
  };

  /** The `routine.test` payload: the environment, a summary and a text, and no routine or entry. */
  const testPayload = (name: string): WebhookPayload => {
    const environment = options.name();
    return {
      type: "routine.test",
      version: ROUTINE_WEBHOOK_VERSION,
      environment: { id: options.environmentId, name: environment },
      routine: null,
      entry: null,
      summary: `A test of the webhook endpoint ${name}.`,
      text: `${environment} sent this test to its webhook endpoint ${name}. A routine there that delivers to ${name} posts its results here.`,
    };
  };

  const resolve = async (name: string, purpose: string): Promise<DeliveryEndpoint> => {
    const endpoint = storedEndpoint(reader, name);
    if (endpoint === null) return { error: `No webhook endpoint ${name} is on this environment.`, retryable: false };
    if (endpoint.secretKind === "reference" && endpoint.reference !== null) {
      const answer = await options.keyManagers.resolve({ reference: endpoint.reference, owner: `endpoint:${name}`, purpose });
      if (answer.outcome === "unavailable") return { error: answer.code, retryable: true };
      return { url: endpoint.url, secret: answer.value, release: answer.release };
    }
    const secret = endpoint.secretKind === "pasted" ? await vault.get(secretEntry(name)) : undefined;
    if (secret === undefined) return { error: `The webhook endpoint ${name} has no secret: set one with routines.endpoints.set, then test it.`, retryable: false };
    return { url: endpoint.url, secret };
  };

  const set: PreparedCommand<"routines.endpoints.set"> = {
    prepare: async (params, context) => {
      const problem = urlProblem(params.url);
      if (problem !== null) throw invalid(["url"], problem);
      const secret = pastedSecret(params.secret);
      if (options.denylisted(params.url)) {
        const host = hostOf(params.url) ?? params.url;
        const rejected: CommandRejection<"denylisted"> = { code: "denylisted", message: `${host} is on the denylist's hosts.`, data: { host } };
        return () => ({ aggregate: stream, rejected });
      }
      if (secret !== undefined) {
        const entry = secretEntry(params.name);
        const replaced = await vault.get(entry);
        context.onUndo(() => (replaced === undefined ? vault.delete(entry) : vault.set(entry, replaced)));
        await vault.set(entry, secret);
      }
      return (_params, command) => {
        const previous = storedEndpoint(reader, params.name);
        const secretKind = params.secret?.kind ?? previous?.secretKind ?? "missing";
        const reference = params.secret?.kind === "reference" ? params.secret.reference : params.secret === undefined ? previous?.reference : null;
        if (previous?.secretKind === "pasted" && secretKind === "reference") command.tx.afterCommit(() => forget(params.name));
        const payload: RoutineEndpointSetPayload = { name: params.name, url: params.url, secretKind, ...(reference != null && { reference }) };
        const endpoint: WebhookEndpoint = { name: params.name, url: params.url, secretKind, lastResult: null,
          ...(reference != null && { reference: displayReference(reference, options.connectionLabel(reference.connectionId)) }),
        };
        return { aggregate: stream, result: { endpoint }, events: [{ type: "routine.endpoint-set", payload: { ...payload } }] };
      };
    },
  };

  return {
    async start() {
      const held = new Set(listStoredEndpoints(reader).flatMap((endpoint) => (endpoint.secretKind === "pasted" ? [secretEntry(endpoint.name)] : [])));
      try {
        for (const key of await vault.keys()) if (key.startsWith(VAULT_PREFIX) && !held.has(key)) await vault.delete(key);
      } catch (error) {
        console.error("Deleting the vault entries of webhook endpoints that are gone failed; the next start tries again:", error);
      }
    },

    removeUnused(name, removingRoute, context) {
      const endpoint = storedEndpoint(reader, name);
      if (endpoint === null) return { name, state: "missing" };
      const routineUses = listStoredRoutines(reader).some(({ definition }) => definition.delivery.some(target => target.kind === "webhook" && target.target === name));
      const routeUses = attentionStore(log).targets().some(({ target }) => target.id !== removingRoute && target.transport === "webhook" && target.configuration["endpoint"] === name);
      if (routineUses || routeUses) return { name, state: "retained" };
      log.append(stream, [{ type: "routine.endpoint-removed", payload: { name } }], { tx: context.tx, actor: context.actor, commandId: context.commandId });
      context.tx.afterCommit(() => forget(name));
      return { name, state: "removed", secretKind: endpoint.secretKind };
    },

    resolve: (name) => resolve(name, "delivery"),
    moveSource: createEndpointMoveSource({ log, reader, vault, set }),
    referenceHolders: (connectionId) => listStoredEndpoints(reader)
      .filter((endpoint) => endpoint.secretKind === "reference" && endpoint.reference?.connectionId.toLowerCase() === connectionId.toLowerCase())
      .map((endpoint) => ({ kind: "endpoint", id: endpoint.name, name: endpoint.name })),

    handlers: {
      "routines.endpoints.list": () => ({ endpoints: listStoredEndpoints(reader).map(listed) }),

      /**
       * Checks the URL and the secret, then writes a pasted secret to the
       * vault before the transaction, putting back what it replaces unless
       * the set is accepted. Inside it, records the endpoint with where its
       * secret is: pasted when one came, else the kind it held, else missing.
       */
      "routines.endpoints.set": set,

      "routines.endpoints.remove": (params, context) => {
        if (storedEndpoint(reader, params.name) === null) return { aggregate: stream, rejected: endpointNotFound(params.name) };
        context.tx.afterCommit(() => forget(params.name));
        return { aggregate: stream, result: { name: params.name }, events: [{ type: "routine.endpoint-removed", payload: { name: params.name } }] };
      },

      /** POSTs the endpoint's `routine.test` payload, signed, and keeps what it came to as the endpoint's latest test; a missing secret posts nothing. */
      "routines.endpoints.test": async (params) => {
        const endpoint = storedEndpoint(reader, params.name);
        if (endpoint === null) throw new ContractError(endpointNotFound(params.name));
        const resolved = await resolve(endpoint.name, "test");
        if ("error" in resolved) return { status: null, durationMs: 0, error: resolved.error };
        try {
          const posted = await postWebhook({
            ...resolved,
            id: `test-${randomUUID()}`,
            body: JSON.stringify(testPayload(endpoint.name)),
            clock,
            ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
          });
          const error = posted.error === null ? null : options.scrub.scrubOutput(posted.error);
          tests.set(endpoint.name, {
            setSequence: endpoint.setSequence,
            result: { at: clock.now().toISOString(), result: error === null ? "delivered" : "failed", status: posted.status, error },
          });
          return { ...posted, error };
        } finally {
          resolved.release?.();
        }
      },
    },
  };
};
