const MESSAGE = "Stored credentials from the previous build could not be read.";

/** A kept credential needs re-pairing, rather than a network retry or revocation. */
export class StoredCredentialUnavailableError extends Error {
  constructor(reason: string) {
    super(`${MESSAGE} ${reason} The saved ciphertext is kept. Pair that environment again.`);
    this.name = "StoredCredentialUnavailableError";
  }
}

/** Electron IPC keeps the message but replaces the error class and prefixes it. */
export const isStoredCredentialUnavailable = (error: unknown): boolean => error instanceof Error && error.message.includes(MESSAGE);
