import { accessInWords } from "./change-access.js";
import { KeyRound, Laptop, Terminal, Bot } from "lucide-react";
import { OWN_CEILING, clientSessionWords, type ClientSessionSummary } from "@agent-harness/client-runtime";
import { MODES, type Ceiling } from "@agent-harness/contracts";
import { useId } from "react";
import { Badge, Button, Select } from "../ui/index.js";
import { useClock } from "../window-context.js";

export interface SessionListProps {
  /** The list's accessible name. */
  readonly name: string;
  readonly sessions: readonly ClientSessionSummary[];
  /** This client's own client session on the environment; null while it holds none. */
  readonly own: string | null;
  /** Whether the list's ceilings and revocations can be sent: the environment is ready and this client holds `admin`. */
  readonly writable: boolean;
  changeAccess(session: ClientSessionSummary): void;
  setCeiling(session: ClientSessionSummary, ceiling: Ceiling): void;
  revoke(session: ClientSessionSummary): void;
}

/**
 * Client sessions (env spec, "Pairing and access"; permissions spec,
 * "Ceilings"; #417): each by its label, this client's own marked, with its
 * kind, scopes and when it was last seen, its ceiling picked from the four
 * modes (this client's own shown, not changed: another admin session
 * changes it), and Revoke….
 */
export const SessionList = ({ name, sessions, own, writable, setCeiling, revoke, changeAccess }: SessionListProps) => (
  <ul aria-label={name} className="flex flex-col gap-2">
    {sessions.map((session) => (
      <SessionItem key={session.id} session={session} own={session.id === own} writable={writable} setCeiling={setCeiling} revoke={revoke} changeAccess={changeAccess} />
    ))}
  </ul>
);

interface SessionItemProps extends Pick<SessionListProps, "writable" | "setCeiling" | "revoke" | "changeAccess"> {
  readonly session: ClientSessionSummary;
  readonly own: boolean;
}

const SessionItem = ({ session, own, writable, setCeiling, revoke, changeAccess }: SessionItemProps) => {
  const clock = useClock();
  const ceiling = useId();
  const Icon = session.kind === "program" ? Bot : session.kind === "tui" ? Terminal : Laptop;
  const why = useId();
  return (
    <li aria-label={session.label} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-panel p-3">
      <div className="flex min-w-0 flex-col gap-0.5 text-sm">
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink">
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          <span className="font-medium">{session.label}</span>
          {own && <Badge variant="secondary">This client</Badge>}
        </p>
        <p className="text-xs text-ink-muted">{clientSessionWords(session, clock.now())}</p>
        <p className="text-xs text-ink-muted">{accessInWords(session.scopes, session.ceiling)}</p>
        {own && (
          <p id={why} className="text-xs text-ink-faint">
            {OWN_CEILING}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={ceiling} className="text-xs text-ink-muted">
          Ceiling
        </label>
        <Select
          id={ceiling}
          title="Ceiling (Arrow keys)"
          value={session.ceiling}
          disabled={!writable || own}
          {...(own && { "aria-describedby": why })}
          onChange={(event) => setCeiling(session, event.target.value as Ceiling)}
        >
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </Select>
        <Button disabled={!writable || own} onClick={() => changeAccess(session)} title={own ? "Another admin client can change this client's access." : "Change access (Enter or Space)"}>Change access</Button>
        <Button variant="destructive" disabled={!writable} onClick={() => revoke(session)} title="Revoke… (Enter or Space)">
          <KeyRound aria-hidden="true" data-icon="inline-start" />Revoke…
        </Button>
      </div>
    </li>
  );
};
