import type { KeyManagerTokenInformation } from "@agent-harness/contracts";
import type { ScrubRegistry, ScrubRelease } from "../scrub/registry.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { ConnectionProvider, RenewAnswer, SignInTarget, TokenLife } from "./provider.js";

/**
 * The logins the environment holds for its key-manager connections, and
 * when each is renewed and replaced (key-managers spec, "Providers" and "Run
 * tokens"; ADR 0028; #369): the login scheduler.
 *
 * - **Held in memory only**, one current login per connection, its token
 *   registered for scrubbing while it is held; a restart signs in again.
 *   Each login held raises the connection's **login generation**, which the
 *   process key names while run tokens are the login's children.
 * - **Renewed at two thirds of its time to live**, on the environment's
 *   clock: by the time to live it was created with, or its period when it is
 *   periodic, and again at two thirds of what each renewal gave it. A
 *   renewal that fails for want of an answer is tried again at two thirds of
 *   what is left, a minute later at the soonest; one the key manager refuses
 *   as unknown ends its renewals, and a current login's connection is
 *   verified at once, which signs a login the environment made in again and
 *   finds a token a person gave expired or rejected.
 * - **Its maximum life** is known from its lookup's explicit maximum, from a
 *   renewal that gave less than it asked (OpenBao caps a renewal at the
 *   maximum its auth method's role sets, which no lookup names), and for a
 *   login that cannot be renewed from its expiry. A maximum a renewal showed
 *   is kept for the connection's later logins at the same address, mount
 *   and method, so each is planned with it from the start.
 * - **Due**: a login the environment made is due once a third of its
 *   maximum life is left, and a token a person gave once its maximum life
 *   has ended; the connection is told once (`due`), and its verification
 *   signs in again from the kept credential, or finds the token expired. A
 *   periodic login renewed in time has no maximum unless an explicit one is
 *   set, so it is never due.
 * - **A replaced login is retired**: it is renewed still, and revoked once
 *   no run token minted from it is held (`use`); a sign-out or removal
 *   revokes every login held for the connection at once. A login the key
 *   manager no longer knows is only let go.
 */

/** A login's token, and how it is let go: whether the environment made it, where and through which provider, and its scrub registration. */
export interface LoginToken {
  readonly token: string;
  /** Whether the environment made it (AppRole, userpass), and so revokes it; a token a person gave is theirs. */
  readonly minted: boolean;
  readonly provider: ConnectionProvider;
  readonly target: SignInTarget;
  readonly release: ScrubRelease;
}

/** A login signed in and looked up: its token, and what its lookup said of it and of its life. */
export interface Login extends LoginToken {
  readonly information: KeyManagerTokenInformation;
  readonly life: TokenLife;
}

/** A current login as run tokens are minted from it (#368, #369). */
export interface MintingLogin {
  readonly token: string;
  readonly provider: ConnectionProvider;
  readonly target: SignInTarget;
  /** Whole seconds until its maximum life ends, from now; null while that is not known. */
  lifeLeft(): number | null;
  /** Counts a run token minted from it as held until the answer is called: a replaced login is revoked once none is. */
  use(): () => void;
}

/** The soonest a renewal that failed for want of an answer is tried again. */
const LOGIN_RENEWAL_RETRY_MS = 60_000;

/** Lets go of a login: one the environment made is revoked first, while its token is still registered; a token a person gave is only let go. */
export const letGo = async (connectionId: string, login: LoginToken, scrub: ScrubRegistry): Promise<void> => {
  try {
    if (!login.minted) return;
    const revoked = await login.provider.revoke(login.target, login.token);
    // One the key manager no longer knows is gone already.
    if (revoked.outcome !== "revoked" && revoked.outcome !== "credential-rejected") {
      console.error(`Revoking a login of the key-manager connection ${connectionId} failed; it expires by itself: ${scrub.scrubOutput(revoked.message)}`);
    }
  } finally {
    login.release();
  }
};

export interface LoginsOptions {
  readonly clock: Clock;
  readonly scrub: ScrubRegistry;
  /** How long one renewal may take, on the wall clock. */
  readonly budgetMs: number;
  /** The connection's current login is due, or the key manager no longer knows it: the connection verifies it at once. */
  readonly due: (connectionId: string) => void;
}

