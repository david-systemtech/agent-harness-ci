import { consumeBrowserRoute } from "./platform/browser-boot.js";
import { webRegistrations } from "./platform/web-registrations.js";
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
const browserRoute = consumeBrowserRoute(window);
const container = document.getElementById("root");
if (container === null) throw new Error("The page has no #root to mount the window in.");

const mount = async (platform: Platform, runtime: Runtime, web?: import("./platform/web-frame.js").WebFrameProps) => {
  const report = (error: unknown) => (platform.reportError ?? console.error)(error);
  const presentation = await openPresentation(platform.documents, report);
  if (web) {
    if (await platform.documents.get("presentation") === undefined) presentation.set("textSize", 16);
    presentation.set("runLocalEnvironment", false);
    presentation.set("firstLaunchDone", true);
  }
  createRoot(container).render(<App runtime={runtime} presentation={presentation} clock={platform.clock} version={platform.client.version} macOS={onMacOS(navigator)} shell={platform.shell} web={web} />);
  if (!web) runtime.start().catch(report);
};

const shell = await readyDesktopShellOf(window);
if (shell) {
  const platform = await windowDesktopPlatform(window, shell, __HARNESS_VERSION__);
  const runtime = createRuntime(platform);
  platform.follow(runtime.connections.list);
  await mount(platform, runtime);
} else {
  const platform = browserPlatform(window, __HARNESS_VERSION__);
  const runtime = createRuntime(platform);
  await runtime.start();
  const stopModules = webRegistrations.flatMap(({ registration }) => {
    const stop = registration.start?.(runtime, platform);
    return stop ? [stop] : [];
  });
  window.addEventListener("pagehide", event => {
    if (event.persisted) return;
    for (const stop of stopModules) stop();
    void runtime.close();
  });
  await mount(platform, runtime, { platform, route: browserRoute });
}
