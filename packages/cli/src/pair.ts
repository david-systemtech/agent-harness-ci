import { randomUUID } from "node:crypto";
import { formatPairingCode, type Ceiling, type MintedPairing, type Scope } from "@agent-harness/contracts";
import { renderUnicodeCompact } from "uqr";
import { LocalFailure, LocalRefusal, withLocalSession, type LocalTarget, type Net } from "./local-session.js";

export interface PairArgs extends LocalTarget {
  readonly scopes?: readonly Scope[] | undefined;
  readonly ceiling?: Ceiling | undefined;
}

/** The label the verb's local client session is exchanged under, as `access.sessions.list` shows it. */
const LABEL = "agent-harness pair";

/**
 * Mints a pairing code on the environment whose data directory is
 * `args.dataDir`, as its own OS user, through a local client session
 * (`local-session.ts`): one `access.pairings.create`, with the client
 * session revoked after, so each run leaves none behind.
 */
export const mintPairing = async (args: PairArgs, net: Net): Promise<MintedPairing> =>
  withLocalSession(args, net, LABEL, async (call) => {
    const params = {
      commandId: randomUUID(),
      ...(args.scopes !== undefined && { scopes: [...args.scopes] }),
      ...(args.ceiling !== undefined && { ceiling: args.ceiling }),
    };
    let answer;
    try {
      answer = await call("access.pairings.create", params);
    } catch (error) {
      if (error instanceof LocalRefusal) throw new LocalFailure(`The environment refused to mint a pairing code: ${error.error.message}`);
      throw error;
    }
    // The response is the command's receipt beside the pairing; a fresh command id always carries the pairing.
    if (answer.result === undefined) throw new LocalFailure("The environment answered with something that is not a pairing code.");
    return answer.result;
  });

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
