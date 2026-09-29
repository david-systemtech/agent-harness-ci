import type { ChallengeKind } from "@agent-harness/contracts";
import { shownText } from "./page-text.js";

/**
 * Challenge detection (browser spec, "Model-boundary hygiene" and
 * `web_read`): whether a page shows a check that only a person may pass, and
 * which. A result naming one tells the model to stop and ask the person to
 * complete it in a browser they can see; no tool retries or solves one
 * (#292: never stealth, never captcha solving).
 *
 * It reads a document: the live page's in the browser, after it rendered,
 * or a fetched page's in jsdom. The markers are the challenge's own, never
 * what a vendor adds to every page it guards: Cloudflare's JavaScript
 * detections script, DataDome's and PerimeterX's sensors and an invisible
 * reCAPTCHA sit on ordinary pages, and a page carrying them is readable.
 */

/** One kind of challenge's markers: elements that mark it, and what its page's inline scripts say. */
export interface ChallengeMarkers {
  readonly kind: ChallengeKind;
  /** CSS selectors, any one of which marks the challenge. */
  readonly selectors: readonly string[];
  /** Patterns over the page's inline scripts, any one of which marks it. */
  readonly scripts: readonly RegExp[];
}

/**
 * The markers, as data, in the order they are asked: a bot-check vendor's
 * page before the captcha frame it may show, since the vendor is what the
 * person meets; then the captcha frames; then the JavaScript challenges.
 * A captcha is marked by its frame or by the markup its script renders into,
 * an invisible one (reCAPTCHA v3, a button bound to one, `data-size`
 * `invisible`, a Turnstile widget whose `data-appearance` shows it only when
 * it needs the person or once it runs) passed over, since it shows the
 * person nothing up front.
 */
export const CHALLENGE_MARKERS: readonly ChallengeMarkers[] = [
  {
    // The page DataDome serves in place of the one asked for: its captcha comes from captcha-delivery.com.
    kind: "datadome",
    selectors: ['script[src*="captcha-delivery.com"]', 'iframe[src*="captcha-delivery.com"]'],
    scripts: [/captcha-delivery\.com/],
  },
  {
    // PerimeterX's block page: its press-and-hold captcha, the page's description, and the captcha script it loads.
    kind: "perimeterx",
    selectors: ["#px-captcha", 'meta[name="description"][content="px-captcha"]', 'script[src*="captcha.px-cloud.net"]', 'script[src*="captcha.px-cdn.net"]'],
    scripts: [/\bpxCaptcha|captcha\.px-c(?:loud|dn)\.net/],
  },
  {
    // Cloudflare's challenge page: its options object, the challenge form of its older pages, and the orchestrating
    // script; never `/cdn-cgi/challenge-platform/` alone, which its JavaScript detections load on ordinary pages.
    kind: "cloudflare",
    selectors: ['form[action*="__cf_chl_"]', "#challenge-running", "#cf-challenge-running", ".cf-browser-verification", 'script[src*="/challenge-platform/"][src*="/orchestrate/"]'],
    scripts: [/\b_cf_chl_opt\b/],
  },
  {
    kind: "recaptcha",
    selectors: ['iframe[src*="/recaptcha/"][src*="/anchor"]:not([src*="size=invisible"])', 'div.g-recaptcha:not([data-size="invisible"])'],
    scripts: [],
  },
  {
    kind: "hcaptcha",
    selectors: ['iframe[src*="hcaptcha.com"][src*="frame=checkbox"]:not([src*="invisible"])', 'div.h-captcha:not([data-size="invisible"])'],
    scripts: [],
  },
  {
    // Turnstile has no invisible size in markup: a widget that appears only once it needs the person, or once it runs, says so by its appearance.
    kind: "turnstile",
    selectors: [
      'iframe[src*="challenges.cloudflare.com"]:not([src*="/invisible/"])',
      'div.cf-turnstile:not([data-appearance="interaction-only"]):not([data-appearance="execute"])',
    ],
    scripts: [],
  },
  {
    // Anubis's proof of work, in front of many open-source hosts: the challenge its script solves.
    kind: "javascript",
    selectors: ["script#anubis_challenge"],
    scripts: [],
  },
];

/**
 * How little text beside it makes a form the page itself: a challenge
 * interstitial is next to empty but for its form, as a shell is but for its
 * script.
 */
const INTERSTITIAL_TEXT_CHARS = 200;

/** The words by which a form or its field names a challenge. */
const CHALLENGE_WORDS = ["challenge", "captcha"] as const;

/** A form naming a challenge by its id, name, class or action, in any case. */
const NAMED_FORMS = CHALLENGE_WORDS.flatMap((word) => ["id", "name", "class", "action"].map((attribute) => `form[${attribute}*="${word}" i]`)).join(", ");

/** A form's field naming a challenge by its name or id, in any case. */
const NAMED_FIELDS = CHALLENGE_WORDS.flatMap((word) =>
  ["input", "select", "textarea", "button"].flatMap((field) => ["name", "id"].map((attribute) => `form ${field}[${attribute}*="${word}" i]`)),
).join(", ");

/**
 * A site's own challenge form (a JavaScript proof of work that submits
 * itself, as Reddit's, or a puzzle a person solves, as DuckDuckGo's): a form
 * that names a challenge or a captcha, or holds a field that does, on a page
 * with under 200 characters of text beside it. A captcha field in a comment
 * form under an article is not the page's point, and the article is
 * readable.
 */
const challengeForm = (document: Document): boolean => {
  const forms = new Set<Element>(document.querySelectorAll(NAMED_FORMS));
  for (const field of Array.from(document.querySelectorAll(NAMED_FIELDS))) {
    const form = field.closest("form");
    if (form !== null) forms.add(form);
  }
  if (forms.size === 0) return false;
  return shownText(document.body ?? document.documentElement, (element) => forms.has(element)).length < INTERSTITIAL_TEXT_CHARS;
};

/** The text of each of the page's inline scripts. */
const inlineScripts = (document: Document): string[] =>
  Array.from(document.querySelectorAll("script:not([src])"), (script) => script.textContent ?? "").filter((text) => text !== "");

/**
 * The challenge `document` shows, named by kind, or null for a page with
 * none: a vendor's check, then a captcha frame, then a JavaScript challenge
 * or a site's own challenge form, the first the page shows in that order.
 */
export const detectChallenge = (document: Document): ChallengeKind | null => {
  let scripts: string[] | undefined;
  for (const { kind, selectors, scripts: patterns } of CHALLENGE_MARKERS) {
    if (selectors.some((selector) => document.querySelector(selector) !== null)) return kind;
    if (patterns.length === 0) continue;
    scripts ??= inlineScripts(document);
    if (scripts.some((text) => patterns.some((pattern) => pattern.test(text)))) return kind;
  }
  return challengeForm(document) ? "javascript" : null;
};
