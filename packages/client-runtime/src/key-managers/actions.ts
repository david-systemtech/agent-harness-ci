import type {
  KeyManagerAuthMethod,
  KeyManagerCertificate,
  KeyManagerConnectionRecord,
  KeyManagerCredential,
  KeyManagerMoveItemRef,
  KeyManagerMoveItemResult,
  KeyManagerProvider,
  KeyManagerMoveLocator,
  ParamsOf,
} from "@agent-harness/contracts";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { uuidv4, uuidv7 } from "../ids.js";
import type { Clock } from "../platform.js";
import type { Runtime } from "../runtime.js";
import { adminCall, type AdminOutcome } from "../status/actions.js";
import { plainRefusal, type RefusedAnswer } from "../words/refusal.js";
import { KEY_MANAGER_PROVIDER_NAMES, savedWords } from "./words.js";

/**
 * What a Key managers pane sends, as both renderers send it and say it
 * (key-managers spec, "Wire methods"; ADR 0028; #425): each an `admin`
 * command or query as a direct request (`requests.call`), never the
 * outbox's, so one made while the environment cannot be reached fails at
 * once and nothing holding a credential or a value waits on the client.
 * Each answers what it did in one line, or the refusal in one line.
 */

/**
 * Whether a provider's form asks for its address: every one but 1Password,
 * whose address is the account URL its service-account token names, which
 * the environment learns at sign-in (#378, #1118).
 */
export const asksAddress = (provider: KeyManagerProvider): boolean => provider !== "onepassword";

/** Where a provider's form presets its address: Doppler's API host and Bitwarden's cloud; OpenBao has none to preset, and 1Password's form asks for none (`asksAddress`). */
export const KEY_MANAGER_ADDRESS_PRESETS: Readonly<Record<KeyManagerProvider, string>> = {
  openbao: "",
  doppler: "https://api.doppler.com",
  onepassword: "",
  bitwarden: "https://vault.bitwarden.com",
};

/** The label a provider's form presets. */
export const KEY_MANAGER_LABEL_PRESETS: Readonly<Record<KeyManagerProvider, string>> = { openbao: "OpenBao", doppler: "Doppler", onepassword: "1Password", bitwarden: "Bitwarden" };

/** The fields of a credential as a form takes them: an AppRole's role id and secret id, a userpass password, or a token. */
export interface TypedCredential {
  readonly roleId: string;
  readonly secretId: string;
  readonly password: string;
  readonly token: string;
}

/** The credential a form's fields make for how the connection signs in: another provider than OpenBao takes a token. */
export const credentialOf = (provider: KeyManagerProvider, method: KeyManagerAuthMethod, typed: TypedCredential): KeyManagerCredential => {
  if (provider !== "openbao" || method === "token") return { method: "token", token: typed.token.trim() };
  if (method === "approle") return { method, roleId: typed.roleId.trim(), secretId: typed.secretId.trim() };
  return { method, password: typed.password };
};

/** Whether every field the credential needs is typed. */
export const credentialTyped = (credential: KeyManagerCredential): boolean => {
  switch (credential.method) {
    case "approle":
      return credential.roleId !== "" && credential.secretId !== "";
    case "userpass":
      return credential.password !== "";
    case "token":
      return credential.token !== "";
  }
};

/** A connection as a form adds it: OpenBao's settings are sent for OpenBao alone. */
export interface ConnectionForm {
  readonly provider: KeyManagerProvider;
  readonly label: string;
  /** Neither asked of nor sent for 1Password (`asksAddress`). */
  readonly address: string;
  readonly method: KeyManagerAuthMethod;
  /** Where the method is mounted; preset the method's name. */
  readonly mount: string;
  readonly username: string;
  /** Empty for none. */
  readonly tokenRole: string;
  /** The CA to pin, as PEM, which a person accepted from the certificate preview; null for none. OpenBao only. */
  readonly ca: string | null;
}

/**
 * What a command a pane sends did: its one line, and the connection it
 * answered with when it answered one; or its refusal's line, with, where it
 * is said plainly, the raw words for Details and the refusal's code.
 */
export type KeyManagerOutcome =
  | { readonly ok: true; readonly line: string; readonly connection: KeyManagerConnectionRecord | null }
  | { readonly ok: false; readonly line: string; readonly details?: readonly string[]; readonly code?: string };

/** The button that connects a provider, and the verb a refusal of it names: `Connect OpenBao`. */
export const connectWords = (provider: KeyManagerProvider): string => `Connect ${KEY_MANAGER_PROVIDER_NAMES[provider]}`;

