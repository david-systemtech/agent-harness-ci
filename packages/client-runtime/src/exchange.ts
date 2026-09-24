import { ClientSessionCredential } from "@agent-harness/contracts";
import type { HttpFetch } from "./platform.js";

/**
 * What an unauthenticated exchange (`POST /api/pair`, `POST /api/bootstrap`)
 * answered: a client session, nothing at all, or a refusal keyed on its
 * body's error `code`, with the HTTP status beside it.
 */
export type ExchangeAnswer =
  | { readonly ok: true; readonly credential: ClientSessionCredential }
  | { readonly ok: false; readonly kind: "unreachable"; readonly message: string }
  | {
      readonly ok: false;
      readonly kind: "refused";
      readonly status: number;
      readonly code: string | undefined;
      readonly message: string | undefined;
      readonly data: Readonly<Record<string, unknown>>;
    };

const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Posts `body` as JSON to `url` and reads the answer. */
export const postExchange = async (fetch: HttpFetch, url: string, body: object): Promise<ExchangeAnswer> => {
  let status: number;
  let json: unknown;
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    status = response.status;
    json = await response.json();
  } catch (error) {
    return { ok: false, kind: "unreachable", message: `Nothing answered at ${url}: ${error instanceof Error ? error.message : String(error)}.` };
  }
  if (status === 200) {
    const credential = ClientSessionCredential.safeParse(json);
    if (credential.success) return { ok: true, credential: credential.data };
  }
  const refusal = objectOf(json);
  return {
    ok: false,
    kind: "refused",
    status,
    code: typeof refusal["code"] === "string" ? refusal["code"] : undefined,
    message: typeof refusal["message"] === "string" ? refusal["message"] : undefined,
    data: objectOf(refusal["data"]),
  };
};
