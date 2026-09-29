import type { ChallengeKind } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { fixturePage, pageOf, type Fixture } from "../test/pages.js";
import { detectChallenge } from "./index.js";

describe("challenge detection on #292's measured pages and the others", () => {
  const FOUND: readonly (readonly [Fixture, ChallengeKind])[] = [
    ["reddit-js-challenge", "javascript"],
    ["datadome-403", "datadome"],
    ["perimeterx-403", "perimeterx"],
    ["duckduckgo-202", "javascript"],
    ["cloudflare-challenge", "cloudflare"],
    ["anubis-challenge", "javascript"],
  ];

  it.each(FOUND)("names what %s shows: %s", (fixture, kind) => {
    expect(detectChallenge(fixturePage(fixture))).toBe(kind);
  });

  it.each(["plain-article", "home-assistant-shell", "excalidraw-shell"] as const)(
    "finds none on %s: a script Cloudflare adds to pages it serves, an invisible reCAPTCHA badge, a captcha field in a comment form and an app shell are none",
    (fixture) => {
      expect(detectChallenge(fixturePage(fixture))).toBeNull();
    },
  );
});

describe("captcha frames", () => {
  const signIn = (widget: string): Document =>
    pageOf(`<!doctype html><title>Sign in</title><body><h1>Sign in</h1><form action="/session" method="post"><input name="email"><input name="password" type="password">${widget}<button>Sign in</button></form><p>${"Terms of service apply. ".repeat(20)}</p></body>`);

  it("names a reCAPTCHA checkbox, as its frame or as the markup its script renders into, on google.com or recaptcha.net", () => {
    expect(detectChallenge(signIn(`<iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?ar=1&amp;k=site-key-for-tests&amp;size=normal"></iframe>`))).toBe("recaptcha");
    expect(detectChallenge(signIn(`<iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?k=site-key-for-tests&amp;size=compact"></iframe>`))).toBe("recaptcha");
    expect(detectChallenge(signIn(`<div class="g-recaptcha" data-sitekey="site-key-for-tests"></div>`))).toBe("recaptcha");
  });

  it("passes over an invisible reCAPTCHA, which shows the person nothing to solve", () => {
    expect(detectChallenge(signIn(`<iframe src="https://www.google.com/recaptcha/api2/anchor?ar=1&amp;k=site-key-for-tests&amp;size=invisible"></iframe>`))).toBeNull();
    expect(detectChallenge(signIn(`<div class="g-recaptcha" data-sitekey="site-key-for-tests" data-size="invisible"></div>`))).toBeNull();
    expect(detectChallenge(signIn(`<button class="g-recaptcha" data-sitekey="site-key-for-tests" data-callback="send">Send</button>`))).toBeNull();
  });

  it("names an hCaptcha checkbox, as its frame or its markup, and passes over an invisible one", () => {
    expect(detectChallenge(signIn(`<iframe src="https://newassets.hcaptcha.com/captcha/v1/build/static/hcaptcha.html#frame=checkbox&amp;sitekey=site-key-for-tests"></iframe>`))).toBe("hcaptcha");
    expect(detectChallenge(signIn(`<div class="h-captcha" data-sitekey="site-key-for-tests"></div>`))).toBe("hcaptcha");
    expect(detectChallenge(signIn(`<iframe src="https://newassets.hcaptcha.com/captcha/v1/build/static/hcaptcha.html#frame=checkbox-invisible"></iframe>`))).toBeNull();
    expect(detectChallenge(signIn(`<div class="h-captcha" data-sitekey="site-key-for-tests" data-size="invisible"></div>`))).toBeNull();
  });

  it("names a Turnstile widget, as its frame or its markup", () => {
    expect(detectChallenge(signIn(`<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/id-for-tests/site-key-for-tests/light/fbE/new/normal/auto/"></iframe>`))).toBe("turnstile");
    expect(detectChallenge(signIn(`<div class="cf-turnstile" data-sitekey="site-key-for-tests"></div>`))).toBe("turnstile");
  });

  it("names the vendor's check before a captcha frame it shows", () => {
    const html = `<html><body><script>window._cf_chl_opt={cType:'managed'};</script><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x/y/light/fbE/new/normal/auto/"></iframe></body></html>`;
    expect(detectChallenge(pageOf(html))).toBe("cloudflare");
  });
});

describe("a site's own challenge form", () => {
  it("is named where the page is little but a form naming a challenge or a captcha", () => {
    expect(detectChallenge(pageOf(`<body><form action="/verify"><input name="captcha"><button>Go</button></form></body>`))).toBe("javascript");
    expect(detectChallenge(pageOf(`<body><p>Checking your browser.</p><form id="challenge"><input type="hidden" name="answer"></form></body>`))).toBe("javascript");
  });

  it("is none where the page has more to it than the form", () => {
    const article = `<p>${"A paragraph of an article about something else entirely. ".repeat(5)}</p>`;
    expect(detectChallenge(pageOf(`<body>${article}<form action="/verify"><input name="captcha"></form></body>`))).toBeNull();
    expect(detectChallenge(pageOf(`<body><form action="/search"><input name="q"></form></body>`))).toBeNull();
  });
});