/** Each sign-in refusal the environment answers in setup-copy.md §5.7's words, by its code and then its reason, for the provider and address signed in to. */
const SIGN_IN_REFUSALS: Readonly<Record<string, (name: string, address: string, reason: string | undefined) => string | undefined>> = {
  verification_failed: (name, _address, reason) =>
    reason === "root_token" ? `Use a token that is not the root token. ${PRODUCT_NAME} never uses root.` : `${name} did not accept these details. Check them and try again.`,
  unreachable: (_name, address) => `${PRODUCT_NAME} could not reach ${address}. Check the address.`,
  sealed: (name) => `${name} is locked (sealed). Unlock it, then connect.`,
  certificate_rejected: () => `${PRODUCT_NAME} does not trust this site's certificate.`,
  provider_unavailable: (name) => `${PRODUCT_NAME} cannot connect to ${name} on this computer yet.`,
  conflict: (name, address, reason) => (reason === "connection_exists" ? `${name} at ${address} is connected already.` : undefined),
};

/** A refusal as `plainRefusal` says it for the button `verb`, with its code. */
const refusedWith = (refusal: RefusedAnswer, verb: string): KeyManagerOutcome & { readonly ok: false } => ({ ok: false, ...plainRefusal(refusal, verb), code: refusal.code });

/**
 * A sign-in's refusal (`keyManagers.connections.add`, `.signIn`, `.update`)
 * as setup-copy.md §5.7 says it, naming the provider and the address signed
 * in to (the refusal's own `data.address` where it names one: 1Password's
 * form sends none), whatever words the environment used; any other refusal,
 * and this client's own (no data: the computer not reached), as
 * `plainRefusal` says it for the button `verb`. Details hold the raw words
 * and `data.details`.
 */
export const signInRefusal = (refusal: RefusedAnswer, provider: KeyManagerProvider, address: string, verb: string): KeyManagerOutcome & { readonly ok: false } => {
  const plain = plainRefusal(refusal, verb);
  const reason = typeof refusal.data?.["reason"] === "string" ? refusal.data["reason"] : undefined;
  const named = typeof refusal.data?.["address"] === "string" && refusal.data["address"] !== "" ? refusal.data["address"] : address;
  const line = refusal.data === undefined ? undefined : SIGN_IN_REFUSALS[refusal.code]?.(KEY_MANAGER_PROVIDER_NAMES[provider], named, reason);
  return { ok: false, line: line ?? plain.line, details: plain.details, code: refusal.code };
};

/** What a pane's commands are sent with: the runtime's requests, and its clock for their command ids. */
export interface KeyManagerSender {
  readonly runtime: Pick<Runtime, "requests">;
  readonly clock: Clock;
}

/** Why the form cannot be sent, before anything is: a field it needs left empty; undefined when it can. */
export const formProblem = (form: ConnectionForm, credential: KeyManagerCredential): string | undefined => {
  if (form.label.trim() === "") return "Give it a label.";
  if (asksAddress(form.provider) && form.address.trim() === "") return "Give it the key manager's address.";
  if (form.provider === "openbao" && form.method === "userpass" && form.username.trim() === "") return "Give the username it signs in as.";
  if (!credentialTyped(credential)) return "Give the credential it signs in with.";
  return undefined;
};

/**
 * Adds a connection with its credential (`keyManagers.connections.add`,
 * sent directly, never queued): the credential crosses the wire in this one
 * call and is kept nowhere on the client, and an OpenBao form's accepted CA
 * goes as the CA it pins. A 1Password form is sent without an address,
 * which its token names (`asksAddress`). A refusal is said as
 * `signInRefusal` says it, and where the connection stands once saved as
 * `savedWords` does (setup-copy.md §5.7).
 */
export const addConnection = async ({ runtime, clock }: KeyManagerSender, environmentId: string, form: ConnectionForm, credential: KeyManagerCredential): Promise<KeyManagerOutcome> => {
  const openBao = form.provider === "openbao";
  const params: ParamsOf<"keyManagers.connections.add"> = {
    commandId: uuidv7(clock.now()),
    connectionId: uuidv4(),
    provider: form.provider,
    label: form.label.trim(),
    ...(asksAddress(form.provider) && { address: form.address.trim() }),
    ...(openBao && {
      method: form.method,
      mount: form.mount.trim() === "" ? form.method : form.mount.trim(),
      ...(form.method === "userpass" && { username: form.username.trim() }),
      ...(form.tokenRole.trim() !== "" && { tokenRole: form.tokenRole.trim() }),
      ...(form.ca !== null && { ca: form.ca }),
    }),
    credential,
  };
  const answer = await adminCall(() => runtime.requests.call(environmentId, "keyManagers.connections.add", params));
  if (!answer.ok) return signInRefusal(answer.refusal, form.provider, params.address ?? "", connectWords(form.provider));
  const connection = answer.result?.connection ?? null;
  return { ok: true, connection, line: connection === null ? `Saved ${params.label}.` : savedWords(connection) };
};

