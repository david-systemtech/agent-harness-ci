import { useId, useState } from "react";
import { MODES, SCOPES, compareModes, pairingPreset, type Ceiling, type Scope } from "@agent-harness/contracts";
import type { AccessOutcome, ClientSessionSummary, EnvironmentView } from "@agent-harness/client-runtime";
import { Button, Checkbox, Dialog, DialogContent, Select } from "../ui/index.js";
import { DialogFooter } from "../ui/dialog.js";
import "./change-access.css";

const SCOPE_WORDS: Record<Scope, string> = { read: "Read sessions", "sessions:write": "Organise sessions", "runs:drive": "Start runs and answer prompts", terminal: "Use terminals, files and diffs", admin: "Manage settings and access" };
export const accessInWords = (scopes: readonly Scope[], ceiling: Ceiling): string =>
  `${scopes.map((scope) => SCOPE_WORDS[scope]).join("; ")}. Run ceiling: ${ceiling}.`;

/** The environment checks these bounds again when saving; this form never edits this client's own grant. */
export const ChangeAccess = ({ session, view, writable, close, save }: {
  readonly session: ClientSessionSummary;
  readonly view: EnvironmentView;
  readonly writable: boolean;
  readonly close: () => void;
  readonly save: (grant: { readonly scopes: readonly Scope[]; readonly ceiling: Ceiling }) => Promise<AccessOutcome | undefined>;
}) => {
  const [preset, setPreset] = useState("custom");
  const [scopes, setScopes] = useState<readonly Scope[]>(session.scopes);
  const [ceiling, setCeiling] = useState<Ceiling>(session.ceiling);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const presetId = useId();
  const ceilingId = useId();
  const holds = (grant: { readonly scopes: readonly Scope[]; readonly ceiling: Ceiling }) => view.ceiling !== null && compareModes(grant.ceiling, view.ceiling) <= 0 && grant.scopes.every((scope) => view.scopes.includes(scope));
  const allowed = writable && !saving && scopes.length > 0 && holds({ scopes, ceiling });
  const submit = async () => {
    if (!allowed) return;
    setSaving(true);
    try {
      const outcome = await save({ scopes, ceiling });
      if (outcome && !outcome.ok) setError(outcome.line);
    } finally { setSaving(false); }
  };
  return <Dialog open onOpenChange={(open) => !open && !saving && close()}>
    <DialogContent data-change-access title={`Change access for ${session.label}`} description="The new access applies without pairing again. Existing connections reconnect; running runs keep their resolved policy." showClose={!saving} onEscapeKeyDown={(event) => { if (saving) event.preventDefault(); }} onPointerDownOutside={(event) => { if (saving) event.preventDefault(); }}>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto" data-access-form>
        <label htmlFor={presetId} className="text-sm">Access preset</label>
        <Select id={presetId} value={preset} disabled={saving || !writable} onChange={(event) => {
          const id = event.target.value;
          setPreset(id); setError(undefined);
          if (id === "own-client" || id === "phone") { const grant = pairingPreset(id); setScopes(grant.scopes); setCeiling(grant.ceiling); }
        }}>
          <option value="own-client" disabled={!holds(pairingPreset("own-client"))}>Full access</option>
          <option value="phone" disabled={!holds(pairingPreset("phone"))}>Restricted phone</option>
          <option value="custom">Custom</option>
        </Select>
        {preset === "custom" && <>
          <div role="group" aria-label="Scopes" className="flex flex-col gap-1">
            {SCOPES.map((scope) => <label key={scope} className="flex items-center gap-2 text-sm">
              <Checkbox aria-label={scope} checked={scopes.includes(scope)} disabled={saving || !writable || (!view.scopes.includes(scope) && !scopes.includes(scope))} onCheckedChange={(on) => setScopes((now) => SCOPES.filter((held) => held === scope ? on === true : now.includes(held)))} />
              {SCOPE_WORDS[scope]}
            </label>)}
          </div>
          <label htmlFor={ceilingId} className="text-sm">Run ceiling</label>
          <Select id={ceilingId} value={ceiling} disabled={saving || !writable} onChange={(event) => setCeiling(event.target.value as Ceiling)}>
            {MODES.map((mode) => <option key={mode} value={mode} disabled={view.ceiling === null || compareModes(mode, view.ceiling) > 0}>{mode}</option>)}
          </Select>
        </>}
        <p className="text-sm text-ink-muted">{accessInWords(scopes, ceiling)}</p>
        {!holds({ scopes, ceiling }) && <p className="text-sm text-amber">Another admin client must grant access above this client's scopes or run ceiling.</p>}
        {scopes.length === 0 && <p className="text-sm text-amber">Choose at least one scope.</p>}
        {ceiling === "bypassPermissions" && <p className="text-sm text-amber">The agent will act without asking and can do anything this account can, within the containment you chose.</p>}
        {error && <p role="alert" className="text-sm text-signal">{error}</p>}
      </div>
      <DialogFooter><Button disabled={saving} onClick={close}>Cancel</Button><Button disabled={!allowed} onClick={() => void submit()}>Save access</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
};
