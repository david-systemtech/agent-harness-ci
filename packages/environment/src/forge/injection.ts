import { ENVIRONMENT_ADDRESS_VARIABLE, RUN_SECRET_VARIABLE, formatHostPort, type ForgeAccountRecord } from "@agent-harness/contracts";
import type { SuppliedVariables } from "../adapter/contract.js";
import { holderName, type ProcessEnvironmentScope, type ProcessEnvironmentSupplier } from "../adapter/process-environment.js";
import type { Address } from "../serve/http.js";
import type { ForgeCredential } from "./forge-service.js";
import { credentialHelper, gitConfigVariables, helperChain, servedOrigins } from "./git-helper.js";
import type { RunSecrets } from "./run-secrets.js";

/**
 * The forge's part of every provider process and terminal (forge spec,
 * "Runs: the injection"; ADR 0020, ADR 0019; #315): the supplier the
 * ForgeService registers with the process environment (#307), so git in any
 * run, whatever started it, and in a session's terminal reaches the forges
 * over http with the forge accounts, never with the machine's helpers.
 *
 * - **The injected set** is every forge account without `identity-changed`
 *   or `needs-credential`, the same for every holder: the scope is not read.
 * - **Its key** names, for each injected forge account, its id, the origins
 *   it is served on, its slug, its kind, whether it is primary and its
 *   credential generation; never a secret. A change to any of them gives the
 *   next run a fresh process; a verification that changes none of them does
 *   not.
 * - **At each spawn** it mints the holder's run-scoped secret, naming the
 *   injected forge accounts, and reads each one's token for the holder's
 *   life, all at once, and answers: git's process-only configuration (for
 *   each origin an injected forge account is served on, an empty helper
 *   that resets the machine's chain for that origin, then the harness's
 *   helper named with its slug; ssh untouched), the environment's loopback
 *   address and the secret, and each forge account's variables
 *   (`FORGE_<SLUG>_URL`, `_TOKEN`, `_KIND`, the primary's also bare,
 *   `GH_TOKEN` for github.com). A token that cannot be read now is left
 *   out, and the rest still go.
 * - **The release** voids the secret, so the credential route refuses it
 *   from then on, and lets go of every token read for the holder.
 */

/** The name the forge's supplier registers under. */
export const FORGE_SUPPLIER = "forge";

/** What a token read for a holder is read for, as the key-manager registry is told. */
const PURPOSE = "a run's process or a terminal";

export interface ForgeInjectionOptions {
  /** The forge accounts the environment holds now, in the order they were added. */
  readonly accounts: () => readonly ForgeAccountRecord[];
  /** Whether a forge account is injected (`forge-store.ts`'s rule). */
  readonly injected: (account: ForgeAccountRecord) => boolean;
  /** How many credentials each forge account has been given, by id. */
  readonly generations: () => ReadonlyMap<string, number>;
  /** Reads a forge account's credential for one holder's life. */
  readonly readCredential: (account: ForgeAccountRecord, purpose: string) => Promise<ForgeCredential>;
  readonly secrets: RunSecrets;
  /** The command line that runs `agent-harness` before its verb, which git names as its helper. */
  readonly command: readonly string[];
  /** The environment's loopback address, where the helper asks; undefined until it listens. */
  readonly address: () => Address | undefined;
}

/** The token a holder was given for a forge account, and its release; null for one that could not be read. */
const readFor = async (read: ForgeInjectionOptions["readCredential"], account: ForgeAccountRecord, holder: string) => {
  try {
    const credential = await read(account, PURPOSE);
    if (credential.outcome === "resolved") return credential;
    console.error(`The token of the forge account ${account.slug} could not be read for ${holder}; its token variables are left out: ${credential.problem.message}`);
  } catch (error) {
    console.error(`Reading the token of the forge account ${account.slug} for ${holder} failed; its token variables are left out:`, error);
  }
  return null;
};

export const createForgeInjection = (options: ForgeInjectionOptions): ProcessEnvironmentSupplier => {
  const injectedNow = (): ForgeAccountRecord[] => options.accounts().filter(options.injected);

  return {
    name: FORGE_SUPPLIER,

    key() {
      const generations = options.generations();
      return JSON.stringify(
        injectedNow().map((account) => ({
          id: account.id,
          origins: servedOrigins(account),
          slug: account.slug,
          kind: account.kind,
          primary: account.primary,
          credential: generations.get(account.id) ?? 0,
        })),
      );
    },

    async supply(scope: ProcessEnvironmentScope): Promise<SuppliedVariables> {
      const accounts = injectedNow();
      if (accounts.length === 0) return { variables: {}, release: () => undefined };
      const address = options.address();
      if (address === undefined) throw new Error("The environment is not listening yet, so git's credential helper has nowhere to ask.");
      const holder = holderName(scope);
      const secret = options.secrets.mint(
        accounts.map((account) => account.id),
        holder,
      );
      const credentials = await Promise.all(accounts.map((account) => readFor(options.readCredential, account, holder)));
      const entries = accounts.flatMap((account) => helperChain(servedOrigins(account), credentialHelper(options.command, account.slug)));
      const variables: Record<string, string> = {
        ...gitConfigVariables(entries),
        [ENVIRONMENT_ADDRESS_VARIABLE]: formatHostPort(address.host, address.port),
        [RUN_SECRET_VARIABLE]: secret.value,
      };
      accounts.forEach((account, index) => {
        const token = credentials[index]?.token;
        for (const name of account.variables.url) variables[name] = account.origin;
        for (const name of account.variables.kind) variables[name] = account.kind;
        if (token !== undefined) for (const name of account.variables.token) variables[name] = token;
      });
      return {
        variables,
        release: () => {
          secret.release();
          for (const credential of credentials) credential?.release();
        },
      };
    },
  };
};
