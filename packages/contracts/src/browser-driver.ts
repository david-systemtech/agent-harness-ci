import { z } from "zod";
import { OneTimeAllowance } from "./browser-policy.js";
import { DenylistMatch } from "./denylist.js";
import { Timestamp } from "./primitives.js";

/**
 * The page-driver contract (browser spec, "One page driver for three
 * browsers" and "The tools"; ADR 0014): what a browser can be asked to do,
 * whichever browser it is. The tools are written once against it, the CDP
 * driver of the `browser` package implements it for a Chrome (through the
 * extension), the headless browser and the browser dock, and the bridge and
 * the browser relay carry its calls and answers.
 *
 * A driver acts on one session's page, named by a page key the environment
 * derives from the run environment's id and the session id and the browser
 * reads as opaque; no verb takes a tab id, so a run cannot reach another
 * session's page. Every verb resolves to its value or to a refusal: a
 * sentence the model can read and act on (a ref from an older snapshot, a
 * denylisted address, a closed Chrome), never an exception, because a thrown
 * error reaches the model as a stack trace that tells it nothing it can use.
 *
 * Its types are plain data: the contracts package stays free of DOM and Node
 * types, so the extension, the `browser` package and the environment all
 * build against it.
 */

// The kinds ------------------------------------------------------------------

/** The browsers a driver drives: a paired Chrome through the extension, the run environment's headless browser, and the desktop window's browser dock. */
export const PAGE_DRIVER_KINDS = ["chrome", "headless", "dock"] as const;
export const PageDriverKind = z.enum(PAGE_DRIVER_KINDS).meta({
  description:
    "Which browser a page driver drives: chrome (a paired Chrome, signed in to the person's sites), headless (the run environment's headless browser, signed in to nothing) or dock (the desktop window's browser dock).",
});
export type PageDriverKind = z.infer<typeof PageDriverKind>;

/** Every verb, in the spec's order. */
export const PAGE_VERBS = [
  "open",
  "navigate",
  "snapshot",
  "click",
  "clickAt",
  "type",
  "read",
  "screenshot",
  "scroll",
  "waitFor",
  "console",
  "network",
  "cookies",
  "storage",
  "evaluate",
  "close",
] as const;
export type PageVerb = (typeof PAGE_VERBS)[number];

/** The deep verbs: what a developer opens the browser's developer tools for, offered only where a kind has them. */
export const DEEP_PAGE_VERBS = ["console", "network", "cookies", "storage", "evaluate"] as const satisfies readonly PageVerb[];

/** What a kind of driver can do: its verbs, and whether cookie values, storage and evaluate answer only where the page policy allows. */
export interface PageDriverAbilities {
  readonly verbs: readonly PageVerb[];
  /** Cookie values, storage and evaluate answer only where the page policy allows (a dev site, or an everywhere switch): a browser signed in to the person's sites. */
  readonly deepReadsByPolicy: boolean;
}

const SHALLOW_VERBS = PAGE_VERBS.filter((verb) => !(DEEP_PAGE_VERBS as readonly PageVerb[]).includes(verb));

/**
 * Each kind's abilities (ADR 0014): a Chrome has every verb, cookie values,
 * storage and evaluate only where the page policy allows; the headless
 * browser has every verb on every site, being signed in to nothing; the
 * dock reads and acts, with none of the deep verbs.
 */
export const PAGE_DRIVER_ABILITIES: { readonly [K in PageDriverKind]: PageDriverAbilities } = {
  chrome: { verbs: PAGE_VERBS, deepReadsByPolicy: true },
  headless: { verbs: PAGE_VERBS, deepReadsByPolicy: false },
  dock: { verbs: SHALLOW_VERBS, deepReadsByPolicy: false },
};

// The page key ---------------------------------------------------------------

/** A session's page, named for a browser that reads the name as opaque. */
export const PageKey = z.string().min(1).max(256).meta({
  description: "A session's page: the run environment's id and the session id, which the browser reads as an opaque name; one tab or browser context per key.",
});
export type PageKey = z.infer<typeof PageKey>;

