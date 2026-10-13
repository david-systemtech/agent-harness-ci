import { activate as proveCaption, geometry as captionChecks } from "../caption-pull-requests-scene.js";
export { script, presentation } from "../caption-pull-requests-scene.js";
export const readySelector = '[role="dialog"][aria-label="Pull requests"]';
export const geometry = [...captionChecks,
  { selector: '[role="dialog"][aria-label="Pull requests"]', contentFits: true },
  { selector: '[aria-label="All pull requests"] button', contentFits: true, visibleWithin: '[role="dialog"][aria-label="Pull requests"]' },
];
export const activate = () => {
  const stop = proveCaption();
  const open = () => {
    const trigger = document.querySelector<HTMLButtonElement>("[data-caption-pr-proof] [data-pr-overflow]");
    if (!trigger) return;
    observer.disconnect();
    trigger.click();
  };
  const observer = new MutationObserver(open);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-caption-pr-proof"] });
  open();
  return () => { stop(); observer.disconnect(); };
};
