import { stepHome, type Notice } from "@agent-harness/client-runtime";
import { STEP_ORDER, settingsRow, type StepId } from "@agent-harness/contracts";
import { nameOf } from "../connections/words.js";
import { useLocalService } from "../connections/local-service.js";
import { useOpenPairing } from "../connections/pairing.js";
import { useOpenInFocusedPane } from "../grid/open-session.js";
import { useChecklist } from "../setup/checklist-window.js";
import { Toast, Toasts } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

/**
 * The window's notices (docs/specs/gui.md, "Parked asks, attention and
 * notices"): every notice of `projections.notices` is a toast with its line
 * and what it offers, stacked in one list, newest last, each kept until it
 * is dismissed. Dismissing one takes it off this client alone
 * (`notices.dismiss`), and so does running what it offers:
 *
 * - `re-pair`: Pair again, the pairing dialog for its environment;
 * - `update-client`: Update this client, which opens About, where this
 *   client's own update is (#424);
 * - `update-environment`: Update <environment>, the connection registry's
 *   `update-environment` action, which raises its own notice when the
 *   environment refuses;
 * - `service.start`: Start the service, this machine's, or the shell's line
 *   where it cannot start one;
 * - a Set up step (`setup.key-manager`, `setup.forges`): Open <the step's
 *   home row> on its environment, leaving the full checklist if it is open
 *   (#425);
 * - none, about a session (a prompt parked, a routine's result): Open the
 *   session, in the focused pane.
 */

/** What a toast offers: a button that runs something, or a line saying why it cannot. */
type Offer = { readonly label: string; readonly run: () => void } | { readonly line: string } | undefined;

/** The step a notice offers, when its action is one: `setup.key-manager` offers the Key manager step. */
const stepOf = (notice: Notice): StepId | undefined => {
  const step = notice.action?.startsWith("setup.") === true ? notice.action.slice("setup.".length) : undefined;
  return STEP_ORDER.find((id) => id === step);
};

/** What the notice offers, as the window runs it. */
const useOffer = (notice: Notice): Offer => {
  const runtime = useRuntime();
  const views = useObservable(runtime.projections.environments);
  const openPairing = useOpenPairing();
  const service = useLocalService();
  const { leave } = useChecklist();
  const openInPane = useOpenInFocusedPane();
  const { environmentId, action, about } = notice;
  switch (action) {
    case "re-pair":
      return { label: "Pair again", run: () => openPairing({ rePair: environmentId }) };
    case "update-client":
      return { label: "Update this client", run: () => leave("about.about", environmentId) };
    case "update-environment": {
      const view = views.find((listed) => listed.environmentId === environmentId);
      // It rejects only for an environment this client no longer holds, which has nothing left to update.
      return { label: `Update ${view === undefined ? "the environment" : nameOf(view)}`, run: () => void runtime.connections.updateEnvironment(environmentId).catch(() => undefined) };
    }
    case "service.start":
      return service.available.status === "absent" ? { line: service.available.message } : { label: "Start the service", run: () => service.start(environmentId) };
    case null:
      return about === null ? undefined : { label: "Open the session", run: () => openInPane({ environmentId, sessionId: about.sessionId }) };
    default: {
      const step = stepOf(notice);
      if (step === undefined) return undefined;
      const row = stepHome(step);
      return { label: `Open ${settingsRow(row).label}`, run: () => leave(row, environmentId) };
    }
  }
};

/** One notice's toast: its line, what it offers, and Dismiss. */
const NoticeToast = ({ notice }: { readonly notice: Notice }) => {
  const runtime = useRuntime();
  const offer = useOffer(notice);
  const dismiss = () => runtime.notices.dismiss(notice.id);
  return (
    <Toast
      open
      duration={Infinity}
      title={notice.message}
      {...(offer !== undefined && "line" in offer && { description: offer.line })}
      {...(offer !== undefined &&
        "run" in offer && {
          action: {
            label: offer.label,
            run: () => {
              dismiss();
              offer.run();
            },
          },
        })}
      onOpenChange={(open) => !open && dismiss()}
    />
  );
};

/** Every notice this client holds, as a toast in one list. */
export const WindowNotices = () => {
  const notices = useObservable(useRuntime().projections.notices);
  if (notices.length === 0) return null;
  return (
    <Toasts>
      {notices.map((notice) => (
        <NoticeToast key={notice.id} notice={notice} />
      ))}
    </Toasts>
  );
};
