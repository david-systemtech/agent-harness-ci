import { forgeCopyCredential, normaliseRemote, type ForgeAccountRecord, type MethodName, type ParamsOf } from "@agent-harness/contracts";
import { noShellMessage, type CapabilityAnswer } from "./capabilities.js";
import { copyToEach, type CopyOutcome, type CopyReport } from "./copies.js";
import { uuidv4, uuidv7 } from "./ids.js";
import type { Clock } from "./platform.js";
import type { RequestAnswer, Requests } from "./requests.js";
import type { Shell } from "./shell.js";

/**
 * Forges in the client runtime (forge spec, "Modules", "Credentials" and
 * "Copies and the state import"; ADR 0020, ADR 0032; #320): what a client
 * does with forge accounts beyond reading `forge.accounts.list` through the
 * request cache. Every call here is a direct request (`admin`), never the
 * outbox's, so a token crosses the wire once and nothing holding one is
 * parked on the client: while the environment cannot take the call it
 * fails at once.
 */

/** What a hand-over adds: `forge.accounts.add`'s params but the ids, which the runtime mints, the credential, which is gh's token, and a copy's source. */
export type HandOverParams = Omit<ParamsOf<"forge.accounts.add">, "commandId" | "forgeAccountId" | "credential" | "copiedFrom">;

export interface Forges {
  /**
   * Hands this computer's `gh` token over to the environment once (ADR
   * 0032): reads it from the shell's `gh` for the host the URL names and
   * calls `forge.accounts.add` once with it as a `stored` credential of
   * provenance `client-gh`, which the environment records with this
   * client session; the token is kept nowhere on the client. Fails at
   * once, reading nothing, while the environment cannot take the add
   * (`unreachable`, `unsupported`, `scope`), without a shell `gh`
   * (`no-shell`, the terminal UI and a browser tab) and for a URL that is
   * no forge's (`invalid_params`); fails `gh-unavailable`, sending nothing,
   * when `gh` gives no token for the host.
   */
  handOverGh(environmentId: string, params: HandOverParams): Promise<RequestAnswer<"forge.accounts.add">>;
  /**
   * Copies `account`, as `fromEnvironmentId` lists it, to each environment
   * named (ADR 0020's bulk copy; forge spec, "Copies and the state
   * import"): `forge.accounts.add` on each, all at once, with its origin,
   * aliases, kind, slug and primary flag and `copiedFrom` naming the source;
   * a key-manager reference as it is, a stored token as `none` (no secret
   * travels between environments; the target's Forges check asks for one),
   * the environment's own `gh` as `gh`. Each is a new forge account there,
   * under an id of its own. Answers a report per environment: `copied` with
   * the forge account it added, or `refused` with the environment's error
   * (a `conflict`, the origin or slug held there) or the connection's
   * (`unreachable` at once, `scope` without `admin`, `unsupported`
   * without `forge`); one refused never stops the others.
   */
  copy(fromEnvironmentId: string, account: ForgeAccountRecord, toEnvironmentIds: readonly string[]): Promise<readonly CopyReport<ForgeAccountRecord | null>[]>;
}

export interface ForgesHost {
  readonly clock: Clock;
  readonly shell: Shell | undefined;
  capability(environmentId: string, method: MethodName): CapabilityAnswer;
  readonly call: Requests["call"];
  /** The environment's name as its record has it; null for one this client has no connection to. */
  name(environmentId: string): string | null;
}

const failed = (code: string, message: string) => ({ ok: false, error: { code, message } }) as const;

/** The host `gh` names a forge by: an origin's host, with its port when it has one. */
const ghHost = (origin: string): string => origin.replace(/^https?:\/\//, "");

/** What an add answered, as a copy reports it: the forge account it added (null for an answer from its stored receipt), or why it was refused. */
const copyOutcome = (answer: RequestAnswer<"forge.accounts.add">): CopyOutcome<ForgeAccountRecord | null> => {
  if (!answer.ok) return { status: "refused", error: answer.error };
  const { receipt, result } = answer.result;
  if (receipt.status === "rejected") return { status: "refused", error: { code: receipt.reason, message: receipt.error.message, data: receipt.error.data } };
  return { status: "copied", result: result?.account ?? null };
};

export const createForges = (host: ForgesHost): Forges => ({
  async handOverGh(environmentId, params) {
    const add = host.capability(environmentId, "forge.accounts.add");
    // As `requests.call` answers it: a connection on its way to ready holds nothing for later.
    if (add.status === "absent") return failed(add.reason === "not-ready" ? "unreachable" : add.reason, add.message);
    const gh = host.shell?.gh;
    if (gh === undefined) return failed("no-shell", noShellMessage("shell.gh"));
    const remote = normaliseRemote(params.url);
    if (remote === null) return failed("invalid_params", `${params.url} is not a forge's URL.`);
    const forgeHost = ghHost(remote.origin);
    let token: string | undefined;
    try {
      token = await gh.token(forgeHost);
    } catch (error) {
      return failed("gh-unavailable", `The gh on this computer could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (token === undefined) return failed("gh-unavailable", `The gh on this computer is not signed in to ${forgeHost}: run gh auth login --hostname ${forgeHost} here, or paste a token.`);
    return host.call(environmentId, "forge.accounts.add", {
      ...params,
      commandId: uuidv7(host.clock.now()),
      forgeAccountId: uuidv4(),
      credential: { kind: "stored", provenance: "client-gh", token },
    });
  },
  async copy(fromEnvironmentId, account, toEnvironmentIds) {
    const environmentName = host.name(fromEnvironmentId);
    return copyToEach(toEnvironmentIds, async (environmentId) => {
      if (environmentName === null) return { status: "refused", error: { code: "unreachable", message: "This client has no connection to the environment the copy is from." } };
      const answer = await host.call(environmentId, "forge.accounts.add", {
        commandId: uuidv7(host.clock.now()),
        forgeAccountId: uuidv4(),
        url: account.origin,
        // GitLab is reserved for milestone 2 (ADR 0033): no environment adds one yet, and without a kind the add is refused.
        ...(account.kind !== "gitlab" && { kind: account.kind }),
        slug: account.slug,
        aliases: account.aliases.map((alias) => alias.origin),
        primary: account.primary,
        credential: forgeCopyCredential(account.credential),
        copiedFrom: { environmentId: fromEnvironmentId, environmentName },
      });
      return copyOutcome(answer);
    });
  },
});
