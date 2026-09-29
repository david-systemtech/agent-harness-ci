import { oneOffMessage, runOneOff, sendMessage, uuidv4, type Lock } from "@agent-harness/client-runtime";
import { useEffect, useLayoutEffect, useRef } from "react";
import { showPane, useSideColumn } from "../side-column/column.js";
import { useClock, useRuntime } from "../window-context.js";
import { xtermScreens } from "./screens.js";
import { useTerminalPanes } from "./terminal-panes.js";

/** A shell line as the client runtime reads it (`shellLine`). */
export interface ShellLine {
  readonly send: boolean;
  readonly command: string;
}

export interface ShellLineHost {
  readonly environmentId: string;
  readonly sessionId: string;
  /** The pane's line now, and the setter that says another. */
  readonly line: string | undefined;
  readonly say: (line: string | undefined) => void;
  /** Whether a run can start now: `!!` sends what it printed only when one can. */
  readonly lock: Lock;
  /** Whether a run is live now, which the message `!!` sends joins. */
  readonly live: boolean;
}

/**
 * The composer's shell lines (docs/specs/gui.md, "A session pane": `!` and
 * `!!` as in the terminal UI; docs/specs/tui.md, "The composer"; #409):
 *
 * - `!command` runs in a terminal of its own, shown in the side column's
 *   Terminal pane, which opens and shows for it; the composer keeps the
 *   keys.
 * - `!!command` runs in a terminal of its own nobody sees, whose output the
 *   client runtime reads (`runOneOff`, through xterm.js as the pane would
 *   show it), and sends it to the agent as the session's next message once
 *   it ends, "Ran `command`:" and the output fenced, how it ended when not
 *   cleanly. A `!!` that ends after its session left the pane sends
 *   nothing: the pane shows another session then.
 *
 * Either is refused at once with one line when no terminal can be opened
 * (the capability's line), and `!!` also when its output could not be sent
 * (the lock's). The ids of both are one-offs, which no pane reopens as the
 * session's shell. It answers whether the line ran, so the box empties, or
 * was refused and stays.
 */
export const useShellLines = (host: ShellLineHost): ((shell: ShellLine) => boolean) => {
  const runtime = useRuntime();
  const clock = useClock();
  const terminals = useTerminalPanes();
  const { environmentId, sessionId } = host;
  const [, changeColumn] = useSideColumn({ environmentId, sessionId });
  // What a `!!` ending up to a minute later reads: the pane's line and run then, and whether its session is still here.
  const latest = useRef({ host, here: true });
  useLayoutEffect(() => {
    latest.current.host = host;
  });
  useEffect(() => {
    latest.current.here = true;
    return () => void (latest.current.here = false);
  }, []);

  const newTerminalId = () => {
    const id = uuidv4();
    terminals.oneOffs.add(id);
    return id;
  };

  return ({ send, command }) => {
    const { say, lock } = host;
    if (command.length === 0) {
      say(send ? "Usage: !!<command> runs it on the session's environment and sends what it printed to the agent." : "Usage: !<command> runs it in the session's terminal.");
      return false;
    }
    const opening = runtime.capability(environmentId, "terminals.open");
    if (opening.status === "absent") {
      say(`Not run: ${opening.message}`);
      return false;
    }
    if (!send) {
      say(undefined);
      changeColumn((held) => showPane(held, "terminal"));
      terminals.ask({ environmentId, sessionId }, { kind: "run", command });
      return true;
    }
    if (lock.locked) {
      say(`Not run: what it printed could not be sent. ${lock.reason}`);
      return false;
    }
    const name = runtime.projections.environments.read().find((view) => view.environmentId === environmentId)?.name ?? "the environment";
    const running = `Running ${command} on ${name}…`;
    say(running);
    void runOneOff({ runtime, clock, newCommandId: uuidv4, newTerminalId, screens: xtermScreens }, { environmentId, sessionId }, command).then((result) => {
      if (!latest.current.here) return;
      const now = latest.current.host;
      if (!result.ok) return now.say(`Not run: ${result.line}`);
      void sendMessage(runtime, environmentId, sessionId, { text: oneOffMessage(command, result), attachments: [] }, now.live).then((outcome) => {
        if (!outcome.ok) return latest.current.host.say(outcome.line);
        // The line it said goes, and only it: another said meanwhile stays.
        if (latest.current.host.line === running) latest.current.host.say(undefined);
      });
    });
    return true;
  };
};
