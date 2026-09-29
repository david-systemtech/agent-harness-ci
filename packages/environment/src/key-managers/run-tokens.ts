import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KeyManagerConnectionRecord } from "@agent-harness/contracts";
import type { SuppliedVariables } from "../adapter/contract.js";
import type { ProcessEnvironmentScope, ProcessEnvironmentSupplier } from "../adapter/process-environment.js";
import type { ScrubRegistry, ScrubRelease } from "../scrub/registry.js";
import type { Clock, Timer } from "../serve/clock.js";
import { openBaoBlock } from "./openbao-block.js";
import type { ConnectionProvider, SignInTarget } from "./provider.js";

/**
 * The key managers' part of every provider process and terminal
 * (key-managers spec, "Run tokens" and "Injection"; ADR 0011, ADR 0015, ADR
 * 0028; #368): the supplier the key-manager registry registers with the
 * process environment (#307), which a holder (a provider process or a
 * terminal, and any holder the host starts through the same call) is given
 * the injecting connections' blocks through.
 *
 * - **What is injected**: each injecting OpenBao connection's block
 *   (`openbao-block.ts`), at most one per provider (the connections' rule);
 *   the other providers' blocks join with their tickets (#377 to #379).
 *   With none, nothing is supplied and the key is empty.
 * - **The key** names, per injected connection, its id, its credential
 *   generation and its status, never a token: a change gives the session's
 *   next run a fresh process, and a verification that changes none of them
 *   does not.
 * - **A run token** is minted for each holder as it starts: a renewable
 *   child of the connection's current login, with the ticked policies plus
 *   `default` (which its own renewal and revocation need), a time to live
 *   of one hour or the login's remaining life if shorter, the display name
 *   `agent-harness` and metadata naming the session and the holder kind;
 *   against the connection's token role when it has one. It is registered
 *   with the scrub registry for the holder's life, renewed every twenty
 *   minutes while the holder lives, and revoked when the holder stops (its
 *   release: the idle stop, a changed key, a rewind, drain, a terminal's
 *   close); the registration is let go once the revocation is answered.
 *   A connection's sign-out or removal revokes every run token minted from
 *   it at once, whatever its token role or login made of it.
 * - **No token** is minted for a connection that is not signed in, holds no
 *   login, or cannot mint (`canMint` false): the holder gets the address
 *   and CA with an empty token, never the login's own. A spawn waits up to
 *   five seconds, on the environment's clock, for a connection still
 *   signing in, then goes on as it stands. A mint that fails is logged,
 *   scrubbed, and the holder gets an empty token too.
 * - **The configuration** both CLIs are pointed at is an empty file under
 *   the data directory's key-manager CLI directory, written again at each
 *   spawn, which the denylist's data-directory preset exempts so a
 *   contained run's CLI can read it.
 */

/** The name the key managers' supplier registers under. */
export const KEY_MANAGER_SUPPLIER = "key-managers";

/** The longest a run token lives without a renewal: one hour (a chosen default, key-managers spec). */
export const RUN_TOKEN_TTL_SECONDS = 3600;

/** How often a held run token is renewed. */
export const RUN_TOKEN_RENEWAL_MS = 20 * 60_000;

/** How long a spawn waits for a connection still signing in. */
export const SIGN_IN_WAIT_MS = 5_000;

/** The display name every run token is minted with (OpenBao keeps it as `token-agent-harness`). */
export const RUN_TOKEN_DISPLAY_NAME = "agent-harness";

/** The data directory's key-manager CLI directory, which the denylist's data-directory preset exempts. */
export const KEY_MANAGER_CLI_DIRECTORY = "key-manager-cli";

/** The harness-owned empty configuration `BAO_CONFIG_PATH` and `VAULT_CONFIG_PATH` name, in the key-manager CLI directory. */
export const OPENBAO_CONFIG_FILE = "openbao.hcl";

/** A connection that injects, as the supplier reads it: its record as it stands, and its credential generation. */
export interface InjectingConnection {
  readonly record: KeyManagerConnectionRecord;
  readonly generation: number;
}

/** A login a run token is minted from: its token, and the provider and target it signed in through. */
export interface MintingLogin {
  readonly token: string;
  readonly provider: ConnectionProvider;
  readonly target: SignInTarget;
}

