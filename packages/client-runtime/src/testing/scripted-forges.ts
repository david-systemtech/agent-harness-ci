import {
  FORGE_EVENT_PAYLOADS,
  ForgeAccountRecord,
  GITHUB_ORIGIN,
  UNKNOWN_FORGE_CAPABILITIES,
  deriveForgeSlug,
  forgeTokenPages,
  forgeVariableNames,
  invalidParams,
  normaliseRemote,
  type ForgeAddCredential,
  type ForgeCapabilities,
  type ForgeCredentialSource,
  type ForgeKind,
  type ForgeProblem,
} from "@agent-harness/contracts";
import { uuidv4 } from "../ids.js";
import type { FakeAnswer, FakeWire } from "./fake-wire.js";
import type { ManualClock } from "./in-memory-platform.js";

/**
 * The scripted environment's forge accounts (forge spec, "Wire methods",
 * "Credentials" and "Events"; ADR 0020, ADR 0032; #419): what
 * `forge.accounts.list` answers and the commands that change it, answered as
 * the environment's ForgeService answers them over one fake forge per
 * origin, and each change appended as its `forge.*` event on the
 * environment stream, so a client's request cache reads the list again and
 * its notices hear the problems. `forge.detect` answers the kind the script
 * gives an origin (github.com GitHub, any other Forgejo); a token the script
 * names is refused, any other answers as the script's login. The tokens the
 * environment keeps are the test's to read (`forgeToken`), never answered
 * on the wire. A test has the environment's own verification find a problem
 * (`verifyForge`).
 */

/** What `forge.detect` finds at an origin: a kind a forge account is added for, GitLab (refused), or no forge at all. */
export type ScriptedDetection = ForgeKind | "not_a_forge" | "unreachable";

export interface ScriptedForges {
  /** The forge accounts held from the start, each over a GitHub one on github.com with a pasted token, verified as the login, the first primary; the fields given replace its own. */
  readonly accounts?: readonly Partial<ForgeAccountRecord>[];
  /** What `forge.detect` finds, by origin: preset GitHub on github.com and Forgejo anywhere else. */
  readonly detect?: Readonly<Record<string, ScriptedDetection>>;
  /** The tokens the forge refuses: an add with one is `verification_failed`, nothing stored. */
  readonly rejects?: readonly string[];
  /** Who a credential answers as: preset `david`, user id 42. */
  readonly login?: string;
}

export interface ScriptedForgesHandle {
  /** The forge accounts as the environment holds them now. */
  forgeAccounts(): readonly ForgeAccountRecord[];
  /** The token the environment's vault keeps for a forge account; undefined for none. */
  forgeToken(forgeAccountId: string): string | undefined;
  /** The environment's own verification of the forge account runs now and finds `problem` (null for none), recording it as `forge.account.verified` when it changed. */
  verifyForge(forgeAccountId: string, problem: Pick<ForgeProblem, "kind" | "message"> | null): void;
  /** Holds every `forge.detect` unanswered until the function it returns is called, each then answered as asked. */
  holdDetects(): () => void;
}

export interface ForgesHost {
  readonly clock: ManualClock;
  readonly wire: FakeWire;
  readonly script: ScriptedForges | undefined;
  /** Says an event on the environment's own stream, as the environment appends it. */
  notice(type: string, payload: Record<string, unknown>): void;
  /** The stream's head now, which an accepted receipt names. */
  head(): number;
  /** Takes the next sequence, for a rejected receipt. */
  next(): number;
  /** A rejection the script names for `method`, if any. */
  refusal(method: string): FakeAnswer | undefined;
  /** The calling client session's id, which a hand-over from its `gh` records. */
  clientSession(): string | undefined;
}

/** The forge commands this module answers, which a script's receipts never answer in its place. */
export const FORGE_COMMANDS: readonly string[] = ["forge.accounts.add", "forge.accounts.remove", "forge.accounts.setPrimary"];

/** The label the scripted environment knows the calling client session by. */
const CLIENT_LABEL = "seth@desk";

/** The reads a verification probes, found verified. */
const readsVerified = (at: string): ForgeCapabilities => ({
  ...UNKNOWN_FORGE_CAPABILITIES,
  readRepository: { state: "verified", verifiedAt: at, status: null },
  readReleases: { state: "verified", verifiedAt: at, status: null },
});