/** The page key of a session on the environment running it. */
export const pageKeyOf = (runEnvironmentId: string, sessionId: string): PageKey => `${runEnvironmentId}/${sessionId}`;

// Arguments ------------------------------------------------------------------

/** The longest address a verb takes: the denylist's matcher reads this much of one. */
const MAX_ADDRESS = 8_192;
/** The longest CSS selector, and the longest text a wait waits for. */
const MAX_SELECTOR = 4_096;
/** The longest ref. */
const MAX_REF = 128;
/** The longest text `type` types, and the longest expression `evaluate` runs. */
const MAX_TEXT = 65_536;

const Address = z.string().min(1).max(MAX_ADDRESS).meta({ description: "An address to open: an http or https URL, or a bare host with an optional port and path." });
const Ref = z.string().min(1).max(MAX_REF).meta({ description: "A ref a snapshot gave an element (e12, prefixed for a child frame's elements)." });

/** How long a snapshot may be, in characters: preset 30,000, at most 200,000, cut at a line boundary, or mid-line when no line ends within them. */
export const SNAPSHOT_MAX_CHARS = { preset: 30_000, max: 200_000 } as const;

/** What a snapshot reads: `interactive` elements (preset) or `all`, how deep, from which ref, and how long. */
const SnapshotArgs = z
  .object({
    filter: z.enum(["interactive", "all"]).optional().meta({ description: "interactive (preset): the elements that can be acted on and their context; all: every element." }),
    depth: z.int().min(1).optional().meta({ description: "How many levels of the tree to read." }),
    ref: Ref.optional().meta({ description: "Read only the subtree of the element with this ref." }),
    maxChars: z
      .int()
      .min(1)
      .max(SNAPSHOT_MAX_CHARS.max)
      .optional()
      .meta({ description: `The most characters to answer, cut at the last line boundary within them, or mid-line when no line ends within them; preset ${SNAPSHOT_MAX_CHARS.preset}, at most ${SNAPSHOT_MAX_CHARS.max}.` }),
  })
  .meta({ description: "What a snapshot reads: its filter, depth, focus and length." });

/** An action's snapshot of the page it left, when the call asks for one. */
const AfterAction = SnapshotArgs.optional().meta({ description: "Answer with a snapshot of the page after the action, read as these arguments say; none when absent." });

/** The element an action acts on: by the ref a snapshot gave it, or by a CSS selector, the second way. */
const ElementTarget = z
  .union([
    z.strictObject({ ref: Ref }).meta({ description: "The element with this ref, from the latest snapshot." }),
    z.strictObject({ selector: z.string().min(1).max(MAX_SELECTOR) }).meta({ description: "The first element this CSS selector matches." }),
  ])
  .meta({ description: "An element: by ref, or by CSS selector." });

/** Where a scroll goes: a direction and an amount in viewports (preset one), or to an element. */
const ScrollTarget = z
  .union([
    z
      .strictObject({
        direction: z.enum(["up", "down", "left", "right"]).meta({ description: "Which way to scroll." }),
        amount: z.number().positive().max(100).optional().meta({ description: "How far, in viewports; preset 1." }),
      })
      .meta({ description: "A direction and an amount." }),
    z.strictObject({ ref: Ref }).meta({ description: "Scroll the element with this ref into view." }),
  ])
  .meta({ description: "Where to scroll: a direction and an amount in viewports, or to an element." });

/** How long a wait may be, in milliseconds: preset 10 seconds, at most 30; a longer ask is clamped, and the answer says so. */
export const WAIT_FOR_MS = { preset: 10_000, max: 30_000 } as const;

const WaitTimeout = z.int().min(1).optional().meta({ description: `How long to wait, in milliseconds; preset ${WAIT_FOR_MS.preset}, clamped to ${WAIT_FOR_MS.max}.` });

