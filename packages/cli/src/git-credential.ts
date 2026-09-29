import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  ENVIRONMENT_ADDRESS_VARIABLE,
  GIT_CREDENTIAL_PATH,
  GIT_CREDENTIAL_TIMEOUT_MS,
  GitCredentialAnswer,
  GitCredentialError,
  PRODUCT_NAME,
  RUN_SECRET_VARIABLE,
  type GitCredentialAction,
  type GitCredentialRequest,
} from "@agent-harness/contracts";

/**
 * `agent-harness git-credential <slug> <verb>`, git's credential helper
 * (forge spec, "The helper and the credential route"; ADR 0020). git runs it
 * with its verb and writes the credential's attributes to its standard
 * input. On `get` it posts git's protocol and host, with its slug, to the
 * environment's credential route, proving itself with the run-scoped secret
 * in its environment, and prints the username and password. When it cannot
 * answer (no secret, the environment unreachable, the credential
 * unavailable, an origin outside the secret's set, fifteen seconds passed)
 * it prints `quit=1`, so git neither asks another helper nor prompts, and
 * one line on standard error naming the origin and the fix. On `erase` it
 * reports git's refusal, never sending the password, and forgets nothing;
 * `store` and any other verb are ignored.
 *
 * It sends its call through the proxy the standard variables name
 * (`http_proxy`, else `HTTP_PROXY`, else `all_proxy` or `ALL_PROXY` when it
 * is an http one), unless `no_proxy` or `NO_PROXY` names the environment's
 * host, so under containment it passes the proxy as any host does. It loads
 * Node's built-ins and the contracts alone: git waits on it.
 *
 * Where the environment cannot be reached at all (the connection fails, as
 * it does from inside a Linux sandbox, whose own network namespace has
 * nothing on the environment's loopback port and whose `no_proxy` names
 * loopback; #315), a `get` is answered from the slug's `FORGE_<SLUG>_TOKEN`
 * when the process has one, as the run's process environment gave it at
 * spawn: a rotation since is not seen there. The username is
 * `x-access-token` for every kind, since the helper holds no login, and
 * Forgejo and Gitea read a token given as the password whatever the
 * username (Forgejo 16.0.3, 2026-09-29). An environment that answers, even
 * to refuse, or does not answer in time, is never passed over.
 */

/** What the verb needs of the process: git's attributes, its output streams and its environment. */
export interface GitCredentialContext {
  readonly stdin: () => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** How long git may wait on the environment; preset `GIT_CREDENTIAL_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

export const GIT_CREDENTIAL_USAGE = `${PRODUCT_NAME} git-credential <slug> get|store|erase`;

/** git's attributes as it writes them: `key=value` lines up to an empty line. */
const attributesOf = (text: string): Map<string, string> => {
  const attributes = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") break;
    const equals = line.indexOf("=");
    if (equals > 0) attributes.set(line.slice(0, equals), line.slice(equals + 1));
  }
  return attributes;
};

/** Why git gets no credential, for the one line a person reads. */
class NoCredential extends Error {}

/** The environment could not be reached at all: the connection failed before any answer. */
class Unreachable extends NoCredential {}

/** The username the helper names with a token it answers from the process's own variables: GitHub's for a token, which Forgejo and Gitea take too. */
const FALLBACK_USERNAME = "x-access-token";

/** The variable the run's process environment gives the slug's token in (`FORGE_<SLUG>_TOKEN`). */
const tokenVariable = (slug: string): string => `FORGE_${slug.toUpperCase()}_TOKEN`;

/** The variable `names` hold first, lower case before upper, as curl reads them; undefined when none is set. */
const firstSet = (env: GitCredentialContext["env"], ...names: string[]): string | undefined => names.map((name) => env[name]).find((value) => value !== undefined && value.trim() !== "");

/** Whether `host` (lower case, no port, no brackets) is one the `no_proxy` list names: `*`, the host itself, or a domain it is in. */
const exempt = (host: string, list: string | undefined): boolean =>
  (list ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/^\*?\./, "").replace(/^\[(.*)\]$/, "$1"))
    .some((entry) => entry === "*" || (entry !== "" && (host === entry || host.endsWith(`.${entry}`))));

/** The proxy the standard variables name for an http call to `target`, or null to call it directly. */
const proxyFor = (target: URL, env: GitCredentialContext["env"]): URL | null => {
  if (exempt(target.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase(), firstSet(env, "no_proxy", "NO_PROXY"))) return null;
  const named = firstSet(env, "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY");
  if (named === undefined) return null;
  let proxy: URL;
  try {
    proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(named) ? named : `http://${named}`);
  } catch {
    return null;
  }
  // A SOCKS proxy (`all_proxy=socks5://...`) is not one an HTTP request goes through.
  return proxy.protocol === "http:" || proxy.protocol === "https:" ? proxy : null;
};