/** A problem that keeps a forge account out of runs, so it injects no variable. */
const LEFT_OUT: ReadonlySet<ForgeProblem["kind"]> = new Set(["needs-credential", "identity-changed"]);

export const scriptedForges = (host: ForgesHost): ScriptedForgesHandle => {
  const { clock, wire } = host;
  const script = host.script ?? {};
  const now = () => clock.now().toISOString();
  const identity = { login: script.login ?? "david", userId: "42" };
  const vault = new Map<string, string>();

  /** The record with the variables it injects as it stands: none while it is left out of runs. */
  const withVariables = (record: Omit<ForgeAccountRecord, "variables"> & Partial<Pick<ForgeAccountRecord, "variables">>): ForgeAccountRecord => {
    const names = forgeVariableNames(record);
    const out = record.problem !== null && LEFT_OUT.has(record.problem.kind);
    return ForgeAccountRecord.parse({ ...record, variables: out ? { url: [], token: [], kind: [] } : { url: names.url, token: names.token, kind: names.kind } });
  };

  const accounts: ForgeAccountRecord[] = (script.accounts ?? []).map((fields, index) => {
    const id = fields.id ?? uuidv4();
    const origin = fields.origin ?? (index === 0 ? GITHUB_ORIGIN : `https://git-${index + 1}.example.test`);
    const record = withVariables({
      id,
      origin,
      aliases: [],
      kind: origin === GITHUB_ORIGIN ? "github" : "forgejo",
      slug: deriveForgeSlug(origin, []),
      identity,
      credential: { kind: "stored", provenance: "pasted", entry: `forge:${id}:${uuidv4()}` },
      capabilities: readsVerified(now()),
      primary: index === 0,
      problem: null,
      statusSince: now(),
      tokenInformation: null,
      createdAt: now(),
      copiedFrom: null,
      ...fields,
    });
    // The vault keeps a token for a stored credential only.
    if (record.credential.kind === "stored") vault.set(id, `stored-token-for-tests-${index + 1}`);
    return record;
  });

  const find = (id: unknown) => accounts.find((account) => account.id === String(id).toLowerCase());
  const put = (record: ForgeAccountRecord) => {
    accounts[accounts.findIndex((account) => account.id === record.id)] = withVariables(record);
  };
  const event = (type: keyof typeof FORGE_EVENT_PAYLOADS, payload: Record<string, unknown>) => host.notice(type, FORGE_EVENT_PAYLOADS[type].parse(payload) as Record<string, unknown>);
  const accepted = (result: Record<string, unknown>): FakeAnswer => ({ result: { receipt: { status: "accepted", sequence: host.head(), changed: true }, result } });
  const rejected = (code: string, message: string, data: Record<string, unknown>): FakeAnswer => ({
    result: { receipt: { status: "rejected", sequence: host.next(), changed: false, reason: code, error: { code, message, data } } },
  });
  const notFound = (id: unknown): FakeAnswer => rejected("not_found", `No forge account ${String(id)} is on this environment.`, { kind: "forge_account" });
  const noRemote = (url: unknown): FakeAnswer => ({ error: invalidParams([{ code: "custom", path: ["url"], message: `${String(url)} is not a forge's URL.` }], `${String(url)} is not a forge's URL.`) });
  const detected = (origin: string): ScriptedDetection => script.detect?.[origin] ?? (origin === GITHUB_ORIGIN ? "github" : "forgejo");
  /** A detection that adds no forge account, as `forge.detect` and an add without a kind refuse it; undefined for a kind that does. */
  const detectionRefusal = (origin: string, found: ScriptedDetection): { readonly code: string; readonly message: string; readonly data: Record<string, unknown> } | undefined => {
    if (found === "not_a_forge") return { code: "not_a_forge", message: `${origin} answered, but not as a forge the harness knows: name its kind to add it anyway.`, data: { origin } };
    if (found === "unreachable") return { code: "unreachable", message: `${origin} did not answer.`, data: { origin } };
    if (found === "gitlab") return { code: "kind_unsupported", message: `${origin} is GitLab, which the harness cannot add a forge account for yet.`, data: { origin, kind: "gitlab" } };
    return undefined;
  };

  wire.answer("forge.accounts.list", () => ({ result: { accounts: [...accounts] } }));

  // The detections a test holds (`holdDetects`), each answered at the release; undefined while none are held.
  let heldDetects: (() => void)[] | undefined;
  const detect = (params: Record<string, unknown>): FakeAnswer => {
    const remote = normaliseRemote(String(params["url"]));
    if (remote === null) return noRemote(params["url"]);
    const found = detected(remote.origin);
    const refused = detectionRefusal(remote.origin, found);
    if (refused !== undefined) return { error: refused };
    const kind = found as Exclude<ForgeKind, "gitlab">;
    return { result: { origin: remote.origin, kind, version: kind === "github" ? null : "11.0.1+gitea-1.22.0", tokenPages: forgeTokenPages(kind, remote.origin) } };
  };
  wire.answer("forge.detect", (params) => {
    const waiting = heldDetects;
    if (waiting === undefined) return detect(params);
    return new Promise<FakeAnswer>((resolve) => waiting.push(() => resolve(detect(params))));
  });

  /** The source a given credential is kept as, and the token the vault keeps for it. */
  const sourceOf = (id: string, credential: ForgeAddCredential): { readonly source: ForgeCredentialSource; readonly token?: string } => {
    switch (credential.kind) {
      case "stored": {
        const entry = `forge:${id}:${uuidv4()}`;
        const source: ForgeCredentialSource =
          credential.provenance === "client-gh"
            ? { kind: "stored", provenance: "client-gh", entry, handedOverBy: { clientSessionId: host.clientSession() ?? "client-for-tests", label: CLIENT_LABEL }, followsGhRotations: false }
            : { kind: "stored", provenance: "pasted", entry };
        return { source, token: credential.token };
      }
      case "gh":
        return { source: { kind: "gh", login: credential.login } };
      case "reference":
        return { source: { kind: "reference", reference: credential.reference } };
      case "none":
        return { source: { kind: "none" } };
    }
  };

  wire.answer("forge.accounts.add", (params) => {
    const refusal = host.refusal("forge.accounts.add");
    if (refusal) return refusal;
    const id = String(params["forgeAccountId"]);
    const remote = normaliseRemote(String(params["url"]));
    if (remote === null) return noRemote(params["url"]);
    const { origin } = remote;
    if (find(id) !== undefined) return rejected("conflict", `A forge account ${id} is on this environment already.`, { reason: "exists" });
    if (accounts.some((account) => account.origin === origin || account.aliases.some((alias) => alias.origin === origin))) {
      return rejected("conflict", `A forge account for ${origin} is on this environment already.`, { reason: "origin_held" });
    }
    const given = params["kind"] as ForgeKind | undefined;
    const found = given ?? detected(origin);
    const refused = given === undefined ? detectionRefusal(origin, found) : undefined;
    if (refused !== undefined) return rejected(refused.code, `${refused.message} Nothing was stored.`, refused.data);
    const kind = found as ForgeKind;
    const slugGiven = params["slug"] as string | undefined;
    if (slugGiven !== undefined && accounts.some((account) => account.slug === slugGiven)) {
      return rejected("conflict", `The slug ${slugGiven} is taken on this environment.`, { reason: "slug_taken" });
    }
    const credential = params["credential"] as ForgeAddCredential;
    if (credential.kind === "stored" && (script.rejects ?? []).includes(credential.token)) {
      return rejected("verification_failed", `${origin} refused the token (HTTP 401): nothing was stored.`, { origin, status: 401 });
    }
    const { source, token } = sourceOf(id, credential);
    const none = credential.kind === "none";
    const primary = accounts.length === 0 || params["primary"] === true;
    const cleared = primary ? (accounts.find((account) => account.primary) ?? null) : null;
    if (cleared !== null) put({ ...cleared, primary: false });
    const problem: ForgeProblem | null = none ? { kind: "needs-credential", since: now(), message: `No credential for ${origin} is on this environment: give it one in Set up, Forges.` } : null;
    const record = withVariables({
      id,
      origin,
      aliases: [],
      kind,
      slug: slugGiven ?? deriveForgeSlug(origin, accounts.map((account) => account.slug)),
      identity: none ? null : identity,
      credential: source,
      capabilities: none ? UNKNOWN_FORGE_CAPABILITIES : readsVerified(now()),
      primary,
      problem,
      statusSince: now(),
      tokenInformation: null,
      createdAt: now(),
      copiedFrom: (params["copiedFrom"] as ForgeAccountRecord["copiedFrom"] | undefined) ?? null,
    });
    accounts.push(record);
    if (token !== undefined) vault.set(id, token);
    event("forge.account.added", {
      forgeAccountId: id,
      origin,
      aliases: [],
      kind,
      slug: record.slug,
      identity: record.identity,
      credential: source,
      primary,
      clearedPrimary: cleared?.id ?? null,
      problem,
      copiedFrom: record.copiedFrom,
    });
    return accepted({ account: record });
  });

  wire.answer("forge.accounts.remove", (params) => {
    const refusal = host.refusal("forge.accounts.remove");
    if (refusal) return refusal;
    const record = find(params["forgeAccountId"]);
    if (record === undefined) return notFound(params["forgeAccountId"]);
    accounts.splice(accounts.indexOf(record), 1);
    vault.delete(record.id);
    event("forge.account.removed", { forgeAccountId: record.id });
    return accepted({ forgeAccountId: record.id });
  });

  wire.answer("forge.accounts.setPrimary", (params) => {
    const refusal = host.refusal("forge.accounts.setPrimary");
    if (refusal) return refusal;
    const record = find(params["forgeAccountId"]);
    if (record === undefined) return notFound(params["forgeAccountId"]);
    if (record.primary) return { result: { receipt: { status: "accepted", sequence: host.head(), changed: false }, result: { account: record } } };
    const cleared = accounts.find((account) => account.primary) ?? null;
    if (cleared !== null) put({ ...cleared, primary: false });
    put({ ...record, primary: true });
    event("forge.account.primary-set", { forgeAccountId: record.id, cleared: cleared?.id ?? null });
    return accepted({ account: find(record.id) });
  });

  /** Records what a verification found, as `forge.account.verified` when anything changed. */
  const verified = (record: ForgeAccountRecord, problem: ForgeProblem | null, capabilities: ForgeCapabilities) => {
    const same = JSON.stringify(record.problem) === JSON.stringify(problem) && JSON.stringify(record.capabilities) === JSON.stringify(capabilities);
    if (same) return;
    const statusSince = problem?.since ?? (record.problem === null ? record.statusSince : now());
    put({ ...record, problem, capabilities, statusSince });
    event("forge.account.verified", { forgeAccountId: record.id, identity: record.identity, capabilities, tokenInformation: record.tokenInformation, problem });
  };
  /** The problem a verification finds, as the environment keeps it: one of the kind there was keeps its since-time. */
  const problemFound = (record: ForgeAccountRecord, found: Pick<ForgeProblem, "kind" | "message"> | null): ForgeProblem | null =>
    found === null ? null : { ...found, since: record.problem?.kind === found.kind ? record.problem.since : now() };
  /** What the next verification of each forge account finds, by id; none scripted finds it working. */
  const pending = new Map<string, Pick<ForgeProblem, "kind" | "message"> | null>();

  wire.answer("forge.accounts.verify", (params) => {
    const id = params["forgeAccountId"];
    const chosen = id === undefined ? [...accounts] : [find(id)].filter((record) => record !== undefined);
    for (const record of chosen) {
      // A copy with no credential, and one whose identity changed, is not verified.
      if (record.problem !== null && LEFT_OUT.has(record.problem.kind)) continue;
      verified(record, problemFound(record, pending.get(record.id) ?? null), readsVerified(now()));
    }
    return { result: { accounts: [...accounts] } };
  });

  return {
    forgeAccounts: () => [...accounts],
    forgeToken: (forgeAccountId) => vault.get(forgeAccountId.toLowerCase()),
    verifyForge(forgeAccountId, problem) {
      const record = find(forgeAccountId);
      if (record === undefined) throw new Error(`No forge account ${forgeAccountId} is scripted.`);
      pending.set(record.id, problem);
      verified(record, problemFound(record, problem), record.capabilities);
    },
    holdDetects() {
      heldDetects ??= [];
      return () => {
        const waiting = heldDetects ?? [];
        heldDetects = undefined;
        for (const release of waiting) release();
      };
    },
  };
};
