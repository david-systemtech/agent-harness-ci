import { LOCAL_PLACEHOLDER_ID, type BrowserRow, type Observable, type Runtime } from "@agent-harness/client-runtime";
import type { SessionBrowser } from "@agent-harness/contracts";
import { STAYS, pickerOf, type Picker, type PickerRow } from "./picker.js";

/** The same projection rows for the session picker and the new-session browser step. */
export const browserPicker = (options: {
  readonly runtime: Runtime;
  readonly title: string;
  readonly environmentId: string;
  readonly rows: () => readonly BrowserRow[];
  readonly follows: readonly Observable<unknown>[];
  readonly choose: (value: SessionBrowser | null, label: string) => Picker | void;
  readonly say: (line: string) => void;
  readonly back?: Picker;
}): Picker => {
  const { runtime } = options;
  const environments = runtime.projections.environments;
  const stale = () => environments.read().filter((env) =>
    env.environmentId !== LOCAL_PLACEHOLDER_ID && (env.environmentId === options.environmentId || env.kind === "local" || options.rows().some((row) => row.value?.kind === "chrome" && row.value.environmentId === env.environmentId)) && env.phase !== "ready",
  );
  const picker = pickerOf({
    title: options.title,
    typed: false,
    ...(options.back !== undefined && { back: options.back }),
    follows: [...options.follows, environments],
    rows: () => [
      ...options.rows().map((row): PickerRow => ({
        key: `browser:${JSON.stringify(row.value)}`,
        text: row.label,
        ...(row.unavailable === null
          ? { detail: `${row.selected ? "· selected · " : ""}${row.note}`, choose: () => options.choose(row.value, row.label) }
          : { ...(row.selected && { detail: "· selected" }), absent: row.unavailable.message }),
      })),
      {
        key: "browser:pair", text: "Pair Chrome", detail: "agent-harness browser pair",
        choose: () => {
          const local = environments.read().find((env) => env.kind === "local" && env.environmentId !== LOCAL_PLACEHOLDER_ID);
          options.say(local === undefined
            ? "Cannot pair Chrome here: install the harness on this machine, then run agent-harness browser pair."
            : local.phase !== "ready"
              ? "Cannot pair Chrome now: the local environment is unreachable."
              : "Run agent-harness browser pair on this machine; the paired Chrome appears here automatically.");
          return STAYS;
        },
      },
    ],
    note: () => stale().length > 0
      ? `${stale().map((env) => env.name ?? "This machine").join(", ")}: cached browser list · stale. Changes apply from the next run.`
      : "Changes apply from the next run. Default chooses the headless browser when available, else none.",
  });
  const at = options.rows().findIndex((row) => row.selected);
  return at > 0 ? { ...picker, cursor: at } : picker;
};

/** `/browser`: organisation state comes from the runtime, including after another client changes it. */
export const sessionBrowserPicker = (runtime: Runtime, environmentId: string, sessionId: string, say: (line: string) => void): Picker => {
  const projection = runtime.projections.browsers(environmentId, sessionId);
  return browserPicker({
    runtime, environmentId, title: "Browser for this session", rows: () => projection.read().rows, follows: [projection], say,
    choose: (browser, label) => {
      void runtime.commands.dispatch(environmentId, "sessions.setBrowser", { sessionId, browser }).then((answer) => {
        say(answer.ok ? `Browser set to ${label}; applies from the next run.` : `Cannot change the browser: ${answer.error.message}`);
      });
    },
  });
};
