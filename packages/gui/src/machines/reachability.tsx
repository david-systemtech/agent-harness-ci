import { RefreshCw, Network, Radio, type LucideIcon } from "lucide-react";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import type { EnvironmentBinding, SettingsKey } from "@agent-harness/contracts";
import { useId, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { nameOf } from "../connections/words.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { Button, Select, Switch } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

/** Loopback alone, with the tailnet switch on: ADR 0025's standing notice, never a failure. */
const TAILSCALE_WARNING = "No Tailscale address found. This machine is reachable only from itself. Install Tailscale to reach it from your other devices.";

/** Installation known by newer environments; older ones retain the generic notice. */
const tailscaleWarning = (installed: boolean | undefined): string => installed === true
  ? "Tailscale is installed, but its address could not be read. This machine is reachable only from itself. Check that Tailscale is running and signed in, then check again."
  : installed === false
    ? "Tailscale is not installed. This machine is reachable only from itself. Install Tailscale to reach it from your other devices."
    : TAILSCALE_WARNING;

/** What binding a LAN address opens the environment to. */
const LAN_WARNING = "Anyone on this network could try to reach it; it still needs a paired client.";

/** How the environment is reached beside loopback, a line for each address it binds; none for loopback alone. */
const reachedLines = (binding: EnvironmentBinding): readonly string[] => [
  ...(binding.tailnet === null
    ? []
    : [`Reachable on the tailnet at ${binding.tailnet.name === null ? binding.tailnet.address : `${binding.tailnet.name} (${binding.tailnet.address})`}.`]),
  ...(binding.lan === null ? [] : [`Reachable on the LAN at ${binding.lan}.`]),
];

/**
 * How an environment is reached, on its Your machines card (the Set up
 * specification, "3. Your machines"; ADR 0025; #576): the tailnet name and
 * address and the LAN address it binds, from `environment.status` in the
 * request cache, so an unreachable environment's is what this window last
 * read. Loopback alone says the Tailscale warning with Check again, which
 * reads the status again, or, once the environment finds a Tailscale address
 * it did not bind at its start, that it binds it at its next start (#861); a
 * notice, never a failure. Under it the two
 * binding switches, `network.bindTailnet` and `network.bindLan`, each
 * written through `settings.update` and applied at the environment's next
 * start, the LAN switch naming the address it would bind (a choice among
 * them where the machine holds more than one) with its warning.
 */
export const Reachability = ({ view, writable }: { readonly view: EnvironmentView; readonly writable: boolean }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const status = useObservable(useMemo(() => runtime.requests.cached(environmentId, "environment.status", {}), [runtime, environmentId]));
  const settings = useSettingsValues(environmentId);
  const [line, setLine] = useState<string | undefined>(undefined);
  const name = nameOf(view);
  const binding = status.result?.binding;
  const values = settings.values;
  const ready = view.phase === "ready";

  const save = (key: SettingsKey, value: unknown) => {
    setLine(undefined);
    void settings.save(key, value).then((saved) => !saved.ok && setLine(`Not saved: ${saved.line}`));
  };

  return (
    <div className="flex flex-col gap-2 text-sm">
      {binding === undefined ? (
        ready && status.result === null && <p className="text-ink-faint">{status.error === null ? `Reading how ${name} is reached…` : `How ${name} is reached could not be read: ${status.error.message}`}</p>
      ) : (
        <Reached
          binding={binding}
          name={name}
          tailnetOff={values?.["network.bindTailnet"] === false}
          recheck={ready ? () => runtime.requests.refresh(environmentId, "environment.status", {}) : undefined}
        />
      )}
      {values !== null && "network.bindTailnet" in values && (
        <>
          <TailnetSwitch on={values["network.bindTailnet"] === true} writable={writable} save={(on) => save("network.bindTailnet", on)} />
          <LanSwitch
            bound={typeof values["network.bindLan"] === "string" ? values["network.bindLan"] : null}
            addresses={binding?.lanAddresses ?? []}
            writable={writable}
            save={(address) => save("network.bindLan", address)}
          />
          <p className="text-ink-muted">Both switches apply at {name}&apos;s next start.</p>
        </>
      )}
      {line !== undefined && <p className="text-signal">{line}</p>}
    </div>
  );
};

interface ReachedProps {
  readonly binding: EnvironmentBinding;
  /** The environment's name, which the line for a Tailscale address found since its start names. */
  readonly name: string;
  readonly tailnetOff: boolean;
  readonly recheck: (() => void) | undefined;
}

/**
 * What the environment binds beside loopback, or loopback alone with Check
 * again: the Tailscale warning, or, for a Tailscale address found since its
 * start, that it binds it at its next start (#861).
 */
const Reached = ({ binding, name, tailnetOff, recheck }: ReachedProps) => {
  const lines = reachedLines(binding);
  if (lines.length > 0) {
    return (
      <div className="flex flex-col gap-0.5 text-ink">
        {lines.map((reached) => (
          <p key={reached}>{reached}</p>
        ))}
      </div>
    );
  }
  // With its tailnet switch off, finding no address is not what kept it to loopback.
  if (tailnetOff) return <p className="text-ink">Reachable only from itself: binding its tailnet address is off.</p>;
  const found = binding.tailnetFound ?? null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {found === null ? <p className="text-amber">{tailscaleWarning(binding.tailscaleInstalled)}</p> : <p className="text-ink">{`Tailscale address ${found} found: ${name} binds it at its next start.`}</p>}
      <Button disabled={recheck === undefined} onClick={recheck} title="Check again (Enter or Space)">
        <RefreshCw aria-hidden="true" data-icon="inline-start" />Check again
      </Button>
    </div>
  );
};

