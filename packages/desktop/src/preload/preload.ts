import { contextBridge, ipcRenderer } from "electron";
import { SHELL_GLOBAL } from "../channels.js";
import { shellBridge } from "./bridge.js";
import { windowCamera } from "./camera.js";

/**
 * The window's preload: it runs in the sandbox, isolated from the page, and
 * exposes the shell's members to the page and nothing else, never
 * `ipcRenderer` itself. Vite bundles it into one CommonJS script
 * (`dist/preload.cjs`), since a sandboxed preload can `require` little but
 * `electron`.
 */
const shell = shellBridge(ipcRenderer);
// The context bridge copies and freezes objects. Resolve capability discovery before
// giving the GUI its shell, rather than trying to mutate an already exposed copy.
const ready = windowCamera(globalThis as unknown as Window).then((camera) => ({ ...shell, ...(camera && { camera }) }));
contextBridge.exposeInMainWorld(SHELL_GLOBAL, { ...shell, ready: () => ready });
