import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useSettingsNoticeHost } from "../settings/settings-window.js";
import { stepHome, type Notice } from "@agent-harness/client-runtime";
import { STEP_ORDER, settingsRow, type StepId } from "@agent-harness/contracts";
import { nameOf } from "../connections/words.js";
import { useLocalService } from "../connections/local-service.js";
import { useOpenPairing } from "../connections/pairing.js";
import { focusedPane, paneShowing } from "../grid/layout.js";
import { useOpenInFocusedPane } from "../grid/open-session.js";
import type { PaneLayout } from "../presentation.js";
import { useChecklist } from "../setup/checklist-window.js";
import { ArrowRight, Info, TriangleAlert, X } from "lucide-react";
import { Button, IconButton, Tooltip } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";

/**
 * The window's notices (docs/specs/gui.md, "Parked asks, attention and
 * notices"): every notice of `projections.notices` is a banner with its line
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
 *
 * A prompt parked on the session the focused pane shows draws no banner: its
 * card in that pane and the header's waiting count say it already, and Open
 * the session would do nothing, while the banner takes a phone's transcript
 * space. It is not dismissed, so it shows again once the pane shows
 * another session, or while Settings covers the pane, where opening the
 * session closes Settings. A rule settling such a prompt draws none either:
 * the prompt's transcript row in that pane says how (#1780), so its
 * `prompt-resolved` notice is taken off this client as soon as the pane is
 * in view, and does not show later about a session already seen.
 */

/** What a banner offers: a button that runs something, or a line saying why it cannot. */
type Offer = { readonly label: string; readonly run: () => void } | { readonly line: string } | undefined;

/** The step a notice offers, when its action is one: `setup.key-manager` offers the Key manager step. */
const stepOf = (notice: Notice): StepId | undefined => {
  const step = notice.action?.startsWith("setup.") === true ? notice.action.slice("setup.".length) : undefined;
  return STEP_ORDER.find((id) => id === step);
};

/** Whether `notice` is about a prompt on the session the focused pane shows, parked or settled by a rule: the pane says it. */
const saidInFocusedPane = (notice: Notice, layout: PaneLayout): boolean =>
  (notice.kind === "prompt-parked" || notice.kind === "prompt-resolved") && notice.about !== null &&
  paneShowing(layout, { environmentId: notice.environmentId, sessionId: notice.about.sessionId })?.id === focusedPane(layout).id;

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

/** The feed carries kinds and routine outcomes; tint is renderer presentation only. */
const toneOf = (notice: Notice): "info" | "warning" | "error" => {
  switch (notice.kind) {
    case "revoked":
    case "expired":
    case "refresh-failed":
    case "credential-unavailable":
    case "update-failed":
    case "routine-delivery-failed":
    case "command-rejected":
    case "command-dropped":
      return "error";
    case "unsupported-client":
    case "protocol-mismatch":
    case "update-refused":
    case "credential-prompt":
    case "draining":
    case "account":
    case "prompt-parked":
    case "forge":
    case "key-manager":
    case "workspace-kept":
      return "warning";
    case "routine":
      return notice.outcome === "failed" ? "error" : "info";
    case "updated":
    case "prompt-resolved":
      return "info";
  }
};
const TINTS = {
  info: "border-hairline bg-wash",
  warning: "border-amber/45 bg-amber/10",
  error: "border-signal/45 bg-signal/10",
};

/** A persistent notice in normal flow, with wrapping text and client-local actions. */
const NoticeBanner = ({ notice }: { readonly notice: Notice }) => {
  const runtime = useRuntime();
  const offer = useOffer(notice);
  const dismiss = () => runtime.notices.dismiss(notice.id);
  const tone = toneOf(notice);
  const Icon = tone === "info" ? Info : TriangleAlert;
  const label = tone === "info" ? "Information" : tone === "warning" ? "Warning" : "Error";
  return (
    <li data-notice-tone={tone} className={`relative flex min-w-0 flex-wrap items-start gap-x-2 gap-y-2 rounded-[8px] border px-3 py-2 pr-9 text-ink ${TINTS[tone]}`}>
      <Icon role="img" aria-label={label} className={`size-4 shrink-0 ${tone === "error" ? "text-signal" : tone === "warning" ? "text-amber" : "text-ink-muted"}`} />
      <div role={tone === "info" ? "status" : "alert"} className="min-w-0 max-w-full flex-1 basis-[16rem] font-mono text-2xs [overflow-wrap:anywhere]">
        <p>{notice.message}</p>
        {offer !== undefined && "line" in offer && <p className="mt-1 text-ink-muted">{offer.line}</p>}
      </div>
      {offer !== undefined && "run" in offer && <Tooltip content={offer.label} keys="Enter / Space">
        <Button variant="outline" size="xs" className="min-w-0 max-w-full" onClick={() => { dismiss(); offer.run(); }}>
          <ArrowRight aria-hidden="true" /><span className="truncate">{offer.label}</span>
        </Button>
      </Tooltip>}
      <IconButton label="Dismiss" keys="Enter / Space" size="icon-xs" className="absolute top-1 right-1" onClick={dismiss}><X aria-hidden="true" /></IconButton>
    </li>
  );
};

/** Environment notices, moved into Settings while its modal covers the session window. */
export const WindowNotices = () => {
  const noticeHost = useSettingsNoticeHost();
  const [layout] = usePresentation("paneLayout");
  const covered = Boolean(noticeHost?.host);
  const runtime = useRuntime();
  const all = useObservable(runtime.projections.notices);
  const notices = all.filter((notice) => covered || !saidInFocusedPane(notice, layout));
  // A settled prompt's notice whose row the focused pane shows has been said: take it off.
  useEffect(() => {
    if (covered) return;
    for (const notice of all) if (notice.kind === "prompt-resolved" && saidInFocusedPane(notice, layout)) runtime.notices.dismiss(notice.id);
  }, [runtime, all, layout, covered]);
  if (notices.length === 0) return null;
  // Settings bounds both notice feeds together; another percentage cap here
  // would shrink each feed inside that already bounded scrollport.
  const scrollport = covered ? "" : "max-h-[40%] min-h-0 shrink-0 overflow-y-auto";
  const content = (
    <section aria-label="Notifications" className={`mb-[7px] min-w-0 ${scrollport}`}>
      <ul className="flex min-w-0 flex-col gap-1.5">
        {notices.map((notice) => <NoticeBanner key={notice.id} notice={notice} />)}
      </ul>
    </section>
  );
  return noticeHost?.host ? createPortal(content, noticeHost.host) : content;
};
