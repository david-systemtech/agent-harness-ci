import { CEILING_CHOICES, CANNOT_GIVE_MORE, SCOPE_TICKS, ceilingAboveOwn, offeredPresets, type EnvironmentView } from "@agent-harness/client-runtime";
import { SCOPES, pairingPreset, presetGrant, type Ceiling, type PairingPresetId, type Scope } from "@agent-harness/contracts";
import { useState, type ReactNode } from "react";
import { ChoiceList, type SettingsChoice } from "../settings/part.js";
import { Checkbox, Fold } from "../ui/index.js";
import { PairingCode } from "./pairing-code.js";

/**
 * Who a pairing code is for (setup-copy.md §5.5, "Add a device"; ADR 0025;
 * #577, #1847): Me, pre-selected, a phone with limited access, or a program
 * or bot, whose agents' freedom is one of the four plain mode choices; under
 * More options, Custom, its access ticked and its choice made. A choice
 * above what this client's own session on the environment holds is dim,
 * with why in words, and so is each mode above its own, since a code grants
 * at most its minter's (#180). The code is made with the scopes and ceiling
 * explicit; `warning`, where the computer has one, sits above its button.
 */
export const PresetPairing = ({ view, writable, warning }: { readonly view: EnvironmentView; readonly writable: boolean; readonly warning?: ReactNode }) => {
  const offered = offeredPresets(view.ceiling, view.scopes);
  const [chosen, choose] = useState<PairingPresetId>(offered.preset.id);
  const [ceilings, pickCeiling] = useState<Partial<Record<PairingPresetId, Ceiling>>>({});
  const [ticked, tick] = useState<readonly Scope[]>(pairingPreset("custom").scopes);
  const [more, setMore] = useState(false);

  // A choice made before this client's own access was known may be dim now: the one offered first stands in for it.
  const current = offered.presets.some(({ preset, dim }) => preset.id === chosen && dim === null) ? chosen : offered.preset.id;
  const preset = pairingPreset(current);
  const ceiling = ceilings[current] ?? preset.ceiling;
  const grant = presetGrant(preset, {
    ...(preset.chooses !== "nothing" && { ceiling }),
    ...(preset.chooses === "scopes-and-ceiling" && { scopes: ticked }),
  });
  // A minted code belongs to this computer and grant; changing either starts with no displayed code.
  const codeKey = grant.ok ? `${view.environmentId}/${grant.ceiling}/${grant.scopes.join(",")}` : `${view.environmentId}/invalid`;
  const held = (scope: Scope) => view.scopes.includes(scope);
  const missing = grant.ok && grant.scopes.some((scope) => !held(scope));
  const above = ceilingAboveOwn(ceiling, view.ceiling);
  const setTicked = (scope: Scope, on: boolean) => tick((now) => SCOPES.filter((kept) => (kept === scope ? on : now.includes(kept))));
  const choicesOf = (ids: readonly PairingPresetId[]): readonly SettingsChoice[] =>
    offered.presets.filter(({ preset: offer }) => ids.includes(offer.id)).map(({ preset: offer, label, note, dim }) => ({
      value: offer.id, label, note: note ?? "",
      ...(!writable ? { disabledReason: "You can look but not change this." } : dim !== null ? { disabledReason: dim } : {}),
    }));
  const ceilingChoice = (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink">How much may its agents do without asking?</p>
      <ChoiceList label="How much may its agents do without asking?" value={ceiling} onValueChange={(value) => pickCeiling((now) => ({ ...now, [current]: value as Ceiling }))} choices={CEILING_CHOICES.map(({ mode, label, note }) => ({
        value: mode, label, note,
        ...(!writable ? { disabledReason: "You can look but not change this." } : ceilingAboveOwn(mode, view.ceiling) !== null ? { disabledReason: CANNOT_GIVE_MORE } : {}),
      }))} />
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink">Who is it for?</p>
      <ChoiceList label="Who is it for?" value={current} choices={choicesOf(["own-client", "phone", "program"])} onValueChange={(value) => choose(value as PairingPresetId)} />
      {preset.chooses === "ceiling" && ceilingChoice}
      <Fold summary="More options" open={more || preset.chooses === "scopes-and-ceiling"} onOpenChange={setMore}>
        <div className="flex flex-col gap-2">
          <ChoiceList label="Custom access" value={current} choices={choicesOf(["custom"])} onValueChange={(value) => choose(value as PairingPresetId)} />
          {preset.chooses === "scopes-and-ceiling" && (
            <>
              <div role="group" aria-label="What it can do" data-pairing-scopes className="flex flex-col gap-1.5 px-1.5">
                {SCOPES.map((scope) => (
                  <label key={scope} className="flex items-center gap-1.5 text-xs text-ink">
                    <Checkbox aria-label={SCOPE_TICKS[scope]} title={`${SCOPE_TICKS[scope]} (Space)`} checked={ticked.includes(scope)} disabled={!writable || !held(scope)} onCheckedChange={(on) => setTicked(scope, on === true)} />
                    <span className="min-w-0">{SCOPE_TICKS[scope]}</span>
                    {!held(scope) && <span className="min-w-0 text-ink-faint">{CANNOT_GIVE_MORE}</span>}
                  </label>
                ))}
              </div>
              {ceilingChoice}
            </>
          )}
        </div>
      </Fold>
      {!grant.ok && <p className="text-xs text-ink-faint">Tick at least one thing it can do.</p>}
      {(above !== null || missing) && <p className="text-xs text-ink-faint">{CANNOT_GIVE_MORE}</p>}
      <PairingCode key={codeKey} view={view} writable={writable && grant.ok && above === null && !missing} grant={grant.ok ? grant : preset} warning={warning} forDevice={current !== "program"} />
    </div>
  );
};
