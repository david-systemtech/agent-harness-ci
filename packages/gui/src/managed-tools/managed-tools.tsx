import type { EnvironmentView } from "@agent-harness/client-runtime";
import { DEFAULT_TERMINAL_SIZE, managedTool, type MethodName, type ToolRunStartedPayload } from "@agent-harness/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { nameOf } from "../connections/words.js";
import { useSettings } from "../settings/settings-window.js";
import { useFollowed, useObservable, useRuntime } from "../window-context.js";
import { ToolRow } from "./tool-row.js";
import { ToolTerminal, type ShownRun } from "./tool-terminal.js";

/** What About's Managed tools send at `admin`: a run and a verification. Without `admin` both are dim, with the capability's line said once on About. */
export const MANAGED_TOOLS_SENT: readonly MethodName[] = ["tools.run", "tools.verify"];

/** A run the environment's stream says is under way, as the section holds it: at the size the environment opens a tool terminal at unless asked another. */
const shownFrom = (running: ToolRunStartedPayload): ShownRun => ({
  terminal: { id: running.terminalId, ...DEFAULT_TERMINAL_SIZE },
  tool: running.tool,
  action: running.action,
  command: running.command,
});

/**
 * About's Managed tools (key-managers spec, "Managed tools"; ADR 0026;
 * docs/specs/gui.md, "Settings"; #426), on the environment About's picker
 * names: a row per tool from `tools.list` in the request cache, which
 * `tools.updated` refreshes, asked once with `refresh` when About opens so
 * the environment probes again (rate-limited there; a client never probes).
 * Install and Update open a tool terminal, drawn here until it is closed;
 * a run under way the environment's stream tells of (from this window
 * earlier, or another client) is drawn too, and kept the same way past its
 * finish, so a `sudo` prompt left waiting can still be answered. Opened at
 * its part (the Key manager step's link), the section takes the focus.
 *
 * Without the `managedTools` flag the section holds its reason alone;
 * without `admin` Install, Update and Verify are dim, About saying why once.
 */
export const ManagedTools = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { part } = useSettings();
  const { environmentId } = view;
  const ready = view.phase === "ready";
  const heading = useId();
  const region = useRef<HTMLElement>(null);
  const flagged = runtime.capability(environmentId, "managedTools");
  const offered = !(flagged.status === "absent" && flagged.reason === "unsupported");
  const listed = useFollowed(useMemo(() => (offered ? runtime.requests.cached(environmentId, "tools.list", {}) : undefined), [runtime, environmentId, offered]));
  const { running, finished } = useObservable(useMemo(() => runtime.projections.toolRuns(environmentId), [runtime, environmentId]));
  /** The run drawn here until its Close: one this window started, or one under way the stream told of; and the terminals closed here, which a run still under way does not bring back. */
  const [drawn, open] = useState<ShownRun | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());

  // Opening About asks the environment to probe again, behind the cached rows it shows meanwhile.
  useEffect(() => {
    if (offered && ready) void runtime.requests.call(environmentId, "tools.list", { refresh: true });
  }, [runtime, environmentId, offered, ready]);
  useEffect(() => {
    if (part === "managed-tools") region.current?.focus();
  }, [part]);
  // A run under way, while none is drawn and its terminal was not closed here, is held as drawn: one object, kept past its finish.
  useEffect(() => {
    if (running !== null && !closed.has(running.terminalId)) open((shown) => shown ?? shownFrom(running));
  }, [running, closed]);

  const close = () => {
    if (drawn !== null) setClosed((held) => new Set(held).add(drawn.terminal.id));
    open(null);
  };
  const writable = ready && MANAGED_TOOLS_SENT.every((method) => runtime.capability(environmentId, method).status === "present");
  const rows = listed?.result?.tools ?? null;
  const unread = listed?.error ?? null;

  return (
    <section ref={region} tabIndex={-1} aria-labelledby={heading} className="flex flex-col gap-3 outline-none">
      <h3 id={heading} className="text-sm font-semibold text-ink">
        Managed tools
      </h3>
      {!offered ? (
        <p className="text-sm text-amber">{flagged.status === "absent" ? flagged.message : null}</p>
      ) : (
        <>
          {rows === null
            ? ready && (
                <p className="text-sm text-ink-faint">{unread === null ? "Reading the managed tools…" : `The managed tools could not be read: ${unread.message}`}</p>
              )
            : rows.map((row) => (
                <ToolRow
                  key={row.tool}
                  environmentId={environmentId}
                  name={nameOf(view)}
                  row={row}
                  writable={writable}
                  readable={ready}
                  finished={row.tool === "vault" ? undefined : finished[row.tool]}
                  started={open}
                />
              ))}
          {drawn !== null && <ToolTerminal key={drawn.terminal.id} environmentId={environmentId} run={drawn} label={managedTool(drawn.tool).label} close={close} />}
        </>
      )}
    </section>
  );
};
