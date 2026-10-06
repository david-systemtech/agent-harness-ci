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

const UNANSWERED = "The OS asked to allow credential access and had no answer";

/** The OS asked the person to allow credential access (macOS's Keychain prompt) and had no answer in time; nothing kept changed. */
export class CredentialAccessUnansweredError extends Error {
  constructor(seconds: number) {
    super(`${UNANSWERED} within ${seconds} seconds. Nothing kept was changed.`);
    this.name = "CredentialAccessUnansweredError";
  }
}

/** Read from the message, which Electron IPC keeps when it replaces the error class. */
export const isCredentialAccessUnanswered = (error: unknown): boolean => error instanceof Error && error.message.includes(UNANSWERED);

/** Keeping a pairing's token failed after the exchange spent its one-use code: pairing again takes a new code. */
export class PairingCodeSpentError extends Error {
  constructor(cause: unknown) {
    super(`${cause instanceof Error ? cause.message : String(cause)} The pairing code was used; make a new one to pair again.`, { cause });
    this.name = "PairingCodeSpentError";
  }
}