/** What a wait waits for: text to appear, a ref to exist, or a number of milliseconds. */
const WaitCondition = z
  .union([
    z.strictObject({ text: z.string().min(1).max(MAX_SELECTOR), timeoutMs: WaitTimeout }).meta({ description: "Until this text appears on the page." }),
    z.strictObject({ ref: Ref, timeoutMs: WaitTimeout }).meta({ description: "Until an element with this ref exists." }),
    z.strictObject({ ms: z.int().min(0).meta({ description: `Milliseconds, clamped to ${WAIT_FOR_MS.max}.` }) }).meta({ description: "For this long." }),
  ])
  .meta({ description: "What to wait for: text, a ref, or a number of milliseconds." });
export type WaitCondition = z.infer<typeof WaitCondition>;

/** The longest a wait runs, clamped at 30 seconds: what the relay adds its margin to. */
export const waitBoundMs = (until: WaitCondition): number => Math.min("ms" in until ? until.ms : (until.timeoutMs ?? WAIT_FOR_MS.preset), WAIT_FOR_MS.max);

// Values ---------------------------------------------------------------------

/** What a challenge on a page is: a captcha frame, a bot-check vendor's markers, or a JavaScript challenge. */
export const CHALLENGE_KINDS = ["recaptcha", "hcaptcha", "turnstile", "datadome", "perimeterx", "cloudflare", "javascript"] as const;
const ChallengeKind = z.enum(CHALLENGE_KINDS).meta({
  description:
    "A challenge the page shows: a reCAPTCHA, hCaptcha or Turnstile frame, DataDome's, PerimeterX's or Cloudflare's bot check, or a JavaScript challenge. Never solved or retried: the person completes it.",
});
export type ChallengeKind = z.infer<typeof ChallengeKind>;

const Challenge = ChallengeKind.optional().meta({ description: "The challenge the page shows, when it shows one." });

const pageLocationShape = {
  url: z.string().meta({ description: "The address the page has now." }),
  title: z.string().meta({ description: "The page's title." }),
};

/** Where a page is. */
const PageLocation = z.object(pageLocationShape).meta({ description: "Where the page is: its address and title." });
export type PageLocation = z.infer<typeof PageLocation>;

const snapshotTextShape = {
  text: z.string().meta({ description: "The accessibility tree, one element per line with its role, name, state and value, and a ref on each element that can be acted on." }),
  totalChars: z.int().min(0).meta({ description: "How long the whole snapshot is, in characters." }),
  truncated: z.boolean().meta({ description: "Whether the text was cut at maxChars: at the last line boundary within them, or mid-line when no line ends within them." }),
  midLine: z
    .literal(true)
    .optional()
    .meta({ description: "Present when the text was cut mid-line, as no line ends within maxChars: at maxChars, or short of a character written as two code units or a ref the cut would split." }),
};

/** A snapshot's text, as an action answers it. */
const SnapshotText = z.object(snapshotTextShape).meta({ description: "A snapshot's text, its full length, and whether and how it was cut." });

/** Where an action left the page: its address and title, its snapshot when the call asked for one, and a challenge it shows. */
const PageArrival = z
  .object({ ...pageLocationShape, snapshot: SnapshotText.optional().meta({ description: "The snapshot the call asked for." }), challenge: Challenge })
  .meta({ description: "Where the verb left the page: its address and title, the snapshot the call asked for, and a challenge the page shows." });
export type PageArrival = z.infer<typeof PageArrival>;

/** The page as an accessibility tree. */
const PageSnapshot = z
  .object({ ...pageLocationShape, ...snapshotTextShape, challenge: Challenge })
  .meta({ description: "The page as an accessibility tree: frames stitched and open shadow roots included, field values the serialiser never reads left out." });
export type PageSnapshot = z.infer<typeof PageSnapshot>;

