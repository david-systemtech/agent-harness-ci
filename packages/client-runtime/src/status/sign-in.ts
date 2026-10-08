import { AccountLabel, type AccountRecord, type SignIn } from "@agent-harness/contracts";
import { ttlWords } from "../prompts/card.js";
import type { Runtime } from "../runtime.js";
import { adminCall, type AdminOutcome } from "./actions.js";

/**
 * The sign-in card as both renderers run it (docs/specs/tui.md, "Status,
 * usage, pickers"; docs/specs/gui.md, "A session pane"; ADR 0018; #147,
 * moved here by #402). The environment runs the provider's own sign-in and
 * publishes its verification URL and state as `signin.updated`, which a
 * renderer cannot hear (ADR 0004): the card follows `accounts.signin.get`
 * in the request cache, which refreshes on that notice. A new account needs
 * a label first (`accounts.add` starts its sign-in); an account not signed
 * in has its sign-in started (`accounts.signin.start`); the code the page
 * shows is sent with `accounts.signin.code`; leaving the card cancels the
 * sign-in it started (`accounts.signin.cancel`). Each is an `admin` command,
 * a direct request. The end is one line.
 */

/** The rule an account's label keeps, said when a typed one breaks it. */
export const LABEL_RULE = "A label is one line of up to 200 characters, with no space at either end.";

/** Why `label` cannot name a new account; undefined when it can. */
export const labelProblem = (label: string): string | undefined => (AccountLabel.safeParse(label).success ? undefined : LABEL_RULE);

/** The sign-in a card attends: its account's (null until a new account is added), from when the card started it (null: any of it), and whether its start is still on its way. */
export interface AttendedSignIn {
  readonly accountId: string | null;
  readonly startedAt: string | null;
  readonly starting: boolean;
}

/**
 * The environment's sign-in, as the card follows it: the one of the card's
 * account from when the card started it. Until the start answers, the sign-in
 * the card started is not told from an earlier one of the account, so none is
 * followed.
 */
export const followedSignIn = (held: SignIn | null | undefined, card: AttendedSignIn): SignIn | undefined => {
  if (!held || card.accountId === null || card.starting || held.accountId !== card.accountId) return undefined;
  if (card.startedAt !== null && Date.parse(held.startedAt) < Date.parse(card.startedAt)) return undefined;
  return held;
};

/** Whether a sign-in ended without signing the account in: it failed or expired. */
export const signInFailed = (signIn: SignIn): boolean => signIn.state === "failed" || signIn.state === "expired";

/** A sign-in's end in one line: done, failed, expired or cancelled; undefined while it runs. */
export const signInEnd = (signIn: SignIn, label: string, environment: string): string | undefined => {
  switch (signIn.state) {
    case "done":
      return `${label} is signed in on ${environment}.`;
    case "failed":
      return `The sign-in of ${label} failed: ${signIn.error ?? "the provider's CLI gave up"}.`;
    case "expired":
      return `The sign-in of ${label} expired: ${signIn.error ?? "no code came within ten minutes"}.`;
    case "cancelled":
      return `The sign-in of ${label} was cancelled.`;
    default:
      return undefined;
  }
};

/**
 * How long a running sign-in has before it expires, ten minutes after it
 * started or after its code was written (ADR 0018), in one line, as the
 * card counts it down.
 */
export const signInLeftWords = (remainingMs: number): string => (remainingMs <= 0 ? "The sign-in is expiring." : `${ttlWords(remainingMs)} to sign in.`);

/**
 * The fallback command for a terminal on the environment's machine
 * (ADR 0018): PowerShell where the account's directory is a Windows path (a
 * drive letter or a backslash), the POSIX shell's otherwise, since the
 * environment's platform is not on the wire.
 */
export const fallbackOf = (signIn: SignIn, directory: string | undefined): string =>
  directory !== undefined && (/^[a-z]:/i.test(directory) || directory.includes("\\")) ? signIn.fallback.powershell : signIn.fallback.posix;

/** What adding an account did: refused, added with no sign-in to follow (said in one line), or added with its sign-in started. */
export type AccountAdded =
  | { readonly kind: "refused"; readonly line: string }
  | { readonly kind: "added"; readonly line: string }
  | { readonly kind: "signing-in"; readonly account: AccountRecord };

/**
 * Adds an account labelled `label` on the environment (`accounts.add`),
 * which starts its sign-in. A retry answered by its stored receipt carries
 * no account, and an environment whose sign-in did not start says why: each
 * is added with nothing to follow.
 */
export const addAccount = async (runtime: Runtime, environmentId: string, label: string, commandId: string, environment: string): Promise<AccountAdded> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "accounts.add", { commandId, label }));
  if (!answer.ok) return { kind: "refused", line: `Not added: ${answer.line}` };
  const result = answer.result;
  if (!result) return { kind: "added", line: `${label} was added on ${environment}.` };
  if (!result.signIn.started) {
    return { kind: "added", line: `${label} was added on ${environment}, but its sign-in did not start: ${result.signIn.message ?? "the environment gave no reason"}` };
  }
  return { kind: "signing-in", account: result.account };
};

/** Starts the sign-in of an account not signed in (`accounts.signin.start`); the refusal says the account was not signed in. */
export const startSignIn = async (
  runtime: Runtime,
  environmentId: string,
  account: Pick<AccountRecord, "id" | "label">,
  commandId: string,
): Promise<{ readonly ok: true; readonly startedAt: string | null } | { readonly ok: false; readonly line: string }> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "accounts.signin.start", { commandId, accountId: account.id }));
  if (!answer.ok) return { ok: false, line: `${account.label} was not signed in: ${answer.line}` };
  return { ok: true, startedAt: answer.result?.signIn.startedAt ?? null };
};

/** Sends the code the sign-in page showed, trimmed as the environment asks (`accounts.signin.code`); the refusal in one line. */
export const sendSignInCode = async (runtime: Runtime, environmentId: string, accountId: string, code: string, commandId: string): Promise<string | undefined> => {
  const answer: AdminOutcome<"accounts.signin.code"> = await adminCall(() => runtime.requests.call(environmentId, "accounts.signin.code", { commandId, accountId, code: code.trim() }));
  return answer.ok ? undefined : `The code was not taken: ${answer.line}`;
};

/** Cancels the sign-in the card started (`accounts.signin.cancel`): the line saying how it ended, and whether that is a failure (a refusal, or a sign-in that had failed or expired). */
export const cancelSignIn = async (runtime: Runtime, environmentId: string, account: { readonly id: string; readonly label: string }, commandId: string, environment: string): Promise<{ readonly ok: boolean; readonly line: string }> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "accounts.signin.cancel", { commandId, accountId: account.id }));
  if (!answer.ok) return { ok: false, line: `The sign-in of ${account.label} was not cancelled: ${answer.line}` };
  const signIn = answer.result?.signIn;
  const ended = signIn === undefined ? undefined : signInEnd(signIn, account.label, environment);
  if (signIn === undefined || ended === undefined) return { ok: true, line: `The sign-in of ${account.label} was cancelled.` };
  return { ok: !signInFailed(signIn), line: ended };
};
