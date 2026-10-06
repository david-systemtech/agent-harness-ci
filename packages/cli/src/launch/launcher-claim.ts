import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { win32 } from "node:path";

/**
 * The claim one launcher holds on a data directory while it runs (#1712): a
 * local socket the launcher listens on, which a second launcher on the same
 * data directory cannot listen on as well. On Windows it is a named pipe, which
 * goes with the process however it ends; Task Scheduler's End leaves the
 * launcher running, and a second start of the task must not start a second
 * launcher beside it. The service managers on macOS and Linux run one instance
 * of the service and stop the whole of it, so only Windows needs the claim.
 *
 * Whoever connects is told who holds the claim, one JSON line: the holder's
 * pid, and whether it is stopping. A launcher that is stopping is waited for;
 * one that runs on is not taken over.
 */

/** The holder of a claim, as it answers a connection. */
export interface ClaimHolder {
  readonly pid: number;
  /** Whether it is stopping: it drains its child and exits, and lets go of the claim when it has. */
  readonly stopping: boolean;
}

/** A claim this process holds. */
export interface LauncherClaim {
  /** Answers from now on that the holder is stopping. */
  markStopping(): void;
  /** Lets go of the claim; a later claim on the address succeeds. */
  release(): Promise<void>;
}

export type ClaimResult = { readonly claimed: LauncherClaim } | { readonly heldBy: ClaimHolder };

/** The named pipe the launchers on `dataDir` claim, one per data directory, as Windows compares paths: without regard to case. */
export const launcherClaimAddress = (dataDir: string): string =>
  `\\\\.\\pipe\\agent-harness-launcher-${createHash("sha256").update(win32.resolve(dataDir).toLowerCase()).digest("hex").slice(0, 32)}`;

const isHolder = (value: unknown): value is ClaimHolder =>
  typeof value === "object" &&
  value !== null &&
  Number.isSafeInteger((value as ClaimHolder).pid) &&
  typeof (value as ClaimHolder).stopping === "boolean";

/** What the holder of the claim at `address` says of itself; undefined when nothing listens there any more. */
const askHolder = (address: string): Promise<ClaimHolder | undefined> =>
  new Promise((resolve, reject) => {
    let answer = "";
    const socket = createConnection(address);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (answer += chunk));
    socket.on("end", () => {
      let holder: unknown;
      try {
        holder = JSON.parse(answer);
      } catch {
        holder = undefined;
      }
      if (isHolder(holder)) resolve(holder);
      else reject(new Error(`the launcher holding ${address} answered ${JSON.stringify(answer)}`));
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      // Its holder let go between the refused listen and this connection.
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(undefined);
      else reject(error);
    });
  });

/** Listens on `address`, answering each connection with `answer()`, and resolves with its release; undefined when another process listens there. */
const listen = (address: string, answer: () => ClaimHolder): Promise<(() => Promise<void>) | undefined> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.end(`${JSON.stringify(answer())}\n`);
    });
    server.once("error", (error: NodeJS.ErrnoException) => (error.code === "EADDRINUSE" ? resolve(undefined) : reject(error)));
    server.listen(address, () => {
      // The claim must not keep the process alive past the launcher's own exit.
      server.unref();
      resolve(() => new Promise<void>((done) => server.close(() => done())));
    });
  });

/** How often a claim is tried again when its holder lets go while it is asked. */
const CLAIM_TRIES = 5;

/** Claims `address` for this process, or says who holds it. */
export const claimLauncher = async (address: string): Promise<ClaimResult> => {
  let stopping = false;
  for (let tried = 0; tried < CLAIM_TRIES; tried++) {
    const release = await listen(address, () => ({ pid: process.pid, stopping }));
    if (release !== undefined) return { claimed: { markStopping: () => void (stopping = true), release } };
    const holder = await askHolder(address);
    if (holder !== undefined) return { heldBy: holder };
  }
  throw new Error(`${address} is in use, and nothing that listens there answers`);
};
