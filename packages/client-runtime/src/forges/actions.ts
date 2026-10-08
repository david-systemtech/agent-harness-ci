import { forgeOriginHost, normaliseRemote, type ForgeAccountRecord, type ForgeKind, type GhProbe, type ResultOf } from "@agent-harness/contracts";
import { ghHost } from "../forges.js";
import { uuidv4, uuidv7 } from "../ids.js";
import type { Clock } from "../platform.js";
import type { Runtime } from "../runtime.js";
import { adminCall, type AdminOutcome } from "../status/actions.js";
import type { RefusedAnswer } from "../words/refusal.js";
import { forgeAccountName, forgeRefusal, machineGhLogin, typedSite } from "./words.js";

/**
 * What a Forges pane sends, as both renderers send it and say it (forge
 * spec, "Wire methods" and "Credentials"; ADR 0020, ADR 0032; #419): each an
 * `admin` command or query as a direct request (`requests.call`), never the
 * outbox's, so a token crosses the wire once, in the one call that carries
 * it, and nothing holding one waits on the client. Each answers what it did
 * in one line, or the refusal in one plain line (`forgeRefusal`,
 * setup-copy.md §5.6) with its raw words for Details.
 */

/** What a pane's commands are sent with: the runtime's requests, and its clock for their command ids. */
export interface ForgeSender {
  readonly runtime: Pick<Runtime, "requests">;
  readonly clock: Clock;
}

/** A refusal in plain words: the line, and the raw words Details show. */
export interface ForgeRefused {
  readonly ok: false;
  readonly line: string;
  readonly details: readonly string[];
}

/** A refusal this client says itself, sending nothing: it has no raw words. */
const refusedHere = (line: string): ForgeRefused => ({ ok: false, line, details: [] });

/** What the address field asks for, as a refusal of an address that names no forge says it. */
export const ADDRESS_EXAMPLE = "https://github.com/you/project";

/**
 * What `forge.detect` found at a URL: its origin, kind and the token pages,
 * or why it could not say, `unrecognised` when the site answered as no forge
 * it knows, so the person names the kind (setup-copy.md §5.6).
 */
export type Detection = { readonly ok: true; readonly found: ResultOf<"forge.detect"> } | (ForgeRefused & { readonly unrecognised: boolean });

/** Asks the environment which forge a URL is on and where to mint its token (`forge.detect`, an `admin` query). */
export const detectForge = async (runtime: Pick<Runtime, "requests">, environmentId: string, url: string): Promise<Detection> => {
  const answer = await runtime.requests.call(environmentId, "forge.detect", { url: url.trim() });
  if (answer.ok) return { ok: true, found: answer.result };
  return { ok: false, ...forgeRefusal(answer.error, typedSite(url), "Check address"), unrecognised: answer.error.code === "not_a_forge" };
};

/** What a command a pane sends did: its one line, and the forge account it answered with when it answered one; or its refusal. */
export type ForgeOutcome = { readonly ok: true; readonly line: string; readonly account: ForgeAccountRecord | null } | ForgeRefused;

/** `answer`'s refusal in plain words, naming `site`, for the button `verb`. */
const refused = (answer: { readonly refusal: RefusedAnswer }, site: string, verb: string): ForgeRefused => ({ ok: false, ...forgeRefusal(answer.refusal, site, verb) });

/** What an add answered, in one line: where the forge account stands once added, or the refusal, for the button `verb`. */
const addOutcome = (answer: AdminOutcome<"forge.accounts.add">, url: string, verb: string): ForgeOutcome => {
  if (!answer.ok) return refused(answer, typedSite(url), verb);
  const account = answer.result?.account ?? null;
  if (account === null) return { ok: true, account, line: `${typedSite(url)} is added.` };
  // A problem is the row's own line: the row says it, once.
  return { ok: true, account, line: account.problem === null ? `${forgeAccountName(account)} is connected.` : `${forgeAccountName(account)} is added.` };
};

/** A forge account as a paste adds it: the URL, the kind detection named or the person chose, and the token. */
export interface PastedForge {
  readonly url: string;
  /** The kind detection named or the person chose; detected again by the environment when absent. */
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
  return addOutcome(answer, url, `Add ${typedSite(url)}`);
};

/**
 * Hands this computer's `gh` token for the URL's host over once
 * (`runtime.forges.handOverGh`): absent with its reason where the shell has
 * no `gh`, refused in one line where `gh` holds no token for the host.
 */
export const addFromGh = async (runtime: Pick<Runtime, "forges">, environmentId: string, url: string, kind?: Exclude<ForgeKind, "gitlab">): Promise<ForgeOutcome> => {
  const answer = await adminCall(() => runtime.forges.handOverGh(environmentId, { url: url.trim(), ...(kind !== undefined && { kind }) }));
  return addOutcome(answer, url, "Use the gh sign-in from this computer");
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
  if (remote === null) return refusedHere(`Enter an address like ${ADDRESS_EXAMPLE}.`);
  const host = ghHost(remote.origin);
  const login = machineGhLogin(probe, host);
  if (login === null) return { ok: false, line: `The gh tool is not signed in to ${host}.`, details: [`gh auth login --hostname ${host} (on ${environmentName})`] };
  const answer = await adminCall(() =>
    runtime.requests.call(environmentId, "forge.accounts.add", {
      commandId: uuidv7(clock.now()),
      forgeAccountId: uuidv4(),
      url: given,
      ...(kind !== undefined && { kind }),
      credential: { kind: "gh", login },
    }),
  );
  return addOutcome(answer, given, "Use gh");
};