/** What the supplier reads of the connections. */
export interface RunTokenSource {
  /** The connections that inject now, in the order they were added. */
  injecting(): readonly InjectingConnection[];
  /** The connection's record as it stands and the login held for it; null for one no longer held. */
  readable(connectionId: string): { readonly record: KeyManagerConnectionRecord; readonly login: MintingLogin | null } | null;
  /** Settles once the connection's sign-in under way ends; undefined when none is. */
  signingIn(connectionId: string): Promise<void> | undefined;
}

export interface RunTokensOptions {
  readonly source: RunTokenSource;
  readonly clock: Clock;
  readonly scrub: ScrubRegistry;
  /** The data directory's key-manager CLI directory, where the harness-owned configuration is. */
  readonly cliDirectory: string;
  /** How long one call to a key manager may take, on the wall clock. */
  readonly budgetMs: number;
}

export interface RunTokens {
  readonly supplier: ProcessEnvironmentSupplier;
  /** Revokes every run token a holder still holds from the connection: its sign-out or removal. */
  revokeAll(connectionId: string): void;
  /** Stops renewing, and lets go of every registration held: the environment's close. */
  close(): void;
}

/** A run token a holder holds. */
interface HeldRunToken {
  readonly connectionId: string;
  readonly token: string;
  readonly provider: ConnectionProvider;
  readonly target: SignInTarget;
  readonly registration: ScrubRelease;
  readonly renewal: Timer;
  revoked: boolean;
}

const NOTHING: SuppliedVariables = { variables: {}, release: () => undefined };

