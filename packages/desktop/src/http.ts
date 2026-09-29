import { BOOTSTRAP_PATH, DISCOVERY_PATH, PAIR_PATH, UPDATE_PATH } from "@agent-harness/contracts";
import { options, optionalText, text } from "./arguments.js";
import type { HttpAnswer } from "./channels.js";
import { isWebLink } from "./schemes.js";

/**
 * The shell's `http`: HTTP to an environment made by the main process,
 * outside Chromium and its request lockdown, so the environment needs no
 * cross-origin headers (docs/specs/gui.md, "The desktop shell"). It reaches
 * the routes the runtime asks an environment over HTTP and no others:
 * discovery, the pairing and bootstrap exchanges, and the update route. A
 * redirect is answered as it is, never followed.
 */
const ROUTES: ReadonlySet<string> = new Set([DISCOVERY_PATH, PAIR_PATH, BOOTSTRAP_PATH, UPDATE_PATH]);

export const environmentHttp = async (address: unknown, given: unknown): Promise<HttpAnswer> => {
  const url = new URL(text(address, "The request's address"));
  if (!isWebLink(url.href)) throw new TypeError(`The shell's http speaks http and https, not ${url.protocol}`);
  if (url.username !== "" || url.password !== "") throw new TypeError("The shell's http takes no credentials in an address.");
  if (!ROUTES.has(url.pathname)) {
    throw new TypeError(`The shell's http reaches an environment's discovery, pairing, bootstrap and update routes only, not ${url.pathname}.`);
  }
  const request = options(given, "The request");
  const method = request["method"] ?? "GET";
  if (method !== "GET" && method !== "POST") throw new TypeError(`The shell's http sends GET and POST, not ${String(method)}.`);
  const headers = Object.fromEntries(Object.entries(options(request["headers"], "The request's headers")).map(([name, value]) => [name, text(value, `The header ${name}`)]));
  const body = optionalText(request["body"], "The request's body");
  const response = await fetch(url, { method, headers, ...(body !== undefined && { body }), redirect: "manual" });
  return { status: response.status, body: await response.text() };
};
