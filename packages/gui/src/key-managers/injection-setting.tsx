import { KeyRound } from "lucide-react";
import { INJECTION_SWITCH_WORDS, INJECTION_WORDS, overridesWith, type EnvironmentView } from "@agent-harness/client-runtime";
import { INJECTION_ANSWERS, type InjectionAnswer, type SettingsKey } from "@agent-harness/contracts";
import { useId, useMemo, useState, type ReactNode } from "react";
import { nameOf } from "../connections/words.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { Select, Switch, Tooltip } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

/** An account's choice: its own answer, or the environment's (`inherit`, no entry in the map). */
type AccountChoice = InjectionAnswer | "inherit";

/**
 * The injection setting (key-managers spec, "Injection"; ADR 0011, ADR
 * 0028; #367, #425): whether runs on the environment receive credentials
 * (`credentials.injection`, allow or deny), and each account's own answer
 * over it (`credentials.injectionByAccount`), an account with none taking
 * the environment's. Both are read from `settings.get` in the request cache
 * and written through `settings.update`; a routine's own answer outranks
 * both, and is the routine's to set.
 */
export const InjectionSetting = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const heading = useId();
  const { environmentId } = view;
  const { values, writable, save, line } = useInjection(view);
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId])).value ?? [];
  if (values === null) return null;
  const answer = (values["credentials.injection"] as InjectionAnswer | undefined) ?? "allow";
  const overrides = (values["credentials.injectionByAccount"] as Readonly<Record<string, InjectionAnswer>> | undefined) ?? {};

  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-3">
      <h3 id={heading} className="text-xs font-semibold text-ink">
        Injection
      </h3>
      <p className="text-sm text-ink-muted">
        Whether runs receive the key managers' variables and the forges' credentials. An account's own answer outranks the environment's, and a routine's outranks both.
      </p>
      <Choice label={`Runs on ${nameOf(view)}`} value={answer} disabled={!writable} change={(next) => save("credentials.injection", next)}>
        {INJECTION_ANSWERS.map((each) => (
          <option key={each} value={each}>
            {INJECTION_WORDS[each]}
          </option>
        ))}
      </Choice>
      {accounts.map((account) => (
        <Choice
          key={account.id}
          label={`Runs on ${account.label}`}
          value={overrides[account.id] ?? "inherit"}
          disabled={!writable}
          change={(next) => save("credentials.injectionByAccount", overridesWith(overrides, account.id, next === "inherit" ? null : next))}
        >
          <option value="inherit">As the environment: {INJECTION_WORDS[answer]}</option>
          {INJECTION_ANSWERS.map((each) => (
            <option key={each} value={each}>
              {INJECTION_WORDS[each]}
            </option>
          ))}
        </Choice>
      ))}
      {line !== undefined && <p className="text-sm text-signal">{line}</p>}
    </section>
  );
};

/**
 * The injection setting's values as `settings.get` holds them, whether this
 * client may write them (the environment reached, with `settings.update`),
 * a write through `settings.update`, and the one line a refused write said.
 */
const useInjection = (view: EnvironmentView) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const settings = useSettingsValues(environmentId);
  const [line, setLine] = useState<string | undefined>(undefined);
  const writable = view.phase === "ready" && runtime.capability(environmentId, "settings.update").status === "present";
  const save = (key: SettingsKey, value: unknown) => {
    setLine(undefined);
    void settings.save(key, value).then((saved) => !saved.ok && setLine(`Not saved: ${saved.line}`));
  };
  return { values: settings.values, writable, save, line };
};

/**
 * The injection switch on the Key manager card (the Set up specification,
 * "5. Key manager"; ADR 0028; #590): `credentials.injection` as a switch,
 * on for `allow` (its preset), beside its sentence, written through
 * `settings.update`. Each account's own answer is the Key managers row's
 * Injection, and a routine's the routine's.
 */
export const InjectionSwitch = ({ view }: { readonly view: EnvironmentView }) => {
  const label = useId();
  const { values, writable, save, line } = useInjection(view);
  if (values === null) return null;
  const on = ((values["credentials.injection"] as InjectionAnswer | undefined) ?? "allow") === "allow";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3 text-sm text-ink">
        <Tooltip content="Give runs credentials" keys="Space to toggle">
          <Switch aria-labelledby={label} checked={on} disabled={!writable} onCheckedChange={(next) => save("credentials.injection", next ? "allow" : "deny")} />
        </Tooltip>
        <KeyRound aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
        <span id={label}>{INJECTION_SWITCH_WORDS}</span>
      </div>
      {line !== undefined && <p className="text-sm text-signal">{line}</p>}
    </div>
  );
};

/** One answer's choice, labelled by whose runs it decides. */
const Choice = <V extends AccountChoice>({
  label,
  value,
  disabled,
  change,
  children,
}: {
  readonly label: string;
  readonly value: V;
  readonly disabled: boolean;
  readonly change: (next: V) => void;
  readonly children: ReactNode;
}) => (
  <Tooltip content={label} keys="Arrow keys to choose">
    <label className="flex min-w-0 flex-col gap-2 text-xs text-ink">
      <span className="inline-flex items-center gap-2"><KeyRound aria-hidden="true" className="size-3.5" />{label}</span>
      <Select value={value} disabled={disabled} onChange={(event) => change(event.target.value as V)}>
        {children}
      </Select>
    </label>
  </Tooltip>
);
