/** A deadline is temporary provider unavailability, never evidence that a login expired. */
export class ProbeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeTimeoutError";
  }
}