export const createRunTokens = (options: RunTokensOptions): RunTokens => {
  const { source, clock, scrub, budgetMs } = options;
  const held = new Set<HeldRunToken>();
  let closed = false;

  /** The injecting connections this supplier serves: OpenBao's. */
  const served = (): InjectingConnection[] => source.injecting().filter(({ record }) => record.provider === "openbao");

  /** How long a run token of the connection may live from now: an hour, or its login's remaining life if shorter. */
  const lifeOf = (record: KeyManagerConnectionRecord): number => {
    const expiry = record.tokenInformation?.expiresAt ?? null;
    const left = expiry === null ? Number.POSITIVE_INFINITY : Math.floor((Date.parse(expiry) - clock.now().getTime()) / 1000);
    return Math.min(RUN_TOKEN_TTL_SECONDS, left);
  };

  /** Writes the harness-owned empty configuration, and answers its path: a CLI reads a missing one as empty too, so a failure is only logged. */
  const configuration = async (): Promise<string> => {
    const path = join(options.cliDirectory, OPENBAO_CONFIG_FILE);
    try {
      await mkdir(options.cliDirectory, { recursive: true, mode: 0o700 });
      await writeFile(path, "", { mode: 0o600 });
    } catch (error) {
      console.error(`Writing the key-manager CLIs' empty configuration ${path} failed:`, error);
    }
    return path;
  };

  /** Revokes a held run token with itself; one the key manager no longer knows is gone already. */
  const revoke = async (run: HeldRunToken): Promise<void> => {
    const answer = await run.provider.revoke(run.target, run.token);
    if (answer.outcome !== "revoked" && answer.outcome !== "credential-rejected") {
      console.error(`Revoking a run token of the key-manager connection ${run.connectionId} failed; it expires within the hour: ${scrub.scrubOutput(answer.message)}`);
    }
  };

  /** Renews a held run token by its connection's life for it now. */
  const renew = async (run: HeldRunToken): Promise<void> => {
    const now = source.readable(run.connectionId);
    const increment = now === null ? RUN_TOKEN_TTL_SECONDS : lifeOf(now.record);
    if (run.revoked || increment < 1) return;
    const answer = await run.provider.renew(run.target, run.token, increment, AbortSignal.timeout(budgetMs));
    if (answer.outcome === "renewed" || run.revoked) return;
    if (answer.outcome === "credential-rejected") {
      run.renewal.cancel();
      console.error(`A run token of the key-manager connection ${run.connectionId} is no longer known to the key manager, and is not renewed again: ${scrub.scrubOutput(answer.message)}`);
      return;
    }
    console.error(`Renewing a run token of the key-manager connection ${run.connectionId} failed; it is tried again in twenty minutes: ${scrub.scrubOutput(answer.message)}`);
  };

  /** Holds a minted run token for its holder: registered for scrubbing, and renewed every twenty minutes. */
  const hold = (connectionId: string, login: MintingLogin, token: string): HeldRunToken => {
    const registration = scrub.register(token, { owner: `key-manager:${connectionId}:run-token` });
    const run: HeldRunToken = {
      connectionId,
      token,
      provider: login.provider,
      target: login.target,
      registration,
      renewal: clock.setInterval(() => void renew(run).catch((error: unknown) => console.error("Renewing a run token failed:", error)), RUN_TOKEN_RENEWAL_MS),
      revoked: false,
    };
    held.add(run);
    return run;
  };

  /** The holder's stop: renewal stopped, the token revoked unless it was already, and its registration let go once that is answered. */
  const release = (run: HeldRunToken): void => {
    run.renewal.cancel();
    held.delete(run);
    if (run.revoked) return run.registration();
    run.revoked = true;
    void revoke(run)
      .catch((error: unknown) => console.error("Revoking a run token failed:", error))
      .finally(run.registration);
  };

  /** Waits up to five seconds on the environment's clock for the connection's sign-in under way, if one is. */
  const waitForSignIn = async (connectionId: string, scope: ProcessEnvironmentScope): Promise<void> => {
    const running = source.signingIn(connectionId);
    if (running === undefined) return;
    let timer: Timer | undefined;
    const ended = await Promise.race([running.then(() => true), new Promise<boolean>((resolve) => (timer = clock.setTimeout(() => resolve(false), SIGN_IN_WAIT_MS)))]);
    timer?.cancel();
    if (!ended) console.error(`The key-manager connection ${connectionId} was still signing in after ${SIGN_IN_WAIT_MS / 1000} s; session ${scope.sessionId}'s ${scope.holder} is given no run token from it.`);
  };

  /** The run token minted for the holder from the connection as it stands; null where none can be. */
  const mintFor = async (record: KeyManagerConnectionRecord, login: MintingLogin | null, scope: ProcessEnvironmentScope): Promise<HeldRunToken | null> => {
    if (record.status.kind !== "signed-in" || login === null || record.canMint === false) return null;
    const ttlSeconds = lifeOf(record);
    if (ttlSeconds < 1) return null;
    const answer = await login.provider.mint(
      login.target,
      login.token,
      {
        policies: [...new Set([...(record.ticks ?? []), "default"])],
        ttlSeconds,
        displayName: RUN_TOKEN_DISPLAY_NAME,
        metadata: { session: scope.sessionId, holder: scope.holder },
        tokenRole: record.tokenRole,
      },
      AbortSignal.timeout(budgetMs),
    );
    if (answer.outcome !== "minted") {
      console.error(`Minting a run token from the key-manager connection ${record.id} for session ${scope.sessionId}'s ${scope.holder} failed; it is given no run token: ${scrub.scrubOutput(answer.message)}`);
      return null;
    }
    const run = hold(record.id, login, answer.token);
    // The environment closed while it was minted: nothing holds it.
    if (closed) {
      release(run);
      return null;
    }
    return run;
  };

  /** The block of one injecting connection for the holder, with its run token and that token's release; null for a connection no longer held. */
  const blockFor = async (connectionId: string, scope: ProcessEnvironmentScope, configPath: string): Promise<SuppliedVariables | null> => {
    await waitForSignIn(connectionId, scope);
    const now = source.readable(connectionId);
    if (now === null) return null;
    const run = await mintFor(now.record, now.login, scope);
    return {
      variables: openBaoBlock({ address: now.record.address, ca: now.record.ca, token: run?.token ?? "", configPath }),
      release: () => {
        if (run !== null) release(run);
      },
    };
  };

  const supplier: ProcessEnvironmentSupplier = {
    name: KEY_MANAGER_SUPPLIER,

    key() {
      const injecting = served();
      return injecting.length === 0 ? "" : JSON.stringify(injecting.map(({ record, generation }) => ({ id: record.id, generation, status: record.status.kind })));
    },

    async supply(scope) {
      const injecting = served();
      if (injecting.length === 0) return NOTHING;
      const configPath = await configuration();
      const blocks = (await Promise.all(injecting.map(({ record }) => blockFor(record.id, scope, configPath)))).filter((given) => given !== null);
      return {
        variables: Object.assign({}, ...blocks.map((given) => given.variables)) as Record<string, string>,
        release: () => {
          for (const given of blocks) given.release();
        },
      };
    },
  };

  return {
    supplier,

    revokeAll(connectionId) {
      for (const run of held) {
        if (run.connectionId !== connectionId || run.revoked) continue;
        run.revoked = true;
        run.renewal.cancel();
        void revoke(run).catch((error: unknown) => console.error("Revoking a run token failed:", error));
      }
    },

    close() {
      closed = true;
      for (const run of held) {
        run.renewal.cancel();
        run.registration();
      }
      held.clear();
    },
  };
};
