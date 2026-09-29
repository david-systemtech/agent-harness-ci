import type { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { connect } from "node:tls";
import { ContractError, httpOriginOf, invalidParams, type KeyManagerCertificate, type ParamsOf, type ResultOf } from "@agent-harness/contracts";

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

/** How long the handshake may take (ADR 0031's budget). */
const PREVIEW_TIMEOUT_MS = 10_000;

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

/** Reads the chain `origin` presents: its anchor, or why none could be read. */
const readChain = (origin: string): Promise<{ readonly outcome: "read"; readonly certificate: KeyManagerCertificate } | { readonly outcome: "unreachable"; readonly reason: string }> =>
  new Promise((resolve) => {
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    // Verification off, for this read alone: the chain is shown to a person, never trusted here. A name goes as SNI; an address cannot.
    const socket = connect({ host, port: url.port === "" ? 443 : Number(url.port), rejectUnauthorized: false, ...(isIP(host) === 0 && { servername: host }) });
    let settled = false;
    const settle = (answer: Awaited<ReturnType<typeof readChain>>): void => {
      if (settled) return;
      settled = true;
      // Closed as it stands: nothing was written, and nothing is.
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(PREVIEW_TIMEOUT_MS, () => settle({ outcome: "unreachable", reason: `no TLS handshake within ${PREVIEW_TIMEOUT_MS / 1000} seconds` }));
    socket.once("error", (error: Error) => settle({ outcome: "unreachable", reason: error.message.replace(/\s+/g, " ").trim() || "no answer" }));
    socket.once("secureConnect", () => {
      const leaf = socket.getPeerX509Certificate();
      settle(leaf === undefined ? { outcome: "unreachable", reason: "its handshake presented no certificate" } : { outcome: "read", certificate: described(anchorOf(leaf)) });
    });
  });

/** `keyManagers.certificate.preview`: the anchor of the chain an `https` key manager presents; `unreachable` naming the address when none can be read. */
export const previewCertificate = async ({ address }: ParamsOf<"keyManagers.certificate.preview">): Promise<ResultOf<"keyManagers.certificate.preview">> => {
  const origin = httpOriginOf(address);
  if (origin === null || !origin.startsWith("https://")) {
    const message = "A certificate is previewed at an https origin, as https://bao.example.com:8200.";
    throw new ContractError(invalidParams([{ code: "custom", path: ["address"], message }], message));
  }
  const answer = await readChain(origin);
  if (answer.outcome === "unreachable") throw new ContractError({ code: "unreachable", message: `${origin} could not be reached for its certificate: ${answer.reason}.`, data: { address: origin } });
  return { certificate: answer.certificate };
};
