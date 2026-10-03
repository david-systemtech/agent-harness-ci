import type { LadderName } from "@agent-harness/theme";
import { createElement, useEffect } from "react";
import { App } from "../src/app.js";
import { showSession } from "../src/grid/layout.js";
import { prepareWorld, startWorld } from "./world.js";

/** Both pages exercise the real palette and its key dispatch over a frozen world. */
export async function paletteScene(page: "root" | "sessions" | "no-match") {
  const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local", colour: "teal", sessions: Array.from({ length: 10 }, (_, index) => ({
    title: index === 0 ? "Check the receipts" : `Receipt task ${index + 1}`,
    workspace: { kind: "worktree" as const, path: `/projects/receipts-${index + 1}`, repository: "/projects/receipts", branch: `task/receipts-${index + 1}` },
  })) }] });
  const holders = await startWorld(prepared, prepared.paired);
  const env = prepared.world.environment("desk");
  holders.presentation.set("paneLayout", showSession(holders.presentation.values.read().paneLayout, holders.presentation.values.read().paneLayout.focused, { environmentId: env.environmentId, sessionId: env.sessionId() }));
  return function PaletteScene({ ladder }: { readonly ladder: LadderName }) {
    useEffect(() => {
      holders.presentation.set("lightOrDark", ladder);
      let opened = false;
      let frame = 0;
      let queried = false;
      const browse = () => {
        if (!opened) {
          const composer = document.querySelector<HTMLElement>('[aria-label="Message"]');
          if (composer === null) return;
          opened = true;
          // Let the key catalogue's subscriptions commit before taking the opening snapshot.
          frame = requestAnimationFrame(() => {
            composer.focus();
            composer.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
          });
        }
        if (page === "no-match" && !queried) {
          const input = document.querySelector<HTMLInputElement>("[data-command-input] input");
          if (input !== null) {
            queried = true;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "no-such-command");
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
        if (page !== "sessions" && page !== "no-match") return;
        const entry = document.querySelector<HTMLElement>('[cmdk-item][data-value="sessions"]');
        if (entry === null) return;
        observer.disconnect();
        entry.click();
      };
      const observer = new MutationObserver(browse);
      observer.observe(document.body, { childList: true, subtree: true });
      browse();
      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        holders.stopFollowing();
        void holders.presentation.close();
        void holders.runtime.close();
      };
    }, [ladder]);
    return createElement(App, { ...holders, clock: prepared.clock, shell: prepared.shell, version: prepared.version, macOS: false });
  };
}

/** look.md §11.3: compact width, 32px search and a scrolling 352px list. */
export const paletteGeometry = [
  { selector: '[data-measure="palette"]', width: 384 },
  { selector: '[data-command-input]', height: 32 },
  { selector: '[cmdk-list]', height: 352 },
  { selector: '[data-measure="palette-row-icon"]', width: 16, height: 16 },
];
