import type { Script } from "@agent-harness/client-runtime/testing/scripted-environment";
import { script as base, presentation } from "./new-session.js";
export { presentation };
export const platform = "web";
export const script: Script = { environments: base.environments.map(environment => ({
  ...environment, reach: "paired", sessions: [{ title: "Project notes", workspace: { kind: "directory", path: "/work/projects/a-long-project-directory-for-phone-notes" } }],
})) };

/** Open the real environment-directory picker through the new-session chip. */
export const activate = () => {
  let opened = false;
  const show = () => {
    const chip = document.querySelector<HTMLButtonElement>('[data-new-session-chip][aria-label^="Workspace:"]');
    if (opened || !chip || chip.disabled) return;
    // A keyboard person's Tab: on the phone layout only focus after a Tab shows a hint (#1741), and this scene bounds it.
    opened = true; document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); chip.click();
  };
  const observer = new MutationObserver(show);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  show();
  return () => observer.disconnect();
};
export const readySelector = "[data-workspace-picker]";
export const geometry = [
  { selector: "[data-workspace-picker]", visibleWithin: "[data-workspace-picker]" },
  { selector: "[data-ui-tooltip]", visibleWithin: "[data-ui-tooltip]" },
  { selector: "[data-workspace-picker] button", minimumWidth: 44, minimumHeight: 44 },
  { selector: '[data-workspace-picker] input', minimumHeight: 44 },
  { selector: '[data-workspace-picker] button[type="submit"]', visibleWithin: "[data-workspace-picker]" },
];
