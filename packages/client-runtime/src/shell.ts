/**
 * The desktop shell interface: what only a desktop app can do for a client
 * (dialogs, window, notifications, tray, deep links, the embedded web view,
 * installer and update, service, clipboard, open-external, the local grant,
 * secrets), each member optional and absent-with-reason `no-shell` when the
 * platform does not provide it. See docs/specs/client-runtime.md, "The desktop
 * shell seam". Members arrive with the client runtime's ticket.
 *
 * Nothing about sessions, runs or organisation passes through it (ADR 0004).
 * The lint rule `agent-harness/no-session-types-in-shell` holds this module to that.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- a stub until the shell's members land
export interface Shell {}
