import { SNAPSHOT_MAX_CHARS } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { serialiseSnapshot } from "./serialiser.js";
import type { AriaNodeJSON } from "./vendor/aria-types.js";

/**
 * The snapshot's serialiser (browser spec, "The tools" and "Model-boundary
 * hygiene"): a pure function from the element tree the page answered, its
 * frames stitched in, to the text the model reads. Its trees are recorded:
 * written as the in-page snapshot answers them.
 */

/** `n` characters from `alphabet`, repeated: a filler no secret scanner takes for a key. */
const fill = (n: number, alphabet = "Fake0Test9"): string => alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);
/** A GitHub token's shape, its prefix kept apart from its body in the source. */
const githubToken = ["gh", "p_", fill(36)].join("");

/** A sign-in page as the in-page snapshot answers it. */
const signIn: AriaNodeJSON[] = [
  {
    role: "generic",
    ref: "e1",
    children: [
      { role: "banner", ref: "e2", children: [{ role: "link", name: "Home", ref: "e3", cursor: "pointer", url: "/" }] },
      { role: "heading", name: "Sign in", level: 1, ref: "e4" },
      { role: "paragraph", ref: "e5", text: "Welcome back." },
      {
        role: "form",
        name: "Sign in",
        ref: "e6",
        children: [
          { role: "textbox", name: "Email", ref: "e7", field: { type: "email", autocomplete: "username" }, text: "person@example.com" },
          { role: "textbox", name: "Password", ref: "e8", field: { type: "password", autocomplete: "current-password" }, text: "[redacted: a password]" },
          { role: "generic", ref: "e9", children: [{ role: "checkbox", name: "Remember me", checked: true, ref: "e10" }, "for thirty days"] },
          { role: "button", name: "Sign in", disabled: true, ref: "e11" },
        ],
      },
    ],
  },
];

const ALL = `- generic [ref=e1]:
  - banner [ref=e2]:
    - link "Home" [ref=e3] [cursor=pointer]:
      - /url: /
  - heading "Sign in" [level=1] [ref=e4]
  - paragraph [ref=e5]: Welcome back.
  - form "Sign in" [ref=e6]:
    - textbox "Email" [ref=e7]: person@example.com
    - textbox "Password" [ref=e8]: "[redacted: a password]"
    - generic [ref=e9]:
      - checkbox "Remember me" [checked] [ref=e10]
      - text: for thirty days
    - button "Sign in" [disabled] [ref=e11]`;

