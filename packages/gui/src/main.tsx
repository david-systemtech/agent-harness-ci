import "./styles.css";
import { createRuntime, type Platform, type Runtime } from "@agent-harness/client-runtime";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { browserPlatform, onMacOS } from "./platform/browser-platform.js";
import { readyDesktopShellOf, windowDesktopPlatform } from "./platform/desktop-platform.js";
import { openPresentation } from "./presentation.js";

/** The bundle's version, stamped from the package at build time (vite.config.ts). */
declare const __HARNESS_VERSION__: string;

/**
 * The bundle's entry: one client runtime for the window, on the desktop
 * platform in the desktop's window (its preload exposes the shell), else on
 * a browser tab's; its presentation opened before the first frame, and the
 * app mounted over them.
 */
const container = document.getElementById("root");
if (container === null) throw new Error("The page has no #root to mount the window in.");

const mount = async (platform: Platform, runtime: Runtime) => {
  const report = (error: unknown) => (platform.reportError ?? console.error)(error);
  const presentation = await openPresentation(platform.documents, report);
  createRoot(container).render(<App runtime={runtime} presentation={presentation} clock={platform.clock} version={platform.client.version} macOS={onMacOS(navigator)} shell={platform.shell} />);
  runtime.start().catch(report);
};

const shell = await readyDesktopShellOf(window);
if (shell) {
  const platform = await windowDesktopPlatform(window, shell, __HARNESS_VERSION__);
  const runtime = createRuntime(platform);
  platform.follow(runtime.connections.list);
  await mount(platform, runtime);
} else {
  const platform = browserPlatform(window, __HARNESS_VERSION__);
  await mount(platform, createRuntime(platform));
}
