import { normaliseRemote, type ForgeAccountRecord, type ForgeKind, type GhProbe, type ResultOf } from "@agent-harness/contracts";
import { ghHost } from "../forges.js";
import { uuidv4, uuidv7 } from "../ids.js";
import type { Clock } from "../platform.js";
import type { Runtime } from "../runtime.js";
import { adminCall, type AdminOutcome } from "../status/actions.js";
import { forgeAccountName, machineGhLogin } from "./words.js";

/**
 * What a Forges pane sends, as both renderers send it and say it (forge
 * spec, "Wire methods" and "Credentials"; ADR 0020, ADR 0032; #419): each an
 * `admin` command or query as a direct request (`requests.call`), never the
 * outbox's, so a token crosses the wire once, in the one call that carries
 * it, and nothing holding one waits on the client. Each answers what it did
 * in one line, or the refusal in one line.
 */

/** What a pane's commands are sent with: the runtime's requests, and its clock for their command ids. */
export interface ForgeSender {
  readonly runtime: Pick<Runtime, "requests">;
  readonly clock: Clock;
}

/** What `forge.detect` found at a URL: its origin, kind and the token pages, or why it could not say. */
export type Detection = { readonly ok: true; readonly found: ResultOf<"forge.detect"> } | { readonly ok: false; readonly line: string };

/** Asks the environment which forge a URL is on and where to mint its token (`forge.detect`, an `admin` query). */
export const detectForge = async (runtime: Pick<Runtime, "requests">, environmentId: string, url: string): Promise<Detection> => {
  const answer = await runtime.requests.call(environmentId, "forge.detect", { url: url.trim() });
  return answer.ok ? { ok: true, found: answer.result } : { ok: false, line: `The forge could not be told: ${answer.error.message}` };
};

/** What a command a pane sends did: its one line, and the forge account it answered with when it answered one. */
export type ForgeOutcome = { readonly ok: true; readonly line: string; readonly account: ForgeAccountRecord | null } | { readonly ok: false; readonly line: string };

/** What an add answered, in one line: where the forge account stands once added, or the refusal. */
const addOutcome = (answer: AdminOutcome<"forge.accounts.add">, origin: string): ForgeOutcome => {
  if (!answer.ok) return { ok: false, line: `Not added: ${answer.line}` };
  const account = answer.result?.account ?? null;
  if (account === null) return { ok: true, account, line: `Added ${origin}.` };
  return { ok: true, account, line: account.problem === null ? `Added ${forgeAccountName(account)}.` : `Added ${account.origin}: ${account.problem.message}` };
};

/** A forge account as a paste adds it: the URL, the kind detection named, and the token. */
export interface PastedForge {
  readonly url: string;
  /** The kind `forge.detect` named; detected again by the environment when absent. */
  readonly kind?: Exclude<ForgeKind, "gitlab">;
  readonly token: string;
}

/**
 * Adds a forge account with a pasted token (`forge.accounts.add`, sent
 * directly, never queued): the token crosses the wire in this one call and
 * is kept nowhere on the client. A refusal (`verification_failed`, an
 * origin held already, the environment not reachable) is one line, and so
 * is where the forge account stands once added.
 */
export const addPastedForge = async ({ runtime, clock }: ForgeSender, environmentId: string, pasted: PastedForge): Promise<ForgeOutcome> => {
  const url = pasted.url.trim();
  const answer = await adminCall(() =>
    runtime.requests.call(environmentId, "forge.accounts.add", {
      commandId: uuidv7(clock.now()),
      forgeAccountId: uuidv4(),
      url,
      ...(pasted.kind !== undefined && { kind: pasted.kind }),
      credential: { kind: "stored", provenance: "pasted", token: pasted.token.trim() },
    }),
  );
  return addOutcome(answer, url);
};

/**
 * Hands this computer's `gh` token for the URL's host over once
 * (`runtime.forges.handOverGh`): absent with its reason where the shell has
 * no `gh`, refused in one line where `gh` holds no token for the host.
 */
export const addFromGh = async (runtime: Pick<Runtime, "forges">, environmentId: string, url: string, kind?: Exclude<ForgeKind, "gitlab">): Promise<ForgeOutcome> => {
  const answer = await adminCall(() => runtime.forges.handOverGh(environmentId, { url: url.trim(), ...(kind !== undefined && { kind }) }));
  return addOutcome(answer, url.trim());
};

/**
 * Adds a forge account whose token the environment's own `gh` reads on
 * every use, so it follows `gh`'s rotations (`forge.accounts.add` with a
 * `gh` credential; ADR 0032): the login `forge.gh.probe` found signed in to
 * the URL's host, the active one where there are several. Refused in one
 * line, sending nothing, where that `gh` is signed in to none there.
 */
export const addFromMachineGh = async (
  { runtime, clock }: ForgeSender,
  environmentId: string,
  environmentName: string,
  probe: GhProbe,
  url: string,
  kind?: Exclude<ForgeKind, "gitlab">,
): Promise<ForgeOutcome> => {
  const given = url.trim();
  const remote = normaliseRemote(given);
  if (remote === null) return { ok: false, line: `Not added: ${given} is not a forge's URL.` };
  const host = ghHost(remote.origin);
  const login = machineGhLogin(probe, host);
  if (login === null) return { ok: false, line: `Not added: The gh on ${environmentName} is not signed in to ${host}: run gh auth login --hostname ${host} there, or paste a token.` };
  const answer = await adminCall(() =>
    runtime.requests.call(environmentId, "forge.accounts.add", {
      commandId: uuidv7(clock.now()),
      forgeAccountId: uuidv4(),
      url: given,
      ...(kind !== undefined && { kind }),
      credential: { kind: "gh", login },
    }),
  );
  return addOutcome(answer, given);
};

