import {
  credentialPromptWords,
  drainAndUpdateDescription,
  drainAndUpdateQuestion,
  drainableUpdate,
  environmentVersionWords,
  pendingUpdateId,
  pendingUpdateWords,
  pinnedWords,
  updateEnvironment,
  updatesUnreadWords,
  uuidv7,
  type ActionOutcome,
  type CachedAnswer,
  type EnvironmentView,
  type UpdateNowOutcome,
} from "@agent-harness/client-runtime";
import { RELEASE_CHANNELS, type MethodName, type SettingsKey, type UpdateWhen } from "@agent-harness/contracts";
import { ArrowUpCircle, ArrowDownToLine, CircleStop, Radio, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { nameOf } from "../connections/words.js";
import { DialogFooter } from "../ui/dialog.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { Outcome } from "../setup/outcome.js";
import { Button, Dialog, DialogClose, DialogContent, Select, Switch, Tooltip } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";
import { useUpdatesStatus } from "./use-updates-status.js";

/** What a control did, or why it was not taken; for Update now, with the `updates.status` read held when its answer came. */
type Said = ActionOutcome | (UpdateNowOutcome & { readonly readBefore: CachedAnswer<"updates.status">["result"] });

/**
 * Whether what was said still holds: a refusal or a write's until the next
 * action; Update now's while its update is pending, or until a read after
 * its answer says otherwise, once the update took, failed, rolled back, was
 * replaced or withdrawn, which the status above and its notice say (#1749).
 */
const saysTruly = (said: Said, read: CachedAnswer<"updates.status">["result"]): boolean => {
  if (!("readBefore" in said) || said.updateId === undefined || read === null || read === said.readBefore) return true;
  return pendingUpdateId(read.pending) === said.updateId;
};

/** A channel as a person reads it. */
const CHANNEL_WORDS: Readonly<Record<(typeof RELEASE_CHANNELS)[number], string>> = { stable: "Stable", beta: "Beta" };

/**
 * An environment's update controls (launcher-update spec, "Settings,
 * methods, notices and flags"; ADR 0025, ADR 0026; #424), which About and
 * each Your machines card draw alike: the version it runs and its pending
 * update with what it waits on, from `updates.status`; its channel and
 * auto-update, from `settings.get` and set through `updates.settings.set`,
 * and a pin that holds it; Update now, `updates.apply` when idle; and,
 * while busy work holds the pending update, Drain and update now (#825),
 * `updates.apply` now, asked once in a dialog that closes unanswered once
 * that update no longer waits on work. What either did, or why it or a
 * write was not taken, is one line; a write taken shows in its control, as
 * in the generic editor; Update now's line holds only while the update it
 * took is pending (#1749). Each control is read-only while the
 * environment is not ready or the connection lacks its method's scope; what
 * holds the controls says why, once.
 */
export const UpdateControls = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const { environmentId } = view;
  const status = useUpdatesStatus(environmentId);
  const settings = useSettingsValues(environmentId);
  const [said, setSaid] = useState<Said | undefined>(undefined);
  // The id of the update Drain and update now's dialog asks about.
  const [asking, setAsking] = useState<string | undefined>(undefined);
  const channelLabel = useId();
  const autoUpdateLabel = useId();
  const name = nameOf(view);
  const ready = view.phase === "ready";
  const admits = (method: MethodName) => ready && runtime.capability(environmentId, method).status === "present";
  const version = status.result?.version ?? view.version;
  const pending = status.result === null ? null : pendingUpdateWords(status.result.pending, name, clock.now());
  const drainable = status.result === null ? null : drainableUpdate(status.result.pending);
  const drainableId = drainable?.updateId;
  // The question goes, for good, once the update it asks about no longer waits on work (it went, was replaced or withdrawn).
  useEffect(() => {
    if (asking !== undefined && asking !== drainableId) setAsking(undefined);
  }, [asking, drainableId]);
  // The `updates.status` read held when Update now's answer came, kept from the last render.
  const lastRead = useRef(status.result);
  useEffect(() => {
    lastRead.current = status.result;
  }, [status.result]);
  const values = settings.values;
  const pinned = values?.["updates.pinnedVersion"];
  const shown = said !== undefined && saysTruly(said, status.result) ? said : undefined;

  const save = (key: SettingsKey, value: unknown) => {
    setSaid(undefined);
    void settings.save(key, value).then((saved) => !saved.ok && setSaid({ ok: false, line: `Not saved: ${saved.line}` }));
  };
  const update = (when: UpdateWhen) => {
    setAsking(undefined);
    setSaid(undefined);
    void updateEnvironment(runtime, environmentId, name, uuidv7(clock.now()), when).then((outcome) => setSaid({ ...outcome, readBefore: lastRead.current }));
  };

  return (
    <div className="flex flex-col gap-3 text-xs">
      {version !== null && <p className="flex items-center gap-2 font-mono text-ink"><ArrowUpCircle aria-hidden="true" className="size-4" />{environmentVersionWords(version)}</p>}
      {ready && status.error !== null && <p className="text-signal">{updatesUnreadWords(status.error.message)}</p>}
      {values !== null && (
        <div className="flex flex-col gap-3">
          <span className="flex flex-wrap items-center gap-2">
            <span id={channelLabel} className="text-ink-muted">
              <Radio aria-hidden="true" className="mr-1 inline size-4" />Channel
            </span>
            <Tooltip content="Channel" keys="Arrow keys"><Select
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
            </Select></Tooltip>
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <span id={autoUpdateLabel} className="text-ink-muted">
              <RefreshCw aria-hidden="true" className="mr-1 inline size-4" />Auto-update
            </span>
            <Tooltip content="Auto-update" keys="Space"><Switch
              aria-labelledby={autoUpdateLabel}
              checked={values["updates.autoUpdate"] === true}
              disabled={!admits("updates.settings.set")}
              onCheckedChange={(on) => save("updates.autoUpdate", on)}
            /></Tooltip>
          </span>
        </div>
      )}
      {typeof pinned === "string" && <p className="text-ink-muted">{pinnedWords(pinned)}</p>}
      {/* The start of the version it updates to waits on macOS's prompt for its stored key (#1689): what it read before is stale. */}
      {view.credentialPrompt !== undefined ? (
        <p role="status" className="text-signal">{credentialPromptWords(view.credentialPrompt.toVersion)}</p>
      ) : (
        pending !== null && <p className="text-ink-muted">{pending}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Tooltip content="Update now" keys="Enter / Space"><Button variant="default" disabled={!admits("updates.apply")} onClick={() => update("idle")}>
          <ArrowDownToLine aria-hidden="true" />Update now
        </Button></Tooltip>
        {drainable !== null && (
          <Tooltip content="Drain and update now" keys="Enter / Space"><Button
            disabled={!admits("updates.apply")}
            onClick={() => {
              setSaid(undefined);
              setAsking(drainable.updateId);
            }}
          >
            <CircleStop aria-hidden="true" />Drain and update now…
          </Button></Tooltip>
        )}
      </div>
      {shown !== undefined && <Outcome outcome={shown} role="status" className={shown.ok ? "text-ink-muted" : "text-signal"} />}
      <Dialog open={asking !== undefined && asking === drainableId} onOpenChange={(open) => !open && setAsking(undefined)}>
        {drainable !== null && (
          <DialogContent showClose={false} title={drainAndUpdateQuestion(name, drainable.toVersion)} description={drainAndUpdateDescription(name, drainable.toVersion)}>
            <DialogFooter>
              <Tooltip content="Cancel" keys="Enter / Space / Escape"><DialogClose asChild>
                <Button><X aria-hidden="true" />Cancel</Button>
              </DialogClose></Tooltip>
              <Tooltip content="Drain and update" keys="Enter / Space"><Button variant="destructive" onClick={() => update("now")}>
                <CircleStop aria-hidden="true" />
                Drain and update
              </Button></Tooltip>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
};
