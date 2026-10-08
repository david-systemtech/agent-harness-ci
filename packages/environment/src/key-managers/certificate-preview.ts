import type { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { connect } from "node:tls";
import { ContractError, httpOriginOf, invalidParams, type KeyManagerCertificate, type ParamsOf, type ResultOf } from "@agent-harness/contracts";
import { KEY_MANAGER_BUDGET_MS } from "./provider.js";

/**
 * The certificate preview (key-managers spec, "Providers"; ADR 0028):
 * before a person trusts a private CA, the environment opens a TLS socket to
 * the key manager with verification off, reads the chain its handshake
 * presents, and closes the socket without sending a byte of a request. It
 * answers the chain's anchor, the issuer walked up to as far as the chain
 * goes, else the leaf, with what a person needs to recognise it. Nothing is
 * pinned here: only a PEM a person accepted, sent back through
 * `keyManagers.connections.add` or `update`, becomes a connection's CA.
 */

/** The anchor of the chain `leaf` begins: each issuer the chain carries walked up to, stopping at one that signs itself. */
const anchorOf = (leaf: X509Certificate): X509Certificate => {
  const seen = new Set([leaf.fingerprint256]);
  let anchor = leaf;
  for (let issuer = anchor.issuerCertificate; issuer !== undefined && !seen.has(issuer.fingerprint256); issuer = anchor.issuerCertificate) {
    seen.add(issuer.fingerprint256);
    anchor = issuer;
  }
  return anchor;
};

/** The DNS names and IP addresses a certificate's subject alternative names hold, as Node writes them (`DNS:localhost, IP Address:127.0.0.1`). */
const namesOf = (certificate: X509Certificate): string[] =>
  [...(certificate.subjectAltName ?? "").matchAll(/(?:^|, )(?:DNS|IP Address):("(?:[^"\\]|\\.)*"|[^,]*)/g)].map(([, name = ""]) =>
    name.startsWith('"') ? (JSON.parse(name) as string) : name,
  );

/** What a person sees of a certificate before trusting it. */
const described = (certificate: X509Certificate): KeyManagerCertificate => ({
  pem: certificate.toString(),
  sha256Fingerprint: certificate.fingerprint256,
  subject: certificate.subject.split("\n").join(", "),
  names: namesOf(certificate),
  expiresAt: certificate.validToDate.toISOString(),
  selfSigned: certificate.checkIssued(certificate) && certificate.verify(certificate.publicKey),
});

type ChainAnswer = { readonly outcome: "read"; readonly certificate: KeyManagerCertificate } | { readonly outcome: "unreachable"; readonly reason: string };

/**
 * Reads the chain `origin` presents: its anchor, or why none could be read.
 * The budget is a deadline on the wall clock, from the connect to the
 * finished handshake, however busy the key manager keeps the socket
 * meanwhile.
 */
const readChain = (origin: string, budgetMs: number): Promise<ChainAnswer> =>
  new Promise((resolve) => {
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    // Verification off, for this read alone: the chain is shown to a person, never trusted here. A name goes as SNI; an address cannot.
    const socket = connect({ host, port: url.port === "" ? 443 : Number(url.port), rejectUnauthorized: false, ...(isIP(host) === 0 && { servername: host }) });
    let settled = false;
    const settle = (answer: ChainAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // Closed as it stands: nothing was written, and nothing is.
      socket.destroy();
      resolve(answer);
    };
    const deadline = setTimeout(() => settle({ outcome: "unreachable", reason: `no TLS handshake within ${budgetMs / 1000} seconds` }), budgetMs);
    socket.once("error", (error: Error) => settle({ outcome: "unreachable", reason: error.message.replace(/\s+/g, " ").trim() || "no answer" }));
    socket.once("secureConnect", () => {
      const leaf = socket.getPeerX509Certificate();
      if (leaf === undefined) return settle({ outcome: "unreachable", reason: "its handshake presented no certificate" });
      // Whatever a certificate the environment does not trust yet holds, reading it answers the query rather than throwing out of the socket's handler.
      try {
        settle({ outcome: "read", certificate: described(anchorOf(leaf)) });
      } catch (error) {
        settle({ outcome: "unreachable", reason: `its certificate could not be read (${error instanceof Error ? error.message : String(error)})` });
      }
    });
  });

/** `keyManagers.certificate.preview`: the anchor of the chain an `https` key manager presents; `unreachable` naming the address when none can be read. */
export const previewCertificate = async ({ address }: ParamsOf<"keyManagers.certificate.preview">, budgetMs = KEY_MANAGER_BUDGET_MS): Promise<ResultOf<"keyManagers.certificate.preview">> => {
  const origin = httpOriginOf(address);
  if (origin === null || !origin.startsWith("https://")) {
    const message = "A certificate is previewed at an https origin, as https://bao.example.com:8200.";
    throw new ContractError(invalidParams([{ code: "custom", path: ["address"], message }], message));
  }
  const answer = await readChain(origin, budgetMs);
  if (answer.outcome === "unreachable") {
    // setup-copy.md §5.7's line; what the socket met stays in details (#1852).
    throw new ContractError({
      code: "unreachable",
      message: `agent-harness could not reach ${origin}. Check the address.`,
      data: { address: origin, details: [`${origin} could not be reached for its certificate: ${answer.reason}.`] },
    });
  }
  return { certificate: answer.certificate };
};
