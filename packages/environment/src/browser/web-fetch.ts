import { request, type IncomingMessage } from "node:http";
import { connect as connectTcp, isIP, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { pipeline } from "node:stream/promises";
import { Writable, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { checkHop, type AddressRules, type ResolvedAddress } from "./address-rules.js";

/**
 * `web_read`'s fetch (browser spec, "`web_read`"): a GET on the run's
 * environment, HTTP and HTTPS only, at most five redirects, each hop held to
 * the address rules as the first is and connected to the address the rules
 * checked, a body read no further than its kind's limit, and all of it
 * within the deadline the caller's signal carries. What comes back is the
 * body with its kind, a status that has no page to read, or a sentence.
 */

/** Most redirects followed: a sixth is refused. */
export const MAX_REDIRECTS = 5;

/** Most bytes read of an HTML or text body, and of a PDF's. */
export const BODY_LIMITS = { html: 20 * 1024 * 1024, text: 20 * 1024 * 1024, pdf: 50 * 1024 * 1024 } as const;

/** What a body is read as: an HTML page, text, or a PDF. */
export type BodyKind = keyof typeof BODY_LIMITS;

/** How the read opens a TCP connection to an address the rules checked; tests route one to their loopback server. */
export type Dialer = (target: ResolvedAddress & { readonly port: number }) => Socket;

export const systemDialer: Dialer = ({ address, port }) => connectTcp({ host: address, port });

export interface FetchOptions {
  readonly rules: () => AddressRules;
  readonly dial: Dialer;
  readonly userAgent: string;
  /** The denylist's hosts section's reading of a redirect's address: the entry it matches, named, or null. */
  readonly denylisted: (url: string) => string | null;
  /** Aborted at the deadline, or when the provider gives up on the call. */
  readonly signal: AbortSignal;
  /** The sentence the model reads when `signal` aborts. */
  readonly abortReason: () => string;
}

/** What a fetch came to. */
export type Fetched =
  /** A body to read: where it was read from, after any redirects, and whether it was cut off at its kind's limit. */
  | {
      readonly kind: "body";
      readonly url: URL;
      readonly redirects: number;
      readonly status: number;
      readonly bodyKind: BodyKind;
      readonly contentType: string;
      readonly bytes: Uint8Array;
      readonly cutOff: boolean;
    }
  /** A status that answers no page: a refusal, an error, a redirect with nowhere to go. */
  | { readonly kind: "status"; readonly url: URL; readonly status: number; readonly statusText: string }
  /** A sentence: the address rules, a scheme, a redirect too many, a type web_read does not read, a connection that failed. */
  | { readonly kind: "refused"; readonly reason: string };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The content types read as HTML, and the others read as text; a PDF by its own type, or by its first bytes when a server names none. */
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_TYPES = new Set(["application/json", "application/xml", "application/javascript", "application/x-ndjson"]);
const PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);
/** What a server says when it does not say: the body is looked at for a PDF's signature. */
const UNNAMED_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/** How a declared type is read, `sniff` for one that names nothing, null for a type web_read does not read. */
const kindOfType = (mediaType: string): BodyKind | "sniff" | null => {
  if (HTML_TYPES.has(mediaType)) return "html";
  if (PDF_TYPES.has(mediaType)) return "pdf";
  if (mediaType.startsWith("text/") || TEXT_TYPES.has(mediaType) || /\+(?:json|xml)$/.test(mediaType)) return "text";
  if (UNNAMED_TYPES.has(mediaType)) return "sniff";
  return null;
};

/** The media type of a Content-Type header: lower case, no parameters. */
const mediaTypeOf = (contentType: string): string => (contentType.split(";")[0] ?? "").trim().toLowerCase();

const PDF_SIGNATURE = "%PDF-";

/** The decoder for a Content-Encoding, null for identity, undefined for one web_read cannot decode. */
const decoderFor = (encoding: string): (() => Readable & NodeJS.WritableStream) | null | undefined => {
  switch (encoding.trim().toLowerCase()) {
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return createGunzip;
    case "deflate":
      return createInflate;
    case "br":
      return createBrotliDecompress;
    default:
      return undefined;
  }
};

/**
 * Reads a response's body, decoded, up to `limit` bytes: past it the rest
 * is left unread and the body is marked cut off. The limit counts what the
 * encoding decodes to, so a small compressed body cannot unpack past it.
 */
const readBody = async (response: IncomingMessage, limit: number, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly cutOff: boolean }> => {
  const decoder = decoderFor(response.headers["content-encoding"] ?? "");
  const chunks: Buffer[] = [];
  let size = 0;
  let cutOff = false;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      const room = limit - size;
      if (chunk.byteLength > room) {
        chunks.push(chunk.subarray(0, room));
        size = limit;
        cutOff = true;
        done(new BodyLimitReached());
        return;
      }
      chunks.push(chunk);
      size += chunk.byteLength;
      done();
    },
  });
  try {
    await (decoder ? pipeline(response, decoder(), sink, { signal }) : pipeline(response, sink, { signal }));
  } catch (error) {
    if (!(error instanceof BodyLimitReached)) throw error;
  } finally {
    response.destroy();
  }
  // A buffer of the body's own, never a slice of Node's pool, since it moves to the extraction worker whole.
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes, cutOff };
};

class BodyLimitReached extends Error {}