/** The commands that answer the connection as it stands after them. */
type ConnectionCommand =
  | "keyManagers.connections.signIn"
  | "keyManagers.connections.update"
  | "keyManagers.connections.signOut"
  | "keyManagers.connections.setPolicies"
  | "keyManagers.connections.setInjected"
  | "keyManagers.connections.setBasePath";

/** The one line a command that answers the connection says: what was done, and where the connection stands now; or its refusal. */
const connectionOutcome = (answer: AdminOutcome<ConnectionCommand>, done: string, refused: string, label: string): KeyManagerOutcome => {
  if (!answer.ok) return { ok: false, line: `${refused}: ${answer.line}` };
  const connection = answer.result?.connection ?? null;
  return { ok: true, connection, line: connection === null ? `${done} ${label}.` : `${done} ${connection.label}: ${connection.status.message}` };
};

/** What a connection's edit changes: each field only when it is given, a null CA or token role clearing it. */
export type ConnectionChanges = Pick<ParamsOf<"keyManagers.connections.update">, "label" | "address" | "ca" | "tokenRole">;

/**
 * Changes a connection's label, address, CA or token role
 * (`keyManagers.connections.update`): a new address or CA is signed in
 * against with the credential the environment keeps, and refused as a
 * sign-in is, changing nothing, said as `signInRefusal` says it for the
 * button `verb`. Accepting a certificate's anchor pins it here, as the CA.
 */
export const updateConnection = async (
  { runtime, clock }: KeyManagerSender,
  environmentId: string,
  connection: KeyManagerConnectionRecord,
  changes: ConnectionChanges,
  verb: string,
): Promise<KeyManagerOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "keyManagers.connections.update", { commandId: uuidv7(clock.now()), connectionId: connection.id, ...changes }));
  if (!answer.ok) return signInRefusal(answer.refusal, connection.provider, changes.address ?? connection.address, verb);
  return connectionOutcome(answer, "Updated", "Not updated", connection.label);
};

/** The certificate a key manager presents, as the preview reads it, or why it could not be read. */
export type CertificatePreview = { readonly ok: true; readonly certificate: KeyManagerCertificate } | { readonly ok: false; readonly line: string };

/** Reads the anchor of the certificate chain the key manager at `address` presents (`keyManagers.certificate.preview`), which only a person's acceptance pins. */
export const previewCertificate = async (runtime: Pick<Runtime, "requests">, environmentId: string, address: string): Promise<CertificatePreview> => {
  const answer = await runtime.requests.call(environmentId, "keyManagers.certificate.preview", { address });
  return answer.ok ? { ok: true, certificate: answer.result.certificate } : { ok: false, line: `The certificate could not be read: ${answer.error.message}` };
};

/**
 * Signs the connection in again with a credential a person gives
 * (`keyManagers.connections.signIn`, sent directly, never queued), which
 * the environment keeps in place of the one it holds only once the key
 * manager takes it: its method from now on, at the mount the connection
 * holds for that method (else the method's name), with the username for
 * userpass. A refusal is said as `signInRefusal` says it.
 */
export const signInAgain = async (
  { runtime, clock }: KeyManagerSender,
  environmentId: string,
  connection: KeyManagerConnectionRecord,
  credential: KeyManagerCredential,
  username: string,
): Promise<KeyManagerOutcome> => {
  const answer = await adminCall(() =>
    runtime.requests.call(environmentId, "keyManagers.connections.signIn", {
      commandId: uuidv7(clock.now()),
      connectionId: connection.id,
      credential,
      ...(connection.provider === "openbao" && { mount: connection.method === credential.method && connection.mount !== null ? connection.mount : credential.method }),
      ...(credential.method === "userpass" && { username: username.trim() }),
    }),
  );
  if (!answer.ok) return signInRefusal(answer.refusal, connection.provider, connection.address, "Sign in");
  return connectionOutcome(answer, "Signed in", "Not signed in", connection.label);
};

