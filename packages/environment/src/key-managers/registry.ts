import type { KeyManagerReference } from "@agent-harness/contracts";
import type { ScrubRelease } from "../scrub/registry.js";

/**
 * The key-manager registry's resolve seam (key-managers spec, "References
 * and resolution"; ADR 0011, ADR 0020): how a harness service reads a
 * key-manager reference for one operation. The caller names the reference,
 * its owner and its purpose; the registry reads the value with the
 * connection's login, registers it with the scrub registry, and answers it
 * with its release, which the caller calls when the operation ends. Nothing
 * is cached: every call reads again, and a read that fails answers no value,
 * never an earlier one.
 *
 * The registry itself, its connections and its providers, is #91's (#370
 * fills this seam). Until then the environment holds no key-manager
 * connection, and every reference is unavailable.
 */

export interface ReferenceRequest {
  readonly reference: KeyManagerReference;
  /** Who holds the value while the operation runs, as the scrub registry names owners: `forge:<forge account id>`. */
  readonly owner: string;
  /** What the value is read for, in a few words: `add`, `verify`. */
  readonly purpose: string;
}

/** What a reference resolved to. */
export type ReferenceResolution =
  /** The value, registered for scrubbing until `release` is called. */
  | { readonly outcome: "resolved"; readonly value: string; readonly release: ScrubRelease }
  /** No value: no connection holds the reference, it is not signed in, or the key manager answered none; one line saying which. */
  | { readonly outcome: "unavailable"; readonly message: string };

export interface KeyManagerRegistry {
  /** Reads `request.reference` now. */
  resolve(request: ReferenceRequest): Promise<ReferenceResolution>;
}

/** The registry while the environment holds no key-manager connection: every reference is unavailable. */
export const noKeyManagerConnections: KeyManagerRegistry = {
  resolve: async ({ reference }) => ({
    outcome: "unavailable",
    message: `No key-manager connection ${reference.connectionId} is on this environment: connect the key manager in Set up, Key manager, or give the forge account another credential.`,
  }),
};
