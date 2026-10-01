import { WEBHOOK_HEADERS, signWebhook, webhookTimestamp } from "@agent-harness/contracts";
import type { Clock } from "../serve/clock.js";

/**
 * One signed webhook POST (routines spec, "Delivery targets"; #522): the
 * body as JSON with the Standard Webhooks headers, its timestamp and the
 * time taken read from the environment's clock, a ten-second timeout armed
 * on it, and no redirect followed. What it came to is answered, never
 * thrown: the status, the time taken, and what went wrong, a network error,
 * the timeout or a status other than 2xx.
 */

/** How long a POST may take before it is given up: ten seconds. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

export interface WebhookPost {
  readonly url: string;
  /** The endpoint's secret, which keys the signature. */
  readonly secret: string;
  /** The delivery's id: the `webhook-id` header, which the signature covers. */
  readonly id: string;
  /** The JSON body, signed and sent exactly as it is. */
  readonly body: string;
  readonly clock: Clock;
  /** Preset: `WEBHOOK_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** What a POST came to. */
export interface WebhookPostResult {
  /** The status the endpoint answered; null when none came. */
  readonly status: number | null;
  readonly durationMs: number;
  /** What went wrong; null when it was delivered, a 2xx. */
  readonly error: string | null;
}

const isRedirect = (status: number): boolean => status >= 300 && status < 400;

/** A network error as a sentence's end: the cause fetch names (`connect ECONNREFUSED 127.0.0.1:9`), its code, or the error itself. */
export const networkReason = (error: unknown): string => {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) {
    if (cause.message !== "") return cause.message;
    if ("code" in cause && typeof cause.code === "string") return cause.code;
  }
  return error instanceof Error ? error.message : String(error);
};

export const postWebhook = async (post: WebhookPost): Promise<WebhookPostResult> => {
  const { clock } = post;
  const timeoutMs = post.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const started = clock.now();
  const timestamp = webhookTimestamp(started);
  const signature = await signWebhook(post.secret, { id: post.id, timestamp, body: post.body });
  const elapsed = (): number => Math.max(0, clock.now().getTime() - started.getTime());
  const controller = new AbortController();
  const timer = clock.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(post.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_HEADERS.id]: post.id,
        [WEBHOOK_HEADERS.timestamp]: String(timestamp),
        [WEBHOOK_HEADERS.signature]: signature,
      },
      body: post.body,
      redirect: "manual",
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    const { status } = response;
    const error = response.ok
      ? null
      : isRedirect(status)
        ? `The endpoint answered ${status}, a redirect, which a webhook POST does not follow.`
        : `The endpoint answered ${status}.`;
    return { status, durationMs: elapsed(), error };
  } catch (error) {
    if (controller.signal.aborted) return { status: null, durationMs: elapsed(), error: `The endpoint did not answer within ${timeoutMs / 1000} seconds.` };
    return { status: null, durationMs: elapsed(), error: `The endpoint could not be reached: ${networkReason(error)}.` };
  } finally {
    timer.cancel();
  }
};
