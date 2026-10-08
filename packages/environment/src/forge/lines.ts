/**
 * The Forges lines a person reads (setup-copy.md §5.6): the problems a
 * verification or a credential's read leaves on a forge account, the add's
 * refusals and the Forges step's checks. Each says what happened and the one
 * thing to do, naming the site by its host; HTTP statuses, user ids, exact
 * times and what a forge or a tool answered go in details beside it, never in
 * the line. None names Set up, Forges: the person reading it is there, or a
 * client links there.
 */

/** An origin as a line names its site: its host, with the port an origin names, as `gh` names an Enterprise host too. */
export const siteOf = (origin: string): string => origin.replace(/^https?:\/\//, "");

/** A forge account as a line names it: its login on its site, or the site until the forge has answered who it is. */
export const accountWords = (origin: string, login: string | null): string => (login === null ? siteOf(origin) : `${login} on ${siteOf(origin)}`);

/** A line in two halves: what happened, and what to do about it, which a line for a token no forge account holds yet leaves out. */
export interface Advice {
  readonly what: string;
  readonly todo: string;
}

/** `advice` as one line, or its first half alone when `remedies` is false. */
export const adviceLine = ({ what, todo }: Advice, remedies = true): string => (remedies ? `${what} ${todo}` : what);

/** A forge account copied with no token. */
export const noToken = (site: string): string => `${site} has no token yet. Add one.`;

/** The forge refused the token on its identity endpoint. */
export const tokenRefused = (site: string, login: string | null): Advice => ({
  what: login === null ? `${site} did not accept the token.` : `${site} did not accept the token for ${login}.`,
  todo: "Create a new token and add it.",
});

/**
 * The forge did not answer: no answer came (`status` absent), or it answered
 * with `status` that it cannot answer now (a server error, a rate limit).
 */
export const notAnswering = (site: string, status: number | undefined): Advice =>
  status === undefined
    ? { what: `${site} did not answer.`, todo: "Check the internet connection, then choose Check again." }
    : { what: `${site} is not answering properly right now.`, todo: "Choose Check again later." };

/** The token answers as another user than the forge account's. */
export const belongsToOther = (site: string, other: string, login: string): Advice => ({
  what: `The token for ${site} belongs to ${other}, not ${login}.`,
  todo: `Add a token for ${login}.`,
});

/** A token that answers as another user, as `belongsToOther` says it with remedies: the line a verification writes since #1850. */
const BELONGS_TO_OTHER = /^The token for .+ belongs to .+, not .+\. Add a token for .+\.$/;

/**
 * A recorded identity-changed problem's line: its own, or, for a line an older
 * build recorded (such an account is never verified again), §5.6's with the
 * other user unnamed. `login` is the forge account's, null when not known.
 */
export const identityChangedLine = (site: string, login: string | null, recorded: string): string =>
  BELONGS_TO_OTHER.test(recorded) || login === null ? recorded : adviceLine(belongsToOther(site, "another user", login));

/** The token runs out within thirty days, as a problem says it between verifications. */
export const runsOutSoon = (site: string): Advice => ({ what: `The token for ${site} runs out soon.`, todo: "Add a new one before then." });

/** The token runs out in `days` whole days or fewer, as the Forges step's check says it. */
export const runsOutIn = (site: string, days: number): string =>
  `The token for ${site} runs out ${days <= 1 ? "within a day" : `in ${days} days`}. Add a new one before then.`;

/** The token has run out. */
export const ranOut = (site: string): string => `The token for ${site} has run out. Add a new one.`;

/** A stored token or a key manager's could not be read; `keyManager` adds signing in to it. */
export const savedTokenUnreadable = (who: string, keyManager: boolean): string =>
  `agent-harness cannot read the saved token for ${who}.${keyManager ? " Sign in to your key manager." : ""}`;

/** `gh` gave no token for the forge account; its own line, in details, says why. */
export const ghGaveNoToken = (who: string): string => `agent-harness cannot get the token for ${who} from the gh tool.`;

export const GH_MISSING = "The gh tool is not installed. Install it to use your GitHub sign-in.";
export const GH_OLD = "The gh tool is out of date.";

/** `gh` is not signed in to `site`, as a credential's read says it. */
export const ghSignedOut = (site: string): string => `The gh tool is not signed in to ${site}.`;

/** `gh` is not signed in to `site`, as the Forges step's check says it, with what to do. */
export const ghSignedOutAdvice = (site: string): string => `${ghSignedOut(site)} Run gh auth login on this computer, or add a token instead.`;

/** The command that signs `gh` in to `site` as `login`, for details. */
export const ghLoginCommand = (site: string, login: string): string => `gh auth login --hostname ${site} (as ${login})`;

/** A token's reads the forge refused, as a line names them. */
export type Read = "read code" | "read releases";

/** The forge refused one or both reads to the token. */
export const cannotRead = (site: string, reads: readonly Read[]): string =>
  `The token for ${site} cannot ${reads.join(" or ")}. Create a new token with ${reads.length === 1 ? "that permission" : "those permissions"} and add it.`;

/** The forge answered the owner list with no list: the token may not list the account's organisations. */
export const cannotListOrganisations = (site: string): string =>
  `The token for ${site} cannot list organisations. Create a new token with that permission and add it.`;

/** A read the forge has not answered yet. */
export const checkingReads = (site: string): string => `Checking what the token for ${site} can do.`;

export const NO_FORGE = "No forge connected. Optional.";
export const CHOOSE_MAIN = "Choose your main forge. New notebooks go there.";

/** A harness operation found no forge account for `site`. */
export const neededElsewhere = (site: string): string => `agent-harness needed a forge for ${site} and found none. Add ${site}.`;

/** The add's refusals (setup-copy.md §5.6, "Add messages"). */
export const GITLAB_UNSUPPORTED = "GitLab is not supported yet.";
export const SITE_UNRECOGNISED = "agent-harness does not recognise this site. Choose what it runs.";
export const unreachableAtAdd = (site: string): string => `agent-harness could not reach ${site}. Check the address and the internet connection.`;
export const alreadyConnected = (site: string): string => `${site} is already connected.`;
export const tokenRefusedAtAdd = (site: string): string => `${site} did not accept this token. Check that you copied all of it, or create a new one.`;
export const tokenOfOther = (found: string, expected: string): string => `This token belongs to ${found}, not ${expected}. Add a token for ${expected}.`;

/** An alias that refused the token, or knows it as another user (another login or user id, in data): it is no other address of the forge account's site. */
export const notAnAlias = (alias: string, login: string, refused: boolean): string =>
  `${refused ? `${alias} did not accept the token for ${login}` : `${alias} knows this token as another user`}, so it is not another address for this site. Nothing was changed.`;
