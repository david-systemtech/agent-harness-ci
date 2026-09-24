/**
 * The local environment's service, as the terminal UI drives it: the CLI's
 * own `service` verbs (`packages/cli/src/service/`), handed in by the `tui`
 * verb, so a stopped service is started on one key (docs/specs/tui.md,
 * "First launch"). A port rather than a shell member: the terminal UI has
 * no shell (ADR 0004), and the CLI, not the runtime, owns the service.
 */

/** What a verb said: whether it succeeded, and its last line for people. */
export interface ServiceOutcome {
  readonly ok: boolean;
  readonly message: string;
}

/** What the local environment's discovery answers: nothing at all, or its readiness. */
export type LocalReadiness = "nothing" | "starting" | "ready" | "draining";

export interface LocalService {
  /** Whether a service is installed for this OS user (`service status`'s first line). */
  installed(): Promise<boolean>;
  /** `service install`. */
  install(): Promise<ServiceOutcome>;
  /** `service start`. */
  start(): Promise<ServiceOutcome>;
  /** What discovery answers on the service's port. */
  readiness(): Promise<LocalReadiness>;
}
