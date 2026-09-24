import { randomUUID } from "node:crypto";
import {
  ContractError,
  TerminalExitedPayload,
  TerminalSnapshot,
  registry,
  type EndReason,
  type Frame,
  type ParamsOf,
  type ResponseOf,
} from "@agent-harness/contracts";
import type { WireClient } from "./wire-client.js";

/**
 * What the terminal, file and diff suites share (#124): a session in a
 * directory of the test's own, the terminal commands as a client sends
 * them, and one terminal subscription as a client follows it.
 */

/** Creates a session whose workspace is the directory `path`; resolves with its id. */
export const sessionIn = async (client: WireClient, path: string): Promise<string> => {
  const id = randomUUID();
  await client.apply("sessions.create", { commandId: randomUUID(), id, workspace: { kind: "directory", path } });
  return id;
};

type TerminalCommand = "terminals.open" | "terminals.write" | "terminals.resize" | "terminals.close";

/** Sends a terminal command with a fresh command id (unless one is given); resolves with its response, checked against its schema. */
export const terminalCommand = async <N extends TerminalCommand>(
  client: WireClient,
  method: N,
  params: Omit<ParamsOf<N>, "commandId"> & { commandId?: string },
): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** Opens a terminal with a fresh id on the session; resolves with the terminal; throws unless it was accepted. */
export const openTerminal = async (client: WireClient, sessionId: string, extra: Partial<ParamsOf<"terminals.open">> = {}) => {
  const answer = await terminalCommand(client, "terminals.open", { id: randomUUID(), sessionId, ...extra });
  if (answer.result === undefined) throw new Error(`terminals.open was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.terminal;
};

/** Writes `data` to the terminal; throws unless it was accepted. */
export const typeInto = async (client: WireClient, id: string, data: string): Promise<void> => {
  const answer = await terminalCommand(client, "terminals.write", { id, data });
  if (answer.receipt.status !== "accepted") throw new Error(`terminals.write was not applied: ${JSON.stringify(answer.receipt)}`);
};

/** One terminal subscription as a client follows it: what it has received, folded, and how to wait for more. */
export interface TerminalView {
  readonly subscription: string;
  /** Every frame of the subscription, in order, `subscribed` aside. */
  readonly frames: Frame[];
  /** The snapshot, if one came. */
  snapshot: TerminalSnapshot | undefined;
  /** The scrollback of the snapshot, if any, then every output chunk since, joined. */
  text: string;
  /** The last sequence received: the cursor to resubscribe from. */
  cursor: number;
  synchronized: boolean;
  exited: TerminalExitedPayload | undefined;
  ended: EndReason | undefined;
  /** Takes frames until `condition` holds of the view; rejects if the subscription ends first or a frame is slow. */
  until(condition: (view: TerminalView) => boolean, what?: string): Promise<TerminalView>;
}

/** Subscribes to the terminal from `afterSequence`; resolves with the view once `subscribed` came. */
export const follow = async (client: WireClient, id: string, afterSequence = 0): Promise<TerminalView> => {
  const { subscription } = await client.subscribe("terminals.subscribe", { id, afterSequence });
  const ours = (frame: Frame): boolean =>
    "subscription" in frame && frame.subscription === subscription && ["snapshot", "event", "synchronized", "end"].includes(frame.type);
  const view: TerminalView = {
    subscription,
    frames: [],
    snapshot: undefined,
    text: "",
    cursor: afterSequence,
    synchronized: false,
    exited: undefined,
    ended: undefined,
    async until(condition, what = "the terminal view") {
      while (!condition(view)) {
        if (view.ended !== undefined) throw new Error(`The subscription ended (${view.ended}) before ${what}; text: ${JSON.stringify(view.text.slice(-400))}`);
        const frame = await client.next(ours);
        view.frames.push(frame);
        switch (frame.type) {
          case "snapshot": {
            const snapshot = TerminalSnapshot.parse(frame.payload);
            view.snapshot = snapshot;
            view.text = snapshot.scrollback;
            view.cursor = frame.sequence;
            break;
          }
          case "event":
            view.cursor = frame.sequence;
            if (frame.event.type === "terminal.output") view.text += String(frame.event.payload["data"]);
            if (frame.event.type === "terminal.exited") view.exited = TerminalExitedPayload.parse(frame.event.payload);
            break;
          case "synchronized":
            view.synchronized = true;
            break;
          case "end":
            view.ended = frame.reason;
            break;
        }
      }
      return view;
    },
  };
  return view;
};

/** Waits, following from `afterSequence`, until the terminal has printed `text`. */
export const waitForOutput = async (client: WireClient, id: string, text: string, afterSequence = 0): Promise<TerminalView> => {
  const view = await follow(client, id, afterSequence);
  return view.until((v) => v.text.includes(text), `the output ${JSON.stringify(text)}`);
};

/**
 * Polls the terminal's snapshot until its scrollback holds `text`, for output
 * too large to follow live; resolves with that snapshot. Each poll is a
 * subscription from cursor 0, unsubscribed once its snapshot came.
 */
export const pollScrollback = async (client: WireClient, id: string, text: string, timeoutMs = 60_000): Promise<TerminalSnapshot> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await follow(client, id, 0);
    await view.until((v) => v.snapshot !== undefined, "the snapshot");
    client.send({ type: "unsubscribe", subscription: view.subscription });
    await client.next((frame) => frame.type === "end" && frame.subscription === view.subscription);
    const snapshot = view.snapshot as TerminalSnapshot;
    if (snapshot.scrollback.includes(text)) return snapshot;
    if (Date.now() > deadline) throw new Error(`The scrollback never held ${JSON.stringify(text)}; it ends ${JSON.stringify(snapshot.scrollback.slice(-200))}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

/** The error a request is refused with. */
export const refusedWith = async (request: Promise<unknown>): Promise<ContractError> => {
  try {
    await request;
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("The request was answered, not refused.");
};
