import { desktopPicker, type Runtime } from "@agent-harness/client-runtime";
import { pickerOf, type Picker, type PickerRow } from "./picker.js";

/**
 * `/desktop` (#2161): the session's desktop for its next run, beside
 * `/browser`. The rows are the runtime's; a never-set field reads as none,
 * and the latest run's refusal, when it asked for a desktop and has none,
 * is the note.
 */
export const sessionDesktopPicker = (runtime: Runtime, environmentId: string, sessionId: string, say: (line: string) => void): Picker => {
  const session = runtime.projections.session(environmentId, sessionId);
  const view = () => {
    const projection = session.read();
    const run = projection.runs.at(-1);
    return desktopPicker(projection.summary?.desktop, run === undefined ? undefined : projection.desktopResolutions[run.runId]);
  };
  const picker = pickerOf({
    title: "Desktop for this session",
    typed: false,
    follows: [session],
    rows: () => view().rows.map((row): PickerRow => ({
      key: `desktop:${row.value.kind}`,
      text: row.label,
      detail: `${row.selected ? "· selected · " : ""}${row.note}`,
      choose: () => {
        void runtime.commands.dispatch(environmentId, "sessions.setDesktop", { sessionId, desktop: row.value }).then((answer) => {
          say(answer.ok ? `Desktop set to ${row.label}; applies from the next run.` : `Cannot change the desktop: ${answer.error.message}`);
        });
      },
    })),
    note: () => {
      const refused = view().refused;
      return refused === null ? "Changes apply from the next run." : `Last run: no desktop. ${refused.message} Changes apply from the next run.`;
    },
  });
  const at = view().rows.findIndex((row) => row.selected);
  return at > 0 ? { ...picker, cursor: at } : picker;
};
