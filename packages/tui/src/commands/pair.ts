import { formatPairingCode, type MintedPairing } from "@agent-harness/contracts";
import type { EnvironmentView, PairingOutcome, Runtime } from "@agent-harness/client-runtime";
import { renderUnicodeCompact } from "uqr";
import { clockTime, nameOf } from "../view.js";

/**
 * `/pair` both ways (docs/specs/tui.md, "First launch: local detection,
 * service down, pairing"): pairing this terminal through
 * `connections.add`, each outcome one line; and `/pair create`, minting a
 * code for another client through `access.pairings.create` with `admin`.
 */

/** A pairing's outcome in one line; a re-pair offer is a question the caller asks. */
export const pairingLine = (outcome: PairingOutcome, views: readonly EnvironmentView[]): string => {
  switch (outcome.status) {
    case "paired": {
      const found = views.find((v) => v.environmentId === outcome.environmentId);
      const name = found ? nameOf(found) : "the environment";
      const replaced = outcome.replaced && !outcome.replaced.revoked ? ` ${outcome.replaced.message}` : "";
      return `Paired with ${name}.${replaced}`;
    }
    case "re-pair-offered":
      return `${outcome.name} is paired already. Pair it again in place? y/n`;
    case "failed":
      // A terminal has no Details fold: the raw failure (`fetch failed`, the HTTP status, the protocols) follows the plain line.
      return `Not paired: ${outcome.failure.message}${outcome.failure.details?.length ? ` Details: ${outcome.failure.details.join("; ")}` : ""}`;
  }
};

/** What `/pair create` prints: who it is for and until when, the link, the code, and a QR of the link in block characters. */
export interface MintedLines {
  readonly heading: string;
  readonly link: string;
  readonly code: string;
  readonly qr: readonly string[];
  /** The link and the code on one line, for when the card cannot be shown. */
  readonly line: string;
}

export const mintedLines = (environment: string, pairing: MintedPairing): MintedLines => ({
  heading: `Pair a client with ${environment} before ${clockTime(pairing.expiresAt)} (ten minutes, one use): open the link, scan the QR, or type the code.`,
  link: pairing.link,
  code: `Code: ${formatPairingCode(pairing.code)}`,
  qr: renderUnicodeCompact(pairing.link, { border: 1 }).split("\n"),
  line: `Pairing code for ${environment}: ${pairing.link} (${formatPairingCode(pairing.code)})`,
});

export type MintOutcome = { readonly ok: true; readonly lines: MintedLines } | { readonly ok: false; readonly line: string };

/** `/pair create` on `environment`: absent with the reason `requests.call` gives without `admin`, else the minted code. */
export const mintPairing = async (runtime: Runtime, environment: EnvironmentView, commandId: string): Promise<MintOutcome> => {
  const answer = await runtime.requests.call(environment.environmentId, "access.pairings.create", { commandId });
  if (!answer.ok) return { ok: false, line: `Cannot create a pairing code on ${nameOf(environment)}: ${answer.error.message}` };
  const { receipt, result } = answer.result;
  if (receipt.status === "rejected") return { ok: false, line: `Creating a pairing code on ${nameOf(environment)} was rejected: ${receipt.error.message}` };
  if (!result) return { ok: false, line: `${nameOf(environment)} accepted the pairing but sent no code; try again.` };
  return { ok: true, lines: mintedLines(nameOf(environment), result) };
};
