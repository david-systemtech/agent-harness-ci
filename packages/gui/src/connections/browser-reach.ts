import type { ConnectionRecord, Runtime } from "@agent-harness/client-runtime";

/** The connection to the environment that served this browser tab: the one saved at the page's own origin. */
export const servingConnection = (records: readonly ConnectionRecord[], pageOrigin: string): ConnectionRecord | undefined =>
  records.find((record) => originOf(record.address) === pageOrigin);

const originOf = (address: string): string | undefined => {
  try {
    return new URL(address).origin;
  } catch {
    return undefined;
  }
};

/**
 * The environment whose Allowed connection origins leave out `origin`, when
 * this browser tab may not contact it (#1713): the page's
 * Content-Security-Policy lets it reach its own origin and those the serving
 * environment lists (`web.origins.get`), and the browser refuses any other
 * before a request leaves, which `fetch` reports as nothing answering.
 * Undefined when the tab may contact `origin`, and when the list cannot be
 * read: then the exchange itself says what happened.
 */
export const unlistedBy = async (runtime: Runtime, origin: string, pageOrigin: string): Promise<string | undefined> => {
  if (originOf(origin) === pageOrigin) return undefined;
  const serving = servingConnection(runtime.connections.list.read(), pageOrigin);
  if (serving === undefined) return undefined;
  const answer = await runtime.requests.call(serving.environmentId, "web.origins.get", {});
  if (!answer.ok) return undefined;
  return answer.result.connectOrigins.some((listed) => originOf(listed) === originOf(origin)) ? undefined : serving.environmentId;
};