/** A page of the page's text as Markdown. */
const PageReading = z
  .object({
    ...pageLocationShape,
    source: z.enum(["article", "snapshot"]).meta({ description: "article: the reader's article, as Markdown; snapshot: the snapshot's text in all mode, where the page is not an article." }),
    text: z.string().meta({ description: "This page of the text." }),
    offset: z.int().min(0).meta({ description: "Where this page starts, in characters." }),
    totalChars: z.int().min(0).meta({ description: "How long the whole text is, in characters." }),
    nextOffset: z.int().min(0).nullable().meta({ description: "Where the next page starts; null on the last." }),
    challenge: Challenge,
  })
  .meta({ description: "A page of the page's readable text: the article as Markdown, or the snapshot's text; paged by offset." });
export type PageReading = z.infer<typeof PageReading>;

/** What a page looks like, base64 because every transport is JSON. */
const PageImage = z
  .object({
    mimeType: z.enum(["image/jpeg", "image/png"]).meta({ description: "The image's type: image/jpeg for a driver's screenshot of the viewport, or image/png." }),
    data: z
      .string()
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .meta({ description: "The image, base64." }),
  })
  .meta({ description: "A screenshot of the viewport." });
export type PageImage = z.infer<typeof PageImage>;

/** One line of the console, or an error nobody caught. */
const ConsoleEntry = z
  .object({
    level: z.enum(["log", "info", "warn", "error", "debug", "exception"]).meta({ description: "The console method, or exception for an uncaught error." }),
    text: z.string(),
    source: z.string().optional().meta({ description: "The script and line, when the browser knows them." }),
    at: Timestamp,
  })
  .meta({ description: "A console line or an uncaught error." });
export type ConsoleEntry = z.infer<typeof ConsoleEntry>;

/** One request the page made. */
const NetworkEntry = z
  .object({
    method: z.string(),
    url: z.string(),
    status: z.int().optional().meta({ description: "The response's status; absent for a request that got no answer." }),
    resourceType: z.string().optional().meta({ description: "document, xhr, fetch, script and so on, as the browser names it." }),
    durationMs: z.number().min(0).optional(),
    failure: z.string().optional().meta({ description: "Why the request failed outright: DNS, CORS, blocked, aborted." }),
    at: Timestamp,
  })
  .meta({ description: "A request the page made." });
export type NetworkEntry = z.infer<typeof NetworkEntry>;

/** A cookie as a developer sees it; its value only where the page policy lets values be read. */
const CookieEntry = z
  .object({
    name: z.string(),
    value: z.string().optional().meta({ description: "The value, only where deep reads are allowed; elsewhere a cookie is its name and attributes." }),
    domain: z.string(),
    path: z.string(),
    expires: Timestamp.optional().meta({ description: "When it expires; absent for a session cookie." }),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional().meta({ description: "When the browser sends it on a request from another site: Strict, Lax or None." }),
  })
  .meta({ description: "A cookie the page would send." });
export type CookieEntry = z.infer<typeof CookieEntry>;

/** The page origin's local and session storage. */
const StorageSnapshot = z
  .object({
    origin: z.string(),
    local: z.record(z.string(), z.string()).meta({ description: "localStorage, by key." }),
    session: z.record(z.string(), z.string()).meta({ description: "sessionStorage, by key." }),
  })
  .meta({ description: "The page origin's local and session storage." });
export type StorageSnapshot = z.infer<typeof StorageSnapshot>;

const EvaluateResult = z.object({ result: z.json().meta({ description: "The expression's value, as JSON." }) }).meta({ description: "What an expression evaluated to." });

const noArgs = z.object({}).meta({ description: "No arguments." });

/**
 * Each verb's arguments and value, in the spec's order: `open` and
 * `navigate` (an address), `snapshot`, `click` and `type` (by ref or
 * selector), `clickAt` (screenshot pixels), `read` (paged by offset),
 * `screenshot`, `scroll`, `waitFor`, the deep verbs, and `close`, which lets
 * go of the session's page (a Chrome's or the dock's tab stays for the
 * person).
 */
