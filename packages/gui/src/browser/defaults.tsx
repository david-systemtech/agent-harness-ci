import type { BrowserRow, EnvironmentView } from "@agent-harness/client-runtime";
import { BrowserReach, PRODUCT_NAME, type BrowserReachChoice } from "@agent-harness/contracts";
import { useMemo, useRef, useState } from "react";
import { useWindowAction } from "../keys/key-dispatch.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { Select } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

/** Reach belongs to each account's environment; read it again before replacing one account's entry. */
export const BrowserDefaults = ({ view, rows }: { readonly view: EnvironmentView; readonly rows: readonly BrowserRow[] }) => {
  const runtime = useRuntime();
  const { values, save } = useSettingsValues(view.environmentId);
  const environments = useObservable(runtime.projections.environments);
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(view.environmentId), [runtime, view.environmentId]));
  const capability = runtime.capability(view.environmentId, "settings.update");
  const form = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [line, say] = useState<string | null>(null);
  useWindowAction("app.browser.default", () => form.current?.querySelector<HTMLSelectElement>("select:not(:disabled)")?.focus(), capability);
  const reach = BrowserReach.safeParse(values?.["browser.reach"]).data ?? {};
  const options = rows.flatMap((row) => row.value?.kind === "chrome" ? [{ row, value: { chrome: { environmentId: row.value.environmentId, chromeId: row.value.chromeId } } }] : []);
  for (const option of [...options]) {
    const environmentId = option.value.chrome.environmentId;
    if (options.some((other) => other.value.chrome.environmentId === environmentId && other.value.chrome.chromeId === null)) continue;
    options.push({ row: { ...option.row, label: `My Chrome (${PRODUCT_NAME} extension) on ${environments.find((environment) => environment.environmentId === environmentId)?.name ?? environmentId}` }, value: { chrome: { environmentId, chromeId: null } } });
  }
  const choose = async (accountId: string, label: string, choice: BrowserReachChoice) => {
    setBusy(true);
    const read = await runtime.requests.call(view.environmentId, "settings.get", { keys: ["browser.reach"] });
    const current = read.ok ? BrowserReach.safeParse(read.result.values["browser.reach"]).data : undefined;
    if (current === undefined) {
      say(`Default browser not saved: ${read.ok ? "The browser reach settings could not be read." : read.error.message}`);
    } else {
      const saved = await save("browser.reach", { ...current, [accountId]: choice });
      say(saved.ok ? `Default browser saved for ${label}.` : `Default browser not saved: ${saved.line}`);
    }
    setBusy(false);
  };
  return (
    <section ref={form} aria-label="Per-account default browser" className="flex flex-col gap-2">
      <h3>Per-account default browser</h3>
      <p>Per-session: no Chrome until one is chosen in the session. Chrome always: this Chrome for every new session of the account.</p>
      {accounts.value?.map((account) => {
        const chosen = reach[account.id] ?? "per-session";
        const missing = chosen !== "per-session" && !options.some((option) => option.value.chrome.environmentId === chosen.chrome.environmentId && option.value.chrome.chromeId === chosen.chrome.chromeId);
        const drivable = chosen !== "per-session" && (chosen.chrome.environmentId === view.environmentId || environments.some((environment) => environment.kind === "local" && environment.environmentId === chosen.chrome.environmentId));
        return <label key={account.id} className="flex flex-col gap-1">{account.label}
          <Select aria-label={`Default browser for ${account.label}`} value={JSON.stringify(chosen)} disabled={capability.status === "absent" || values === null || busy}
            onChange={(event) => {
              const choice = BrowserReach.parse({ [account.id]: JSON.parse(event.target.value) })[account.id];
              if (choice !== undefined) void choose(account.id, account.label, choice);
            }}>
            <option value={JSON.stringify("per-session")}>Per-session</option>
            {options.map(({ row, value }, index) => <option key={index} value={JSON.stringify(value)} disabled={row.unavailable !== null}>{row.label}{row.unavailable !== null && ` — ${row.unavailable.message}`}</option>)}
            {missing && <option value={JSON.stringify(chosen)} disabled>{drivable ? "My Chrome — no longer paired. Pair it again or choose another browser." : "My Chrome on another machine — no local client can drive it here, or it is no longer paired."}</option>}
          </Select>
        </label>;
      })}
      {capability.status === "absent" && <p>{capability.message}</p>}
      {line !== null && <p role="status">{line}</p>}
    </section>
  );
};