export interface Logins {
  /** Holds `login` as the connection's current one, retiring the one it replaces, and raises the connection's login generation. */
  hold(connectionId: string, login: Login): void;
  /** The connection's current login; undefined while none is held. */
  current(connectionId: string): Login | undefined;
  /** The connection's current login as run tokens are minted from it; null while none is held. */
  minting(connectionId: string): MintingLogin | null;
  /** Whether the connection's current login is one the environment made and a third of its maximum life or less is left. */
  isDue(connectionId: string): boolean;
  /** How many logins have been held for the connection: its login generation. */
  generation(connectionId: string): number;
  /** Stops holding `login`, which the key manager no longer knows, while it is still the connection's current one; its registration is the caller's to let go. Answers whether it was. */
  drop(connectionId: string, login: Login): boolean;
  /** Revokes every login held for the connection, current and retired: its sign-out or removal. */
  forget(connectionId: string): void;
  /** Stops every renewal and lets go of every registration; no login is revoked, and each expires. */
  close(): void;
}

/** A login held, current or retired, with where its life stands. */
interface Held {
  readonly connectionId: string;
  readonly login: Login;
  /** When it was issued, on the environment's clock. */
  readonly issuedAt: number;
  /** When its lease began: its sign-in, or its last renewal. */
  leaseStart: number;
  /** When it ends unless renewed; null for a token that does not expire. */
  expiresAt: number | null;
  /** The soonest it is renewed: a minute after a renewal that failed for want of an answer. */
  notBefore: number;
  /** When its maximum life ends; null while that is not known. */
  maxEndsAt: number | null;
  current: boolean;
  /** Whether its connection has been told it is due. */
  told: boolean;
  /** How many run tokens minted from it are held. */
  uses: number;
  timer: Timer | undefined;
}

/** The part of a target a maximum life is kept for: the same address, mount, method and username. */
const targetKey = (target: SignInTarget): string => JSON.stringify([target.address, target.mount, target.method, target.username]);

