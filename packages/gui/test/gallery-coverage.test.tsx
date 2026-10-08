// @vitest-environment node
import { expect, it } from "vitest";
import { sceneFiles } from "../gallery/capture-plan.js";

it("covers every registered Settings pane, all first-run steps and the verification scene families", async () => {
  const names = await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname);
  // look.md §16: these are the states a baseline set must include, independent of discovery order.
  const required = [
    "window-empty", "window-not-ready", "window-start-failed", "window-session", "header", "update-chip", "grid-two", "primitives", "window-scale-11", "window-scale-20",
    "session-conversation", "session-streaming", "session-tools", "session-find", "session-queue", "session-steering", "session-history",
    "composer-idle", "composer-running", "composer-stopping", "composer-slash", "composer-bypass", "status-line", "context-usage", "run-picker", "run-picker-compact",
    "dock-files", "dock-file-view", "dock-files-empty", "dock-files-loading", "dock-files-error", "dock-diff", "dock-terminal", "dock-browser", "dock-browser-loading", "dock-documents", "dock-tasks", "dock-preview", "dock-sheet",
    "palette-root", "palette-sessions", "palette-no-match", "dialogs", "dialog-hand-off", "dialog-run-info", "dialog-pairing", "dialog-restore", "dialog-sign-in", "notices",
    "settings-setup", "settings-accounts", "settings-default-model", "settings-usage", "settings-banks", "settings-skills", "settings-instructions", "settings-permissions", "settings-browser", "settings-key-managers", "settings-forges", "settings-routines", "settings-bots", "settings-machines", "settings-access", "settings-service", "settings-theme", "settings-shortcuts", "settings-about", "settings-read-only", "settings-unreachable", "settings-search", "settings-notice-single", "settings-notices-stacked", "settings-notices-text-20",
    "setup-introduction", "setup-introduction-failed", "setup-introduction-ready", "setup-account", "setup-rail-states", "setup-carry-over", "setup-your-machines", "setup-host-updater", "setup-forges", "setup-forges-gh", "setup-forges-add", "setup-forges-unknown", "setup-key-manager", "setup-memory-bank", "setup-skills-long", "setup-instructions", "setup-browser", "setup-permissions", "setup-appearance", "setup-close-confirmation", "setup-parts", "setup-status-done", "setup-status-fix", "setup-status-could-not-check", "setup-status-unreachable",
  ];
  for (const kind of ["permission", "question", "plan", "denylist"]) {
    for (const state of ["pending", "busy", "error", "settled"]) required.push(`prompt-${kind}${state === "pending" ? "" : `-${state}`}`);
  }
  expect(required.filter((name) => !names.includes(name))).toEqual([]);
});
