import { ContractError, displayReference, invalidParams, type KeyManagerProvider, type ParamsOf, type ResultOf } from "@agent-harness/contracts";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { HeldLogin, KeyManagerConnections, ReadableConnection } from "./connections.js";
import { KEY_MANAGER_BUDGET_MS, PROVIDER_NAMES, type ListAnswer, type ProviderFailure, type ReadAnswer } from "./provider.js";
import type { KeyManagerRegistry, ReferenceRefusal, ReferenceResolution } from "./registry.js";

/**
 * The key-manager registry's references (key-managers spec, "References and
 * resolution"; ADR 0011, ADR 0020, ADR 0028): the resolve the harness's own
 * services read their credentials through, and the check and the browse a
 * reference picker asks.
 *
 * - **A reference is read with its connection's login**, never a run token,
 *   within the budget (ADR 0031's ten seconds), and only while the
 *   connection is `signed-in`. The value is registered with the scrub
 *   registry for its owner and answered with its release; nothing is kept,
 *   so every resolve reads again and a read that fails answers no value.
 * - **The refusals** are the ones a resolve's callers answer on the wire:
 *   a connection not held, not signed in or that could not be asked now is
 *   `credential_source_unavailable`; nothing at the locator is
 *   `reference_not_found`; a read the key manager refuses is
 *   `reference_denied`, whose line says to check the mount first, since
 *   OpenBao refuses a path the login may not read, a path that is not there
 *   and a mount that is not there alike. Every line a key manager's text
 *   becomes passes the scrub registry first.
 * - **The check** resolves and lets go at once, answering the display form
 *   and the refusal, never the value; **the browse** lists names, never
 *   values, refused as a resolve is, except that a connection it names and
 *   the environment does not hold is `not_found`, as every connection method
 *   answers one. A connection's id is found whatever its case.
 */

export interface KeyManagerReferences extends KeyManagerRegistry {
  /** `keyManagers.references.check`: whether `reference` resolves now, and why not. */
  check(params: ParamsOf<"keyManagers.references.check">): Promise<ResultOf<"keyManagers.references.check">>;
  /** `keyManagers.references.browse`: the names under a path; refused as a resolve is. */
  browse(params: ParamsOf<"keyManagers.references.browse">): Promise<ResultOf<"keyManagers.references.browse">>;
}

export interface KeyManagerReferencesOptions {
  readonly connections: KeyManagerConnections;
  readonly scrub: ScrubRegistry;
  /** How long one read or list may take, on the wall clock; preset `KEY_MANAGER_BUDGET_MS`. */
  readonly budgetMs?: number;
}

/** What OpenBao's refusals leave open, which a denied read's line says. */
const CHECK_THE_MOUNT =
  "OpenBao refuses a path the login may not read, a path that is not there and a mount that is not there alike: check the mount first, then the path and the login's policies.";

/** A refusal: the code a caller answers, and its line. */
interface Refused {
  readonly outcome: "unavailable";
  readonly code: ReferenceRefusal;
  readonly message: string;
}

const refused = (code: ReferenceRefusal, message: string): Refused => ({ outcome: "unavailable", code, message });

/** A signed-in connection's login, ready to read with, and how its key manager is named (`OpenBao at <address>`). */
interface Ready {
  readonly outcome: "ready";
  readonly login: HeldLogin;
  readonly named: string;
}

