/* eslint-disable agent-harness/no-client-organisation-state -- Scripted environment fixtures, not renderer-owned organisation state. */
import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import type { PresentationValues } from "../src/presentation.js";
import type { SceneGeometry } from "./scene-registry.js";

const environmentId = "0199cc00-0000-4000-8000-000000000001";
const sessionId = "0199dd00-0000-4000-8000-000000000001";
export const script: Script = { environments: [{ name: "desk", reach: "local", environmentId,
  sessions: [{ id: sessionId, title: "Check the ledger", workspace: { kind: "worktree", path: "/projects/ledger-review", repository: "/projects/ledger", branch: "review" },
    pullRequests: Array.from({ length: 7 }, (_, index) => ({ url: `https://forge.example.test/team/ledger/pulls/${index + 1}`, state: "open", mergedAt: null, closedAt: null })),
  }],
}] };

export const presentation: Partial<PresentationValues> = { paneLayout: { focused: "pane-1", rows: [
  { id: "row-1", height: 50, panes: [{ id: "pane-1", width: 100, session: { environmentId, sessionId } }] },
  { id: "row-2", height: 50, panes: [{ id: "pane-2", width: 100, session: null }] },
] } };
export const geometry: readonly SceneGeometry[] = [
  { selector: "[data-caption-title]", minimumWidth: 100, visibleWithin: "[data-pane-caption]" },
  { selector: "[data-caption-title] button", visibleWithin: "[data-pane-caption]", contentFits: true },
  { selector: "[data-caption-identity] [role=note]", minimumWidth: 30, visibleWithin: "[data-pane-caption]" },
  { selector: "[data-caption-pull-requests] button", renderedOnly: true, visibleWithin: "[data-pane-caption]", contentFits: true },
  { selector: "[data-caption-run-info] > button", visibleWithin: "[data-pane-caption]" },
  { selector: '[aria-label="Close the pane"]', visibleWithin: "[data-pane-caption]" },
];
export const readySelector = "[data-caption-pr-proof]";

/** Hosted native layout proves the chip count and overflow wording on both sides of the text-scaled breakpoint. */
export const activate = () => {
  let stopped = false, checking = false;
  const prove = () => {
    const caption = document.querySelector<HTMLElement>("[data-pane-caption]:has([data-caption-pull-requests])");
    if (!caption || checking) return;
    checking = true;
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (stopped) return;
      const chips = caption.querySelector<HTMLElement>("[data-pr-chips]")!;
      if (caption.clientWidth !== 0) {
        const style = getComputedStyle(caption);
        const contentWidth = caption.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const expanded = contentWidth >= 40 * parseFloat(getComputedStyle(document.documentElement).fontSize);
        if ((getComputedStyle(chips).display !== "none") !== expanded) throw new Error("Caption chips did not collapse before squeezing the title.");
        const overflow = caption.querySelector<HTMLElement>(expanded ? "[data-pr-expanded]" : "[data-pr-compact]")!;
        if (getComputedStyle(overflow).display === "none" || overflow.textContent !== (expanded ? "+5 PRs" : "7 PRs")) throw new Error("The overflow must count every hidden PR.");
      }
      caption.setAttribute("data-caption-pr-proof", "passed");
    });
  };
  const observer = new MutationObserver(prove);
  observer.observe(document.body, { childList: true, subtree: true });
  prove();
  return () => { stopped = true; observer.disconnect(); };
};
