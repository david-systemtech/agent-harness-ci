import type { SceneModule } from "../scene-registry.js";
export const platform = "web";
export const script = { environments: [{ name: "desk", reach: "paired", hello: { ceiling: "bypassPermissions" }, clientSessions: [{ label: "Phone", kind: "web", scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits" }] }] } satisfies SceneModule["script"];
export const presentation = { settingsRow: "environments.access" } as const;
export const activate = () => {
  let opened = false;
  let changing = false;
  const advance = () => {
    if (!opened) { const settings = document.querySelector<HTMLButtonElement>('[aria-label="Settings"]'); if (!settings) return; opened = true; settings.click(); }
    if (!changing) { const button = [...document.querySelectorAll<HTMLButtonElement>('li[aria-label="Phone"] button')].find((candidate) => candidate.textContent === "Change access"); if (!button || button.disabled) return; changing = true; button.click(); }
  };
  const observer = new MutationObserver(advance);
  observer.observe(document.body, { childList: true, subtree: true }); advance();
  return () => observer.disconnect();
};
export const readySelector = "[data-change-access]";
export const geometry: SceneModule["geometry"] = ({ width }) => [
  { selector: "[data-change-access]", maxWidth: width - 16, visibleWithin: "body", contentFits: true },
  { selector: "[data-change-access] button", minimumWidth: 44, minimumHeight: 44, renderedOnly: true },
  { selector: "[data-change-access] select", minimumHeight: 44 },
  { selector: "[data-change-access] label:has([role=checkbox])", minimumHeight: 44 },
];
