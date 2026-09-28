import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { GIT_CREDENTIAL_PATH, formatHostPort, type CommandReceipt, type EventEnvelope, type EventFrame, type ForgeAccountRecord, type ParamsOf, type ResponseOf } from "@agent-harness/contracts";
import type { Address } from "../src/serve/http.js";
import type { TestEnvironment } from "./helper.js";
import { create } from "./sessions.js";
import type { WireClient } from "./wire-client.js";

/**
 * What the forge suites share (#310, #312): the forge account methods sent
 * as a client sends them, the forge events a client reads, and what a run's
 * provider says back of a value, which is how a test sees whether the
 * environment holds it as a secret.
 */

/** Values that stand for tokens a person pastes: nothing a secret scanner takes for a real one. */
export const TOKEN = "token-for-tests";
export const OTHER_TOKEN = "second-paste-for-tests";

export const DAVID = { login: "david", id: 42 } as const;

export const pasted = (token: string) => ({ kind: "stored", provenance: "pasted", token }) as const;

export type AddParams = Omit<ParamsOf<"forge.accounts.add">, "commandId" | "forgeAccountId" | "credential"> &
  Partial<Pick<ParamsOf<"forge.accounts.add">, "forgeAccountId" | "credential">>;

/** Sends `forge.accounts.add` with a fresh command id and forge account id unless given, and the test's token unless another credential is. */
export const add = (client: WireClient, params: AddParams): Promise<ResponseOf<"forge.accounts.add">> =>
  client.request("forge.accounts.add", { commandId: randomUUID(), forgeAccountId: randomUUID(), credential: pasted(TOKEN), ...params });

/** The forge account an add made; throws unless the add was accepted. */
export const added = async (client: WireClient, params: AddParams): Promise<ForgeAccountRecord> => {
  const answer = await add(client, params);
  if (answer.result === undefined) throw new Error(`forge.accounts.add was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.account;
};

export const update = (client: WireClient, params: Omit<ParamsOf<"forge.accounts.update">, "commandId">): Promise<ResponseOf<"forge.accounts.update">> =>
  client.request("forge.accounts.update", { commandId: randomUUID(), ...params });

export const remove = (client: WireClient, forgeAccountId: string): Promise<ResponseOf<"forge.accounts.remove">> =>
  client.request("forge.accounts.remove", { commandId: randomUUID(), forgeAccountId });

export const setPrimary = (client: WireClient, forgeAccountId: string): Promise<ResponseOf<"forge.accounts.setPrimary">> =>
  client.request("forge.accounts.setPrimary", { commandId: randomUUID(), forgeAccountId });

export const list = async (client: WireClient): Promise<ForgeAccountRecord[]> => (await client.request("forge.accounts.list", {})).accounts;

/** Sends `forge.accounts.verify` for one forge account, or every one; answers the records it answers. */
export const verify = async (client: WireClient, forgeAccountId?: string): Promise<ForgeAccountRecord[]> =>
  (await client.request("forge.accounts.verify", forgeAccountId === undefined ? {} : { forgeAccountId })).accounts;

/** The receipt's rejection: its reason, message and data; throws unless the command was rejected. */
export const rejection = (receipt: CommandReceipt) => {
  if (receipt.status !== "rejected") throw new Error(`The command was accepted: ${JSON.stringify(receipt)}`);
  return { reason: receipt.reason, message: receipt.error.message, data: receipt.error.data };
};

/** The forge events a client reads on `environment.subscribe` after `afterSequence`, up to where it is synchronized. */
export const forgeEvents = async (client: WireClient, afterSequence: number): Promise<EventEnvelope[]> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence });
  const events: EventEnvelope[] = [];
  for (;;) {
    const frame = await client.next((f) => "subscription" in f && f.subscription === subscription && (f.type === "event" || f.type === "synchronized"));
    if (frame.type === "synchronized") return events.filter((event) => event.type.startsWith("forge."));
    events.push((frame as EventFrame).event);
  }
};

/**
 * Each of `values` as a run's provider says it back and a subscribed client
 * reads it (the fake's preset reply is `Done: <the prompt>`): `[redacted]`
 * for one the environment holds as a secret, itself for one it does not.
 */
export const saidBack = async (t: TestEnvironment, values: readonly string[]): Promise<string[]> => {
  const client = await t.client();
  const { id } = await create(client);
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: t.env.log.head() });
  await client.apply("runs.start", { commandId: randomUUID(), sessionId: id, text: values.join(" ") });
  const { event } = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "assistant.text");
  return String(event.payload["text"]).replace(/^Done: /, "").split(" ");
};

/** The form git's Basic header carries a token in for `username`. */
export const basicAuth = (username: string, token: string): string => Buffer.from(`${username}:${token}`).toString("base64");

/** git's host attribute for an origin: the host, and its port when it has one. */
export const gitHost = (origin: string): string => origin.replace(/^https?:\/\//, "");

/** What the credential route answered: its status and its JSON body, null for none. */
export interface RouteAnswer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Asks the credential route at `address` as the helper does (#314): the
 * secret as a bearer credential, git's attributes as the JSON body, and a
 * Host header naming the address unless `headers` gives another.
 */
export const askCredentialRoute = (address: Address, secret: string | null, body: unknown, headers: Record<string, string> = {}): Promise<RouteAnswer> =>
  new Promise((resolve, reject) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const sent = request(
      {
        host: address.host,
        port: address.port,
        method: "POST",
        path: GIT_CREDENTIAL_PATH,
        headers: {
          host: formatHostPort(address.host, address.port),
          "content-type": "application/json",
          "content-length": Buffer.byteLength(text),
          ...(secret !== null && { authorization: `Bearer ${secret}` }),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const answer = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode ?? 0, body: answer === "" ? null : (JSON.parse(answer) as unknown) });
        });
      },
    );
    sent.on("error", reject);
    sent.end(text);
  });