describe("serialiseSnapshot", () => {
  it("writes every element one a line, with its role, name, states, value and ref, its children indented under it", () => {
    expect(serialiseSnapshot(signIn, { filter: "all" })).toEqual({ ok: true, text: ALL, totalChars: ALL.length, truncated: false });
  });

  it("keeps by default the elements that can be acted on, whole, under the landmarks, dialogs and named elements they sit in", () => {
    const interactive = `- banner [ref=e2]:
  - link "Home" [ref=e3] [cursor=pointer]:
    - /url: /
- form "Sign in" [ref=e6]:
  - textbox "Email" [ref=e7]: person@example.com
  - textbox "Password" [ref=e8]: "[redacted: a password]"
  - checkbox "Remember me" [checked] [ref=e10]
  - button "Sign in" [disabled] [ref=e11]`;
    expect(serialiseSnapshot(signIn, {})).toEqual({ ok: true, text: interactive, totalChars: interactive.length, truncated: false });
    expect(serialiseSnapshot(signIn, { filter: "interactive" })).toMatchObject({ text: interactive });
  });

  it("reads as many levels as depth asks, an element at the last level keeping only text of its own", () => {
    expect(serialiseSnapshot(signIn, { filter: "all", depth: 2 })).toMatchObject({
      text: `- generic [ref=e1]:
  - banner [ref=e2]
  - heading "Sign in" [level=1] [ref=e4]
  - paragraph [ref=e5]: Welcome back.
  - form "Sign in" [ref=e6]`,
    });
    expect(serialiseSnapshot(signIn, { filter: "all", depth: 1 })).toMatchObject({ text: "- generic [ref=e1]" });
  });

  it("focuses on the element a ref names, filtering below it, and counts depth from it", () => {
    expect(serialiseSnapshot(signIn, { filter: "all", ref: "e6", depth: 1 })).toMatchObject({ text: `- form "Sign in" [ref=e6]` });
    expect(serialiseSnapshot(signIn, { ref: "e9" })).toMatchObject({ text: `- generic [ref=e9]:\n  - checkbox "Remember me" [checked] [ref=e10]` });
  });

  it("refuses a ref no element of the snapshot has, telling the model to take a new snapshot", () => {
    expect(serialiseSnapshot(signIn, { ref: "e99" })).toEqual({
      ok: false,
      reason: "No element on the page has the ref e99 now: it is from an older snapshot, or its element has left the page. Take a new snapshot without ref, and focus on a ref it gives.",
    });
  });

  it("cuts the text at the last line boundary within maxChars, stating the whole text's length", () => {
    const cut = ALL.slice(0, ALL.indexOf("\n  - paragraph"));
    expect(serialiseSnapshot(signIn, { filter: "all", maxChars: cut.length + 10 })).toEqual({ ok: true, text: cut, totalChars: ALL.length, truncated: true });
    expect(serialiseSnapshot(signIn, { filter: "all", maxChars: ALL.length })).toMatchObject({ text: ALL, truncated: false });
  });

  it("cuts at 30,000 characters when maxChars is not given", () => {
    const links: AriaNodeJSON[] = Array.from({ length: 2_000 }, (_, index) => ({ role: "link", name: `Result number ${index + 1}`, ref: `e${index + 1}` }));
    const result = serialiseSnapshot([{ role: "list", children: links }], {});
    if (!result.ok) throw new Error(result.reason);
    expect(SNAPSHOT_MAX_CHARS.preset).toBe(30_000);
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBeGreaterThan(30_000);
    expect(result.text.length).toBeLessThanOrEqual(30_000);
    expect(result.text.endsWith(`[ref=e${result.text.split("\n").length}]`)).toBe(true);
  });

  it("gives no text, cut at a line boundary, when the first line alone is longer than maxChars", () => {
    const long: AriaNodeJSON[] = [{ role: "paragraph", text: "word ".repeat(40).trim() }, { role: "button", name: "Next", ref: "e2" }];
    expect(serialiseSnapshot(long, { filter: "all", maxChars: 50 })).toEqual({ ok: true, text: "", totalChars: 237, truncated: true });
  });

  it("writes the marker for a password, card or one-time-code field's value, whatever the page reported", () => {
    const fields: AriaNodeJSON[] = [
      { role: "textbox", name: "Password", ref: "e1", field: { type: "password" }, text: "hunter2-for-tests" },
      { role: "textbox", name: "New password", ref: "e2", field: { type: "text", autocomplete: "new-password" }, text: "shown-as-text-for-tests" },
      {
        role: "combobox",
        name: "Expiry year",
        ref: "e3",
        field: { type: "select-one", autocomplete: "billing cc-exp-year" },
        children: [{ role: "option", name: "2031", selected: true, ref: "e4" }],
      },
      { role: "textbox", name: "Code", ref: "e5", field: { type: "text", autocomplete: "one-time-code" }, text: "246810" },
      { role: "textbox", name: "Search", ref: "e6", field: { type: "search" }, text: "red shoes" },
    ];
    expect(serialiseSnapshot(fields, {})).toMatchObject({
      text: `- textbox "Password" [ref=e1]: "[redacted: a password]"
- textbox "New password" [ref=e2]: "[redacted: a password]"
- combobox "Expiry year" [ref=e3]: "[redacted: a payment card detail]"
- textbox "Code" [ref=e5]: "[redacted: a one-time code]"
- textbox "Search" [ref=e6]: red shoes`,
    });
  });

  it("replaces a token-shaped string in any name, text, address or placeholder with its marker", () => {
    const leaky: AriaNodeJSON[] = [
      { role: "heading", name: `Your token ${githubToken}`, level: 2, ref: "e1" },
      { role: "paragraph", ref: "e2", children: [`Paste ${githubToken} into your config`, { role: "code", ref: "e3", text: githubToken }] },
      { role: "link", name: "Reset", ref: "e4", url: `/reset?token=${githubToken}` },
      { role: "textbox", name: "Key", ref: "e5", field: { type: "text" }, placeholder: githubToken, text: githubToken },
    ];
    const result = serialiseSnapshot(leaky, { filter: "all" });
    expect(result).toMatchObject({
      // The markers hold a colon and a space, so the YAML quotes what holds one.
      text: `- 'heading "Your token [redacted: a GitHub token]" [level=2] [ref=e1]'
- paragraph [ref=e2]:
  - text: "Paste [redacted: a GitHub token] into your config"
  - code [ref=e3]: "[redacted: a GitHub token]"
- link "Reset" [ref=e4]:
  - /url: "/reset?token=[redacted: a GitHub token]"
- textbox "Key" [ref=e5]:
  - /placeholder: "[redacted: a GitHub token]"
  - text: "[redacted: a GitHub token]"`,
    });
  });
});