export const createKeyManagerReferences = ({ connections, scrub, budgetMs = KEY_MANAGER_BUDGET_MS }: KeyManagerReferencesOptions): KeyManagerReferences => {
  /** The refusal of a reference whose connection this environment does not hold. */
  const notHeld = (connectionId: string): Refused =>
    refused("credential_source_unavailable", `No key-manager connection ${connectionId} is on this environment: connect the key manager in Set up, Key manager, or name another connection.`);

  /** The login a connection is read with, or why it cannot be: not signed in, or another provider's than the reference. */
  const loginOf = ({ record, login }: ReadableConnection, provider: KeyManagerProvider): Ready | Refused => {
    if (provider !== record.provider) {
      return refused("credential_source_unavailable", `The reference is ${PROVIDER_NAMES[provider]}'s, and the key-manager connection ${record.label} is ${PROVIDER_NAMES[record.provider]}.`);
    }
    if (record.status.kind !== "signed-in" || login === null) {
      return refused("credential_source_unavailable", `The key-manager connection ${record.label} is not signed in (${record.status.message}), so its references cannot be read.`);
    }
    return { outcome: "ready", login, named: `${PROVIDER_NAMES[record.provider]} at ${record.address}` };
  };

  /** The refusal a provider's failure comes to: nothing there, a read refused, or a key manager that could not be asked. */
  const refusalOf = (failure: ProviderFailure, provider: KeyManagerProvider): Refused => {
    const message = scrub.scrubOutput(failure.message);
    if (failure.outcome === "not-found") return refused("reference_not_found", message);
    if (failure.outcome === "denied") return refused("reference_denied", provider === "openbao" ? `${message} ${CHECK_THE_MOUNT}` : message);
    return refused("credential_source_unavailable", message);
  };

  /** Settles as `work` does, or as the key manager not having answered once the budget has passed, when the work's signal is aborted too. */
  const withinBudget = async <A extends ReadAnswer | ListAnswer>(named: string, asked: string, work: (signal: AbortSignal) => Promise<A>): Promise<A | Refused> => {
    const controller = new AbortController();
    const overrun = new Promise<Refused>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(refused("credential_source_unavailable", `${named} did not answer the ${asked} within ${budgetMs / 1000} s.`)));
    });
    // On the wall clock, never the environment's, which a test may hold still.
    const timer = setTimeout(() => controller.abort(), budgetMs);
    timer.unref();
    try {
      return await Promise.race([work(controller.signal), overrun]);
    } finally {
      clearTimeout(timer);
    }
  };

  const resolve: KeyManagerRegistry["resolve"] = async ({ reference, owner, purpose }): Promise<ReferenceResolution> => {
    try {
      const held = connections.readable(reference.connectionId);
      const ready = held === null ? notHeld(reference.connectionId) : loginOf(held, reference.provider);
      if (ready.outcome === "unavailable") return ready;
      const { login, named } = ready;
      const answer = await withinBudget(named, "read", (signal) => login.provider.read(login.target, login.token, reference, signal));
      if (answer.outcome === "unavailable") return answer;
      if (answer.outcome !== "read") return refusalOf(answer, reference.provider);
      return { outcome: "resolved", value: answer.value, release: scrub.register(answer.value, { owner }) };
    } catch (error) {
      console.error(`Reading a key-manager reference for ${owner} (${purpose}) failed inside the environment:`, error);
      return refused("credential_source_unavailable", "Reading the reference failed inside the environment; try again.");
    }
  };

  return {
    resolve,

    async check({ reference }) {
      const display = displayReference(reference, connections.readable(reference.connectionId)?.record.label ?? null);
      const answer = await resolve({ reference, owner: `key-manager:${reference.connectionId}:check`, purpose: "check" });
      if (answer.outcome === "resolved") {
        answer.release();
        return { display, problem: null };
      }
      return { display, problem: { code: answer.code, message: answer.message, data: { connectionId: reference.connectionId } } };
    },

    async browse({ connectionId, mount, path }) {
      const id = connectionId.toLowerCase();
      const held = connections.readable(id);
      if (path !== undefined && mount === undefined && held?.record.provider !== "doppler") {
        const message = "A path is listed under a mount: name the mount too.";
        throw new ContractError(invalidParams([{ code: "custom", path: ["path"], message }], message));
      }
      if (held === null) {
        throw new ContractError({ code: "not_found", message: `No key-manager connection ${id} is on this environment.`, data: { kind: "key_manager_connection", connectionId: id } });
      }
      const ready = loginOf(held, held.record.provider);
      const location = { mount: mount ?? null, path: path ?? null };
      const answer = ready.outcome === "unavailable" ? ready : await withinBudget(ready.named, "list", (signal) => ready.login.provider.list(ready.login.target, ready.login.token, location, signal));
      if (answer.outcome === "listed") return { names: [...answer.names] };
      const problem = answer.outcome === "unavailable" ? answer : refusalOf(answer, held.record.provider);
      throw new ContractError({ code: problem.code, message: problem.message, data: { connectionId: id } });
    },
  };
};
