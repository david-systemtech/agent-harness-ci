import type { NewSessionChips } from "@agent-harness/client-runtime";
import { createContext, use, useEffect, useRef, useState, type ReactNode } from "react";

/** Choices are requests for the rest of this checklist run; session ids keep cards attached after Skip for now. */
export interface AuthoringChoice {
  readonly chips: NewSessionChips;
  readonly effort?: string;
}

interface AuthoringRun {
  readonly choices: ReadonlyMap<string, AuthoringChoice>;
  readonly sessions: ReadonlyMap<string, string>;
  choose(environmentId: string, choice: AuthoringChoice): void;
  attach(key: string, sessionId: string): void;
}

const AuthoringContext = createContext<AuthoringRun | null>(null);

export const ChecklistAuthoringProvider = ({ runId, children }: { readonly runId: number; readonly children: ReactNode }) => {
  const [choices, setChoices] = useState<ReadonlyMap<string, AuthoringChoice>>(new Map());
  const [sessions, setSessions] = useState<ReadonlyMap<string, string>>(new Map());
  const before = useRef(runId);
  useEffect(() => {
    if (runId !== before.current) {
      setChoices(new Map());
      setSessions(new Map());
    }
    before.current = runId;
  }, [runId]);
  return <AuthoringContext value={{ choices, sessions, choose: (id, choice) => setChoices((held) => new Map(held).set(id, choice)), attach: (key, id) => setSessions((held) => new Map(held).set(key, id)) }}>{children}</AuthoringContext>;
};

export const useAuthoringRun = (): AuthoringRun => {
  const run = use(AuthoringContext);
  if (run === null) throw new Error("An authoring card belongs to a checklist run.");
  return run;
};
