import { SettingsCardGrid } from "../settings/part.js";
import {
  NO_PLAN_READING,
  NO_WINDOWS_READ,
  gaugeWho,
  pooledWords,
  readingsOf,
  resetWords,
  windowWords,
  type EnvironmentAnswer,
  type EnvironmentView,
  type UsageGauge,
} from "@agent-harness/client-runtime";
import { settingsRow, type AccountUsage } from "@agent-harness/contracts";
import { useId, useMemo } from "react";
import { nameOf } from "../connections/words.js";
import { reachWords } from "../settings/generic-editor.js";
import { WindowReading } from "../status/window-reading.js";
import { useObservable, useRuntime } from "../window-context.js";

/**
 * Usage, `accounts.usage` (docs/specs/gui.md, "Settings"; ADR 0005, ADR
 * 0018, ADR 0027; #414), an `everywhere` row: every gauge of
 * `projections.usage`, the readings of every environment pooled by account
 * identity, so one login signed in on two environments is one gauge. Each is
 * headed by who it pools, lists the accounts it pools by label and
 * environment, then each window with its bar, percent and reset, or the
 * reason it has none. Under the gauges, each environment not reached (its
 * readings pooled as this window last read them) or whose read failed. The
 * row writes nothing, so it has no read-only line.
 */
export const UsagePane = () => {
  const runtime = useRuntime();
  const usage = useObservable(runtime.projections.usage);
  const views = useObservable(runtime.projections.environments);
  return (
    <>
      <p className="text-2xs leading-relaxed text-ink-faint">{settingsRow("accounts.usage").hint}</p>
      {usage.gauges.length === 0 && <p className="text-sm text-ink-faint">{NO_PLAN_READING}</p>}
      <SettingsCardGrid>{usage.gauges.map((gauge) => (
        <Gauge key={gauge.accounts.map(({ environmentId, accountId }) => `${environmentId} ${accountId}`).join(" ")} gauge={gauge} views={views} />
      ))}</SettingsCardGrid>
      {usage.environments.map((answer) => (
        <EnvironmentLine key={answer.environmentId} answer={answer} view={views.find((view) => view.environmentId === answer.environmentId)} />
      ))}
    </>
  );
};

/** One gauge: who it pools, the accounts it pools, and its windows or why it has none. */
const Gauge = ({ gauge, views }: { readonly gauge: UsageGauge; readonly views: readonly EnvironmentView[] }) => {
  const heading = useId();
  const readings = readingsOf(gauge);
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2 rounded-lg border border-hairline bg-panel p-3">
      <h3 id={heading} className="text-sm font-medium text-ink">
        {gaugeWho(gauge)}
      </h3>
      <ul aria-label="Accounts" className="flex flex-wrap gap-x-3 text-2xs text-ink-muted">
        {gauge.accounts.map(({ environmentId, accountId }) => {
          const view = views.find((each) => each.environmentId === environmentId);
          return <PooledAccount key={`${environmentId} ${accountId}`} environmentId={environmentId} accountId={accountId} environment={view === undefined ? "an environment" : nameOf(view)} />;
        })}
      </ul>
      {readings.length === 0 ? (
        <p className="text-sm text-ink-faint">{gauge.unavailableReason ?? NO_WINDOWS_READ}</p>
      ) : (
        <ul aria-label="Windows" className="flex flex-col gap-1 text-sm text-ink">
          {readings.map((reading) => {
            const reset = resetWords(reading.resetsAt);
            return (
              <li key={reading.window} className="flex flex-wrap items-center gap-2">
                <span className="w-20">{`${windowWords(reading.window)} `}</span>
                <WindowReading reading={reading} />
                {reset !== undefined && <span className="text-2xs text-ink-faint">, {reset}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

/** An account a gauge pools, by its label as its environment's `accounts.list` has it (its id until that is read) and the environment's name. */
const PooledAccount = ({ environmentId, accountId, environment }: { readonly environmentId: string; readonly accountId: string; readonly environment: string }) => {
  const runtime = useRuntime();
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const label = accounts.value?.find((account) => account.id === accountId)?.label ?? accountId;
  return <li>{pooledWords(label, environment)}</li>;
};

/** An environment whose readings are not fresh: not reached, its readings as last read; or its read failed. Nothing otherwise. */
const EnvironmentLine = ({ answer, view }: { readonly answer: EnvironmentAnswer<readonly AccountUsage[]>; readonly view: EnvironmentView | undefined }) => {
  const runtime = useRuntime();
  if (view === undefined) return null;
  if (view.phase !== "ready") {
    const read = answer.value === null ? "this window has read none of its readings." : "its readings as this window last read them.";
    return <p className="text-sm text-amber">{`${nameOf(view)}: ${reachWords(runtime, view)}: ${read}`}</p>;
  }
  return answer.error === null ? null : <p className="text-sm text-amber">{`${nameOf(view)}: ${answer.error.message}`}</p>;
};