/** Posts `body` to the credential route at `target`, directly or through `proxy`, within `signal`. */
const post = (target: URL, proxy: URL | null, secret: string, body: GitCredentialRequest, signal: AbortSignal): Promise<{ readonly status: number; readonly text: string }> =>
  new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const headers: Record<string, string | number> = {
      host: target.host,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      authorization: `Bearer ${secret}`,
    };
    if (proxy !== null && proxy.username !== "") {
      headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    }
    const via = proxy ?? target;
    const send = via.protocol === "https:" ? httpsRequest : httpRequest;
    const sent = send(
      {
        host: via.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: via.port === "" ? (via.protocol === "https:" ? 443 : 80) : Number(via.port),
        method: "POST",
        // Through a proxy, the request names the whole URL, as any HTTP client's call through one does.
        path: proxy === null ? target.pathname : target.href,
        headers,
        signal,
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      },
    );
    sent.on("error", reject);
    sent.end(text);
  });

/** `text` read as JSON; undefined for text that is not. */
const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** What the route said, as a reason for the person reading git's output. */
const refusalOf = (status: number, text: string): string => {
  const refusal = GitCredentialError.safeParse(jsonOf(text));
  return refusal.success ? refusal.data.message : `the environment answered HTTP ${status}`;
};

/** Asks the route about `action` for git's `protocol` and `host`; answers what it said, or throws `NoCredential` with why not. */
const ask = async (action: GitCredentialAction, slug: string, attributes: Map<string, string>, context: GitCredentialContext, signal: AbortSignal) => {
  const secret = context.env[RUN_SECRET_VARIABLE];
  const address = context.env[ENVIRONMENT_ADDRESS_VARIABLE];
  if (secret === undefined || secret === "" || address === undefined || address === "") {
    throw new NoCredential(`this process has no run-scoped secret from ${PRODUCT_NAME} (${RUN_SECRET_VARIABLE} and ${ENVIRONMENT_ADDRESS_VARIABLE} are not both set), so it cannot ask the environment`);
  }
  const protocol = attributes.get("protocol");
  const host = attributes.get("host");
  if ((protocol !== "https" && protocol !== "http") || host === undefined || host === "") {
    throw new NoCredential(`the helper serves git's http and https transport alone, not ${protocol ?? "a request with no protocol"}`);
  }
  let target: URL;
  try {
    target = new URL(`http://${address}${GIT_CREDENTIAL_PATH}`);
  } catch {
    throw new NoCredential(`${ENVIRONMENT_ADDRESS_VARIABLE} holds ${address}, which is no address`);
  }
  try {
    return await post(target, proxyFor(target, context.env), secret, { action, slug, protocol, host }, signal);
  } catch (error) {
    if (signal.aborted) throw new NoCredential(`the environment at ${address} did not answer within ${Math.round((context.timeoutMs ?? GIT_CREDENTIAL_TIMEOUT_MS) / 1000)} seconds`);
    throw new Unreachable(`the environment at ${address} did not answer (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
  }
};

/** The one line a person reads: what did not happen (`git gets no credential for <origin>`), why, and where to fix it. */
const line = (what: string, reason: string): string => {
  const said = reason.replace(/\s+/g, " ").replace(/\.$/, "");
  const fix = said.includes("Set up, Forges") ? "" : ". Fix it in Set up, Forges";
  return `${PRODUCT_NAME}: ${what}: ${said}${fix}.\n`;
};

/** Runs the helper on `args` (`<slug> <verb>`); resolves to its exit code, 0 whenever it spoke git's protocol. */
export const gitCredential = async (args: readonly string[], context: GitCredentialContext): Promise<number> => {
  const [slug, verb] = args;
  if (args.length !== 2 || slug === undefined || verb === undefined) {
    context.stderr(`usage: ${GIT_CREDENTIAL_USAGE}\n`);
    return 2;
  }
  if (verb !== "get" && verb !== "erase") {
    // git sends store's attributes all the same; they are read and left.
    await context.stdin().catch(() => "");
    return 0;
  }
  const signal = AbortSignal.timeout(context.timeoutMs ?? GIT_CREDENTIAL_TIMEOUT_MS);
  let attributes = new Map<string, string>();
  /** Tells git to stop at this helper (on `get`), and a person why. */
  const refuse = (reason: string): number => {
    const origin = `${attributes.get("protocol") ?? "?"}://${attributes.get("host") ?? "?"}`;
    if (verb === "get") context.stdout("quit=1\n");
    context.stderr(line(verb === "get" ? `git gets no credential for ${origin}` : `could not report git's refusal for ${origin}`, reason));
    return 0;
  };
  try {
    const late = new Promise<never>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new NoCredential("git's attributes did not arrive in time")), { once: true }),
    );
    // Once the attributes have come, the deadline's rejection is heard by no one.
    late.catch(() => undefined);
    attributes = attributesOf(await Promise.race([context.stdin(), late]));
    const answer = await ask(verb, slug, attributes, context, signal);
    if (verb === "erase") return answer.status === 204 ? 0 : refuse(refusalOf(answer.status, answer.text));
    const credential = GitCredentialAnswer.safeParse(answer.status === 200 ? jsonOf(answer.text) : undefined);
    if (!credential.success) return refuse(refusalOf(answer.status, answer.text));
    context.stdout(`username=${credential.data.username}\npassword=${credential.data.password}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof NoCredential)) throw error;
    const token = context.env[tokenVariable(slug)];
    if (error instanceof Unreachable && verb === "get" && token !== undefined && token !== "") {
      context.stdout(`username=${FALLBACK_USERNAME}\npassword=${token}\n`);
      return 0;
    }
    return refuse(error.message);
  }
};

/** Reads the process's standard input to its end: git closes it once the attributes are written. */
export const readStandardInput = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
