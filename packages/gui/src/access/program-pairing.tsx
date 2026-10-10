import type { EnvironmentView } from "@agent-harness/client-runtime";
import { MODES, SCOPES, pairingPreset, type Ceiling, type Scope } from "@agent-harness/contracts";
import { useId, useState } from "react";
import { PairingCode } from "../machines/pairing-code.js";
import { Checkbox, Select } from "../ui/index.js";

/** The program preset (contracts), whose scopes and ceiling the form starts from. */
const PROGRAM = pairingPreset("program");

/**
 * Pair a program (ADR 0025's program preset; env spec, "Pairing and
 * access"; #417): the scopes its client session will hold, ticked from
 * read, sessions:write and runs:drive, and its ceiling, preset acceptEdits;
 * then a pairing code made with them explicit (`access.pairings.create`),
 * shown once with what it grants until it expires. The program's own
 * client session, once it has exchanged the code, is listed beside the
 * others.
 */
export const ProgramPairing = ({ view, writable }: { readonly view: EnvironmentView; readonly writable: boolean }) => {
  const [scopes, setScopes] = useState<readonly Scope[]>(PROGRAM.scopes);
  const [ceiling, setCeiling] = useState<Ceiling>(PROGRAM.ceiling);
  const legend = useId();
  const ceilingId = useId();
  const tick = (scope: Scope, on: boolean) => setScopes((now) => SCOPES.filter((held) => (held === scope ? on : now.includes(held))));
  return (
    <div role="group" aria-labelledby={legend} className="flex flex-col gap-2 rounded-lg border border-hairline bg-panel p-3">
      <h4 id={legend} className="text-xs font-semibold text-ink-muted">
        Pair a program
      </h4>
      <div role="group" aria-label="Scopes" className="flex flex-wrap gap-3">
        {SCOPES.map((scope) => (
          <label key={scope} className="flex items-center gap-1.5 font-mono text-2xs text-ink">
            <Checkbox aria-label={scope} title={`${scope} (Space)`} checked={scopes.includes(scope)} disabled={!writable} onCheckedChange={(on) => tick(scope, on === true)} />
            {scope}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={ceilingId} className="text-xs text-ink-muted">
          Ceiling
        </label>
        <Select title="Ceiling (Arrow keys)" id={ceilingId} value={ceiling} disabled={!writable} onChange={(event) => setCeiling(event.target.value as Ceiling)}>
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </Select>
      </div>
      {scopes.length === 0 && <p className="text-xs text-ink-faint">Tick at least one scope.</p>}
      <PairingCode view={view} writable={writable && scopes.length > 0} grant={{ scopes, ceiling }} action="Make a program's pairing code" grantShown />
    </div>
  );
};
