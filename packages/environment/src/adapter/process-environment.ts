import type { InjectionAnswer, RunActorKind } from "@agent-harness/contracts";
import type { PolicyActor } from "../permissions/resolver.js";
import type { ProcessEnvironment, SuppliedVariables } from "./contract.js";

export type { InjectionAnswer };

/**
 * The process environment's registry (forge spec, "Runs: the injection";
 * key-managers spec, "The key" and "Injection"; ADR 0011, ADR 0020, ADR
 * 0028; #307): the suppliers harness services register (the forge's
 * variables and credential helper, #315; the key managers' block and run
 * tokens, #91), none by default, from which each holder's process
 * environment is built the same way, whatever started it. A holder is a
 * run's provider process or a session's terminal.
 *
 * One injection answer is asked for each holder, with the level that
 * decided it (ADR 0011, ADR 0028; #367): the holder's own override (a
 * routine's, later a bot's), else its account's entry, else the
 * environment's value, the most specific present (`decideInjection`; the
 * environment's seam reads `credentials.injection` and
 * `credentials.injectionByAccount`). On `deny` no supplier is asked
 * anything. A seam that throws denies, logged. The key is empty while no
 * supplier is registered. Otherwise it names the answer, its level and, on
 * `allow`, each supplier's part, in the order they were registered, so a
 * changed answer, level or part is a changed key.
 *
 * A supplier's variables are asked at each spawn, every supplier at once;
 * where two name one variable, the one registered later wins. A supplier
 * that fails is logged and left out, of the key when its key fails and of
 * the variables when its supply does: nothing is supplied in its place.
 * The release calls each supplier's release once, a failure logged.
 */

/**
 * The level that decided a holder's injection answer (#367): the
 * environment's `credentials.injection`, an account's entry in
 * `credentials.injectionByAccount`, or the run's own override, a routine's
 * (later a bot's), each by its id.
 */
export type InjectionLevel = { readonly kind: "environment" } | { readonly kind: "account"; readonly id: string } | RunInjectionLevel;

/** The level of a run's own override: its routine or bot, by id. */
export interface RunInjectionLevel {
  readonly kind: "routine" | "bot";
  readonly id: string;
}

/** A holder's injection answer, and the level that decided it. */
export interface InjectionDecision<Level extends InjectionLevel = InjectionLevel> {
  readonly answer: InjectionAnswer;
  readonly level: Level;
}

/** A run's own override, which outranks every setting: its routine's or bot's `allow` or `deny`. */
export type RunInjectionOverride = InjectionDecision<RunInjectionLevel>;

/** A run's own override from who started it (#367): a routine's or bot's injection, its level the routine or bot; null for anyone else, or one that inherits. */
export const runOverrideOf = (actor: PolicyActor): RunInjectionOverride | null =>
  (actor.kind === "routine" || actor.kind === "bot") && actor.injection !== undefined
    ? { answer: actor.injection.answer, level: { kind: actor.kind, id: actor.injection.id } }
    : null;

/** Who a holder serves: its session, the account its runs go through (null when neither the session nor the environment names one), and who started it (a client, for a terminal). */
export interface ProcessEnvironmentScope {
  readonly sessionId: string;
  readonly accountId: string | null;
  readonly origin: RunActorKind;
  /** The run's own injection override (a routine's `allow` or `deny`, #92's firing); null for none, as for a client's run, a completions request's and a terminal. */
  readonly override: RunInjectionOverride | null;
}

/** The injection setting as the answer reads it: the environment's value and each account's entry. */
export interface InjectionSetting {
  readonly environment: InjectionAnswer;
  readonly byAccount: Readonly<Record<string, InjectionAnswer>>;
}

/** The environment's level: its value decided. */
const ENVIRONMENT_LEVEL: InjectionLevel = { kind: "environment" };

/**
 * A holder's answer (ADR 0011, ADR 0028; key-managers spec, "Injection"):
 * the most specific present. Its own override first, then its account's
 * entry, then the environment's value.
 */
export const decideInjection = (scope: ProcessEnvironmentScope, setting: InjectionSetting): InjectionDecision => {
  if (scope.override !== null) return scope.override;
  const { accountId } = scope;
  if (accountId !== null && Object.hasOwn(setting.byAccount, accountId)) {
    return { answer: setting.byAccount[accountId] as InjectionAnswer, level: { kind: "account", id: accountId } };
  }
  return { answer: setting.environment, level: ENVIRONMENT_LEVEL };
};

/** Answers a holder's injection, with the level that decided it (ADR 0011, ADR 0028; #367). */
export type InjectionSeam = (scope: ProcessEnvironmentScope) => InjectionDecision;

/** The setting at its presets: `allow`, and no account's entry, so a holder's own override or `allow` at the environment's level. */
export const presetInjection: InjectionSeam = (scope) => decideInjection(scope, { environment: "allow", byAccount: {} });

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

/** The holder's injection answer and its level: the seam's, or `deny` at the environment's level when the seam fails. */
const decisionOf = (injection: InjectionSeam, scope: ProcessEnvironmentScope): InjectionDecision => {
  try {
    const { answer, level } = injection(scope);
    return { answer: answer === "allow" ? "allow" : "deny", level };
  } catch (error) {
    console.error(`The injection answer for session ${scope.sessionId} could not be read; nothing is injected: ${describe(error)}`);
    return { answer: "deny", level: ENVIRONMENT_LEVEL };
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
      const { answer, level } = decisionOf(injection, scope);
      if (suppliers.length === 0) return EMPTY_PROCESS_ENVIRONMENT;
      if (answer === "deny") return { key: JSON.stringify({ injection: answer, level }), supply: async () => NOTHING };
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
        key: JSON.stringify({ injection: answer, level, suppliers: parts.map((part) => [part.supplier.name, part.key]) }),
        supply: () => supplyAll(asked, scope),
      };
    },
  };
};
