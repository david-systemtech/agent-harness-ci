import type { RunActorKind } from "@agent-harness/contracts";
import type { ProcessEnvironment, SuppliedVariables } from "./contract.js";

/**
 * The process environment's registry (forge spec, "Runs: the injection";
 * key-managers spec, "The key" and "Injection"; ADR 0011, ADR 0020, ADR
 * 0028; #307): the suppliers harness services register (the forge's
 * variables and credential helper, #315; the key managers' block and run
 * tokens, #91), none by default, from which each holder's process
 * environment is built the same way, whatever started it. A holder is a
 * run's provider process or a session's terminal.
 *
 * The key is empty while no supplier is registered. Otherwise it names
 * each supplier's part, in the order they were registered, so a part that
 * changes is a key that changes. A supplier's variables are asked at each
 * spawn, all of them at once; where two name one variable, the one
 * registered later wins. A supplier that fails is logged and left out, of
 * the key when its key fails and of the variables when its supply does:
 * nothing is supplied in its place. The release calls each supplier's
 * release once, a failure logged.
 */

/** Who a holder serves: its session, the account its runs go through (null when neither the session nor the environment names one), and who started it (a client, for a terminal). */
export interface ProcessEnvironmentScope {
  readonly sessionId: string;
  readonly accountId: string | null;
  readonly origin: RunActorKind;
}

/**
 * One harness service's part of every holder's process environment: its
 * name, its part of the key, read as the holder's environment is built and
 * never a secret, and, at each spawn, the variables and their release.
 */
export interface ProcessEnvironmentSupplier {
  readonly name: string;
  key(scope: ProcessEnvironmentScope): string;
  supply(scope: ProcessEnvironmentScope): SuppliedVariables | Promise<SuppliedVariables>;
}

export interface ProcessEnvironments {
  /** Adds a supplier, asked from the next holder built on; a name registered already is refused. */
  register(supplier: ProcessEnvironmentSupplier): void;
  /** The process environment of one holder, built now. */
  of(scope: ProcessEnvironmentScope): ProcessEnvironment;
}

/** Nothing to supply, and nothing to release. */
const NOTHING: SuppliedVariables = { variables: {}, release: () => undefined };

/** A holder's process environment while no supplier is registered: an empty key, and nothing supplied. */
export const EMPTY_PROCESS_ENVIRONMENT: ProcessEnvironment = { key: "", supply: async () => NOTHING };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Asks each supplier for `scope` at once, and answers what they supplied, their release one. */
const supplyAll = async (suppliers: readonly ProcessEnvironmentSupplier[], scope: ProcessEnvironmentScope): Promise<SuppliedVariables> => {
  const outcomes = await Promise.allSettled(suppliers.map(async (supplier) => supplier.supply(scope)));
  const variables: Record<string, string> = {};
  const releases: { readonly name: string; readonly release: () => void }[] = [];
  outcomes.forEach((outcome, index) => {
    const name = suppliers[index]?.name;
    if (outcome.status === "rejected") {
      console.error(`The process-environment supplier ${name} failed for session ${scope.sessionId}; its variables are left out: ${describe(outcome.reason)}`);
      return;
    }
    Object.assign(variables, outcome.value.variables);
    releases.push({ name: name ?? "", release: () => outcome.value.release() });
  });
  let released = false;
  return {
    variables,
    release: () => {
      if (released) return;
      released = true;
      for (const { name, release } of releases) {
        try {
          release();
        } catch (error) {
          console.error(`Releasing what the process-environment supplier ${name} supplied for session ${scope.sessionId} failed:`, error);
        }
      }
    },
  };
};

export const createProcessEnvironments = (): ProcessEnvironments => {
  const suppliers: ProcessEnvironmentSupplier[] = [];
  return {
    register(supplier) {
      if (suppliers.some((registered) => registered.name === supplier.name)) throw new Error(`A process-environment supplier named ${supplier.name} is registered already.`);
      suppliers.push(supplier);
    },
    of(scope) {
      if (suppliers.length === 0) return EMPTY_PROCESS_ENVIRONMENT;
      const parts = suppliers.flatMap((supplier) => {
        try {
          return [{ supplier, key: supplier.key(scope) }];
        } catch (error) {
          console.error(`The process-environment supplier ${supplier.name} could not give its key for session ${scope.sessionId}; it is left out: ${describe(error)}`);
          return [];
        }
      });
      const asked = parts.map((part) => part.supplier);
      return {
        key: JSON.stringify({ suppliers: parts.map((part) => [part.supplier.name, part.key]) }),
        supply: () => supplyAll(asked, scope),
      };
    },
  };
};
