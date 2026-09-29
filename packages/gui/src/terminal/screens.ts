import { xtermScreen, type TextScreens } from "@agent-harness/client-runtime";
import { Terminal } from "@xterm/xterm";

/**
 * The emulator a `!!` command's output is read through (the client
 * runtime's `runOneOff`): xterm.js, which the terminal pane draws with,
 * never opened, so what the agent is sent is what the pane would have shown.
 */
export const xtermScreens: TextScreens = (size) => xtermScreen(new Terminal({ ...size, allowProposedApi: true }));
