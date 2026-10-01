import { adminCall, rowKeys, uuidv7, LOCAL_PLACEHOLDER_ID, type EnvironmentView } from "@agent-harness/client-runtime";
import { useMemo, useRef, useState } from "react";
import { useWindowAction } from "../keys/key-dispatch.js";
import { GenericEditor } from "../settings/generic-editor.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { Button } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { BrowserPairing } from "./browser-card.js";
import { BrowserDefaults } from "./defaults.js";
import { BrowserHeadless } from "./headless.js";

/** The Browser settings row reads the runtime's paired lists, retaining them while unreachable. */
export const BrowserSettingsPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <BrowserSettingsOn key={picked.environmentId} view={picked} />;
};
const BrowserSettingsOn = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const browser = useObservable(useMemo(() => runtime.projections.browsers(view.environmentId, ""), [runtime, view.environmentId]));
  const local = useObservable(runtime.projections.environments).find((environment) => environment.kind === "local" && environment.environmentId !== LOCAL_PLACEHOLDER_ID);
  const [pairing, pair] = useState<number | null>(null);
  const startPairing = () => pair((held) => (held ?? -1) + 1);
  const pairedList = useRef<HTMLElement>(null);
  const pairingOffer = local === undefined
    ? { status: "absent" as const, message: "Install agent-harness on this machine to pair your Chrome." }
    : runtime.capability(local.environmentId, "browser.pairing.code");
  useWindowAction("app.browser.pair", startPairing, pairingOffer);
  const [line, say] = useState<string | null>(null);
  const writable = browser.chromes.some((group) => group.chromes.length > 0 && runtime.capability(group.environmentId, "browser.chromes.unpair").status === "present");
  useWindowAction(
    "app.browser.unpair",
    () => pairedList.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(),
    writable ? { status: "present" } : { status: "absent", message: "The paired Chromes are read-only." },
  );
  const unpair = async (environmentId: string, id: string, name: string) => {
    const answer = await adminCall(() => runtime.requests.call(environmentId, "browser.chromes.unpair", { commandId: uuidv7(clock.now()), chromeId: id }));
    say(answer.ok ? `Unpaired ${name}.` : `Not unpaired: ${answer.line}`);
    if (answer.ok) runtime.requests.refresh(environmentId, "browser.chromes.list", {});
  };
  return (
    <>
      <section ref={pairedList} aria-label="Paired Chromes" className="flex flex-col gap-2">
        <h3>Paired Chromes</h3>
        {browser.chromes.map((group) => (
          <section key={group.environmentId} aria-label={`Chromes on ${group.name}`} className="flex flex-col gap-2">
            <h4>{group.name}</h4>
            {group.stale && <p className="text-amber">Cached paired Chromes — stale. {group.error ?? `${group.name} cannot be reached.`}</p>}
            {group.chromes.map((chrome) => (
              <div key={chrome.id} className="flex items-center gap-2">
                <div className="flex flex-1 flex-col">
                  <span>{chrome.name}</span>
                  <span className="text-xs text-ink-faint">{chrome.connected ? "Connected" : "Disconnected"} · Last seen: {chrome.lastConnectedAt}</span>
                </div>
                <Button
                  aria-label={`Unpair ${chrome.name}`}
                  disabled={runtime.capability(group.environmentId, "browser.chromes.unpair").status !== "present"}
                  onClick={() => void unpair(group.environmentId, chrome.id, chrome.name)}
                >
                  Unpair
                </Button>
              </div>
            ))}
            {group.chromes.length === 0 && <p>No paired Chrome{group.stale ? " is cached" : " yet"}.</p>}
          </section>
        ))}
      </section>
      <Button disabled={pairingOffer.status === "absent"} onClick={startPairing}>Pair another Chrome</Button>
      {pairingOffer.status === "absent" && <p>{pairingOffer.message}</p>}
      {pairing !== null && local !== undefined && (
        <section aria-label="Pair another Chrome" className="flex flex-col gap-3">
          <BrowserPairing environmentId={local.environmentId} accountsEnvironmentId={view.environmentId} another={pairing} />
          <Button onClick={() => pair(null)}>Close pairing</Button>
        </section>
      )}
      <BrowserHeadless view={view} status={browser.status} />
      <BrowserDefaults view={view} rows={browser.rows} />
      <GenericEditor view={view} keys={rowKeys("access.browser").filter((key) => key !== "browser.reach" && key !== "browser.headless.allowRuns")} />
      {line !== null && <p role="status">{line}</p>}
    </>
  );
};