/** One GET of `url` over a connection to `target`, answering the response's head; its body is read by the caller. */
const get = (url: URL, target: ResolvedAddress, options: FetchOptions): Promise<IncomingMessage> =>
  new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const port = url.port === "" ? (secure ? 443 : 80) : Number(url.port);
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const createConnection = (): Socket => {
      const socket = options.dial({ ...target, port });
      // TLS names the host the address was checked for, so the certificate is checked against it and not the address.
      return secure ? connectTls({ socket, host, ...(isIP(host) === 0 && { servername: host }), ALPNProtocols: ["http/1.1"] }) : socket;
    };
    const outgoing = request({
      method: "GET",
      path: `${url.pathname}${url.search}`,
      setHost: false,
      headers: {
        host: url.host,
        "user-agent": options.userAgent,
        accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.9,*/*;q=0.5",
        "accept-encoding": "gzip, deflate, br",
      },
      createConnection,
      signal: options.signal,
    });
    outgoing.on("response", resolve);
    outgoing.on("error", reject);
    outgoing.end();
  });

/** Why a connection failed, in the words of its error code where it has one. */
const failureOf = (error: unknown): string => (error instanceof Error ? ("code" in error && typeof error.code === "string" ? error.code : error.message) : String(error));

/** A GET of `url`, tried at each address the rules checked in turn until one connects. */
const getFirst = async (url: URL, addresses: readonly ResolvedAddress[], options: FetchOptions): Promise<IncomingMessage | string> => {
  let failure = "no address";
  for (const target of addresses) {
    try {
      return await get(url, target, options);
    } catch (error) {
      if (options.signal.aborted) throw error;
      failure = failureOf(error);
    }
  }
  return `${url.href} could not be reached (${failure}).`;
};

/** A scheme web_read reads. */
const readable = (url: URL): boolean => url.protocol === "http:" || url.protocol === "https:";

/** The sentence for a scheme web_read does not read. */
export const schemeRefusal = (address: string, scheme: string): string => `web_read reads http and https addresses only; ${address} uses ${scheme.replace(/:$/, "")}.`;

/**
 * Fetches `url`: at each hop the address rules first, then, for a hop a
 * redirect named, the denylist's hosts section, which the gate checked the
 * first hop against before the call; the connection to an address the rules
 * checked; a redirect followed to at most five; a body read to its kind's
 * limit, or a status with no page to read.
 */
export const fetchPage = async (first: URL, options: FetchOptions): Promise<Fetched> => {
  try {
    let url = first;
    for (let redirects = 0; ; redirects++) {
      // The denylist first, as the gate met the first hop before the call ran; then the address rules.
      if (redirects > 0) {
        const entry = options.denylisted(url.href);
        if (entry !== null) {
          return {
            kind: "refused",
            reason: `A redirect led to ${url.href}, which was not followed: ${entry}. To read it, call web_read on that address, and the person is asked.`,
          };
        }
      }
      const ruling = await checkHop(url, options.rules());
      if (!ruling.ok) return { kind: "refused", reason: redirects === 0 ? ruling.reason : `A redirect led to ${url.href}, which was not followed: ${ruling.reason}` };
      const response = await getFirst(url, ruling.addresses, options);
      if (typeof response === "string") return { kind: "refused", reason: response };
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (REDIRECTS.has(status) && location !== undefined) {
        response.destroy();
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { kind: "refused", reason: `${url.href} redirected to ${location}, which is no address.` };
        }
        if (!readable(next)) return { kind: "refused", reason: `${url.href} redirected to ${next.href}: ${schemeRefusal(next.href, next.protocol)}` };
        if (redirects === MAX_REDIRECTS) {
          return { kind: "refused", reason: `${first.href} redirected ${MAX_REDIRECTS} times; the sixth redirect, to ${next.href}, was not followed.` };
        }
        url = next;
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        return { kind: "status", url, status, statusText: response.statusMessage ?? "" };
      }
      const contentType = response.headers["content-type"] ?? "";
      const mediaType = mediaTypeOf(contentType);
      const declared = kindOfType(mediaType);
      if (declared === null) {
        response.destroy();
        return { kind: "refused", reason: `web_read reads HTML, text and PDFs; ${url.href} is ${mediaType}.` };
      }
      if (decoderFor(response.headers["content-encoding"] ?? "") === undefined) {
        response.destroy();
        return { kind: "refused", reason: `${url.href} is encoded as ${response.headers["content-encoding"]}, which web_read cannot decode.` };
      }
      const limit = declared === "sniff" ? BODY_LIMITS.pdf : BODY_LIMITS[declared];
      const body = await readBody(response, limit, options.signal);
      let bodyKind: BodyKind;
      if (declared !== "sniff") bodyKind = declared;
      else if (Buffer.from(body.bytes.subarray(0, PDF_SIGNATURE.length)).toString("latin1") === PDF_SIGNATURE) bodyKind = "pdf";
      else return { kind: "refused", reason: `web_read reads HTML, text and PDFs; ${url.href} ${mediaType === "" ? "names no content type" : `is ${mediaType}`}, and is no PDF.` };
      return { kind: "body", url, redirects, status, bodyKind, contentType, bytes: body.bytes, cutOff: body.cutOff };
    }
  } catch (error) {
    if (options.signal.aborted) return { kind: "refused", reason: options.abortReason() };
    return { kind: "refused", reason: `${first.href} could not be read (${failureOf(error)}).` };
  }
};
