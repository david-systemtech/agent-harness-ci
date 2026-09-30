import type { ForgeAccountRecord, ForgeKind, ResultOf } from "@agent-harness/contracts";
import { uuidv4, uuidv7 } from "../ids.js";
import type { Clock } from "../platform.js";
import type { Runtime } from "../runtime.js";
import { adminCall, type AdminOutcome } from "../status/actions.js";
import { forgeAccountName } from "./words.js";

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