/** `network.bindTailnet`: whether the environment binds its tailnet address, when one is found. */
const TailnetSwitch = ({ on, writable, save }: { readonly on: boolean; readonly writable: boolean; readonly save: (on: boolean) => void }) => (
  <SwitchRow icon={Radio} words="Bind the tailnet address" title="Bind the tailnet address (Space)" checked={on} disabled={!writable} onCheckedChange={save} />
);

interface SwitchRowProps extends Omit<ComponentProps<typeof Switch>, "id" | "aria-labelledby" | "children"> {
  readonly icon: LucideIcon;
  readonly words: string;
  /** What else the row holds, after the label. */
  readonly children?: ReactNode;
}

/** A binding switch in its wash box, its label (icon and words) right after it and toggling it too (#1728). */
const SwitchRow = ({ icon: Icon, words, children, ...props }: SwitchRowProps) => {
  const control = useId();
  const label = useId();
  return (
    <span className="flex flex-wrap items-center gap-2 rounded-md bg-wash p-3">
      <Switch id={control} aria-labelledby={label} {...props} />
      <label id={label} htmlFor={control} className="flex min-w-0 items-center gap-2 text-xs text-ink">
        <Icon aria-hidden="true" className="size-4 shrink-0" />{words}
      </label>
      {children}
    </span>
  );
};

interface LanSwitchProps {
  /** The LAN address `network.bindLan` names; null while it is off. */
  readonly bound: string | null;
  /** The LAN addresses the machine holds, as `environment.status` last said. */
  readonly addresses: readonly string[];
  readonly writable: boolean;
  readonly save: (address: string | null) => void;
}

/**
 * `network.bindLan`: the switch named for the address it would bind, the
 * one bound, else the one picked among those the machine holds, else the
 * first; with more than one, a choice among them, which while it is on
 * binds the one chosen instead.
 */
const LanSwitch = ({ bound, addresses, writable, save }: LanSwitchProps) => {
  const [picked, pick] = useState<string | undefined>(undefined);
  const choices = bound === null || addresses.includes(bound) ? addresses : [bound, ...addresses];
  const address = bound ?? (picked !== undefined && addresses.includes(picked) ? picked : addresses[0]);
  return (
    <div className="flex flex-col gap-1">
      <SwitchRow icon={Network} words={address === undefined ? "Bind a LAN address" : `Bind ${address} on the LAN`} title="Bind a LAN address (Space)" checked={bound !== null} disabled={!writable || address === undefined} onCheckedChange={(on) => save(on ? (address ?? null) : null)}>
        {choices.length > 1 && (
          <Select title="LAN address (Arrow keys)" aria-label="LAN address" value={address} disabled={!writable} onChange={(event) => (bound === null ? pick(event.target.value) : save(event.target.value))}>
            {choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </Select>
        )}
      </SwitchRow>
      {address === undefined && <p className="text-ink-muted">No LAN address found on this machine.</p>}
      {address?.includes(":") && <p className="text-ink-muted">An IPv6 address may change. If it does, choose an address this machine still holds.</p>}
      <p className="text-ink-muted">{LAN_WARNING}</p>
    </div>
  );
};