/** Signs the connection out (`keyManagers.connections.signOut`): its login revoked and its credential deleted, so it awaits a sign-in. */
export const signOutConnection = async ({ runtime, clock }: KeyManagerSender, environmentId: string, connection: KeyManagerConnectionRecord): Promise<KeyManagerOutcome> =>
  connectionOutcome(
    await adminCall(() => runtime.requests.call(environmentId, "keyManagers.connections.signOut", { commandId: uuidv7(clock.now()), connectionId: connection.id })),
    "Signed out of",
    "Not signed out",
    connection.label,
  );

/** What a removal did: removed, refused, or refused because references name the connection, which a forced removal leaves unable to resolve. */
export type Removed = { readonly ok: true; readonly line: string } | { readonly ok: false; readonly line: string; readonly referenced: boolean };

/**
 * Removes the connection (`keyManagers.connections.remove`); with `force`,
 * even while references name it. A refusal because they do (`conflict`
 * reason `referenced`) says who holds them.
 */
export const removeConnection = async ({ runtime, clock }: KeyManagerSender, environmentId: string, connection: KeyManagerConnectionRecord, force: boolean): Promise<Removed> => {
  const answer = await runtime.requests.call(environmentId, "keyManagers.connections.remove", { commandId: uuidv7(clock.now()), connectionId: connection.id, ...(force && { force }) });
  if (!answer.ok) return { ok: false, line: `Not removed: ${answer.error.message}`, referenced: false };
  const { receipt } = answer.result;
  if (receipt.status === "rejected") return { ok: false, line: `Not removed: ${receipt.error.message}`, referenced: receipt.reason === "conflict" && receipt.error.data?.["reason"] === "referenced" };
  return { ok: true, line: `Removed ${connection.label}.` };
};

/** Verifies the connection now (`keyManagers.connections.verify`), which records what it finds: where it stands after, in one line; a refusal in plain words (`plainRefusal`) for the button `verb`. */
export const verifyConnection = async (runtime: Pick<Runtime, "requests">, environmentId: string, connection: KeyManagerConnectionRecord, verb: string): Promise<KeyManagerOutcome> => {
  const answer = await runtime.requests.call(environmentId, "keyManagers.connections.verify", { connectionId: connection.id });
  if (!answer.ok) return refusedWith(answer.error, verb);
  const verified = answer.result.connections.find((each) => each.id === connection.id) ?? null;
  return { ok: true, connection: verified, line: verified === null ? `${connection.label} is no longer on this environment.` : `Verified ${verified.label}: ${verified.status.message}` };
};

/** The ticks with `policy` ticked or not, in the order the login's lookup names its policies, as the environment keeps them. */
export const ticksWith = (connection: { readonly policies: KeyManagerConnectionRecord["policies"]; readonly ticks: readonly string[] | null }, policy: string, ticked: boolean): readonly string[] => {
  const held = new Set(connection.ticks ?? []);
  if (ticked) held.add(policy);
  else held.delete(policy);
  return (connection.policies ?? []).map((each) => each.name).filter((name) => held.has(name));
};

/** Ticks which of the login's policies runs receive (`keyManagers.connections.setPolicies`). */
export const setPolicies = async ({ runtime, clock }: KeyManagerSender, environmentId: string, connection: KeyManagerConnectionRecord, ticks: readonly string[]): Promise<KeyManagerOutcome> =>
  connectionOutcome(
    await adminCall(() => runtime.requests.call(environmentId, "keyManagers.connections.setPolicies", { commandId: uuidv7(clock.now()), connectionId: connection.id, ticks: [...ticks] })),
    "Ticked the policies of",
    "The policies were not ticked",
    connection.label,
  );

/** Makes the connection the one of its provider whose variables runs receive (`keyManagers.connections.setInjected`); a refusal as `plainRefusal` says it for the control `verb`. */
export const setInjected = async ({ runtime, clock }: KeyManagerSender, environmentId: string, connection: KeyManagerConnectionRecord, verb: string): Promise<KeyManagerOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "keyManagers.connections.setInjected", { commandId: uuidv7(clock.now()), connectionId: connection.id }));
  return answer.ok ? { ok: true, connection: answer.result?.connection ?? null, line: `Runs receive the variables of ${connection.label} from their next start.` } : refusedWith(answer.refusal, verb);
};

