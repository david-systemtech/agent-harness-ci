import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOOTSTRAP_GRANT_FILE,
  BOOTSTRAP_PATH,
  BootstrapError,
  BootstrapGrant,
  ClientSessionCredential,
  PROTOCOL_VERSION,
  WIRE_PATH,
  decodeFrame,
  encodeFrame,
  formatHostPort,
  formatPairingCode,
  registry,
  type Ceiling,
  type MintedPairing,
  type Scope,
} from "@agent-harness/contracts";
import { HARNESS_VERSION } from "@agent-harness/environment";
import { renderUnicodeCompact } from "uqr";

/** The network the verb uses: the platform's own, or a test's recording one. */
export interface Net {
  readonly fetch: typeof fetch;
  readonly WebSocket: typeof WebSocket;
}

export interface PairArgs {
  readonly dataDir: string;
  /** The environment's port when it is not the one the grant file names. */
  readonly port?: number | undefined;
  readonly scopes?: readonly Scope[] | undefined;
  readonly ceiling?: Ceiling | undefined;
}

/** The pairing could not be minted; the message says why, for people. */
export class PairFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PairFailure";
  }
}

/** How long the verb waits for the environment over the wire. */
const WIRE_TIMEOUT_MS = 10_000;

/** The label the verb's local client session is exchanged under, as `access.sessions.list` shows it. */
const LABEL = "agent-harness pair";

const readGrant = (dataDir: string): BootstrapGrant => {
  const path = join(dataDir, BOOTSTRAP_GRANT_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PairFailure(`No environment is running on ${dataDir}: it has no bootstrap grant file.`);
    }
    throw new PairFailure(`The bootstrap grant file ${path} could not be read: ${(error as Error).message}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PairFailure(`The bootstrap grant file ${path} is not one an environment writes.`);
  }
  const grant = BootstrapGrant.safeParse(parsed);
  if (!grant.success) throw new PairFailure(`The bootstrap grant file ${path} is not one an environment writes.`);
  return grant.data;
};

/** Exchanges the grant's secret for a local `tui` client session, which the verb revokes itself once the code is minted. */
const exchangeGrant = async (origin: string, secret: string, net: Net): Promise<ClientSessionCredential> => {
  let response: Response;
  try {
    response = await net.fetch(`${origin}${BOOTSTRAP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, kind: "tui", label: LABEL }),
    });
  } catch (error) {
    throw new PairFailure(`The environment at ${origin} did not answer: ${(error as Error).message}`, { cause: error });
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const refusal = BootstrapError.safeParse(body);
    throw new PairFailure(`The environment refused the bootstrap exchange: ${refusal.success ? refusal.data.message : `HTTP ${response.status}`}`);
  }
  const credential = ClientSessionCredential.safeParse(body);
  if (!credential.success) throw new PairFailure(`The environment at ${origin} answered the bootstrap exchange with something that is not a client session.`);
  return credential.data;
};

/**
 * Authenticates on the wire, calls `access.pairings.create` once, then
 * revokes its own client session, which the environment answers with
 * `bye: revoked` and the close.
 */
const createOverWire = (
  url: string,
  credential: ClientSessionCredential,
  params: Record<string, unknown>,
  net: Net,
): Promise<MintedPairing> =>
  new Promise<MintedPairing>((resolve, reject) => {
    const ws = new net.WebSocket(url);
    let minted: MintedPairing | undefined;
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000);
      outcome();
    };
    const fail = (message: string) => settle(() => reject(new PairFailure(message)));
    const timer = setTimeout(() => fail(`The environment at ${url} did not answer within ${WIRE_TIMEOUT_MS / 1000} seconds.`), WIRE_TIMEOUT_MS);
    const request = (id: string, method: string, requestParams: Record<string, unknown>) =>
      ws.send(encodeFrame({ type: "request", id, method, params: requestParams }));

    ws.addEventListener("open", () =>
      ws.send(
        encodeFrame({ type: "auth", token: credential.token, protocolVersion: PROTOCOL_VERSION, clientKind: "tui", harnessVersion: HARNESS_VERSION }),
      ),
    );
    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = decodeFrame(String(event.data));
      } catch {
        return fail("The environment sent a frame this CLI cannot read.");
      }
      switch (frame.type) {
        case "hello":
          return request("pair", "access.pairings.create", params);
        case "ping":
          return ws.send(encodeFrame({ type: "pong" }));
        case "bye": {
          const pairing = minted;
          if (pairing && frame.reason === "revoked") return settle(() => resolve(pairing));
          return fail(`The environment closed the socket (${frame.reason})${frame.message ? `: ${frame.message}` : "."}`);
        }
        case "response": {
          if (frame.id === "revoke" && frame.error) return fail(`The environment would not revoke this CLI's client session: ${frame.error.message}`);
          if (frame.id !== "pair") return;
          if (frame.error) return fail(`The environment refused to mint a pairing code: ${frame.error.message}`);
          const result = registry["access.pairings.create"].result.safeParse(frame.result);
          if (!result.success) return fail("The environment answered with something that is not a pairing code.");
          minted = result.data;
          return request("revoke", "access.sessions.revoke", { commandId: randomUUID(), clientSessionId: credential.clientSessionId });
        }
        default:
          return;
      }
    });
    ws.addEventListener("error", () => fail(`The environment at ${url} did not answer.`));
    ws.addEventListener("close", () => fail("The environment closed the socket before answering."));
  });

/**
 * Mints a pairing code on the environment whose data directory is
 * `args.dataDir`, as its own OS user: exchanges the bootstrap grant for a
 * local client session, opens the wire, calls `access.pairings.create`, and
 * revokes that client session, so each run leaves none behind.
 */
export const mintPairing = async (args: PairArgs, net: Net): Promise<MintedPairing> => {
  const grant = readGrant(args.dataDir);
  const hostPort = formatHostPort(grant.address.host, args.port ?? grant.address.port);
  const credential = await exchangeGrant(`http://${hostPort}`, grant.secret, net);
  const params = {
    commandId: randomUUID(),
    ...(args.scopes !== undefined && { scopes: [...args.scopes] }),
    ...(args.ceiling !== undefined && { ceiling: args.ceiling }),
  };
  return createOverWire(`ws://${hostPort}${WIRE_PATH}`, credential, params, net);
};

/** What `pair` prints: the link, a QR of the link for a phone's camera, and the short code for typing. */
export const renderPairing = (pairing: MintedPairing): string =>
  [
    `Pair a client with this environment before ${pairing.expiresAt} (ten minutes, one use).`,
    "Open the link, scan the QR, or type the code:",
    "",
    `  ${pairing.link}`,
    "",
    renderUnicodeCompact(pairing.link, { border: 2 }),
    "",
    `  Code: ${formatPairingCode(pairing.code)}`,
    `  Scopes: ${pairing.scopes.join(", ")}`,
    `  Ceiling: ${pairing.ceiling}`,
    "",
  ].join("\n");
