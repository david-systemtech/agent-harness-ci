import { PRODUCT_NAME } from "@agent-harness/contracts";

/**
 * A refusal in plain words (docs/specs/setup-copy.md §3, "raw refusals";
 * #1837): every wire error code and reason, and the request layer's own
 * failures, as one line a person reads, with the raw words kept for
 * Details. A line never shows a code, a method or a schema's words; an
 * unknown refusal says to try again with the button that asked.
 */

/** A refusal as the request layer or a rejected receipt carries it: `RequestFailure` and `WireError` alike. */
export interface RefusedAnswer {
  readonly code: string;
  readonly message: string;
  /** The environment's structured data; absent on a failure this client met itself, before or instead of an answer. */
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

/** A refusal said plainly: the one line, and the raw words for Details. */
export interface PlainRefusal {
  readonly line: string;
  readonly details: readonly string[];
}

/** A line, given the verb of the button that asked ("Check again"). */
type Words = (verb: string) => string;

const tryAgain: Words = (verb) => `Choose ${verb} to try again.`;
const said =
  (line: string): Words =>
  () =>
    line;

const LIMITED = said("This app has limited access to that computer, so it cannot do this. Pair again with full access to change this.");
const GIVE_MORE = said("This app itself has limited access, so it cannot give more.");
const PARAMS: Words = (verb) => `${PRODUCT_NAME} could not use what was sent. Check what you entered, then choose ${verb}.`;
const CONFLICT: Words = (verb) => `This cannot be done right now. Wait a moment, then choose ${verb}.`;
const EXISTS = said("That already exists. Choose another name.");

/** The failures this client meets itself, which carry no data: a request never sent, or no answer. */
const OWN: Readonly<Record<string, Words>> = {
  timeout: (verb) => `There was no answer in time. ${tryAgain(verb)}`,
  malformed: (verb) => `${PRODUCT_NAME} answered in a way this app cannot read. Update this app, then choose ${verb}.`,
  unreachable: (verb) => `This app cannot reach that computer right now. ${tryAgain(verb)}`,
  invalid_params: PARAMS,
};

/** A capability's absence the request layer answers with, whose message is the capability's own plain line (`answerCapability`), naming the environment. */
const CAPABILITY_LINES: ReadonlySet<string> = new Set(["scope", "unsupported", "no-shell"]);

/** The environment's error codes, shared and each method's own. */
const WIRE: Readonly<Record<string, Words>> = {
  unauthorized: said("This app's access to that computer has run out. Pair again to keep using it."),
  forbidden: LIMITED,
  unavailable: (verb) => `${PRODUCT_NAME} is not ready yet. Choose ${verb} in a moment.`,
  invalid_params: PARAMS,
  not_found: (verb) => `${PRODUCT_NAME} could not find what this needs. ${tryAgain(verb)}`,
  conflict: CONFLICT,
  internal: (verb) => `${PRODUCT_NAME} ran into a problem. ${tryAgain(verb)}`,
  rate_limited: said("Too many tries. Wait one minute, then try again."),
  unreachable: (verb) => `The site did not answer. Check the address and your connection, then choose ${verb}.`,
  pairing_invalid: said("The other computer does not know this code. Check it, or make a new one."),
  pairing_expired: said("This code has run out. Make a new code on the other computer."),
  pairing_used: said("This code was already used. Make a new code on the other computer."),
  protocol_mismatch: said("This app and that computer run versions that cannot talk. Update the older one."),
  out_of_window: said("Choose a time later today, and no more than a year ahead."),
  verification_failed: (verb) => `The sign-in was not accepted. Check it, then choose ${verb}.`,
  sealed: (verb) => `The key manager is locked (sealed). Unlock it, then choose ${verb}.`,
  certificate_rejected: said(`${PRODUCT_NAME} does not trust this site's certificate. Check the certificate.`),
  provider_unavailable: said(`${PRODUCT_NAME} cannot connect to that key manager on this computer yet.`),
  credential_source_unavailable: (verb) => `${PRODUCT_NAME} cannot reach the key manager that keeps this key. Connect it, then choose ${verb}.`,
  reference_not_found: said("The key manager has no key at that place. Check the name."),
  reference_denied: said(`The key manager did not let ${PRODUCT_NAME} read that key.`),
  cannot_write: said(`The key manager does not let ${PRODUCT_NAME} save there.`),
  kind_unsupported: said(`${PRODUCT_NAME} cannot work with this kind of forge yet.`),
  not_a_forge: said(`${PRODUCT_NAME} does not recognise this site as a forge.`),
  identity_mismatch: said("This token belongs to a different account. Use a token for the right account."),
  alias_identity_mismatch: said("That address reaches a different account. Check the address."),
  forge_account_missing: said("No forge is added for this site. Add one in Forges."),
  credential_unavailable: said(`${PRODUCT_NAME} cannot read a saved token. Add it again.`),
  not_a_pull_request: said("That link is not a pull request."),
  bank_read_only: said("You can look at this memory bank but not change it."),
  bank_required: said("Choose a memory bank first."),
  validation_failed: said("The memory bank has a problem. Fix the description, then save again."),
  secret_shaped: said("This looks like a password or a key. Keep secrets out of it."),
  tool_not_runnable: said("That tool cannot be installed from here."),
  containment_unavailable: said("This sandbox does not work on this computer yet."),
  denylisted: said("That is on the always-ask list, so it was not done."),
  output_too_large: said("The result was too large to keep."),
};

/** Each code's reasons (`data.reason`; `data.readiness` for `unavailable`), where one says more than its code. */
const REASONS: Readonly<Record<string, Readonly<Record<string, Words>>>> = {
  forbidden: {
    ceiling: GIVE_MORE,
    scope: GIVE_MORE,
    local: said("Only the app on that computer itself can do this."),
    program: said(`A program connected to ${PRODUCT_NAME} cannot do this.`),
    addressed: said("This question was sent to another app, so only that app can answer it."),
  },
  unavailable: {
    starting: (verb) => `${PRODUCT_NAME} is still starting. Choose ${verb} in a moment.`,
    draining: (verb) => `${PRODUCT_NAME} is restarting. Choose ${verb} in a moment.`,
  },
  verification_failed: {
    rejected: said("The key manager did not accept these details. Check them and try again."),
    root_token: said(`Use a token that is not the root token. ${PRODUCT_NAME} never uses root.`),
  },
  conflict: {
    // An update's (updates.apply, the update route).
    // eslint-disable-next-line agent-harness/no-client-organisation-state -- An update conflict's reason on the wire (a pinned version), not session organisation.
    pinned: (verb) => `This computer is pinned to another version. Change or clear the pin, then choose ${verb}.`,
    current: said("This version is running already, or there is nothing newer."),
    schema: said("This version is older than the saved data. Choose a newer version."),
    launcher: said(`This version needs a newer install of ${PRODUCT_NAME}. Reinstall ${PRODUCT_NAME}, then update.`),
    in_progress: said("An update is under way already. Wait for it to finish."),
    no_release_access: said(`${PRODUCT_NAME} cannot read where updates come from. Check that site in Forges.`),
    unreachable: (verb) => `The site updates come from did not answer. ${tryAgain(verb)}`,
    manifest: said("This release is incomplete. Wait for a fixed release, or choose another version."),
    artefact: (verb) => `The update did not download correctly. ${tryAgain(verb)}`,
    install: (verb) => `The update did not install. ${tryAgain(verb)}`,
    no_launcher: said(`${PRODUCT_NAME} cannot update itself here. Update it the way it was installed.`),
    not_outside: said("This computer's updates are not run by an outside updater."),
    not_ready: (verb) => `That update is not ready yet. Wait for it, then choose ${verb}.`,
    // A memory bank's.
    exists: EXISTS,
    name_taken: said("That name is taken. Choose another name."),
    index_too_large: said("The memory bank's summary is too long. Shorten it, then save again."),
    landing_in_progress: (verb) => `The memory bank is saving a change. Wait for it, then choose ${verb}.`,
    not_local_only: said("This memory bank is not kept only on this computer."),
    registered_path: said("That folder holds a memory bank already. Choose another folder."),
    // A routine's.
    firing_running: said("The routine is running now. Wait for it to finish."),
    // A managed tool's run.
    tool_run_in_progress: said("That tool is being set up already. Wait for it to finish."),
    pty_unavailable: said(`This computer cannot open terminals. Reinstall ${PRODUCT_NAME}.`),
    // A file undo's.
    run_active: (verb) => `An agent is working. Wait for it to finish, then choose ${verb}.`,
    workspace_missing: said("The project folder is missing."),
    unsafe_path: said("That file is outside the project folder."),
    nothing_to_undo: said("There is nothing to undo."),
    snapshot_unavailable: said("The earlier copy of that file is gone."),
    file_changed: said("The file changed since then, so it cannot be put back."),
    // A key-manager move's.
    target_exists: said("Something is saved there already. Replace it, or choose another place."),
  },
};

/** The reason a refusal names in its data, if any. */
const reasonOf = ({ code, data }: RefusedAnswer): string | undefined => {
  const reason = data?.[code === "unavailable" ? "readiness" : "reason"];
  return typeof reason === "string" ? reason : undefined;
};

/** The lines of their own a refusal's data names for Details (`data.details`, a key-manager sign-in's since #1852); none when it names none. */
const detailsOf = ({ data }: RefusedAnswer): readonly string[] => {
  const details = data?.["details"];
  return Array.isArray(details) ? details.filter((line): line is string => typeof line === "string") : [];
};

/**
 * `refusal` in plain words, for the button `verb` ("Check again"): its
 * reason's line, else its code's, else `Something went wrong. Choose {verb}
 * to try again.`; Details hold the code, the reason and the raw message,
 * then the lines its data names (`data.details`).
 * A refusal with no data is this client's own (`requests.call`'s), worded
 * apart: its `unreachable` is a lost connection, the wire's a site that did
 * not answer; a capability's absence keeps the capability's plain line.
 */
export const plainRefusal = (refusal: RefusedAnswer, verb: string): PlainRefusal => {
  const reason = reasonOf(refusal);
  const own = refusal.data === undefined;
  const words = (reason === undefined ? undefined : REASONS[refusal.code]?.[reason]) ?? (own && CAPABILITY_LINES.has(refusal.code) ? said(refusal.message) : (own ? OWN : WIRE)[refusal.code]);
  return {
    line: words === undefined ? `Something went wrong. ${tryAgain(verb)}` : words(verb),
    details: [`${refusal.code}${reason === undefined ? "" : ` (${reason})`}: ${refusal.message}`, ...detailsOf(refusal)],
  };
};