export const PAGE_VERB_SCHEMAS = {
  open: {
    args: z
      .object({ url: Address.optional().meta({ description: "Where to open the page; absent, the session's page as it is." }), snapshot: AfterAction })
      .meta({ description: "open: the session's page, made when it has none, at an address or as it is." }),
    value: PageArrival,
  },
  navigate: {
    args: z.object({ url: Address, snapshot: AfterAction }).meta({ description: "navigate: go to an address and let the load settle." }),
    value: PageArrival,
  },
  snapshot: { args: SnapshotArgs, value: PageSnapshot },
  click: {
    args: z.object({ target: ElementTarget, snapshot: AfterAction }).meta({ description: "click: scroll the element into view and click its centre." }),
    value: PageArrival,
  },
  clickAt: {
    args: z
      .object({
        x: z.number().min(0).meta({ description: "Pixels from the screenshot's left edge." }),
        y: z.number().min(0).meta({ description: "Pixels from the screenshot's top edge." }),
        snapshot: AfterAction,
      })
      .meta({ description: "clickAt: click at a point of the latest screenshot." }),
    value: PageArrival,
  },
  type: {
    args: z
      .object({ target: ElementTarget, text: z.string().max(MAX_TEXT).meta({ description: "What the field holds afterwards: typing replaces its contents." }), snapshot: AfterAction })
      .meta({ description: "type: replace an input's, a textarea's or an editable element's contents." }),
    value: PageArrival,
  },
  read: {
    args: z
      .object({
        offset: z.int().min(0).optional().meta({ description: "Where the page of text starts, in characters; preset 0." }),
        links: z.boolean().optional().meta({ description: "Keep link targets in the Markdown; preset false, the link text kept." }),
      })
      .meta({ description: "read: the page's readable text, paged." }),
    value: PageReading,
  },
  screenshot: { args: noArgs, value: PageImage },
  scroll: { args: z.object({ to: ScrollTarget }).meta({ description: "scroll: by a direction and an amount, or to an element." }), value: PageLocation },
  waitFor: { args: z.object({ until: WaitCondition }).meta({ description: "waitFor: text, a ref or a number of milliseconds." }), value: PageLocation },
  console: { args: noArgs, value: z.array(ConsoleEntry).meta({ description: "The console lines and uncaught errors since the last console verb." }) },
  network: {
    args: z.object({ failedOnly: z.boolean().optional().meta({ description: "Only the requests that failed; preset false." }) }).meta({ description: "network: the requests since the last network verb." }),
    value: z.array(NetworkEntry).meta({ description: "The requests since the last network verb." }),
  },
  cookies: { args: noArgs, value: z.array(CookieEntry).meta({ description: "The cookies the page would send." }) },
  storage: { args: noArgs, value: StorageSnapshot },
  evaluate: {
    args: z.object({ expression: z.string().min(1).max(MAX_TEXT) }).meta({ description: "evaluate: run a JavaScript expression in the page." }),
    value: EvaluateResult,
  },
  close: { args: noArgs, value: z.null().meta({ description: "The page was let go of." }) },
} as const satisfies { readonly [V in PageVerb]: { readonly args: z.ZodType; readonly value: z.ZodType } };

export type PageArgs<V extends PageVerb> = z.infer<(typeof PAGE_VERB_SCHEMAS)[V]["args"]>;
export type PageValue<V extends PageVerb> = z.infer<(typeof PAGE_VERB_SCHEMAS)[V]["value"]>;

// Calls and answers ----------------------------------------------------------

/** One verb with its arguments. */
export const PageCommand = z
  .discriminatedUnion(
    "verb",
    PAGE_VERBS.map((verb) => z.object({ verb: z.literal(verb), args: PAGE_VERB_SCHEMAS[verb].args })) as unknown as [
      z.ZodObject<{ verb: z.ZodLiteral<PageVerb>; args: z.ZodType }>,
      ...z.ZodObject<{ verb: z.ZodLiteral<PageVerb>; args: z.ZodType }>[],
    ],
  )
  .meta({ description: "A verb and its arguments." });
