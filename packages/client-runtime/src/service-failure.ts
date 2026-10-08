/**
 * Why the desktop could not install, start or read this computer's service
 * (setup-copy.md §4.1): its artefact is missing (`no-artefact`) or will not
 * run (`unrunnable`), or the service's `install`, `start` or `status` verb
 * refused, or the service started and did not answer (`no-answer`).
 */
export const SERVICE_FAILURE_KINDS = ["no-artefact", "unrunnable", "install", "start", "status", "no-answer"] as const;

export type ServiceFailureKind = (typeof SERVICE_FAILURE_KINDS)[number];

/** A failure of the shell's `service`: its kind, which the window words, and the desktop's own text, which Details shows. */
export interface ServiceFailure {
  readonly kind: ServiceFailureKind;
  readonly text: string;
}

const MARK = /\[service ([a-z-]+)\] ([\s\S]*)$/;

/** What the desktop's `service` rejects with; the kind rides in the message, which Electron IPC keeps when it replaces the error class. */
export class ServiceFailureError extends Error {
  constructor(readonly kind: ServiceFailureKind, readonly text: string) {
    super(`[service ${kind}] ${text}`);
    this.name = "ServiceFailureError";
  }
}

/** The failure a rejection of the shell's `service` carries, read from its message; undefined when it names no kind. */
export const serviceFailureOf = (error: unknown): ServiceFailure | undefined => {
  const marked = error instanceof Error ? MARK.exec(error.message) : null;
  const kind = SERVICE_FAILURE_KINDS.find((known) => known === marked?.[1]);
  return kind === undefined || marked === null ? undefined : { kind, text: marked[2]! };
};
