import type { KeyManagerAuthMethod, KeyManagerConnectionRecord, KeyManagerCredential, KeyManagerProvider, ParamsOf } from "@agent-harness/contracts";
import { uuidv4, uuidv7 } from "../ids.js";
import type { Clock } from "../platform.js";
import type { Runtime } from "../runtime.js";
import { adminCall } from "../status/actions.js";

/**
 * What a Key managers pane sends, as both renderers send it and say it
 * (key-managers spec, "Wire methods"; ADR 0028; #425): each an `admin`
 * command or query as a direct request (`requests.call`), never the
 * outbox's, so one made while the environment cannot be reached fails at
 * once and nothing holding a credential or a value waits on the client.
 * Each answers what it did in one line, or the refusal in one line.
 */

/** Where a provider's form presets its address: Doppler's API host and Bitwarden's cloud; OpenBao and 1Password have none to preset. */
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
  readonly address: string;
  readonly method: KeyManagerAuthMethod;
  /** Where the method is mounted; preset the method's name. */
  readonly mount: string;
  readonly username: string;
  /** Empty for none. */
  readonly tokenRole: string;
}

/** What a command a pane sends did: its one line, and the connection it answered with when it answered one. */
export type KeyManagerOutcome = { readonly ok: true; readonly line: string; readonly connection: KeyManagerConnectionRecord | null } | { readonly ok: false; readonly line: string };

/** What the pane's hands need: the runtime's requests and its clock for command ids. */
export interface KeyManagerHands {
  readonly runtime: Pick<Runtime, "requests">;
  readonly clock: Clock;
}

/** Why the form cannot be sent, before anything is: a field it needs left empty; undefined when it can. */
export const formProblem = (form: ConnectionForm, credential: KeyManagerCredential): string | undefined => {
  if (form.label.trim() === "") return "Give it a label.";
  if (form.address.trim() === "") return "Give it the key manager's address.";
  if (form.provider === "openbao" && form.method === "userpass" && form.username.trim() === "") return "Give the username it signs in as.";
  if (!credentialTyped(credential)) return "Give the credential it signs in with.";
  return undefined;
};

/**
 * Adds a connection with its credential (`keyManagers.connections.add`,
 * sent directly, never queued): the credential crosses the wire in this one
 * call and is kept nowhere on the client. A refusal (`verification_failed`,
 * a connection held already, the environment not reachable) is one line,
 * and so is where the connection stands once added.
 */
export const addConnection = async ({ runtime, clock }: KeyManagerHands, environmentId: string, form: ConnectionForm, credential: KeyManagerCredential): Promise<KeyManagerOutcome> => {
  const openBao = form.provider === "openbao";
  const params: ParamsOf<"keyManagers.connections.add"> = {
    commandId: uuidv7(clock.now()),
    connectionId: uuidv4(),
    provider: form.provider,
    label: form.label.trim(),
    address: form.address.trim(),
    ...(openBao && {
      method: form.method,
      mount: form.mount.trim() === "" ? form.method : form.mount.trim(),
      ...(form.method === "userpass" && { username: form.username.trim() }),
      ...(form.tokenRole.trim() !== "" && { tokenRole: form.tokenRole.trim() }),
    }),
    credential,
  };
  const answer = await adminCall(() => runtime.requests.call(environmentId, "keyManagers.connections.add", params));
  if (!answer.ok) return { ok: false, line: `Not added: ${answer.line}` };
  const connection = answer.result?.connection ?? null;
  return { ok: true, connection, line: connection === null ? `Added ${params.label}.` : `Added ${connection.label}: ${connection.status.message}` };
};
