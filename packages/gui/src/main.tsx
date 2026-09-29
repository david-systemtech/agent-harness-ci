import "./styles.css";
import { createRuntime } from "@agent-harness/client-runtime";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { browserPlatform, onMacOS } from "./platform/browser-platform.js";
import { openPresentation } from "./presentation.js";

/** The bundle's version, stamped from the package at build time (vite.config.ts). */
declare const __HARNESS_VERSION__: string;

/**
 * The bundle's entry: one client runtime for the window, its presentation
 * opened before the first frame, and the app mounted over them.
 */
const container = document.getElementById("root");
if (container === null) throw new Error("The page has no #root to mount the window in.");
const platform = browserPlatform(window, __HARNESS_VERSION__);
const runtime = createRuntime(platform);
const presentation = await openPresentation(platform.documents, platform.reportError);
createRoot(container).render(<App runtime={runtime} presentation={presentation} clock={platform.clock} macOS={onMacOS(navigator)} shell={platform.shell} />);
runtime.start().catch(platform.reportError);
