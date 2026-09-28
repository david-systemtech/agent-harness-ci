import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ScrubRegistry } from "../scrub/registry.js";

/**
 * Run-scoped secrets (ADR 0020; forge spec, "Runs: the injection" and "The
 * helper and the credential route"): what the credential helper proves
 * itself with to the credential route. Each is 32 random bytes, held in
 * memory alone, naming the forge accounts the route may serve it; it is
 * registered with the scrub registry while it lives, and void once released
 * or once the environment stops, since nothing keeps it. A harness git
 * operation mints one for the operation; a provider process or a terminal
 * mints one for its life (#315).
 */

/** How many random bytes a secret is (a chosen default): written base64url, 43 characters. */
export const RUN_SECRET_BYTES = 32;

/** A secret as minted: its value, for the process's variables, and what voids it. */
export interface RunSecret {
  readonly value: string;
  /** Voids the secret: the route refuses it from now on, and the scrub registry lets it go. Calling it again does nothing. */
  readonly release: () => void;
}

/** A secret the environment holds, as the route reads it. */
export interface HeldSecret {
  /** An id of its own, never the value: what its rate-limit bucket is kept under. */
  readonly id: string;
  /** The forge accounts it names, by id. */
  readonly forgeAccountIds: readonly string[];
}

export interface RunSecrets {
  /** Mints a secret naming `forgeAccountIds`, for `owner` (what it was minted for, as the scrub registry records it). */
  mint(forgeAccountIds: readonly string[], owner: string): RunSecret;
  /** The secret `given` is, while it lives; null for any other. Compared in constant time against every secret held. */
  find(given: string): HeldSecret | null;
  /** Voids every secret: the environment's close. */
  close(): void;
}

const digest = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

export const createRunSecrets = (scrub: ScrubRegistry): RunSecrets => {
  /** Each live secret by the digest of its value, beside what it names and its scrub registration. */
  const held = new Map<HeldSecret, { readonly digest: Buffer; readonly unregister: () => void }>();

  const release = (secret: HeldSecret): void => {
    held.get(secret)?.unregister();
    held.delete(secret);
  };

  return {
    mint(forgeAccountIds, owner) {
      const value = randomBytes(RUN_SECRET_BYTES).toString("base64url");
      const secret: HeldSecret = { id: randomUUID(), forgeAccountIds: [...forgeAccountIds] };
      held.set(secret, { digest: digest(value), unregister: scrub.register(value, { owner: `run-secret:${owner}` }) });
      return { value, release: () => release(secret) };
    },
    find(given) {
      const asked = digest(given);
      let found: HeldSecret | null = null;
      // Every secret is compared, the match or not, so the time taken says nothing of which one matched or how nearly.
      for (const [secret, entry] of held) if (timingSafeEqual(asked, entry.digest) && found === null) found = secret;
      return found;
    },
    close() {
      for (const secret of [...held.keys()]) release(secret);
    },
  };
};
