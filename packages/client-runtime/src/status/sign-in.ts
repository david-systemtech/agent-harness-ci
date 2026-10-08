import { AccountLabel, PRODUCT_NAME, type AccountRecord, type SignIn, type SignInStart } from "@agent-harness/contracts";
import type { Runtime } from "../runtime.js";
import { plainRefusal, type RefusedAnswer } from "../words/refusal.js";
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
 * a direct request. The words are setup-copy.md §5.2's: an end is a title and
 * the one thing to do next, the environment's own words kept for Details.
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

/**
 * How a sign-in ended (setup-copy.md §5.2): `done`; `cancelled` by a person,
 * which the card closes on; or `stopped` any other way, which the card keeps
 * open with Start again.
 */
export interface SignInEnding {
  readonly kind: "done" | "cancelled" | "stopped";
  /** What happened: a notice's title. */
  readonly title: string;
  /** The one thing to do next, said after the title; null when there is none. */
  readonly next: string | null;
  /** The title and what to do next, as one line. */
  readonly line: string;
  /** Whether Start again can sign the account in afresh: not once the account is gone. */
  readonly again: boolean;
  /** The environment's own words, for Details. */
  readonly details: readonly string[];
}

const ending = (kind: SignInEnding["kind"], title: string, next: string | null, again: boolean, details: readonly string[]): SignInEnding => ({
  kind,
  title,
  next,
  line: next === null ? title : `${title} ${next}`,
  again,
  details,
});

const START_AGAIN = "Choose Start again.";

/** A refused code: the provider's, or the environment's refusal to take it. */
const refusedCode = (details: readonly string[]): SignInEnding => ending("stopped", "Claude did not accept this code.", "Start the sign-in again.", true, details);

/** A sign-in's end; undefined while it runs. The error the environment gave goes to Details as it is. */
export const signInEnd = (signIn: SignIn, label: string): SignInEnding | undefined => {
  const details = signIn.error === null ? [] : [signIn.error];
  switch (signIn.state) {
    case "done":
      return ending("done", `${label} is signed in.`, null, false, details);
    case "failed":
      return signIn.cause === "code-refused" ? refusedCode(details) : ending("stopped", "The sign-in did not finish.", START_AGAIN, true, details);
    case "expired":
      return ending("stopped", "The sign-in ran out of time.", START_AGAIN, true, details);
    case "cancelled":
      if (signIn.cause === "restarted") return ending("stopped", `The sign-in stopped because ${PRODUCT_NAME} restarted.`, START_AGAIN, true, details);
      if (signIn.cause === "account-removed") return ending("stopped", `The sign-in stopped because ${label} was removed.`, null, false, details);
      return ending("cancelled", "The sign-in was cancelled.", null, false, details);
    default:
      return undefined;
  }
};

/**
 * How long a running sign-in has before it expires, ten minutes after it
 * started or after its code was written (ADR 0018), as the card counts it
 * down: whole minutes, rounded up, then less than one.
 */
export const signInLeftWords = (remainingMs: number): string => (remainingMs > 60_000 ? `${Math.ceil(remainingMs / 60_000)} min left` : "Less than a minute left.");

/** A refusal of the code (`accounts.signin.code`), said as the provider's refusal is, with Start again. */
export const codeRefused = (refusal: RefusedAnswer): SignInEnding => refusedCode(plainRefusal(refusal, "Start again").details);

/** A refused start, in one line: another account's running sign-in by its label, any other refusal in plain words. */
export const startRefusedLine = (refusal: RefusedAnswer): string => {
  if (refusal.data?.["reason"] === "signin_running") {
    const holder = refusal.data["label"];
    return `Another sign-in is running${typeof holder === "string" ? ` for ${holder}` : ""}. Finish or cancel it first.`;
  }
  return plainRefusal(refusal, "Sign in again").line;
};

/** An account added whose sign-in did not start, in one line (setup-copy.md §5.1). */
export const notStartedLine = (label: string, start: SignInStart): string => {
  if (start.reason === "signin_running") return `${label} is added. Its sign-in did not start because another sign-in is running. Finish that one first.`;
  if (start.reason === "signin_unavailable") return `${label} is added. ${PRODUCT_NAME} cannot sign it in on that computer. Sign in with Claude Code there instead.`;
  return `${label} is added. Its sign-in did not start. Choose Sign in again.`;
};

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
  if (!result.signIn.started) return { kind: "added", line: notStartedLine(label, result.signIn) };
  return { kind: "signing-in", account: result.account };
};

/** Starts the sign-in of an account not signed in (`accounts.signin.start`); a refusal in one line, its raw words for Details. */
export const startSignIn = async (
  runtime: Runtime,
  environmentId: string,
  account: Pick<AccountRecord, "id" | "label">,
  commandId: string,
): Promise<{ readonly ok: true; readonly startedAt: string | null } | { readonly ok: false; readonly line: string; readonly details: readonly string[] }> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "accounts.signin.start", { commandId, accountId: account.id }));
  if (!answer.ok) return { ok: false, line: startRefusedLine(answer.refusal), details: plainRefusal(answer.refusal, "Start again").details };
  return { ok: true, startedAt: answer.result?.signIn.startedAt ?? null };
};

/** Sends the code the sign-in page showed, trimmed as the environment asks (`accounts.signin.code`); undefined once taken, else how the refusal ends the attempt. */
export const sendSignInCode = async (runtime: Runtime, environmentId: string, accountId: string, code: string, commandId: string): Promise<SignInEnding | undefined> => {
  const answer: AdminOutcome<"accounts.signin.code"> = await adminCall(() => runtime.requests.call(environmentId, "accounts.signin.code", { commandId, accountId, code: code.trim() }));
  return answer.ok ? undefined : codeRefused(answer.refusal);
};

/** Cancels the sign-in the card started (`accounts.signin.cancel`): the line saying how it ended. */
export const cancelSignIn = async (runtime: Runtime, environmentId: string, account: { readonly id: string; readonly label: string }, commandId: string): Promise<string> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "accounts.signin.cancel", { commandId, accountId: account.id }));
  if (!answer.ok) return `The sign-in was not cancelled. ${plainRefusal(answer.refusal, "Cancel the sign-in").line}`;
  const ended = answer.result ? signInEnd(answer.result.signIn, account.label) : undefined;
  return ended?.line ?? "The sign-in was cancelled.";
};
