import type { SceneViewport } from "../scene-registry.js";

export const platform = "web";
export const script = { environments: [{ name: "desk", reach: "paired" as const }] };
export const presentation = { settingsRow: "appearance.theme" as const };
export const readySelector = '[data-theme-preference="Text size"]';
export const activate = () => {
  const open = () => {
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Settings"]');
    if (!button) return;
    observer.disconnect(); button.click();
  };
  const observer = new MutationObserver(open);
  observer.observe(document.body, { childList: true, subtree: true }); open();
  return () => observer.disconnect();
};

/** Measure instructions themselves: no horizontal overflow can still hide a 37px help strip. */
export const geometry = ({ width, height }: SceneViewport) => [
  { selector: "[data-settings-dialog]", width, height, visibleWithin: "body" },
  ...["Light or dark", "Text size"].flatMap(name => {
    const row = `[data-theme-preference="${name}"]`;
    return [
      { selector: `${row} .theme-preference-label > div`, minimumWidth: width - 160, contentFits: true, wordsIntact: true },
      { selector: `${row} .theme-preference-control`, below: `${row} .theme-preference-label`, contentFits: true },
    ];
  }),
  { selector: '[data-theme-preference] :is(button, input[type="number"], label:has(input[type="radio"]))', minimumHeight: 44, minimumWidth: 44 },
  { selector: '[aria-label="Close Settings"]', hitTestable: true, visibleWithin: "[data-settings-dialog]" },
];
