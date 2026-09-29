import type { KeyManagerConnectionRecord, KeyManagerReference } from "@agent-harness/contracts";
import { copyOutcome, copyToEach, type CopyReport, type CopySource } from "./copies.js";
import { uuidv4, uuidv7 } from "./ids.js";
import type { Clock } from "./platform.js";
import type { RequestFailure, Requests } from "./requests.js";

/**
 * Key managers in the client runtime (key-managers spec, "Modules" and
 * "Copies and the state import"; ADR 0028; #384): what a client does with
 * key-manager connections beyond reading `keyManagers.list`,
 * `keyManagers.move.list` and `tools.list` through the request cache. A
 * credential crosses the wire once, in `keyManagers.connections.add` or
 * `signIn`, and `keyManagers.move.copyValue` answers a stored value once:
 * each is an `admin` command, which `commands.dispatch` refuses as `direct`
 * and `requests.call` sends at once or fails at once, so nothing holding a
 * secret is ever parked on the client.
 */

export interface KeyManagers {
  /**
   * Copies `connection`, as `fromEnvironmentId` lists it, to each
   * environment named (ADR 0028's "same on every environment"; key-managers
   * spec, "Copies and the state import"): `keyManagers.connections.add` on
   * each, all at once, with its provider, label, address, CA, auth method,
   * mount, username, token role, ticks and base path, and `copiedFrom`
   * naming the source; never a credential, which no client holds, so each
   * copy waits `awaiting-sign-in` there and asks for one once. Each is a new
   * connection there, under an id of its own. Answers a report per
   * environment: `copied` with the connection it added, or `refused` with
   * the environment's error (`conflict` reason `connection_exists`, the
   * provider and address held there) or the connection's (`unreachable` at
   * once, `scope` without `admin`, `unsupported` without `keyManagers`);
   * one refused never stops the others.
   */
  copy(fromEnvironmentId: string, connection: KeyManagerConnectionRecord, toEnvironmentIds: readonly string[]): Promise<readonly CopyReport<KeyManagerConnectionRecord | null>[]>;
}

export interface KeyManagersHost {
  readonly clock: Clock;
  readonly call: Requests["call"];
  /** The environment's name as its record has it; null for one this client has no connection to. */
  name(environmentId: string): string | null;
}

export const createKeyManagers = (host: KeyManagersHost): KeyManagers => ({
  async copy(fromEnvironmentId, connection, toEnvironmentIds) {
    const environmentName = host.name(fromEnvironmentId);
    const from = environmentName === null ? null : { environmentId: fromEnvironmentId, environmentName };
    return copyToEach(from, toEnvironmentIds, async (environmentId, copiedFrom) => {
      const answer = await host.call(environmentId, "keyManagers.connections.add", {
        commandId: uuidv7(host.clock.now()),
        connectionId: uuidv4(),
        provider: connection.provider,
        label: connection.label,
        address: connection.address,
        // What the source holds none of (another provider's OpenBao settings, ticks before a first sign-in, no base path yet) is left out.
        ...(connection.ca !== null && { ca: connection.ca }),
        ...(connection.method !== null && { method: connection.method }),
        ...(connection.mount !== null && { mount: connection.mount }),
        ...(connection.username !== null && { username: connection.username }),
        ...(connection.tokenRole !== null && { tokenRole: connection.tokenRole }),
        ...(connection.ticks !== null && { ticks: connection.ticks }),
        ...(connection.basePath !== null && { basePath: connection.basePath }),
        copiedFrom,
      });
      return copyOutcome(answer, (result) => result.connection);
    });
  },
});

/** A key-manager reference as another environment reads it, or why it cannot be sent there. */
export type ReferenceThere = { readonly ok: true; readonly reference: KeyManagerReference } | { readonly ok: false; readonly error: RequestFailure };

/**
 * Where a key-manager reference copied from `from` is read on each target
 * (key-managers spec, "Copies and the state import"; ADR 0020's "resolves
 * at once where that environment has the same key manager"; #706): the
 * same locator through the target's own connection to the key manager the
 * source reads it through, found by provider and address in each one's
 * `keyManagers.list`, since a copied connection is a new one there under an
 * id of its own and a person may have added one there besides. Reads the
 * source's list once, now, and a target's when asked for it.
 *
 * A target holding no connection to that key manager answers
 * `credential_source_unavailable`, naming the reference's connection, as
 * every target does when the source holds no connection by the reference's
 * id or cannot be asked which key manager it is: the copy is refused there,
 * sending nothing, rather than added without a credential, so the report
 * says to copy the connection first and the locator is not lost. A target
 * whose list cannot be read answers why, as its add would.
 */
export const referenceCopies = async (
  host: Pick<KeyManagersHost, "call" | "name">,
  from: CopySource,
  reference: KeyManagerReference,
): Promise<(environmentId: string) => Promise<ReferenceThere>> => {
  const unavailable = (message: string): ReferenceThere => ({ ok: false, error: { code: "credential_source_unavailable", message, data: { connectionId: reference.connectionId } } });
  const listed = await host.call(from.environmentId, "keyManagers.list", {});
  if (!listed.ok) {
    const refused = unavailable(`${from.environmentName} could not say which key manager the reference is read through: ${listed.error.message}`);
    return async () => refused;
  }
  // The environment finds a connection whatever case a reference writes its id in (#370).
  const source = listed.result.connections.find((connection) => connection.id.toLowerCase() === reference.connectionId.toLowerCase());
  if (source === undefined) {
    const refused = unavailable(`The reference is read through the key-manager connection ${reference.connectionId}, which ${from.environmentName} does not hold.`);
    return async () => refused;
  }
  return async (environmentId) => {
    const there = await host.call(environmentId, "keyManagers.list", {});
    if (!there.ok) return there;
    const counterpart = there.result.connections.find((connection) => connection.provider === source.provider && connection.address === source.address);
    if (counterpart === undefined) {
      const name = host.name(environmentId) ?? "The environment";
      return unavailable(`${name} holds no connection to ${source.label} at ${source.address}: copy that key-manager connection there and sign it in, then copy again.`);
    }
    return { ok: true, reference: { ...reference, connectionId: counterpart.id } };
  };
};
