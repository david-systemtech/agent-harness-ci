import { stepHome, type Notice } from "@agent-harness/client-runtime";
import { STEP_ORDER, settingsRow, type StepId } from "@agent-harness/contracts";
import { Toast, Toasts } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { useChecklist } from "./checklist-window.js";

/** The step a notice offers, when its action is one: `setup.key-manager` offers the Key manager step. */
const stepOf = (notice: Notice): StepId | undefined => {
  const step = notice.action?.startsWith("setup.") === true ? notice.action.slice("setup.".length) : undefined;
  return STEP_ORDER.find((id) => id === step);
};

/**
 * The notices a Set up step answers (`projections.notices` whose action is
 * `setup.<step>`: a key-manager connection needing David, a forge account's
 * problem; #320, #384, #425), each a toast with its line and the step's home
 * row to open on the notice's environment, which takes the notice off this
 * client, as dismissing it does. The window's other notices are #405's to
 * show.
 */
export const StepNotices = () => {
  const runtime = useRuntime();
  const { leave } = useChecklist();
  const notices = useObservable(runtime.projections.notices).flatMap((notice) => {
    const step = stepOf(notice);
    return step === undefined ? [] : [{ notice, row: stepHome(step) }];
  });
  if (notices.length === 0) return null;
  return (
    <Toasts>
      {notices.map(({ notice, row }) => (
        <Toast
          key={notice.id}
          open
          duration={Infinity}
          title={notice.message}
          action={{
            label: `Open ${settingsRow(row).label}`,
            run: () => {
              runtime.notices.dismiss(notice.id);
              leave(row, notice.environmentId);
            },
          }}
          onOpenChange={(open) => !open && runtime.notices.dismiss(notice.id)}
        />
      ))}
    </Toasts>
  );
};
