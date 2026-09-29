import { contextBridge, ipcRenderer } from "electron";
import { SHELL_GLOBAL } from "../channels.js";
import { shellBridge } from "./bridge.js";

/**
 * The window's preload: it runs in the sandbox, isolated from the page, and
 * exposes the shell's members to the page and nothing else, never
 * `ipcRenderer` itself. Vite bundles it into one CommonJS script
 * (`dist/preload.cjs`), since a sandboxed preload can `require` little but
 * `electron`.
 */
contextBridge.exposeInMainWorld(SHELL_GLOBAL, shellBridge(ipcRenderer));
