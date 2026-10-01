import { randomUUID } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_PATH,
  PORT_FILE_NAME,
  decodeFromExtension,
  encodeBridgeMessage,
  type BridgeFromEnvironment,
  type BridgeFromExtension,
  type PortFile,
} from "@agent-harness/contracts";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * The scripted environment (browser spec, "Testing Decisions"): a loopback
 * WebSocket at the bridge's path that the worker dials from the port file
 * in its folder, and that answers nothing by itself. The test reads what
 * the extension sent and sends version 2's answers, one socket at a time,
 * so each handshake is spelled out where it is asserted.
 */

/** How long a test waits for something the extension or the environment does: a cap for a hang, never a budget. */
export const WAIT_MS = 20_000;

const withCap = <T>(promise: Promise<T>, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${WAIT_MS} ms waiting for ${what}.`)), WAIT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

/** One socket the extension opened. */
export interface PeerSocket {
  /** Every message the extension sent on it, in order. */
  readonly received: readonly BridgeFromExtension[];
  /** The first message, now or later, matching `predicate` that no earlier `next` returned. */
  next(predicate?: (message: BridgeFromExtension) => boolean): Promise<BridgeFromExtension>;
  send(message: BridgeFromEnvironment): void;
  /** Sends `refused` with `reason` and closes with 1008, as the listener ends a conversation. */
  refuse(reason: string): void;
  close(code?: number): void;
  /** Settles once the socket has closed, with its code. */
  readonly closed: Promise<{ readonly code: number }>;
}

export interface ScriptedEnvironment {
  readonly port: number;
  readonly environmentId: string;
  readonly environmentName: string;
  /** The port file this environment would write: its port, id and name. */
  readonly portFile: PortFile;
  /** The next socket the extension opens, now or later, that no earlier call returned. */
  nextSocket(): Promise<PeerSocket>;
  /** How many sockets the extension has opened. */
  socketCount(): number;
  close(): Promise<void>;
}

const peerSocket = (socket: WebSocket): PeerSocket => {
  const received: BridgeFromExtension[] = [];
  const returned = new Set<number>();
  const waiters = new Set<() => void>();
  let failure: Error | undefined;
  let isClosed = false;
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const closed = new Promise<{ readonly code: number }>((resolve) =>
    socket.once("close", (code) => {
      isClosed = true;
      resolve({ code });
      wake();
    }),
  );
  socket.on("message", (data) => {
    const decoded = decodeFromExtension(String(data));
    if (decoded.ok) received.push(decoded.message);
    else failure = new Error(`The extension sent what the codec refuses: ${decoded.reason}`);
    wake();
  });
  const send = (message: BridgeFromEnvironment) => {
    if (socket.readyState === socket.OPEN) socket.send(encodeBridgeMessage(message));
  };
  return {
    received,
    next: (predicate = () => true) =>
      withCap(
        new Promise<BridgeFromExtension>((resolve, reject) => {
          const look = () => {
            if (failure !== undefined) {
              waiters.delete(look);
              return reject(failure);
            }
            const index = received.findIndex((message, i) => !returned.has(i) && predicate(message));
            if (index >= 0) {
              returned.add(index);
              waiters.delete(look);
              return resolve(received[index] as BridgeFromExtension);
            }
            if (isClosed) {
              waiters.delete(look);
              reject(new Error(`The socket closed before the message came; received ${JSON.stringify(received)}.`));
            }
          };
          waiters.add(look);
          look();
        }),
        "a message from the extension",
      ),
    send,
    refuse(reason) {
      send({ type: "refused", reason });
      socket.close(1008);
    },
    close: (code = 1000) => socket.close(code),
    closed,
  };
};

/** Starts a scripted environment on a free loopback port. */
export const scriptedEnvironment = async (options: { readonly name?: string; readonly environmentId?: string } = {}): Promise<ScriptedEnvironment> => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: BRIDGE_PATH });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The scripted environment has no port.");
  const sockets: PeerSocket[] = [];
  const raw: WebSocket[] = [];
  let taken = 0;
  const arrivals = new Set<() => void>();
  server.on("connection", (socket) => {
    raw.push(socket);
    sockets.push(peerSocket(socket));
    for (const arrival of [...arrivals]) arrival();
  });
  const environmentId = options.environmentId ?? randomUUID();
  const environmentName = options.name ?? "Laptop";
  return {
    port: address.port,
    environmentId,
    environmentName,
    portFile: { port: address.port, environmentId, environmentName, harnessVersion: "1.2.3-test" },
    nextSocket: () =>
      withCap(
        new Promise<PeerSocket>((resolve) => {
          const look = () => {
            const socket = sockets[taken];
            if (socket === undefined) return;
            taken += 1;
            arrivals.delete(look);
            resolve(socket);
          };
          arrivals.add(look);
          look();
        }),
        "the extension to open a socket",
      ),
    socketCount: () => sockets.length,
    close: async () => {
      for (const socket of raw) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/** A folder standing for the extension's own, unpacked: the worker reads its port file from it. */
export interface OwnFolder {
  readonly path: string;
  /** Writes the port file as the environment does: a whole file, renamed into place. */
  writePortFile(file: PortFile | string): void;
  removePortFile(): void;
  /** Reads a file of the folder, null when it is not there: the worker's and the options page's `readOwnFile`. */
  readOwnFile(path: string): Promise<string | null>;
  remove(): void;
}

export const ownFolder = (): OwnFolder => {
  const path = mkdtempSync(join(tmpdir(), "agent-harness-extension-own-"));
  return {
    path,
    writePortFile(file) {
      const staged = join(path, `${PORT_FILE_NAME}.${randomUUID()}.tmp`);
      writeFileSync(staged, typeof file === "string" ? file : JSON.stringify(file));
      renameSync(staged, join(path, PORT_FILE_NAME));
    },
    removePortFile: () => rmSync(join(path, PORT_FILE_NAME), { force: true }),
    readOwnFile: (file) => readFile(join(path, file), "utf8").catch(() => null),
    remove: () => rmSync(path, { recursive: true, force: true }),
  };
};
