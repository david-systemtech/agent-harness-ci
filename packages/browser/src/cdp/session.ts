/**
 * The CDP session interface (browser spec, "One page driver for three
 * browsers"): the small surface the page driver is written against, so one
 * driver runs in every browser. The environment gives it over a WebSocket or
 * a pipe to Chromium (`cdpConnection`), the extension over `chrome.debugger`,
 * and the desktop shell over Electron's `webContents.debugger`; all three
 * speak the same protocol (#292).
 *
 * A session is one page's target and the child targets under it. A command
 * goes to the page's target, or to a child target by the session id its
 * attachment gave; every event of either arrives with the session id it came
 * from (none for the page's own). Child targets, the cross-site frames site
 * isolation puts in other processes, are attached through the protocol's own
 * `Target.setAutoAttach` in flat mode, so each arrives as a
 * `Target.attachedToTarget` event carrying the session id that reaches it.
 */

/** A command's parameters, a result or an event's parameters: a JSON object as the protocol sends it. */
export type CdpParams = Record<string, unknown>;

/** One event of the page's target or one of its child targets. */
export interface CdpEvent {
  readonly method: string;
  readonly params: CdpParams;
  /** The child target's session the event came from; absent for the page's own target. */
  readonly sessionId?: string;
}

/**
 * A page's target and its child targets, attached: commands in, events out.
 * The driver never learns which browser is behind it.
 */
export interface CdpSession {
  /**
   * Sends a command to the page's target, or to the child target attached
   * under `sessionId`, and resolves with its result. Rejects with a
   * `CdpError` when the protocol answers an error, and when the target goes
   * before it answers.
   */
  send(method: string, params?: CdpParams, sessionId?: string): Promise<CdpParams>;
  /** Hears every event of the page's target and its child targets, in the order they came. Returns what stops it. */
  onEvent(listener: (event: CdpEvent) => void): () => void;
  /** Hears the session end, once, with why: the target closed or crashed, the debugger was detached, the connection closed. */
  onDetach(listener: (reason: string) => void): () => void;
  /** Lets go of the page's target and its child targets. The page itself stays: closing it is its host's to do. */
  detach(): Promise<void>;
}

/** A protocol error: the browser's answer to a command it could not carry out, or a target gone before it answered. */
export class CdpError extends Error {
  override readonly name = "CdpError";
  constructor(
    message: string,
    /** The protocol's error code, when the browser answered one. */
    readonly code?: number,
  ) {
    super(message);
  }
}

/**
 * A message channel to a browser: what a WebSocket and a pipe both give,
 * one protocol message (a JSON text) at a time.
 */
export interface CdpTransport {
  send(message: string): void;
  /** Hears each message, in order. */
  onMessage(listener: (message: string) => void): void;
  /** Hears the channel close, once, with why. */
  onClose(listener: (reason: string) => void): void;
  close(): void;
}