/**
 * Adds an alias to a forge account (`forge.accounts.update` with its
 * aliases and the one typed; ADR 0020): the environment asks the alias's own
 * origin who the credential is before it is used, accepting it verified when
 * it answers as the same login and user id, and keeping it unverified, not
 * used, while it does not answer. A URL that names no forge, the forge
 * account's own origin and an alias it has already are refused here,
 * sending nothing; the environment's refusal (another identity, an origin
 * another forge account holds) is one line.
 */
export const addForgeAlias = async ({ runtime, clock }: ForgeSender, environmentId: string, account: ForgeAccountRecord, typed: string): Promise<ForgeOutcome> => {
  const given = typed.trim();
  const origin = normaliseRemote(given)?.origin;
  if (origin === undefined) return { ok: false, line: `Not added: ${given} names no forge: give its https or http address.` };
  if (origin === account.origin) return { ok: false, line: `Not added: ${origin} is the forge account's own origin.` };
  if (account.aliases.some((alias) => alias.origin === origin)) return { ok: false, line: `Not added: ${origin} is an alias of it already.` };
  const answer = await adminCall(() =>
    runtime.requests.call(environmentId, "forge.accounts.update", {
      commandId: uuidv7(clock.now()),
      forgeAccountId: account.id,
      aliases: [...account.aliases.map((alias) => alias.origin), origin],
    }),
  );
  if (!answer.ok) return { ok: false, line: `Not added: ${answer.line}` };
  const updated = answer.result?.account ?? null;
  const login = (updated ?? account).identity?.login ?? "the forge account's login";
  const verified = updated?.aliases.find((alias) => alias.origin === origin)?.verifiedAt ?? null;
  return {
    ok: true,
    account: updated,
    line: verified === null ? `${origin} did not answer: it is not used until it answers as ${login}.` : `${origin} answers as ${login}: it is an alias of ${forgeAccountName(updated ?? account)}.`,
  };
};

/**
 * Gives a forge account a new pasted token in place of its credential
 * (`forge.accounts.update`, sent directly, never queued): the token crosses
 * the wire in this one call and must answer as the forge account's
 * identity. A refusal (`verification_failed`, `identity_mismatch`) is one
 * line, and so is where the forge account stands after.
 */
export const signInForgeAgain = async ({ runtime, clock }: ForgeSender, environmentId: string, account: ForgeAccountRecord, token: string): Promise<ForgeOutcome> => {
  const answer = await adminCall(() =>
    runtime.requests.call(environmentId, "forge.accounts.update", {
      commandId: uuidv7(clock.now()),
      forgeAccountId: account.id,
      credential: { kind: "stored", provenance: "pasted", token: token.trim() },
    }),
  );
  if (!answer.ok) return { ok: false, line: `Not signed in again: ${answer.line}` };
  const updated = answer.result?.account ?? null;
  if (updated === null) return { ok: true, account: null, line: `${forgeAccountName(account)} is signed in again.` };
  return { ok: true, account: updated, line: updated.problem === null ? `${forgeAccountName(updated)} is signed in again.` : `Signed in again to ${updated.origin}: ${updated.problem.message}` };
};

/** Makes the forge account the primary forge (`forge.accounts.setPrimary`), clearing the one that was. */
export const setPrimaryForge = async ({ runtime, clock }: ForgeSender, environmentId: string, account: ForgeAccountRecord): Promise<ForgeOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "forge.accounts.setPrimary", { commandId: uuidv7(clock.now()), forgeAccountId: account.id }));
  return answer.ok
    ? { ok: true, account: answer.result?.account ?? null, line: `${forgeAccountName(account)} is the primary forge: new repositories go there unless another is named.` }
    : { ok: false, line: `Not made primary: ${answer.line}` };
};

/** Verifies the forge account now (`forge.accounts.verify`), which records what it finds: where it stands after, in one line. */
export const verifyForge = async (runtime: Pick<Runtime, "requests">, environmentId: string, account: ForgeAccountRecord): Promise<ForgeOutcome> => {
  const answer = await runtime.requests.call(environmentId, "forge.accounts.verify", { forgeAccountId: account.id });
  if (!answer.ok) return { ok: false, line: `Not verified: ${answer.error.message}` };
  const verified = answer.result.accounts.find((each) => each.id === account.id) ?? null;
  if (verified === null) return { ok: true, account: null, line: `${account.origin} is no longer on this environment.` };
  return { ok: true, account: verified, line: verified.problem === null ? `Verified ${forgeAccountName(verified)}.` : `Verified ${verified.origin}: ${verified.problem.message}` };
};

/** Removes the forge account (`forge.accounts.remove`): its stored token is deleted, and a primary one leaves none primary. */
export const removeForge = async ({ runtime, clock }: ForgeSender, environmentId: string, account: ForgeAccountRecord): Promise<ForgeOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "forge.accounts.remove", { commandId: uuidv7(clock.now()), forgeAccountId: account.id }));
  return answer.ok ? { ok: true, account: null, line: `Removed ${forgeAccountName(account)}.` } : { ok: false, line: `Not removed: ${answer.line}` };
};
