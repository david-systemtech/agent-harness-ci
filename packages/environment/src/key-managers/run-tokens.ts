import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KeyManagerConnectionRecord } from "@agent-harness/contracts";
import type { SuppliedVariables } from "../adapter/contract.js";
import { holderName, type ProcessEnvironmentScope, type ProcessEnvironmentSupplier } from "../adapter/process-environment.js";
import type { ScrubRegistry, ScrubRelease } from "../scrub/registry.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { BackgroundWork } from "./background.js";
import type { MintingLogin } from "./logins.js";
import { onePasswordBlock } from "./onepassword-block.js";
import { OPENBAO_TOKEN_HELPER_SCRIPT, openBaoBlock, openBaoConfiguration } from "./openbao-block.js";
import type { ConnectionProvider, SignInTarget } from "./provider.js";

/**
 * The key managers' part of every provider process and terminal
 * (key-managers spec, "Run tokens" and "Injection"; ADR 0011, ADR 0015, ADR
 * 0028; #368): the supplier the key-manager registry registers with the
 * process environment (#307), which a holder (a provider process, a
 * terminal, a managed tool's verify command (#375), and any holder the host
 * starts through the same call) is given the injecting connections' blocks
 * through.
 *
 * - **What is injected**: each injecting OpenBao connection's block
 *   (`openbao-block.ts`) and 1Password connection's (`onepassword-block.ts`,
 *   #378), at most one per provider (the connections' rule); the other
 *   providers' blocks join with their tickets (#377, #379). With none,
 *   nothing is supplied and the key is empty.
 * - **1Password** mints nothing: a holder is given the connection's own
 *   service-account token while it is signed in, registered with the scrub
 *   registry for the holder's life, and a 0700 configuration directory of
 *   its own in the key-manager CLI directory, deleted when it stops.
 * - **The key** names, per injected connection, its id, its credential
 *   generation and its status, and while run tokens are its login's
 *   children (no token role) its login generation (#369), never a token: a
 *   change gives the session's next run a fresh process, and a verification
 *   that changes none of them does not. A process that keeps its key keeps
 *   its run token.
 * - **A run token** is minted for each holder as it starts: a renewable
 *   child of the connection's current login, with the ticked policies plus
 *   `default` (which its own renewal and revocation need), a time to live
 *   of one hour or, for a child, what is left of the login's maximum life
 *   if that is known and shorter, the display name `agent-harness` and
 *   metadata naming the holder kind and its session, if any; against the
 *   connection's token role when it has one, whose tokens may outlive the
 *   login. It is registered with the scrub registry for the holder's life,
 *   renewed every twenty minutes while the holder lives, and revoked when
 *   the holder stops (its release: the idle stop, a changed key, a rewind,
 *   drain, a terminal's close); the registration is let go once the
 *   revocation is answered, and with it the login's count of run tokens
 *   held, so a login replaced meanwhile is revoked once none is (#369).
 *   A connection's sign-out or removal revokes every run token minted from
 *   it at once, whatever its token role or login made of it, and one whose
 *   mint was under way then as it lands, its holder given none.
 * - **No token** is minted for a connection that is not signed in, holds no
 *   login, or cannot mint (`canMint` false): the holder gets the address
 *   and CA with an empty token, never the login's own. A spawn waits up to
 *   five seconds, on the environment's clock, for a connection still
 *   signing in, then goes on as it stands. A mint that fails is logged,
 *   scrubbed, and the holder gets an empty token too.
 * - **The configuration** both CLIs are pointed at is a file under the data
 *   directory's key-manager CLI directory naming the harness's token helper
 *   beside it, which answers no token, so an empty token never falls back to
 *   `~/.vault-token` (#716). Both are written again at each spawn, each
 *   through a temporary renamed over it, so a CLI reading one meanwhile
 *   never finds it cut short; the denylist's data-directory preset exempts
 *   the directory, so a contained run's CLI can read and run them.
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

/** The harness-owned configuration `BAO_CONFIG_PATH` and `VAULT_CONFIG_PATH` name, in the key-manager CLI directory. */
export const OPENBAO_CONFIG_FILE = "openbao.hcl";

/** The harness's token helper the configuration names, beside it (#716). */
export const OPENBAO_TOKEN_HELPER_FILE = "openbao-token-helper";

/** What each holder's 1Password configuration directory in the key-manager CLI directory is named from: `op-` and a random suffix (#378). */
export const ONEPASSWORD_CONFIG_PREFIX = "op-";

/** A connection that injects, as the supplier reads it: its record as it stands, its credential generation, and its login generation (#369). */
export interface InjectingConnection {
  readonly record: KeyManagerConnectionRecord;
  readonly generation: number;
  readonly loginGeneration: number;
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
  /** Where each renewal and revocation runs, off any request (#745). */
  readonly background: BackgroundWork;
}

