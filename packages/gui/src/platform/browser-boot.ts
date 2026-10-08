import { normalisePairingCode } from "@agent-harness/contracts";
import type { PairingInput } from "@agent-harness/client-runtime";
import type { PaneSession } from "../presentation.js";

export interface BrowserRoute { readonly pairing?: PairingInput; readonly session?: PaneSession }
/** Consume one-use codes synchronously, before mounting UI or starting network activity. */
export const consumeBrowserRoute = (view: Pick<Window, "location" | "history">): BrowserRoute => {
  const { pathname, hash, origin } = view.location;
  if (pathname === "/pair") {
    view.history.replaceState(null, "", "/");
    try {
      const code = normalisePairingCode(decodeURIComponent(hash.slice(1)));
      return code === undefined ? {} : { pairing: { address: origin, code } };
    } catch { return {}; }
  }
  const session = sessionOfHash(hash);
  return session ? { session } : {};
};
/** The session a `#/session/<environment>/<session>` hash opens, if it is one. */
export const sessionOfHash = (hash: string): PaneSession | undefined => {
  const match = /^#\/session\/([^/]+)\/([^/]+)$/.exec(hash);
  try {
    return match ? { environmentId: decodeURIComponent(match[1] ?? ""), sessionId: decodeURIComponent(match[2] ?? "") } : undefined;
  } catch { return undefined; }
};
export const sessionLink = ({ environmentId, sessionId }: PaneSession): string => `/#/session/${encodeURIComponent(environmentId)}/${encodeURIComponent(sessionId)}`;
