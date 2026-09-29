import type { KeyManagerConnectionRecord } from "@agent-harness/contracts";
import { copyOutcome, copyToEach, type CopyReport } from "./copies.js";
import { uuidv4, uuidv7 } from "./ids.js";
import type { Clock } from "./platform.js";
import type { Requests } from "./requests.js";

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