/** Sets where Move keeps the harness's secrets on the connection (`keyManagers.connections.setBasePath`); a refusal as `plainRefusal` says it for the button `verb`. */
export const setBasePath = async ({ runtime, clock }: KeyManagerSender, environmentId: string, connection: KeyManagerConnectionRecord, basePath: string, verb: string): Promise<KeyManagerOutcome> => {
  const answer = await adminCall(() =>
    runtime.requests.call(environmentId, "keyManagers.connections.setBasePath", { commandId: uuidv7(clock.now()), connectionId: connection.id, basePath: basePath.trim() }),
  );
  return answer.ok
    ? { ok: true, connection: answer.result?.connection ?? null, line: `Move keeps the harness's secrets on ${connection.label} under ${basePath.trim()}.` }
    : refusedWith(answer.refusal, verb);
};

/**
 * What an item's failed Move offers next (ADR 0028; #372): Overwrite a
 * different value at its target, Copy value where the login cannot write
 * it, Verify the paste again after a verify-only Move found nothing there
 * or another value; null for nothing more than moving it again.
 */
export type MoveFollowUp = "overwrite" | "copy-value" | "verify" | null;

/** One item's part of a Move: the item, what the Move said of it in one line, and what it offers next. */
export interface MoveLine {
  readonly item: KeyManagerMoveItemRef;
  readonly line: string;
  readonly followUp: MoveFollowUp;
}

const followUpOf = (result: KeyManagerMoveItemResult, verifyOnly: boolean): MoveFollowUp => {
  if (result.outcome === "moved") return null;
  if (result.error.code === "cannot_write") return "copy-value";
  if (result.error.code === "conflict" && (result.error.data as { readonly reason?: unknown } | undefined)?.reason === "target_exists") return "overwrite";
  return verifyOnly && result.step === "read-back" ? "verify" : null;
};

/** How a Move takes its items: replacing a different value at a target, or writing nothing and verifying what a person pasted. */
export interface MoveOptions {
  readonly overwrite?: boolean;
  readonly verifyOnly?: boolean;
}

/**
 * Moves stored tokens into the connection (`keyManagers.move`): the items
 * named, or all; each answered in one line, named as people know it
 * (`names`, by item id), with what it offers next. A refusal of the whole
 * Move (no base path, not signed in) is one line, as `plainRefusal` says it
 * for the button `verb`.
 */
export const moveItems = async (
  { runtime, clock }: KeyManagerSender,
  environmentId: string,
  connection: KeyManagerConnectionRecord,
  items: "all" | readonly KeyManagerMoveItemRef[],
  names: ReadonlyMap<string, string>,
  verb: string,
  options: MoveOptions = {},
): Promise<{ readonly ok: true; readonly lines: readonly MoveLine[] } | (KeyManagerOutcome & { readonly ok: false })> => {
  const answer = await adminCall(() =>
    runtime.requests.call(environmentId, "keyManagers.move", {
      commandId: uuidv7(clock.now()),
      connectionId: connection.id,
      items: items === "all" ? "all" : [...items],
      ...(options.overwrite === true && { overwrite: true }),
      ...(options.verifyOnly === true && { verifyOnly: true }),
    }),
  );
  if (!answer.ok) return refusedWith(answer.refusal, verb);
  const results = answer.result?.items ?? [];
  return {
    ok: true,
    lines: results.map((result) => ({
      item: result.item,
      line: `${names.get(result.item.id) ?? result.item.id}: ${result.outcome === "moved" ? result.message : result.error.message}`,
      followUp: followUpOf(result, options.verifyOnly === true),
    })),
  };
};

/** An item's stored value, answered once for a person to paste at its target, or why it was not. */
export type CopiedValue = { readonly ok: true; readonly value: string; readonly reference: KeyManagerMoveLocator } | { readonly ok: false; readonly line: string; readonly details?: readonly string[] };

/**
 * Answers an item's stored value once (`keyManagers.move.copyValue`, sent
 * directly, never queued), after a Move found the login cannot write its
 * target: for a person to paste there, then verify. The value is held by
 * whoever shows it, and nowhere else on the client.
 */
export const copyValue = async ({ runtime, clock }: KeyManagerSender, environmentId: string, connection: KeyManagerConnectionRecord, item: KeyManagerMoveItemRef): Promise<CopiedValue> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "keyManagers.move.copyValue", { commandId: uuidv7(clock.now()), connectionId: connection.id, item }));
  if (!answer.ok) return { ok: false, ...plainRefusal(answer.refusal, "Copy value") };
  if (answer.result === undefined) return { ok: false, line: "The value was copied once already; move the item again to copy it again." };
  return { ok: true, value: answer.result.value, reference: answer.result.reference };
};
