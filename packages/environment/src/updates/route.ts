import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { UpdateAnswer, UpdateError, UpdateRequest, invalidParams, registry, type EnvironmentReadiness, type WireError } from "@agent-harness/contracts";
import type { ClientSessions, VerifiedClientSession } from "../auth/client-sessions.js";
import type { EventLog } from "../event-log/event-log.js";
import { BodyTooLargeError, readBody, sendJson, type RouteHandler } from "../serve/http.js";
import type { MethodTable } from "../serve/methods.js";
import { createDispatch, type Answer } from "../wire/dispatch.js";

/**
 * `POST /api/update` (launcher-update spec, "Across a protocol gap"; #353):
 * what `updates.apply` does with `when: idle`, over a stable HTTP route
 * outside the wire, so a newer client can ask an environment it no longer
 * shares a wire protocol with. The route never reads the protocol version
 * and answers as `UpdateAnswer` and `UpdateError` (contracts) say.
 *
 * The client session's token is the `Authorization: Bearer` header's, and
 * the session needs the scope `updates.apply` needs. The update itself is
 * `updates.apply` run through the method table as that client session, so its
 * scope, its refusals (an artefact path from a paired session among them) and
 * its receipts are the wire's; this route only puts them in HTTP's words.
 */

/** The most a request's body may be: a version and a path. */
export const MAX_UPDATE_BYTES = 16 * 1024;

/** The HTTP status of each refusal the route answers. */
const STATUS: { readonly [Code in UpdateError["code"]]: number } = {
  unauthorized: 401,
  forbidden: 403,
  invalid_params: 400,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  internal: 500,
};

export interface UpdateRouteOptions {
  readonly log: Pick<EventLog, "command" | "receipt">;
  /** Token verification. */
  readonly clientSessions: Pick<ClientSessions, "verify">;
  /** The method table `updates.apply` is served from. */
  readonly methods: MethodTable;
  readonly readiness: () => EnvironmentReadiness;
}

/** The refusal the route makes itself, with the status it goes out at. */
class Refused extends Error {
  constructor(
    readonly status: number,
    readonly error: UpdateError,
  ) {
    super(error.message);
  }
}

const refusal = (error: UpdateError, status: number = STATUS[error.code]): Refused => new Refused(status, error);

export const createUpdateRoute = (options: UpdateRouteOptions): RouteHandler => {
  const dispatch = createDispatch(options.methods, options.log);
  const { scope } = registry["updates.apply"];

  const authenticate = (request: IncomingMessage): VerifiedClientSession => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? "");
    if (match === null) {
      throw refusal({ code: "unauthorized", message: "Send the token of a client session as Authorization: Bearer <token>.", data: {} });
    }
    const verified = options.clientSessions.verify(match[1] as string);
    if (!verified.ok) throw refusal({ code: "unauthorized", message: verified.message, data: {} });
    if (!verified.clientSession.scopes.includes(scope)) {
      throw refusal({ code: "forbidden", message: `Updating the environment needs the ${scope} scope, which this client session does not hold.`, data: { scope } });
    }
    return verified.clientSession;
  };

  const readRequest = async (request: IncomingMessage): Promise<UpdateRequest> => {
    let text: string;
    try {
      text = await readBody(request, MAX_UPDATE_BYTES);
    } catch (error) {
      if (!(error instanceof BodyTooLargeError)) throw error;
      throw refusal(invalidParams([{ code: "too_big", path: [], message: error.message }], error.message), 413);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw refusal(invalidParams([{ code: "custom", path: [], message: "The body is not JSON." }], "The body is not JSON."));
    }
    const parsed = UpdateRequest.safeParse(json);
    if (!parsed.success) throw refusal(invalidParams(parsed.error.issues, "The body is not an update request."));
    return parsed.data;
  };

  /** `updates.apply` as the client session, with `when: idle`, answered once: the wire's error, the receipt's rejection, or the update taken. */
  const apply = (clientSession: VerifiedClientSession, { version, artefactPath }: UpdateRequest): Promise<Answer> =>
    new Promise((resolve) => {
      void dispatch(
        { type: "request", id: randomUUID(), method: "updates.apply", params: { commandId: randomUUID(), version, ...(artefactPath !== undefined && { artefactPath }), when: "idle" } },
        clientSession,
        resolve,
        () => resolve({ error: { code: "internal", message: "updates.apply is a stream.", data: {} } }),
      );
    });

  /** What `updates.apply` answered, as the update taken or the refusal it is. */
  const outcome = (answer: Answer): UpdateAnswer | Refused => {
    const receipt = "result" in answer ? (answer.result["receipt"] as { status?: string; error?: WireError } | undefined) : undefined;
    const error = "error" in answer ? answer.error : receipt?.status === "rejected" ? receipt.error : undefined;
    if (error !== undefined) {
      const refused = UpdateError.safeParse(error);
      if (refused.success) return refusal(refused.data);
      console.error("updates.apply refused with an error the update route does not name:", error);
      return refusal({ code: "internal", message: "The environment failed.", data: {} });
    }
    const taken = UpdateAnswer.safeParse("result" in answer ? answer.result["result"] : undefined);
    if (taken.success) return taken.data;
    console.error("updates.apply answered outside the update route's answer:", answer);
    return refusal({ code: "internal", message: "The environment failed.", data: {} });
  };

  const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void =>
    sendJson(response, status, body, { "cache-control": "no-store", ...headers });

  return async (request, response) => {
    try {
      const clientSession = authenticate(request);
      const readiness = options.readiness();
      if (readiness !== "ready") {
        throw refusal({ code: "unavailable", message: `The environment is ${readiness}; try again once it is ready.`, data: { readiness } });
      }
      const asked = await readRequest(request);
      const answered = outcome(await apply(clientSession, asked));
      if (answered instanceof Refused) throw answered;
      send(response, 200, answered);
    } catch (error) {
      if (error instanceof Refused) {
        return send(response, error.status, error.error, error.status === 401 ? { "www-authenticate": "Bearer" } : {});
      }
      console.error("The update route failed:", error);
      if (response.headersSent) return void response.destroy();
      send(response, 500, { code: "internal", message: "The environment failed.", data: {} } satisfies UpdateError);
    }
  };
};
