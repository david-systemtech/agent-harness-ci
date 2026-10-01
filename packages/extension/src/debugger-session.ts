import { CdpError, type CdpEvent, type CdpSession } from "@agent-harness/browser";
import type { DebuggerSession, ExtensionChrome, ProtocolParams } from "./chrome.js";

/**
 * The CDP session interface over `chrome.debugger` (browser spec, "One page
 * driver for three browsers"): one tab's target and the child targets of its
 * cross-site frames, which Chrome gives an extension's debugger as sessions
 * under the tab's own, so the page driver drives a Chrome's tab as it drives
 * the headless browser's. The debugger is attached already; this hears only
 * that tab's events.
 */

/** The session to a tab, with how the extension ends it itself and says why. */
export interface TabSession extends CdpSession {
  /** Lets go of the tab, telling the driver `reason`: Chrome says nothing of an extension's own detach. */
  end(reason: string): Promise<void>;
}

/** Why Chrome let go of the debugger, as a sentence's clause. */
const detachReason = (reason: string): string => {
  switch (reason) {
    case "target_closed":
      return "its tab was closed";
    case "canceled_by_user":
      return "the person cancelled the debugging on Chrome's banner";
    default:
      return `Chrome let go of its tab (${reason})`;
  }
};

/**
 * A protocol error as `chrome.debugger` rejects with one: its code and
 * message as JSON text, or a sentence of Chrome's own (a tab gone, a
 * debugger not attached).
 */
const cdpErrorOf = (method: string, error: unknown): CdpError => {
  const text = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(text) as { readonly code?: unknown; readonly message?: unknown };
    if (typeof parsed.message === "string") return new CdpError(`${method}: ${parsed.message}`, typeof parsed.code === "number" ? parsed.code : undefined);
  } catch {
    // Chrome's own sentence, not the protocol's.
  }
  return new CdpError(`${method}: ${text}`);
};

export const debuggerSession = (chrome: Pick<ExtensionChrome, "debugger">, tabId: number): TabSession => {
  const eventListeners = new Set<(event: CdpEvent) => void>();
  const detachListeners = new Set<(reason: string) => void>();
  let ended: string | undefined;

  const onEvent = (source: DebuggerSession, method: string, params?: ProtocolParams): void => {
    if (source.tabId !== tabId || ended !== undefined) return;
    const event: CdpEvent = { method, params: params ?? {}, ...(source.sessionId !== undefined && { sessionId: source.sessionId }) };
    for (const listener of [...eventListeners]) listener(event);
  };
  const finish = (reason: string): void => {
    if (ended !== undefined) return;
    ended = reason;
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    for (const listener of [...detachListeners]) listener(reason);
    detachListeners.clear();
  };
  const onDetach = (source: { readonly tabId?: number }, reason: string): void => {
    if (source.tabId === tabId) finish(detachReason(reason));
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);

  const end = async (reason: string): Promise<void> => {
    if (ended !== undefined) return;
    finish(reason);
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
  };

  return {
    async send(method, params, sessionId) {
      if (ended !== undefined) throw new CdpError(`${method}: the tab's debugger is gone (${ended})`);
      try {
        return (await chrome.debugger.sendCommand({ tabId, ...(sessionId !== undefined && { sessionId }) }, method, params ?? {})) ?? {};
      } catch (error) {
        throw cdpErrorOf(method, error);
      }
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => void eventListeners.delete(listener);
    },
    onDetach(listener) {
      if (ended !== undefined) {
        listener(ended);
        return () => undefined;
      }
      detachListeners.add(listener);
      return () => void detachListeners.delete(listener);
    },
    detach: () => end("the extension let go of the tab"),
    end,
  };
};