export type PageCommand = { readonly [V in PageVerb]: { readonly verb: V; readonly args: PageArgs<V> } }[PageVerb];

/**
 * How long a browser that drives through another process (the extension, a
 * relayed client) has to answer a verb before the caller gives up (ported,
 * per verb): 20 seconds to open, navigate, click and click at a point, 18
 * for a screenshot, 5 to let go of a page, a wait's own bound and 5 more,
 * and 12 for the rest. A late answer is dropped.
 */
export const pageCallDeadlineMs = (command: PageCommand): number => {
  switch (command.verb) {
    case "open":
    case "navigate":
    case "click":
    case "clickAt":
      return 20_000;
    case "screenshot":
      return 18_000;
    case "close":
      return 5_000;
    case "waitFor":
      return waitBoundMs(command.args.until) + 5_000;
    default:
      return 12_000;
  }
};

/** A verb for a session's page: the page key, the command, and a one-time allowance a person gave for this call. */
export const PageCall = z
  .object({
    pageKey: PageKey,
    command: PageCommand,
    allowance: OneTimeAllowance.optional().meta({ description: "A person's allow of a denylisted host on this call: it opens that host once." }),
  })
  .meta({ description: "One verb for one session's page, with a one-time allowance when a person allowed a denylisted address." });
export type PageCall = Omit<z.infer<typeof PageCall>, "command"> & { readonly command: PageCommand };

/** Whether an address a frame reached was a top-level navigation (held, and put to the person) or a sub-frame (the page refused whole). */
const DENYLIST_FRAMES = ["top-level", "sub-frame"] as const;

/**
 * A verb that did not do what was asked: the sentence the model reads, and,
 * when the denylist's browser section refused an address a frame reached,
 * the match with the frame it was in, which the tool server hands the gate.
 */
export const PageRefusal = z
  .object({
    ok: z.literal(false),
    reason: z.string().min(1).meta({ description: "The sentence the model reads: what went wrong and what it can do instead." }),
    denylist: z
      .object({
        frame: z.enum(DENYLIST_FRAMES).meta({
          description: "top-level: a navigation of the page, held at about:blank and put to the person; sub-frame: a frame of the page, which refuses the page whole.",
        }),
        match: DenylistMatch,
      })
      .optional()
      .meta({ description: "The denylist entry that refused an address a frame reached, and which frame." }),
  })
  .meta({ description: "A refusal: a sentence the model can act on, never an exception, with the denylist's match when the browser section refused an address." });
export type PageRefusal = z.infer<typeof PageRefusal>;

const notice = z.string().min(1).optional().meta({ description: "Something true of the answer that is not part of it: a wait clamped, a buffer that dropped its oldest entries." });

/** A verb's answer on a wire that does not know the verb: its value is the verb's own, checked against it where the call is known. */
export const PageOutcome = z
  .union([z.object({ ok: z.literal(true), value: z.json().meta({ description: "The verb's value, as PAGE_VERB_SCHEMAS gives it." }), notice }), PageRefusal])
  .meta({ description: "A verb's answer: its value, or a refusal." });
export type PageOutcome = z.infer<typeof PageOutcome>;

/** A verb's answer, typed by the verb. */
export type PageResult<V extends PageVerb> = { readonly ok: true; readonly value: PageValue<V>; readonly notice?: string } | PageRefusal;

/** A call of one verb. */
export type PageCallOf<V extends PageVerb> = Omit<PageCall, "command"> & { readonly command: { readonly verb: V; readonly args: PageArgs<V> } };

/**
 * One kind of browser's hands on its pages: a call in, the verb's value or a
 * refusal sentence out. It never rejects; whatever goes wrong is a refusal.
 */
export interface PageDriver {
  readonly kind: PageDriverKind;
  perform<V extends PageVerb>(call: PageCallOf<V>): Promise<PageResult<V>>;
}