export const createLogins = (options: LoginsOptions): Logins => {
  const { clock, scrub, budgetMs } = options;
  const now = (): number => clock.now().getTime();
  /** Every login held, current and retired. */
  const held = new Set<Held>();
  const currents = new Map<string, Held>();
  const generations = new Map<string, number>();
  /** The maximum life a renewal showed for each connection's logins, and the target it holds for. */
  const learned = new Map<string, { readonly target: string; readonly lifeMs: number }>();

  /** The time to live a renewal asks for: its period for a periodic login, else the time to live it was created with. */
  const askedOf = ({ login }: Held): number => login.life.periodSeconds || login.life.creationTtlSeconds || login.information.ttlSeconds;

  /** When the login is next renewed: at two thirds of its lease; null when it cannot be, its lease reaches its maximum life already, or it lapses first. */
  const renewalAt = (entry: Held): number | null => {
    const { expiresAt, maxEndsAt } = entry;
    if (!entry.login.information.renewable || expiresAt === null || askedOf(entry) === 0) return null;
    if (maxEndsAt !== null && expiresAt >= maxEndsAt) return null;
    const at = Math.max(entry.leaseStart + ((expiresAt - entry.leaseStart) * 2) / 3, entry.notBefore);
    return at < expiresAt ? at : null;
  };

  /** When a login is due: a third of its maximum life left for one the environment made, its end for a token a person gave; null while its maximum is not known. */
  const dueTime = ({ login, issuedAt, maxEndsAt }: Held): number | null => {
    if (maxEndsAt === null) return null;
    return login.minted ? maxEndsAt - (maxEndsAt - issuedAt) / 3 : maxEndsAt;
  };

  /** When the connection is told its current login is due; null for a retired login, or one it has been told of. */
  const dueAt = (entry: Held): number | null => (!entry.current || entry.told ? null : dueTime(entry));

  /** Arms the login's next renewal or due time, whichever comes first; one reached already (a renewal that showed its maximum life) is acted on at once. */
  const schedule = (entry: Held): void => {
    entry.timer?.cancel();
    entry.timer = undefined;
    const times = [renewalAt(entry), dueAt(entry)].filter((time) => time !== null);
    if (times.length === 0) return;
    const wait = Math.min(...times) - now();
    if (wait <= 0) fire(entry);
    else entry.timer = clock.setTimeout(() => fire(entry), wait);
  };

  const tell = (entry: Held): void => {
    entry.told = true;
    options.due(entry.connectionId);
  };

  const fire = (entry: Held): void => {
    entry.timer = undefined;
    if (!held.has(entry)) return;
    const due = dueAt(entry);
    if (due !== null && now() >= due) {
      tell(entry);
      schedule(entry);
      return;
    }
    void renew(entry).catch((error: unknown) => console.error(`Renewing a login of the key-manager connection ${entry.connectionId} failed:`, error));
  };

  const renew = async (entry: Held): Promise<void> => {
    const asked = askedOf(entry);
    // The lease is dated from the asking, never later than the key manager dated it, however late the answer is read.
    const at = now();
    const answer = await entry.login.provider
      .renew(entry.login.target, entry.login.token, asked, AbortSignal.timeout(budgetMs))
      // A renewal that throws is tried again as one that got no answer is.
      .catch((error: unknown): RenewAnswer => ({ outcome: "unreachable", message: error instanceof Error ? error.message : String(error) }));
    if (!held.has(entry)) return;
    if (answer.outcome === "renewed") {
      entry.leaseStart = at;
      entry.expiresAt = at + answer.ttlSeconds * 1000;
      // Less than asked: the key manager held it to its maximum life, which ends as this lease does.
      if (answer.ttlSeconds < asked) {
        entry.maxEndsAt = entry.expiresAt;
        if (entry.login.minted) learned.set(entry.connectionId, { target: targetKey(entry.login.target), lifeMs: entry.maxEndsAt - entry.issuedAt });
      }
      return schedule(entry);
    }
    if (answer.outcome === "credential-rejected") {
      console.error(`A login of the key-manager connection ${entry.connectionId} is no longer known to the key manager, and is not renewed again: ${scrub.scrubOutput(answer.message)}`);
      if (entry.current) tell(entry);
      return;
    }
    console.error(`Renewing a login of the key-manager connection ${entry.connectionId} failed; it is tried again: ${scrub.scrubOutput(answer.message)}`);
    entry.leaseStart = at;
    entry.notBefore = at + LOGIN_RENEWAL_RETRY_MS;
    schedule(entry);
  };

  /** Lets go of a login held: revoked when the environment made it. */
  const end = (entry: Held): void => {
    if (!held.delete(entry)) return;
    entry.timer?.cancel();
    void letGo(entry.connectionId, entry.login, scrub);
  };

  /** The login is no longer current: revoked at once when no run token of it is held, else once none is, renewed until then. */
  const retire = (entry: Held): void => {
    entry.current = false;
    if (entry.uses === 0) end(entry);
    else schedule(entry);
  };

  return {
    hold(connectionId, login) {
      const at = now();
      const issuedAt = login.life.issuedAt === null ? at : Date.parse(login.life.issuedAt);
      const expiresAt = login.information.expiresAt === null ? null : Date.parse(login.information.expiresAt);
      const kept = learned.get(connectionId);
      const ends = [
        login.life.explicitMaxTtlSeconds > 0 ? issuedAt + login.life.explicitMaxTtlSeconds * 1000 : null,
        kept !== undefined && kept.target === targetKey(login.target) ? issuedAt + kept.lifeMs : null,
        login.information.renewable ? null : expiresAt,
      ].filter((end) => end !== null);
      const entry: Held = {
        connectionId,
        login,
        issuedAt,
        leaseStart: at,
        expiresAt,
        notBefore: at,
        maxEndsAt: ends.length === 0 ? null : Math.min(...ends),
        current: true,
        told: false,
        uses: 0,
        timer: undefined,
      };
      const replaced = currents.get(connectionId);
      held.add(entry);
      currents.set(connectionId, entry);
      generations.set(connectionId, (generations.get(connectionId) ?? 0) + 1);
      if (replaced !== undefined) retire(replaced);
      schedule(entry);
    },

    current: (connectionId) => currents.get(connectionId)?.login,

    minting(connectionId) {
      const entry = currents.get(connectionId);
      if (entry === undefined) return null;
      const { token, provider, target } = entry.login;
      return {
        token,
        provider,
        target,
        lifeLeft: () => (entry.maxEndsAt === null ? null : Math.max(0, Math.floor((entry.maxEndsAt - now()) / 1000))),
        use() {
          entry.uses += 1;
          let released = false;
          return () => {
            if (released) return;
            released = true;
            entry.uses -= 1;
            if (!entry.current && entry.uses === 0) end(entry);
          };
        },
      };
    },

    isDue(connectionId) {
      const entry = currents.get(connectionId);
      const due = entry?.login.minted === true ? dueTime(entry) : null;
      return due !== null && now() >= due;
    },

    generation: (connectionId) => generations.get(connectionId) ?? 0,

    drop(connectionId, login) {
      const entry = currents.get(connectionId);
      if (entry === undefined || entry.login !== login) return false;
      currents.delete(connectionId);
      held.delete(entry);
      entry.timer?.cancel();
      return true;
    },

    forget(connectionId) {
      currents.delete(connectionId);
      learned.delete(connectionId);
      for (const entry of [...held]) if (entry.connectionId === connectionId) end(entry);
    },

    close() {
      for (const entry of held) {
        entry.timer?.cancel();
        entry.login.release();
      }
      held.clear();
      currents.clear();
    },
  };
};
