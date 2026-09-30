import { INJECTION_WORDS, overridesWith, saveSetting, uuidv7, type EnvironmentView } from "@agent-harness/client-runtime";
import { INJECTION_ANSWERS, type InjectionAnswer, type SettingsKey } from "@agent-harness/contracts";
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { nameOf } from "../connections/words.js";
import { Select } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";

/** An account's choice: its own answer, or the environment's (`inherit`, no entry in the map). */
type AccountChoice = InjectionAnswer | "inherit";

/** A write's answer, shown over the cached settings until they are fetched again. */
interface Written {
  readonly over: string | null;
  readonly values: Readonly<Record<string, unknown>>;
}

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
  const clock = useClock();
  const heading = useId();
  const { environmentId } = view;
  const settings = useObservable(useMemo(() => runtime.requests.cached(environmentId, "settings.get", {}), [runtime, environmentId]));
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId])).value ?? [];
  const [written, setWritten] = useState<Written | undefined>(undefined);
  const [line, setLine] = useState<string | undefined>(undefined);
  const fetchedAt = useRef(settings.fetchedAt);
  useLayoutEffect(() => {
    fetchedAt.current = settings.fetchedAt;
  });
  const read = settings.result?.values;
  if (read === undefined) return null;
  const values = written?.over === settings.fetchedAt ? { ...read, ...written.values } : read;
  const answer = (values["credentials.injection"] as InjectionAnswer | undefined) ?? "allow";
  const overrides = (values["credentials.injectionByAccount"] as Readonly<Record<string, InjectionAnswer>> | undefined) ?? {};
  const writable = view.phase === "ready" && runtime.capability(environmentId, "settings.update").status === "present";

  const save = (key: SettingsKey, value: unknown) => {
    setLine(undefined);
    void saveSetting(runtime, environmentId, key, value, { commandId: uuidv7(clock.now()) }).then((saved) => {
      if (!saved.ok) return setLine(`Not saved: ${saved.line}`);
      const over = fetchedAt.current;
      setWritten((now) => ({ over, values: { ...(now?.over === over ? now.values : {}), ...saved.values } }));
    });
  };

  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3 rounded-md border border-line p-4">
      <h3 id={heading} className="text-base font-semibold text-ink">
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
  <label className="flex items-center justify-between gap-3 text-sm text-ink">
    {label}
    <Select value={value} disabled={disabled} onChange={(event) => change(event.target.value as V)}>
      {children}
    </Select>
  </label>
);
