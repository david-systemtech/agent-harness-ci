import { environmentVersionWords, pendingUpdateWords, pinnedWords, updateEnvironment, updatesUnreadWords, uuidv7, type ActionOutcome, type EnvironmentView } from "@agent-harness/client-runtime";
import { RELEASE_CHANNELS, type MethodName, type SettingsKey } from "@agent-harness/contracts";
import { useId, useState } from "react";
import { nameOf } from "../connections/words.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { Button, Select, Switch } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";
import { useUpdatesStatus } from "./use-updates-status.js";

/** A channel as a person reads it. */
const CHANNEL_WORDS: Readonly<Record<(typeof RELEASE_CHANNELS)[number], string>> = { stable: "Stable", beta: "Beta" };

/**
 * An environment's update controls (launcher-update spec, "Settings,
 * methods, notices and flags"; ADR 0025, ADR 0026; #424), which About and
 * each Your machines card draw alike: the version it runs and its pending
 * update with what it waits on, from `updates.status`; its channel and
 * auto-update, from `settings.get` and set through `updates.settings.set`,
 * and a pin that holds it; and Update now, `updates.apply` when idle. What
 * Update now did, or why it or a write was not taken, is one line; a write
 * taken shows in its control, as in the generic editor. Each control is
 * read-only while the environment is not ready or the connection lacks its
 * method's scope; what holds the controls says why, once.
 */
export const UpdateControls = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const { environmentId } = view;
  const status = useUpdatesStatus(environmentId);
  const settings = useSettingsValues(environmentId);
  const [said, setSaid] = useState<ActionOutcome | undefined>(undefined);
  const channelLabel = useId();
  const autoUpdateLabel = useId();
  const name = nameOf(view);
  const ready = view.phase === "ready";
  const admits = (method: MethodName) => ready && runtime.capability(environmentId, method).status === "present";
  const version = status.result?.version ?? view.version;
  const pending = status.result === null ? null : pendingUpdateWords(status.result.pending, name, clock.now());
  const values = settings.values;
  const pinned = values?.["updates.pinnedVersion"];

  const save = (key: SettingsKey, value: unknown) => {
    setSaid(undefined);
    void settings.save(key, value).then((saved) => !saved.ok && setSaid({ ok: false, line: `Not saved: ${saved.line}` }));
  };
  const updateNow = () => {
    setSaid(undefined);
    void updateEnvironment(runtime, environmentId, name, uuidv7(clock.now())).then(setSaid);
  };

  return (
    <div className="flex flex-col gap-2 text-sm">
      {version !== null && <p className="text-ink">{environmentVersionWords(version)}</p>}
      {ready && status.error !== null && <p className="text-signal">{updatesUnreadWords(status.error.message)}</p>}
      {values !== null && (
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex items-center gap-2">
            <span id={channelLabel} className="text-ink-muted">
              Channel
            </span>
            <Select
              aria-labelledby={channelLabel}
              value={String(values["updates.channel"])}
              disabled={!admits("updates.settings.set")}
              onChange={(event) => save("updates.channel", event.target.value)}
            >
              {RELEASE_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {CHANNEL_WORDS[channel]}
                </option>
              ))}
            </Select>
          </span>
          <span className="flex items-center gap-2">
            <span id={autoUpdateLabel} className="text-ink-muted">
              Auto-update
            </span>
            <Switch
              aria-labelledby={autoUpdateLabel}
              checked={values["updates.autoUpdate"] === true}
              disabled={!admits("updates.settings.set")}
              onCheckedChange={(on) => save("updates.autoUpdate", on)}
            />
          </span>
        </div>
      )}
      {typeof pinned === "string" && <p className="text-ink-muted">{pinnedWords(pinned)}</p>}
      {pending !== null && <p className="text-ink-muted">{pending}</p>}
      <Button className="self-start" disabled={!admits("updates.apply")} onClick={updateNow}>
        Update now
      </Button>
      {said !== undefined && <p role="status" className={said.ok ? "text-ink-muted" : "text-signal"}>{said.line}</p>}
    </div>
  );
};
