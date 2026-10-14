import { DESKTOP_ABILITIES, type DesktopDriver, type DesktopDriverKind, type DesktopOperation, type DesktopResult } from "@agent-harness/contracts";

/**
 * A desktop this environment cannot drive (computer spec, "Contained and
 * live drivers"): every operation answers `unavailable` with the reason,
 * which the tool server hands the model, so a run says why rather than
 * failing. It claims every ability so the reason, not a missing ability, is
 * what the model reads.
 */
export const unavailableDesktop = (kind: DesktopDriverKind, reason: string): DesktopDriver => ({
  kind,
  abilities: DESKTOP_ABILITIES,
  perform: async <O extends DesktopOperation>(): Promise<DesktopResult<O>> => ({ ok: false, code: "unavailable", reason }),
});

/** Where a contained desktop's VNC endpoint is, as the environment's private configuration gives it (#2162). */
export interface ContainedDesktopEndpoint {
  readonly host: string;
  readonly port: number;
}

/**
 * The contained desktop's driver, until #2162's RFB client: with no endpoint
 * configured on this environment, that; with one, that this environment
 * cannot connect to it yet. Either way the reason reaches the model.
 */
export const containedDesktopDriver = (endpoint: ContainedDesktopEndpoint | null): DesktopDriver =>
  unavailableDesktop(
    "contained",
    endpoint === null
      ? "The contained desktop is not available on this environment: none is configured. Ask the operator to set one up, or work without a desktop."
      : `The contained desktop is not available on this environment: it cannot connect to ${endpoint.host}:${endpoint.port} until its desktop driver is installed.`,
  );
