import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A webhook receiver on loopback port 0 (routines spec, "Testing"; #522):
 * it records every request it takes and answers each as told, a status or
 * never, and `verifyStandardWebhook` checks a request's signature the way
 * the Standard Webhooks specification describes it, with Node's own HMAC,
 * independent of the contracts' signer.
 */

/** A request the receiver took, its body whole. */
export interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** How the receiver answers: a status with its headers, or `hang`, never. */
export type ReceiverAnswer = { readonly status: number; readonly headers?: Readonly<Record<string, string>> } | "hang";

export interface WebhookReceiver {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** Every request taken, oldest first. */
  readonly received: readonly ReceivedRequest[];
  /** How the requests from now on are answered; 204 until told. */
  answer(answer: ReceiverAnswer): void;
  /** Resolves with the request taken after the ones `received` holds now. */
  next(): Promise<ReceivedRequest>;
  /** Closes the server and every connection, a hanging one too. */
  close(): Promise<void>;
}

export const webhookReceiver = async (): Promise<WebhookReceiver> => {
  const received: ReceivedRequest[] = [];
  const waiting: ((request: ReceivedRequest) => void)[] = [];
  let answer: ReceiverAnswer = { status: 204 };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const taken: ReceivedRequest = { method: request.method ?? "", path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(taken);
      for (const resolve of waiting.splice(0)) resolve(taken);
      if (answer === "hang") return;
      response.writeHead(answer.status, answer.headers).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    answer: (next) => {
      answer = next;
    },
    next: () => new Promise((resolve) => waiting.push(resolve)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

/** A loopback origin nothing listens on: a server's port once it has closed. */
export const closedOrigin = async (): Promise<string> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
};

/** How far a `webhook-timestamp` may be from now, either way: Hermes's replay window. */
export const REPLAY_WINDOW_SECONDS = 300;

/**
 * Whether `request` carries a Standard Webhooks `v1` signature by `secret`
 * over its `webhook-id`, `webhook-timestamp` and body, its timestamp within
 * five minutes of `now`: the key a `whsec_` secret's base64 decodes to,
 * else the secret's bytes; any of the space-separated signatures may match,
 * compared in constant time.
 */
export const verifyStandardWebhook = (secret: string, request: ReceivedRequest, now: Date): boolean => {
  const header = (name: string): string | undefined => {
    const value = request.headers[name];
    return typeof value === "string" ? value : undefined;
  };
  const id = header("webhook-id");
  const timestamp = header("webhook-timestamp");
  const signatures = header("webhook-signature");
  if (id === undefined || timestamp === undefined || signatures === undefined || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp)) > REPLAY_WINDOW_SECONDS) return false;
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice("whsec_".length), "base64") : Buffer.from(secret, "utf8");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(request.body, "utf8").digest();
  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    if (version !== "v1" || signature === undefined) return false;
    const given = Buffer.from(signature, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
};
