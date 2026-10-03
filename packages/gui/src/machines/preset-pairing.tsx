import { ceilingAboveOwn, offeredPresets, type EnvironmentView } from "@agent-harness/client-runtime";
import { MODES, SCOPES, pairingPreset, presetGrant, type Ceiling, type PairingPresetId, type Scope } from "@agent-harness/contracts";
import { useId, useState } from "react";
import { nameOf } from "../connections/words.js";
import { ChoiceList } from "../settings/part.js";
import { Checkbox, Select } from "../ui/index.js";
import { PairingCode } from "./pairing-code.js";

/**
 * Pair another client from a Your machines card (ADR 0025; the Set up spec,
 * "Pairing codes"; #577): the contracts' presets as a choice, my own client
 * preset; a program's ceiling picked, preset acceptEdits; a custom code's
 * scopes ticked and ceiling picked. A preset whose ceiling is above the one
 * this client's own session holds on the environment is dim with the
 * reason, and so is each ceiling above it in a picker, since a code grants
 * at most its minter's (#180). The code is made with the scopes and ceiling
 * explicit, and said beside it with its countdown.
 */
export const PresetPairing = ({ view, writable }: { readonly view: EnvironmentView; readonly writable: boolean }) => {
  const environment = nameOf(view);
  const offered = offeredPresets(view.ceiling, environment);
  const [chosen, choose] = useState<PairingPresetId>(offered.preset.id);
  const [ceilings, pickCeiling] = useState<Partial<Record<PairingPresetId, Ceiling>>>({});
  const [ticked, tick] = useState<readonly Scope[]>(pairingPreset("custom").scopes);
  const ceilingId = useId();

  // A choice made before this client's own ceiling was known may be dim now: the one offered first stands in for it.
  const current = offered.presets.some(({ preset, dim }) => preset.id === chosen && dim === null) ? chosen : offered.preset.id;
  const preset = pairingPreset(current);
  const ceiling = ceilings[current] ?? preset.ceiling;
  const grant = presetGrant(preset, {
    ...(preset.chooses !== "nothing" && { ceiling }),
    ...(preset.chooses === "scopes-and-ceiling" && { scopes: ticked }),
  });
  const above = ceilingAboveOwn(ceiling, view.ceiling, environment);
  const setTicked = (scope: Scope, on: boolean) => tick((now) => SCOPES.filter((held) => (held === scope ? on : now.includes(held))));

  return (
    <div className="flex flex-col gap-2">
      <ChoiceList label="What the code grants" value={current} choices={offered.presets.map(({ preset: offer, words, dim }) => ({
        value: offer.id, label: offer.name, note: words,
        ...(!writable ? { disabledReason: "Read-only on this environment." } : dim !== null ? { disabledReason: dim } : {}),
      }))} onValueChange={(value) => choose(value as PairingPresetId)} />
      {preset.chooses === "scopes-and-ceiling" && (
        <div role="group" aria-label="Scopes" className="flex flex-wrap gap-3">
          {SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-1.5 font-mono text-2xs text-ink">
              <Checkbox aria-label={scope} title={`${scope} (Space)`} checked={ticked.includes(scope)} disabled={!writable} onCheckedChange={(on) => setTicked(scope, on === true)} />
              {scope}
            </label>
          ))}
        </div>
      )}
      {preset.chooses !== "nothing" && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={ceilingId} className="text-xs text-ink-muted">
            Ceiling
          </label>
          <Select title="Ceiling (Arrow keys)" id={ceilingId} value={ceiling} disabled={!writable} onChange={(event) => pickCeiling((now) => ({ ...now, [current]: event.target.value as Ceiling }))}>
            {MODES.map((mode) => (
              <option key={mode} value={mode} disabled={ceilingAboveOwn(mode, view.ceiling, environment) !== null}>
                {mode}
              </option>
            ))}
          </Select>
        </div>
      )}
      {!grant.ok && <p className="text-xs text-ink-faint">{grant.message}</p>}
      {above !== null && <p className="text-xs text-ink-faint">{above}</p>}
      <PairingCode view={view} writable={writable && grant.ok && above === null} grant={grant.ok ? grant : preset} />
    </div>
  );
};
