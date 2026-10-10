import { forgeCopyCredential, normaliseRemote, type ForgeAccountRecord, type ForgeAddCredential, type MethodName, type ParamsOf } from "@agent-harness/contracts";
import { noShellMessage, type CapabilityAnswer } from "./capabilities.js";
import { copyOutcome, copyToEach, type CopyReport } from "./copies.js";
import { uuidv4, uuidv7 } from "./ids.js";
import { referenceCopies } from "./key-managers.js";
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
   * no forge's (`invalid_params`); fails, sending nothing, `gh-unavailable`
   * when `gh` gives no token for the host and `gh-failed` when reading it fails.
   */
  handOverGh(environmentId: string, params: HandOverParams): Promise<RequestAnswer<"forge.accounts.add">>;
  /**
   * Copies `account`, as `fromEnvironmentId` lists it, to each environment
   * named (ADR 0020's bulk copy; forge spec, "Copies and the state
   * import"): `forge.accounts.add` on each, all at once, with its origin,
   * aliases, kind, slug and primary flag and `copiedFrom` naming the source;
   * a key-manager reference with its locator, read through that
   * environment's own connection to the same key manager (#706,
   * `referenceCopies`), a stored token as `none` (no secret travels between
   * environments; the target's Forges check asks for one), the
   * environment's own `gh` as `gh`. Each is a new forge account there,
   * under an id of its own. Answers a report per environment: `copied` with
   * the forge account it added, or `refused` with the environment's error
   * (a `conflict`, the origin or slug held there) or the connection's
   * (`unreachable` at once, `scope` without `admin`, `unsupported`
   * without `forge`), or `credential_source_unavailable`, sending nothing,
   * for a reference where the environment holds no connection to its key
   * manager; one refused never stops the others.
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
export const ghHost = (origin: string): string => origin.replace(/^https?:\/\//, "");

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
      return failed("gh-failed", `The gh on this computer could not be read: ${error instanceof Error ? error.message : String(error)}`);
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
    const from = environmentName === null ? null : { environmentId: fromEnvironmentId, environmentName };
    const credential = forgeCopyCredential(account.credential);
    // A reference names a connection by an id each environment gives its own copy of the key manager (#706).
    const referenceOn = from !== null && credential.kind === "reference" ? await referenceCopies(host, from, credential.reference) : null;
    return copyToEach(from, toEnvironmentIds, async (environmentId, copiedFrom) => {
      let given: ForgeAddCredential = credential;
      if (referenceOn !== null) {
        const there = await referenceOn(environmentId);
        if (!there.ok) return { status: "refused", error: there.error };
        given = { kind: "reference", reference: there.reference };
      }
      const answer = await host.call(environmentId, "forge.accounts.add", {
        commandId: uuidv7(host.clock.now()),
        forgeAccountId: uuidv4(),
        url: account.origin,
        // GitLab is reserved for milestone 2 (ADR 0033): no environment adds one yet, and without a kind the add is refused.
        ...(account.kind !== "gitlab" && { kind: account.kind }),
        slug: account.slug,
        aliases: account.aliases.map((alias) => alias.origin),
        primary: account.primary,
        credential: given,
        copiedFrom,
      });
      return copyOutcome(answer, (result) => result.account);
    });
  },
});