export interface RunTokens {
  readonly supplier: ProcessEnvironmentSupplier;
  /** Revokes every run token a holder still holds from the connection, and any whose mint is under way as it lands: its sign-out or removal. */
  revokeAll(connectionId: string): void;
  /** Stops renewing, and lets go of every registration held: the environment's close. */
  close(): void;
}

/** A run token a holder holds: the login it was minted from, and whether it is that login's child, dying with it. */
interface HeldRunToken {
  readonly connectionId: string;
  readonly token: string;
  readonly provider: ConnectionProvider;
  readonly target: SignInTarget;
  readonly login: MintingLogin;
  readonly child: boolean;
  /** Lets go of its scrub registration, and of its login's count of run tokens held: once its revocation is answered, or at the close. */
  readonly unregister: ScrubRelease;
  readonly renewal: Timer;
  revoked: boolean;
}

const NOTHING: SuppliedVariables = { variables: {}, release: () => undefined };

/** Writes `text` to `path` through a temporary beside it renamed over it, so a reader meanwhile finds the old text or the new, never a file cut short. */
const replaceFile = async (path: string, text: string, mode: number): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const createRunTokens = (options: RunTokensOptions): RunTokens => {
  const { source, clock, scrub, budgetMs, background } = options;
  const held = new Set<HeldRunToken>();
  /** How many times each connection's run tokens were all revoked (its sign-outs and removal): a mint under way across one is revoked as it lands. */
  const revocations = new Map<string, number>();
  let closed = false;

  const revocationsOf = (connectionId: string): number => revocations.get(connectionId) ?? 0;

  /** The injecting connections this supplier serves: OpenBao's and 1Password's. */
  const served = (): InjectingConnection[] => source.injecting().filter(({ record }) => record.provider === "openbao" || record.provider === "onepassword");

  /** How long a run token of `login` may live from now: an hour, or for its child what is left of the login's maximum life if that is known and shorter. */
  const lifeOf = (login: MintingLogin, child: boolean): number => Math.min(RUN_TOKEN_TTL_SECONDS, (child ? login.lifeLeft() : null) ?? Number.POSITIVE_INFINITY);

  /**
   * Writes the harness-owned configuration, then the token helper it names, and answers the configuration's path; a failure is
   * logged. The configuration goes first: one naming a helper that is missing has the CLI refuse, where a missing configuration
   * would have it read `~/.vault-token`.
   */
  const configuration = async (): Promise<string> => {
    const path = join(options.cliDirectory, OPENBAO_CONFIG_FILE);
    const helper = join(options.cliDirectory, OPENBAO_TOKEN_HELPER_FILE);
    try {
      await mkdir(options.cliDirectory, { recursive: true, mode: 0o700 });
      await replaceFile(path, openBaoConfiguration(helper), 0o600);
      await replaceFile(helper, OPENBAO_TOKEN_HELPER_SCRIPT, 0o700);
    } catch (error) {
      console.error(`Writing the key-manager CLIs' configuration ${path} and token helper failed:`, error);
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

  /** Renews a held run token by its life from now. */
  const renew = async (run: HeldRunToken): Promise<void> => {
    const increment = lifeOf(run.login, run.child);
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

  /** Holds a minted run token for its holder: registered for scrubbing, counted as held from its login (`use`, taken before the mint), and renewed every twenty minutes. */
  const hold = (connectionId: string, login: MintingLogin, child: boolean, token: string, use: () => void): HeldRunToken => {
    const registered = scrub.register(token, { owner: `key-manager:${connectionId}:run-token` });
    const run: HeldRunToken = {
      connectionId,
      token,
      provider: login.provider,
      target: login.target,
      login,
      child,
      unregister: () => {
        registered();
        use();
      },
      renewal: clock.setInterval(() => background.run(renew(run).catch((error: unknown) => console.error("Renewing a run token failed:", error))), RUN_TOKEN_RENEWAL_MS),
      revoked: false,
    };
    held.add(run);
    return run;
  };

  /** The holder's stop: renewal stopped, the token revoked unless it was already, and it is unregistered once that is answered. */
  const release = (run: HeldRunToken): void => {
    run.renewal.cancel();
    held.delete(run);
    if (run.revoked) return run.unregister();
    run.revoked = true;
    background.run(
      revoke(run)
        .catch((error: unknown) => console.error("Revoking a run token failed:", error))
        .finally(run.unregister),
    );
  };

  /** Waits up to five seconds on the environment's clock for the connection's sign-in under way, if one is. */
  const waitForSignIn = async (connectionId: string, scope: ProcessEnvironmentScope): Promise<void> => {
    const running = source.signingIn(connectionId);
    if (running === undefined) return;
    let timer: Timer | undefined;
    const ended = await Promise.race([running.then(() => true), new Promise<boolean>((resolve) => (timer = clock.setTimeout(() => resolve(false), SIGN_IN_WAIT_MS)))]);
    timer?.cancel();
    if (!ended) console.error(`The key-manager connection ${connectionId} was still signing in after ${SIGN_IN_WAIT_MS / 1000} s; ${holderName(scope)} is given no run token from it.`);
  };

  /** The run token minted for the holder from the connection as it stands; null where none can be. */
  const mintFor = async (record: KeyManagerConnectionRecord, login: MintingLogin | null, scope: ProcessEnvironmentScope): Promise<HeldRunToken | null> => {
    if (record.status.kind !== "signed-in" || login === null || record.canMint === false) return null;
    const child = record.tokenRole === null;
    const ttlSeconds = lifeOf(login, child);
    if (ttlSeconds < 1) return null;
    const revoked = revocationsOf(record.id);
    // Counted from before the mint, so a login replaced while it is under way is not revoked under it.
    const use = login.use();
    const answer = await login.provider
      .mint(
        login.target,
        login.token,
        {
          policies: [...new Set([...(record.ticks ?? []), "default"])],
          ttlSeconds,
          displayName: RUN_TOKEN_DISPLAY_NAME,
          metadata: { ...(scope.sessionId !== null && { session: scope.sessionId }), holder: scope.holder },
          tokenRole: record.tokenRole,
        },
        AbortSignal.timeout(budgetMs),
      )
      .catch((error: unknown) => {
        // A mint that throws lets go of the login's count as one refused does.
        use();
        throw error;
      });
    if (answer.outcome !== "minted") {
      use();
      console.error(`Minting a run token from the key-manager connection ${record.id} for ${holderName(scope)} failed; it is given no run token: ${scrub.scrubOutput(answer.message)}`);
      return null;
    }
    const run = hold(record.id, login, child, answer.token, use);
    // The environment closed, or the connection was signed out or removed, while it was minted: it is revoked, and the holder gets none.
    if (closed || revocationsOf(record.id) !== revoked) {
      release(run);
      return null;
    }
    return run;
  };

  /**
   * A 1Password connection's block for the holder (#378): its own token
   * while it is signed in, registered for scrubbing until the holder stops,
   * and a 0700 configuration directory of the holder's own, deleted then.
   */
  const onePasswordBlockFor = async (record: KeyManagerConnectionRecord, login: MintingLogin | null): Promise<SuppliedVariables> => {
    await mkdir(options.cliDirectory, { recursive: true, mode: 0o700 });
    const configDirectory = await mkdtemp(join(options.cliDirectory, ONEPASSWORD_CONFIG_PREFIX));
    const token = record.status.kind === "signed-in" && login !== null ? login.token : "";
    const registered = token === "" ? () => undefined : scrub.register(token, { owner: `key-manager:${record.id}:holder` });
    return {
      variables: onePasswordBlock({ token, configDirectory }),
      release: () => {
        registered();
        background.run(rm(configDirectory, { recursive: true, force: true }).catch((error: unknown) => console.error(`Deleting the 1Password CLI directory ${configDirectory} failed:`, error)));
      },
    };
  };

  /** The block of one injecting connection for the holder, once its sign-in under way has ended or been waited for, with its run token and that token's release; null for a connection no longer held. */
  const blockFor = async (connectionId: string, waited: Promise<void>, scope: ProcessEnvironmentScope, configPath: string): Promise<SuppliedVariables | null> => {
    await waited;
    const now = source.readable(connectionId);
    if (now === null) return null;
    if (now.record.provider === "onepassword") return onePasswordBlockFor(now.record, now.login);
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
      if (injecting.length === 0) return "";
      // A child dies with its login, so a process whose login was replaced is replaced at its next run; a token role's may outlive it, and 1Password's token is the connection's own.
      return JSON.stringify(
        injecting.map(({ record, generation, loginGeneration }) => ({
          id: record.id,
          generation,
          ...(record.provider === "openbao" && record.tokenRole === null && { login: loginGeneration }),
          status: record.status.kind,
        })),
      );
    },

    async supply(scope) {
      const injecting = served();
      if (injecting.length === 0) return NOTHING;
      // The five seconds run from the spawn: each wait starts before anything is awaited.
      const waits = injecting.map(({ record }) => waitForSignIn(record.id, scope));
      const configPath = injecting.some(({ record }) => record.provider === "openbao") ? await configuration() : "";
      const blocks = (await Promise.all(injecting.map(({ record }, index) => blockFor(record.id, waits[index] ?? Promise.resolve(), scope, configPath)))).filter(
        (given) => given !== null,
      );
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
      revocations.set(connectionId, revocationsOf(connectionId) + 1);
      for (const run of held) {
        if (run.connectionId !== connectionId || run.revoked) continue;
        run.revoked = true;
        run.renewal.cancel();
        background.run(revoke(run).catch((error: unknown) => console.error("Revoking a run token failed:", error)));
      }
    },

    close() {
      closed = true;
      for (const run of held) {
        run.renewal.cancel();
        run.unregister();
      }
      held.clear();
    },
  };
};