/** What adds another address, as a refusal of one names the button. */
const ADD_ADDRESS = "Add address";

/** Why `origin` cannot be another address of the forge account as `account` shows it: its own address, or one it has already; null when it can. */
const aliasRefusal = (account: ForgeAccountRecord, origin: string): ForgeRefused | null => {
  const site = typedSite(origin);
  if (origin === account.origin) return refusedHere(`${site} is this site's own address.`);
  return account.aliases.some((alias) => alias.origin === origin) ? refusedHere(`${site} is already another address for this site.`) : null;
};

/**
 * Adds an alias to a forge account (`forge.accounts.update` with its
 * aliases and the one typed; ADR 0020): the environment asks the alias's own
 * origin who the credential is before it is used, accepting it verified when
 * it answers as the same login and user id, and keeping it unverified, not
 * used, while it does not answer. A URL that names no forge, the forge
 * account's own origin and an alias the row shows already are refused here,
 * sending nothing; the environment's refusal (another identity, an origin
 * another forge account holds) is one line. The update replaces the
 * aliases, and the row's record is read again only once the update's event
 * is heard, so the aliases sent are the ones `forge.accounts.list` answers
 * just before: an alias added a moment earlier is kept, not dropped.
 */
export const addForgeAlias = async ({ runtime, clock }: ForgeSender, environmentId: string, account: ForgeAccountRecord, typed: string): Promise<ForgeOutcome> => {
  const given = typed.trim();
  const origin = normaliseRemote(given)?.origin;
  if (origin === undefined) return refusedHere(`Enter an address like ${ADDRESS_EXAMPLE}.`);
  const shown = aliasRefusal(account, origin);
  if (shown !== null) return shown;
  const listed = await runtime.requests.call(environmentId, "forge.accounts.list", {});
  if (!listed.ok) return { ok: false, ...forgeRefusal(listed.error, typedSite(origin), ADD_ADDRESS) };
  // One the environment no longer holds is sent as the row shows it, for the environment to refuse.
  const held = listed.result.accounts.find((candidate) => candidate.id === account.id) ?? account;
  const known = aliasRefusal(held, origin);
  if (known !== null) return known;
  const answer = await adminCall(() =>
    runtime.requests.call(environmentId, "forge.accounts.update", {
      commandId: uuidv7(clock.now()),
      forgeAccountId: account.id,
      aliases: [...held.aliases.map((alias) => alias.origin), origin],
    }),
  );
  if (!answer.ok) return refused(answer, typedSite(origin), ADD_ADDRESS);
  const updated = answer.result?.account ?? null;
  const login = (updated ?? account).identity?.login ?? "your login";
  const verified = updated?.aliases.find((alias) => alias.origin === origin)?.verifiedAt ?? null;
  const site = typedSite(origin);
  return {
    ok: true,
    account: updated,
    line: verified === null ? `${site} did not answer. It is used once it answers as ${login}.` : `${site} is another address for ${forgeAccountName(updated ?? account)}.`,
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
  if (!answer.ok) return refused(answer, forgeOriginHost(account.origin), "Add a new token");
  const updated = answer.result?.account ?? null;
  if (updated === null) return { ok: true, account: null, line: `${forgeAccountName(account)} is signed in again.` };
  return { ok: true, account: updated, line: updated.problem === null ? `${forgeAccountName(updated)} is signed in again.` : `Signed in again to ${updated.origin}: ${updated.problem.message}` };
};

/** Makes the forge account the primary forge (`forge.accounts.setPrimary`), clearing the one that was. */
export const setPrimaryForge = async ({ runtime, clock }: ForgeSender, environmentId: string, account: ForgeAccountRecord): Promise<ForgeOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "forge.accounts.setPrimary", { commandId: uuidv7(clock.now()), forgeAccountId: account.id }));
  return answer.ok
    ? { ok: true, account: answer.result?.account ?? null, line: `${forgeAccountName(account)} is your main forge. New notebooks go there.` }
    : refused(answer, forgeOriginHost(account.origin), "Make main");
};

/** Verifies the forge account now (`forge.accounts.verify`), which records what it finds: where it stands after, in one line. */
export const verifyForge = async (runtime: Pick<Runtime, "requests">, environmentId: string, account: ForgeAccountRecord): Promise<ForgeOutcome> => {
  const answer = await runtime.requests.call(environmentId, "forge.accounts.verify", { forgeAccountId: account.id });
  if (!answer.ok) return { ok: false, ...forgeRefusal(answer.error, forgeOriginHost(account.origin), "Check again") };
  const verified = answer.result.accounts.find((each) => each.id === account.id) ?? null;
  if (verified === null) return { ok: true, account: null, line: `${account.origin} is no longer on this environment.` };
  return { ok: true, account: verified, line: verified.problem === null ? `Verified ${forgeAccountName(verified)}.` : `Verified ${verified.origin}: ${verified.problem.message}` };
};

/** Removes the forge account (`forge.accounts.remove`): its stored token is deleted, and a primary one leaves none primary. */
export const removeForge = async ({ runtime, clock }: ForgeSender, environmentId: string, account: ForgeAccountRecord): Promise<ForgeOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "forge.accounts.remove", { commandId: uuidv7(clock.now()), forgeAccountId: account.id }));
  return answer.ok ? { ok: true, account: null, line: `Removed ${forgeAccountName(account)}.` } : refused(answer, forgeOriginHost(account.origin), "Remove");
};
