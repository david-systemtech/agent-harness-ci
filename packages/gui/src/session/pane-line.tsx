import { createContext, use, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { usePresentation } from "../window-context.js";

/** A line the pane says, and where: under its composer, or under the user message it is about (`under`, the message's id). */
interface Said {
  readonly text: string;
  readonly under: string | null;
}

/** The pane's line and the setter that says another (undefined clears it). */
type Line = readonly [string | undefined, (line: string | undefined) => void];

const LineContext = createContext<readonly [Said | undefined, Dispatch<SetStateAction<Said | undefined>>] | null>(null);

/** The lines handed to a session's pane before the pane opens on it, by `paneKey`. */
const HandedContext = createContext<Map<string, string> | null>(null);

const paneKey = (environmentId: string, sessionId: string): string => `${environmentId} ${sessionId.toLowerCase()}`;

/**
 * Where the session pane region keeps the lines handed to a pane that is
 * about to open (`useOpenInPane`): the pane a session opens in says its
 * line first, once.
 */
export const PaneLines = ({ children }: { readonly children: ReactNode }) => {
  const [handed] = useState(() => new Map<string, string>());
  return <HandedContext value={handed}>{children}</HandedContext>;
};

export interface PaneLineProps {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly children: ReactNode;
}

/**
 * A session pane's one line (docs/specs/gui.md, "A session pane"): what was
 * refused or could not be done, said once, the latest over the one before.
 * Whatever acts on the session from the pane (a send, a Stop, a queued
 * message's Read now or Edit) says it under the composer, which draws it; a
 * Fork or a Rewind under a user message says it under that message (#403),
 * so a refusal is one line, in one place, wherever it was asked. A pane
 * opened on a session with a line handed to it (`useOpenInPane`) says that
 * line first.
 */
export const PaneLine = ({ environmentId, sessionId, children }: PaneLineProps) => {
  const handed = use(HandedContext);
  const key = paneKey(environmentId, sessionId);
  const line = useState<Said | undefined>(() => {
    const text = handed?.get(key);
    return text === undefined ? undefined : { text, under: null };
  });
  // Said once: the pane opened on the session again later opens with no line.
  useEffect(() => void handed?.delete(key), [handed, key]);
  return <LineContext value={line}>{children}</LineContext>;
};

const useSaid = () => {
  const line = use(LineContext);
  if (line === null) throw new Error("The pane's line is said inside a session pane, which holds it.");
  return line;
};

/** The pane's line under its composer (none while the line is under a message), and the setter that says another there. */
export const usePaneLine = (): Line => {
  const [said, set] = useSaid();
  return [said?.under === null ? said.text : undefined, (text) => set(text === undefined ? undefined : { text, under: null })];
};

/** The pane's line while it is about the user message `messageId`, said under it; undefined while it is not. */
export const useMessageLine = (messageId: string): string | undefined => {
  const [said] = useSaid();
  return said?.under === messageId ? said.text : undefined;
};

/**
 * The setter that says a line under a user message of the pane (whatever
 * acts on one message says its outcome there); undefined clears the line
 * only while it is still that message's.
 */
export const useSayUnder = (): ((messageId: string, line: string | undefined) => void) => {
  const [, set] = useSaid();
  return (messageId, text) => set(text === undefined ? (held) => (held?.under === messageId ? undefined : held) : { text, under: messageId });
};

/**
 * Opens a session in the pane (`paneLayout`), with a line its pane says
 * first: why it is the one opened (a rewind to a session's first message
 * opens the session the runtime started for it).
 */
export const useOpenInPane = (): ((environmentId: string, sessionId: string, line?: string) => void) => {
  const handed = use(HandedContext);
  const [, setLayout] = usePresentation("paneLayout");
  return (environmentId, sessionId, line) => {
    if (line !== undefined) handed?.set(paneKey(environmentId, sessionId), line);
    setLayout({ session: { environmentId, sessionId } });
  };
};
