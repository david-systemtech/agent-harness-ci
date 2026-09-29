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
 * One injection answer is asked for each holder (ADR 0011's setting,
 * #91's; until then the seam's preset, `allow`, ADR 0028), and on `deny`
 * no supplier is asked anything. A seam that throws denies, logged. The key
 * is empty while no supplier is registered, and on `allow` while every
 * supplier's part is empty, as the key managers' is with no injecting
 * connection (#368). Otherwise it names the answer and, on `allow`, each
 * supplier's part that is not empty, in the order they were registered, so
 * a changed answer or a changed part is a changed key.
 *
 * A supplier's variables are asked at each spawn, every supplier at once;
 * where two name one variable, the one registered later wins. A supplier
 * that fails is logged and left out, of the key when its key fails and of
 * the variables when its supply does: nothing is supplied in its place.
 * The release calls each supplier's release once, a failure logged.
 */

/** What a holder is (#368): a run's provider process or a session's terminal; the key managers' run tokens name it in their metadata. */
export type HolderKind = "provider-process" | "terminal";

/** Who a holder serves: its session, the account its runs go through (null when neither the session nor the environment names one), who started it (a client, for a terminal), and what it is. */
export interface ProcessEnvironmentScope {
  readonly sessionId: string;
  readonly accountId: string | null;
  readonly origin: RunActorKind;
  readonly holder: HolderKind;
}

/** Whether a holder's suppliers are asked for its variables (ADR 0011). */
export type InjectionAnswer = "allow" | "deny";

/**
 * Answers a holder's injection (ADR 0011, ADR 0028): #91's setting, the
 * environment's `credentials.injection`, outranked by the account's and
 * then a routine's or a bot's. Preset: `allow`, the setting's preset.
 */
export type InjectionSeam = (scope: ProcessEnvironmentScope) => InjectionAnswer;

export const presetInjection: InjectionSeam = () => "allow";

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

/** git's process-only configuration: how many entries, then a key and a value each. */
const GIT_CONFIG_COUNT = "GIT_CONFIG_COUNT";
const GIT_CONFIG_ENTRY = /^GIT_CONFIG_(KEY|VALUE)_(\d+)$/;

/** The entries `GIT_CONFIG_COUNT` announces in `env`: 0 for none, or a count that is no whole number. */
const gitConfigCount = (env: Readonly<Record<string, string | undefined>>): number => {
  const count = env[GIT_CONFIG_COUNT];
  return count !== undefined && /^\d+$/.test(count) ? Number(count) : 0;
};

/**
 * `supplied` as a holder layers it over what it inherits (#315): the
 * process-only git configuration a supplier gives (`GIT_CONFIG_COUNT`, its
 * `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`) numbered after the
 * entries `inherited` holds, which it keeps, the count covering both, so a
 * supplier's entries come after the machine's, as git reads them in order.
 * Every other variable is as supplied; with nothing inherited, or no
 * configuration supplied, `supplied` is answered as it is.
 */
export const afterInheritedGitConfig = (
  inherited: Readonly<Record<string, string | undefined>>,
  supplied: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const offset = gitConfigCount(inherited);
  if (offset === 0 || supplied[GIT_CONFIG_COUNT] === undefined) return supplied;
  const count = gitConfigCount(supplied);
  const layered: Record<string, string> = {};
  for (const [name, value] of Object.entries(supplied)) {
    const entry = GIT_CONFIG_ENTRY.exec(name);
    if (name === GIT_CONFIG_COUNT) layered[name] = String(offset + count);
    else if (entry === null) layered[name] = value;
    else if (Number(entry[2]) < count) layered[`GIT_CONFIG_${entry[1]}_${offset + Number(entry[2])}`] = value;
  }
  return layered;
};

/** Nothing to supply, and nothing to release. */
const NOTHING: SuppliedVariables = { variables: {}, release: () => undefined };

/** A holder's process environment while no supplier is registered: an empty key, and nothing supplied. */
export const EMPTY_PROCESS_ENVIRONMENT: ProcessEnvironment = { key: "", supply: async () => NOTHING };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Asks each supplier for `scope` at once, and answers what they supplied, their release one. */
const supplyAll = async (suppliers: readonly ProcessEnvironmentSupplier[], scope: ProcessEnvironmentScope): Promise<SuppliedVariables> => {
  const answers = await Promise.all(
    suppliers.map(async (supplier) => {
      try {
        return { name: supplier.name, supplied: await supplier.supply(scope) };
      } catch (error) {
        console.error(`The process-environment supplier ${supplier.name} failed for session ${scope.sessionId}; its variables are left out: ${describe(error)}`);
        return null;
      }
    }),
  );
  const given = answers.filter((answer) => answer !== null);
  // In the order they registered, so the later's value wins a name both give.
  const variables: Record<string, string> = {};
  for (const { supplied } of given) Object.assign(variables, supplied.variables);
  let released = false;
  return {
    variables,
    release: () => {
      if (released) return;
      released = true;
      for (const { name, supplied } of given) {
        try {
          supplied.release();
        } catch (error) {
          console.error(`Releasing what the process-environment supplier ${name} supplied for session ${scope.sessionId} failed:`, error);
        }
      }
    },
  };
};

/** The holder's injection answer: the seam's, or `deny` when the seam fails. */
const answerOf = (injection: InjectionSeam, scope: ProcessEnvironmentScope): InjectionAnswer => {
  try {
    return injection(scope) === "allow" ? "allow" : "deny";
  } catch (error) {
    console.error(`The injection answer for session ${scope.sessionId} could not be read; nothing is injected: ${describe(error)}`);
    return "deny";
  }
};

export const createProcessEnvironments = (injection: InjectionSeam = presetInjection): ProcessEnvironments => {
  const suppliers: ProcessEnvironmentSupplier[] = [];
  return {
    register(supplier) {
      if (suppliers.some((registered) => registered.name === supplier.name)) throw new Error(`A process-environment supplier named ${supplier.name} is registered already.`);
      suppliers.push(supplier);
    },
    of(scope) {
      const answer = answerOf(injection, scope);
      if (suppliers.length === 0) return EMPTY_PROCESS_ENVIRONMENT;
      if (answer === "deny") return { key: JSON.stringify({ injection: answer }), supply: async () => NOTHING };
      const parts = suppliers.flatMap((supplier) => {
        try {
          return [{ supplier, key: supplier.key(scope) }];
        } catch (error) {
          console.error(`The process-environment supplier ${supplier.name} could not give its key for session ${scope.sessionId}; it is left out: ${describe(error)}`);
          return [];
        }
      });
      const asked = parts.map((part) => part.supplier);
      const named = parts.filter((part) => part.key !== "");
      return {
        key: named.length === 0 ? "" : JSON.stringify({ injection: answer, suppliers: named.map((part) => [part.supplier.name, part.key]) }),
        supply: () => supplyAll(asked, scope),
      };
    },
  };
};
